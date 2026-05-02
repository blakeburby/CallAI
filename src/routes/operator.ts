import { Router } from "express";
import { z } from "zod";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { taskService } from "../modules/execution-engine/taskService.js";
import { jarvisChatService } from "../modules/jarvis-chat/jarvisChatService.js";
import { smsService } from "../modules/sms/smsService.js";
import { vapiCallService } from "../modules/voice-calls/vapiCallService.js";
import { requireFrontendSession } from "../middleware/frontendSession.js";
import {
  checkDatabaseConnection,
  database
} from "../services/dbService.js";
import type {
  AuditEventRecord,
  CodexThreadJobRecord,
  ConfirmationRequestRecord,
  DeveloperTaskRecord,
  JarvisChatReplyJobRecord
} from "../types/operator.js";

const createTaskSchema = z.object({
  utterance: z.string().min(3).max(5000),
  repo_hint: z.string().min(1).max(200).optional()
});

const chatMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  repo_hint: z.string().min(1).max(200).optional()
});

const decisionSchema = z.object({
  decision: z.enum(["approved", "denied"])
});

const continueSchema = z.object({
  instructions: z.string().min(1).max(5000).optional()
});

const cancelSchema = z.object({
  reason: z.string().min(1).max(1000).optional()
});

const outboundCallSchema = z.object({
  phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/),
  reason: z.string().min(3).max(1000),
  task_id: z.string().min(1).optional()
});

export const operatorRouter = Router();

operatorRouter.use("/operator", requireFrontendSession);

operatorRouter.get("/operator/overview", async (_request, response, next) => {
  try {
    const [tasks, confirmations, events, databaseHealth, smsHealth, replyJobs] =
      await Promise.all([
        database.listTasks(50),
        database.listPendingConfirmations(50),
        database.listAuditEvents({ limit: 80 }),
        checkDatabaseConnection(),
        smsService.getHealth(),
        database.listJarvisChatReplyJobs()
      ]);
    const codexThreadJobs = (
      await Promise.all(
        tasks
          .filter((task) => task.execution_target === "codex_thread")
          .map((task) => database.getCodexThreadJob(task.id))
      )
    ).filter((job): job is CodexThreadJobRecord => Boolean(job));

    const runner = summarizeRunner(events, tasks);
    const codexThread = summarizeCodexThread(events, tasks, codexThreadJobs);
    const chatReplyQueue = summarizeChatReplyQueue(replyJobs);
    const jarvisState = summarizeJarvisState({
      chatReplyQueue,
      codexThread,
      confirmations,
      databaseHealth,
      runner,
      tasks
    });

    response.json({
      success: true,
      data: {
        tasks,
        confirmations,
        counts: buildTaskCounts(tasks, confirmations),
        jarvis_state: jarvisState,
        runner,
        codex_thread: codexThread,
        chat_reply_queue: chatReplyQueue,
        sms: smsHealth.summary,
        database: databaseHealth,
        last_activity_at: latestActivityAt(tasks, confirmations, events, replyJobs)
      }
    });
  } catch (error) {
    next(error);
  }
});

operatorRouter.get("/operator/tasks", async (_request, response, next) => {
  try {
    const [tasks, confirmations] = await Promise.all([
      taskService.listTasks(),
      taskService.listPendingConfirmations()
    ]);

    response.json({
      success: true,
      data: {
        tasks,
        confirmations
      }
    });
  } catch (error) {
    next(error);
  }
});

operatorRouter.get("/operator/chat/messages", async (_request, response, next) => {
  try {
    response.json({
      success: true,
      data: {
        messages: await jarvisChatService.listMessages()
      }
    });
  } catch (error) {
    next(error);
  }
});

operatorRouter.post("/operator/chat/messages", async (request, response, next) => {
  try {
    const body = chatMessageSchema.parse(request.body);
    const result = await jarvisChatService.handleMessage({
      channelKind: "web",
      externalId: "operator-console",
      displayName: "Website Chat",
      body: body.message,
      repoHint: body.repo_hint
    });

    response.json({
      success: true,
      data: {
        reply: result.reply,
        task_id: result.taskId ?? null,
        messages: result.messages
      }
    });
  } catch (error) {
    next(error);
  }
});

operatorRouter.post("/operator/tasks", async (request, response, next) => {
  try {
    const body = createTaskSchema.parse(request.body);
    const data = await taskService.createFromUtterance({
      utterance: body.utterance,
      repoHint: body.repo_hint,
      source: "console"
    });

    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

operatorRouter.get("/operator/tasks/:taskId", async (request, response, next) => {
  try {
    const data = await taskService.getStatus(request.params.taskId);

    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

operatorRouter.get(
  "/operator/tasks/:taskId/desktop-state",
  async (request, response, next) => {
    try {
      const data = await database.getDesktopSnapshot(request.params.taskId);

      response.json({
        success: true,
        data: data ?? {
          task_id: request.params.taskId,
          run_id: null,
          current_url: null,
          page_title: null,
          latest_action: null,
          step: 0,
          screenshot_data_url: null,
          redacted: false,
          updated_at: null
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.get("/operator/sms/health", async (_request, response, next) => {
  try {
    const data = await smsService.getHealth();

    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

operatorRouter.post(
  "/operator/tasks/:taskId/continue",
  async (request, response, next) => {
    try {
      const body = continueSchema.parse(request.body);
      const data = await taskService.continueTask(
        request.params.taskId,
        body.instructions
      );

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.post(
  "/operator/tasks/:taskId/cancel",
  async (request, response, next) => {
    try {
      const body = cancelSchema.parse(request.body);
      const data = await taskService.cancelTask(request.params.taskId, body.reason);

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.get(
  "/operator/tasks/:taskId/events",
  async (request, response, next) => {
    try {
      const data = await auditLog.forTask(request.params.taskId, 80);

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.get(
  "/operator/confirmations",
  async (_request, response, next) => {
    try {
      const data = await taskService.listPendingConfirmations();

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.post(
  "/operator/confirmations/:confirmationId",
  async (request, response, next) => {
    try {
      const body = decisionSchema.parse(request.body);
      const data = await taskService.approveAction(
        request.params.confirmationId,
        body.decision
      );

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.post("/operator/calls/outbound", async (request, response, next) => {
  try {
    const body = outboundCallSchema.parse(request.body);
    const data = await vapiCallService.startOutboundCall({
      phone_number: body.phone_number,
      reason: body.reason,
      task_id: body.task_id
    });

    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

function buildTaskCounts(
  tasks: DeveloperTaskRecord[],
  confirmations: ConfirmationRequestRecord[]
): Record<string, number> {
  return {
    running: tasks.filter((task) => task.status === "running").length,
    needs_approval: Math.max(
      confirmations.length,
      tasks.filter((task) => task.status === "needs_confirmation").length
    ),
    queued: tasks.filter((task) => task.status === "queued").length,
    waiting_for_codex_chat: tasks.filter(
      (task) => task.execution_target === "codex_thread" && task.status === "queued"
    ).length,
    blocked_failed: tasks.filter((task) =>
      ["blocked", "failed"].includes(task.status)
    ).length,
    done: tasks.filter((task) =>
      ["succeeded", "cancelled"].includes(task.status)
    ).length
  };
}

function summarizeCodexThread(
  events: AuditEventRecord[],
  tasks: DeveloperTaskRecord[],
  jobs: CodexThreadJobRecord[]
): Record<string, unknown> {
  const bridgeEvent = events.find((event) =>
    event.event_type.startsWith("codex_thread.")
  );
  const queued = tasks.filter(
    (task) => task.execution_target === "codex_thread" && task.status === "queued"
  );
  const running = tasks.find(
    (task) =>
      task.execution_target === "codex_thread" && task.status === "running"
  );
  const staleThresholdMs = Number(
    process.env.CODEX_THREAD_STALE_AFTER_MS ?? 15 * 60 * 1000
  );
  const activeJob = running
    ? jobs.find((job) => job.task_id === running.id) ?? null
    : null;
  const oldestQueued = queued
    .map((task) => task.created_at)
    .sort()
    .at(0);
  const waitingStale =
    Boolean(oldestQueued) &&
    Date.now() - new Date(oldestQueued!).getTime() > staleThresholdMs;
  const activeHeartbeatAt =
    activeJob?.heartbeat_at ?? activeJob?.claimed_at ?? activeJob?.updated_at ?? null;
  const activeStale =
    Boolean(running && activeHeartbeatAt) &&
    Date.now() - new Date(activeHeartbeatAt!).getTime() > staleThresholdMs;
  const stale = waitingStale || activeStale;

  return {
    enabled: isEnabled(process.env.CODEX_THREAD_BRIDGE_ENABLED),
    status: stale
      ? "waiting_stale"
      : running
        ? "claimed"
      : queued.length
        ? "waiting"
        : "idle",
    waiting_count: queued.length,
    active_task_id: running?.id ?? null,
    active_task_title: running?.title ?? null,
    active_heartbeat_at: activeHeartbeatAt,
    oldest_waiting_at: oldestQueued ?? null,
    stale,
    active_stale: activeStale,
    last_event_type: bridgeEvent?.event_type ?? null,
    last_seen_at: bridgeEvent?.created_at ?? null
  };
}

function summarizeRunner(
  events: AuditEventRecord[],
  tasks: DeveloperTaskRecord[]
): Record<string, unknown> {
  const runnerEvent = events.find((event) => event.event_type.startsWith("runner."));
  const lastCheckInEvent =
    events.find((event) =>
      ["runner.heartbeat", "runner.preflight", "runner.started", "runner.claimed_task"].includes(
        event.event_type
      )
    ) ?? runnerEvent;
  const running = tasks.find(
    (task) => task.status === "running" && task.execution_target === "runner"
  );
  const queuedRunnerTasks = tasks.filter(
    (task) => task.status === "queued" && task.execution_target === "runner"
  );
  const heartbeatAgeMs = lastCheckInEvent
    ? Date.now() - new Date(lastCheckInEvent.created_at).getTime()
    : null;
  const staleAfterMs = Number(
    process.env.RUNNER_HEARTBEAT_STALE_AFTER_MS ?? 3 * 60 * 1000
  );
  const stopped = runnerEvent?.event_type === "runner.stopped";
  const bridgeOffline =
    stopped ||
    (Boolean(lastCheckInEvent) && Boolean(heartbeatAgeMs && heartbeatAgeMs > staleAfterMs)) ||
    (!lastCheckInEvent && (queuedRunnerTasks.length > 0 || Boolean(running)));

  return {
    status: bridgeOffline
      ? "offline"
      : running
        ? "active"
        : runnerEvent
          ? "seen"
          : "unknown",
    runner_id:
      stringField(lastCheckInEvent?.payload.runner_id) ??
      stringField(runnerEvent?.payload.runner_id),
    task_scope:
      stringField(lastCheckInEvent?.payload.task_scope) ??
      stringField(runnerEvent?.payload.task_scope),
    last_event_type: runnerEvent?.event_type ?? null,
    last_seen_at: runnerEvent?.created_at ?? null,
    last_heartbeat_at: lastCheckInEvent?.created_at ?? null,
    heartbeat_age_ms: heartbeatAgeMs,
    heartbeat_stale_after_ms: staleAfterMs,
    bridge_offline: bridgeOffline,
    queued_runner_count: queuedRunnerTasks.length,
    active_task_id: running?.id ?? null,
    active_task_title: running?.title ?? null
  };
}

function latestActivityAt(
  tasks: DeveloperTaskRecord[],
  confirmations: ConfirmationRequestRecord[],
  events: AuditEventRecord[],
  replyJobs: JarvisChatReplyJobRecord[] = []
): string | null {
  return [
    ...tasks.map((task) => task.updated_at),
    ...confirmations.map((confirmation) => confirmation.expires_at),
    ...events.map((event) => event.created_at),
    ...replyJobs.map((job) => job.updated_at)
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

function summarizeChatReplyQueue(
  jobs: JarvisChatReplyJobRecord[]
): Record<string, unknown> {
  const queued = jobs.filter((job) => job.status === "queued");
  const running = jobs.filter((job) => job.status === "running");
  const failures = jobs.filter((job) => job.status === "failed" || job.status === "expired");
  const active = running[0] ?? queued[0] ?? null;
  const latestFailure = failures[0] ?? null;
  const now = Date.now();
  const overdue = [...queued, ...running]
    .filter((job) => Date.parse(job.expires_at) < now)
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))[0];

  return {
    queued_count: queued.length,
    running_count: running.length,
    failed_recent_count: failures.length,
    active_job_id: active?.id ?? null,
    active_worker_id: active?.worker_id ?? null,
    oldest_queued_at: queued.at(-1)?.created_at ?? null,
    latest_failure_reason: latestFailure?.error ?? null,
    latest_failure_at: latestFailure?.completed_at ?? latestFailure?.updated_at ?? null,
    latest_failure_worker_id: latestFailure?.worker_id ?? null,
    timeout_age_ms: overdue ? now - Date.parse(overdue.expires_at) : null
  };
}

function summarizeJarvisState(input: {
  chatReplyQueue: Record<string, unknown>;
  codexThread: Record<string, unknown>;
  confirmations: ConfirmationRequestRecord[];
  databaseHealth: Awaited<ReturnType<typeof checkDatabaseConnection>>;
  runner: Record<string, unknown>;
  tasks: DeveloperTaskRecord[];
}): Record<string, unknown> {
  const attentionTask =
    input.tasks.find((task) => task.status === "running") ??
    input.tasks.find((task) => task.status === "needs_confirmation") ??
    input.tasks.find((task) => task.status === "queued") ??
    input.tasks.find((task) => ["failed", "blocked"].includes(task.status)) ??
    null;
  const replyActive =
    Number(input.chatReplyQueue.running_count ?? 0) > 0 ||
    Number(input.chatReplyQueue.queued_count ?? 0) > 0;

  if (!input.databaseHealth.ok) {
    return jarvisState("degraded", "Jarvis is degraded", input.databaseHealth.message, attentionTask, true);
  }

  if (input.confirmations.length > 0) {
    const task =
      input.tasks.find((item) => item.id === input.confirmations[0]?.task_id) ??
      attentionTask;
    return jarvisState(
      "waiting_for_approval",
      "Approval needed",
      `${input.confirmations.length} action${input.confirmations.length === 1 ? "" : "s"} waiting on you.`,
      task,
      true
    );
  }

  if (input.runner.bridge_offline && Number(input.runner.queued_runner_count ?? 0) > 0) {
    return jarvisState(
      "bridge_offline",
      "Mac bridge needs attention",
      "Runner work is queued, but the last bridge heartbeat is stale or missing.",
      attentionTask,
      true
    );
  }

  if (input.codexThread.stale) {
    return jarvisState(
      "stuck",
      "A Codex-thread task looks stale",
      "Manual bridge work has waited longer than the configured stale threshold.",
      attentionTask,
      true
    );
  }

  if (input.tasks.some((task) => task.status === "running")) {
    return jarvisState(
      "working",
      "Jarvis is working",
      attentionTask?.title ?? "A task is running now.",
      attentionTask,
      false
    );
  }

  if (replyActive) {
    return jarvisState(
      "thinking",
      "Jarvis is thinking",
      "A Codex-backed chat reply is queued or running.",
      attentionTask,
      false
    );
  }

  if (Number(input.chatReplyQueue.failed_recent_count ?? 0) > 0) {
    return jarvisState(
      "degraded",
      "Chat replies need a look",
      stringField(input.chatReplyQueue.latest_failure_reason) ??
        "A recent Codex-backed casual reply failed.",
      attentionTask,
      true
    );
  }

  if (input.tasks.some((task) => task.status === "queued")) {
    return jarvisState(
      "working",
      "Work is queued",
      attentionTask?.title ?? "A task is waiting for the right executor.",
      attentionTask,
      false
    );
  }

  return jarvisState(
    "online",
    "Jarvis is online",
    "Chat, approvals, repo work, and Mac bridge routing are standing by.",
    attentionTask,
    false
  );
}

function jarvisState(
  state: string,
  headline: string,
  detail: string,
  task: DeveloperTaskRecord | null,
  needsAttention: boolean
): Record<string, unknown> {
  return {
    state,
    headline,
    detail,
    active_task_id: task?.id ?? null,
    active_task_title: task?.title ?? null,
    needs_attention: needsAttention
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

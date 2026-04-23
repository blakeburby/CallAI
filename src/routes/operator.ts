import { Router } from "express";
import { z } from "zod";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { taskService } from "../modules/execution-engine/taskService.js";
import { smsService } from "../modules/sms/smsService.js";
import { vapiCallService } from "../modules/voice-calls/vapiCallService.js";
import { requireFrontendSession } from "../middleware/frontendSession.js";
import {
  checkDatabaseConnection,
  database
} from "../services/dbService.js";
import type {
  AuditEventRecord,
  ConfirmationRequestRecord,
  DeveloperTaskRecord
} from "../types/operator.js";

const createTaskSchema = z.object({
  utterance: z.string().min(3).max(5000),
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
    const [tasks, confirmations, events, databaseHealth, smsHealth] =
      await Promise.all([
        database.listTasks(50),
        database.listPendingConfirmations(50),
        database.listAuditEvents({ limit: 80 }),
        checkDatabaseConnection(),
        smsService.getHealth()
      ]);

    response.json({
      success: true,
      data: {
        tasks,
        confirmations,
        counts: buildTaskCounts(tasks, confirmations),
        runner: summarizeRunner(events, tasks),
        sms: smsHealth.summary,
        database: databaseHealth,
        last_activity_at: latestActivityAt(tasks, confirmations, events)
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
    blocked_failed: tasks.filter((task) =>
      ["blocked", "failed"].includes(task.status)
    ).length,
    done: tasks.filter((task) =>
      ["succeeded", "cancelled"].includes(task.status)
    ).length
  };
}

function summarizeRunner(
  events: AuditEventRecord[],
  tasks: DeveloperTaskRecord[]
): Record<string, unknown> {
  const runnerEvent = events.find((event) => event.event_type.startsWith("runner."));
  const running = tasks.find((task) => task.status === "running");

  return {
    status: running ? "active" : runnerEvent ? "seen" : "unknown",
    runner_id: stringField(runnerEvent?.payload.runner_id),
    task_scope: stringField(runnerEvent?.payload.task_scope),
    last_event_type: runnerEvent?.event_type ?? null,
    last_seen_at: runnerEvent?.created_at ?? null,
    active_task_id: running?.id ?? null,
    active_task_title: running?.title ?? null
  };
}

function latestActivityAt(
  tasks: DeveloperTaskRecord[],
  confirmations: ConfirmationRequestRecord[],
  events: AuditEventRecord[]
): string | null {
  return [
    ...tasks.map((task) => task.updated_at),
    ...confirmations.map((confirmation) => confirmation.expires_at),
    ...events.map((event) => event.created_at)
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

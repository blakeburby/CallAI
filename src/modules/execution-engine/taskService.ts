import { auditLog } from "../audit-log/auditLogService.js";
import { contextMemory } from "../context-memory/contextMemoryService.js";
import { parseDeveloperTask } from "../task-parser/taskParser.js";
import { smsNotifier } from "../sms/smsNotifier.js";
import { database } from "../../services/dbService.js";
import { logger } from "../../utils/logger.js";
import type {
  ConfirmationRequestRecord,
  CreateTaskInput,
  DeveloperTask,
  DeveloperTaskRecord,
  PermissionLevel,
  TaskCreationResult,
  TaskStatusResult
} from "../../types/operator.js";

const FULL_WRITE_PERMISSIONS: PermissionLevel[] = [
  "full_write",
  "destructive_admin"
];

export const taskService = {
  async createFromUtterance(input: CreateTaskInput): Promise<TaskCreationResult> {
    const sessionId = isUuid(input.sessionId) ? input.sessionId : undefined;
    const interpreted = await parseDeveloperTask(input.utterance);
    const repoResolution = await contextMemory.resolveRepo(
      interpreted,
      input.repoHint
    );
    const permissionNeedsApproval = FULL_WRITE_PERMISSIONS.includes(
      interpreted.permissionRequired
    );
    const lowConfidence = interpreted.confidence < 0.55;
    const codeActionNeedsTarget =
      interpreted.permissionRequired !== "read_only" && !repoResolution.repo;
    const needsConfirmation =
      permissionNeedsApproval ||
      lowConfidence ||
      codeActionNeedsTarget ||
      repoResolution.reason === "ambiguous_repo";
    const taskStatus = needsConfirmation ? "needs_confirmation" : "queued";

    const task = await database.createTask({
      session_id: sessionId ?? null,
      user_id: input.userId ?? null,
      repo_id: repoResolution.repo?.id ?? null,
      title: interpreted.title,
      raw_request: input.utterance,
      normalized_action: interpreted.action,
      structured_request: interpreted as unknown as Record<string, unknown>,
      status: taskStatus,
      permission_required: interpreted.permissionRequired
    });

    await auditLog.log({
      task_id: task.id,
      session_id: sessionId ?? null,
      event_type: "task.created",
      payload: {
        interpreted,
        repo_resolution: {
          reason: repoResolution.reason,
          confidence: repoResolution.confidence,
          candidates: repoResolution.candidates.map((repo) => ({
            id: repo.id,
            owner: repo.owner,
            name: repo.name,
            local_path: repo.local_path
          }))
        }
      }
    });

    let confirmation: ConfirmationRequestRecord | undefined;

    if (needsConfirmation) {
      confirmation = await database.createConfirmation({
        task_id: task.id,
        prompt: buildConfirmationPrompt(interpreted, repoResolution.reason),
        risk: describeRisk(interpreted, repoResolution.reason),
        expires_at: new Date(Date.now() + 1000 * 60 * 15).toISOString()
      });

      await auditLog.log({
        task_id: task.id,
        session_id: sessionId ?? null,
        event_type: "confirmation.requested",
        severity:
          interpreted.permissionRequired === "destructive_admin" ? "warn" : "info",
        payload: {
          confirmation_id: confirmation.id,
          risk: confirmation.risk
        }
      });

      if (input.source !== "sms") {
        smsNotifier.taskNeedsConfirmation(task, confirmation).catch((err) => logger.error("SMS notification failed", { error: String(err) }));
      }
    } else {
      await auditLog.log({
        task_id: task.id,
        session_id: sessionId ?? null,
        event_type: "task.queued",
        payload: {
          executor: chooseExecutor(interpreted)
        }
      });
    }

    return {
      task_id: task.id,
      status: task.status,
      interpreted_task: interpreted,
      needs_confirmation: needsConfirmation,
      ...(confirmation ? { confirmation_id: confirmation.id } : {}),
      ...(repoResolution.repo
        ? {
            repo: {
              id: repoResolution.repo.id,
              owner: repoResolution.repo.owner,
              name: repoResolution.repo.name,
              local_path: repoResolution.repo.local_path
            }
          }
        : {})
    };
  },

  async getStatus(taskId: string): Promise<TaskStatusResult> {
    const task = await requireTask(taskId);
    const [latestEvents, runs, confirmation] = await Promise.all([
      auditLog.forTask(taskId, 40),
      database.listExecutionRuns(taskId),
      database.getPendingConfirmationForTask(taskId)
    ]);
    const finalSummary = runs.find((run) => run.final_summary)?.final_summary;

    return {
      task,
      latest_events: latestEvents,
      runs,
      ...(confirmation ? { confirmation } : {}),
      ...(finalSummary ? { final_summary: finalSummary } : {})
    };
  },

  async continueTask(
    taskId: string,
    instructions?: string
  ): Promise<TaskStatusResult> {
    const task = await requireTask(taskId);

    if (!["failed", "blocked"].includes(task.status)) {
      throw new Error(`Task cannot be continued from ${task.status}.`);
    }

    const updated = await database.updateTask(task.id, { status: "queued" });

    await auditLog.log({
      task_id: task.id,
      event_type: "task.continued",
      payload: {
        previous_status: task.status,
        instructions: instructions ?? null
      }
    });

    return taskService.getStatus(updated.id);
  },

  async approveAction(
    confirmationId: string,
    decision: "approved" | "denied"
  ): Promise<{ task_id: string; status: DeveloperTaskRecord["status"] }> {
    const confirmation = await database.getConfirmation(confirmationId);

    if (!confirmation) {
      throw new Error("Confirmation request was not found.");
    }

    if (confirmation.status !== "pending") {
      throw new Error(`Confirmation is already ${confirmation.status}.`);
    }

    if (new Date(confirmation.expires_at) <= new Date()) {
      await database.updateConfirmation(confirmation.id, "denied");
      throw new Error("Confirmation has expired.");
    }

    const task = await requireTask(confirmation.task_id);
    await database.updateConfirmation(confirmation.id, decision);

    if (decision === "denied") {
      const cancelled = await database.updateTask(task.id, {
        status: "cancelled"
      });

      await auditLog.log({
        task_id: task.id,
        event_type: "confirmation.denied",
        severity: "warn",
        payload: {
          confirmation_id: confirmation.id
        }
      });

      return {
        task_id: cancelled.id,
        status: cancelled.status
      };
    }

    const queued = await database.updateTask(task.id, {
      status: "queued"
    });

    await auditLog.log({
      task_id: task.id,
      event_type: "confirmation.approved",
      payload: {
        confirmation_id: confirmation.id
      }
    });

    return {
      task_id: queued.id,
      status: queued.status
    };
  },

  async cancelTask(
    taskId: string,
    reason?: string
  ): Promise<{ task_id: string; status: DeveloperTaskRecord["status"] }> {
    const task = await requireTask(taskId);
    const updated = await database.updateTask(task.id, { status: "cancelled" });

    await auditLog.log({
      task_id: task.id,
      event_type: "task.cancelled",
      severity: "warn",
      payload: {
        reason: reason ?? null,
        previous_status: task.status
      }
    });

    return {
      task_id: updated.id,
      status: updated.status
    };
  },

  async listTasks(): Promise<DeveloperTaskRecord[]> {
    return database.listTasks(30);
  },

  async listPendingConfirmations(): Promise<ConfirmationRequestRecord[]> {
    return database.listPendingConfirmations(30);
  }
};

const requireTask = async (taskId: string): Promise<DeveloperTaskRecord> => {
  const task = await database.getTask(taskId);

  if (!task) {
    throw new Error("Task was not found.");
  }

  return task;
};

const isUuid = (value: string | undefined): value is string => {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value
      )
  );
};

const buildConfirmationPrompt = (
  task: DeveloperTask,
  repoReason: string
): string => {
  if (repoReason === "ambiguous_repo" || repoReason === "no_repos_configured") {
    return `I need a repo before I can proceed with: ${task.title}. Which repo should I use?`;
  }

  if (task.permissionRequired === "destructive_admin") {
    return `This could affect protected files, deployments, or secrets. Do you explicitly approve: ${task.title}?`;
  }

  if (task.permissionRequired === "full_write") {
    return `This may commit, push, open a PR, or send an external update. Do you approve: ${task.title}?`;
  }

  return `I heard: ${task.title}. Should I proceed?`;
};

const describeRisk = (task: DeveloperTask, repoReason: string): string => {
  if (repoReason === "ambiguous_repo") {
    return "The repo target is ambiguous.";
  }

  if (repoReason === "no_repos_configured") {
    return "No repo target is configured yet.";
  }

  if (task.permissionRequired === "destructive_admin") {
    return "Destructive or admin-level operation.";
  }

  if (task.permissionRequired === "full_write") {
    return "External write operation requiring explicit approval.";
  }

  if (task.confidence < 0.55) {
    return "Low confidence interpretation.";
  }

  return "Proceeding requires user confirmation.";
};

const chooseExecutor = (task: DeveloperTask): string => {
  if (task.action === "send_chat_message") {
    return "chat";
  }

  if (
    task.action === "inspect_repo" ||
    task.action === "summarize_project" ||
    task.action === "query_logs" ||
    task.action === "run_tests"
  ) {
    return "direct";
  }

  return "codex_local";
};

import { auditLog } from "../audit-log/auditLogService.js";
import { smsNotifier } from "../sms/smsNotifier.js";
import { smsService } from "../sms/smsService.js";
import { telegramService } from "../telegram/telegramService.js";
import { database } from "../../services/dbService.js";
import { jarvisChatService } from "./jarvisChatService.js";
import type {
  ConfirmationRequestRecord,
  DeveloperTaskRecord,
  TaskStatus
} from "../../types/operator.js";

export const jarvisChatNotifier = {
  async taskNeedsConfirmation(
    task: DeveloperTaskRecord,
    confirmation: ConfirmationRequestRecord
  ): Promise<void> {
    const body = `Approval needed: ${task.title}. Risk: ${confirmation.risk}. Reply approve ${confirmation.id.slice(-6)} or deny ${confirmation.id.slice(-6)}.`;
    await notifyTaskOrigins(task, body, "confirmation_requested", () =>
      smsNotifier.taskNeedsConfirmation(task, confirmation)
    );
  },

  async taskFinished(
    task: DeveloperTaskRecord,
    status: Extract<TaskStatus, "succeeded" | "failed" | "blocked">,
    summary: string
  ): Promise<void> {
    const label =
      status === "succeeded" ? "completed" : status === "blocked" ? "blocked" : "failed";
    const body = `Jarvis ${label}: ${task.title}. ${summary}`;
    await notifyTaskOrigins(task, body, `task_${status}`, () =>
      smsNotifier.taskFinished(task, status, summary)
    );
  }
};

const notifyTaskOrigins = async (
  task: DeveloperTaskRecord,
  body: string,
  relation: string,
  fallback: () => Promise<void>
): Promise<void> => {
  const origins = await database.listChatTaskOrigins(task.id);

  if (origins.length === 0) {
    await fallback();
    return;
  }

  for (const origin of origins) {
    await jarvisChatService.appendTaskUpdate({
      conversationId: origin.conversation_id,
      taskId: task.id,
      body,
      relation
    });

    try {
      if (origin.channel_kind === "sms") {
        await smsService.sendOwnerMessage(body);
      }

      if (origin.channel_kind === "telegram") {
        await telegramService.sendMessage(origin.external_id, body);
      }
    } catch (error) {
      await auditLog.log({
        task_id: task.id,
        event_type: "jarvis.origin_notification_failed",
        severity: "warn",
        payload: {
          channel_kind: origin.channel_kind,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
};

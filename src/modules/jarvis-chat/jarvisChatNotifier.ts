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
    const body = `Approval gate. Task ${task.id.slice(-6)} wants a risky move: ${task.title}. Risk: ${confirmation.risk}. Reply approve ${confirmation.id.slice(-6)} or deny ${confirmation.id.slice(-6)}.`;
    await notifyTaskOrigins(
      task,
      body,
      "confirmation_requested",
      () => smsNotifier.taskNeedsConfirmation(task, confirmation),
      {
        telegramReplyMarkup: telegramService.approvalReplyMarkup(confirmation.id)
      }
    );
  },

  async taskProgress(
    task: DeveloperTaskRecord,
    body: string,
    relation = "task_progress"
  ): Promise<void> {
    await notifyTaskOrigins(
      task,
      body,
      relation,
      async () => undefined,
      {
        externalBody: renderExternalProgress(task, body, relation)
      }
    );
  },

  async taskFinished(
    task: DeveloperTaskRecord,
    status: Extract<TaskStatus, "succeeded" | "failed" | "blocked">,
    summary: string
  ): Promise<void> {
    const label = status === "succeeded" ? "Done" : status === "blocked" ? "Blocked" : "Failed";
    const body = `${label}. Task ${task.id.slice(-6)}: ${task.title}. ${summary}`;
    await notifyTaskOrigins(task, body, `task_${status}`, () =>
      smsNotifier.taskFinished(task, status, summary)
    );
  }
};

const notifyTaskOrigins = async (
  task: DeveloperTaskRecord,
  body: string,
  relation: string,
  fallback: () => Promise<void>,
  options: {
    externalBody?: string | null;
    telegramReplyMarkup?: ReturnType<typeof telegramService.approvalReplyMarkup>;
  } = {}
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
      const externalBody = options.externalBody ?? body;
      const shouldNotify = shouldNotifyOrigin(relation, externalBody);

      if (origin.channel_kind === "sms") {
        if (shouldNotify) {
          await smsService.sendOwnerMessage(externalBody);
        }
      }

      if (origin.channel_kind === "telegram") {
        if (shouldNotify) {
          await telegramService.sendMessage(origin.external_id, externalBody, {
            ...(options.telegramReplyMarkup
              ? { replyMarkup: options.telegramReplyMarkup }
              : {})
          });
        }
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

const shouldNotifyOrigin = (relation: string, body: string | null): body is string => {
  if (!body) {
    return false;
  }

  return [
    "confirmation_requested",
    "task_started",
    "task_succeeded",
    "task_failed",
    "task_blocked",
    "computer_shell_started",
    "computer_shell_completed",
    "computer_session_started",
    "desktop_session_started",
    "desktop_chrome_opened",
    "desktop_confirmation_required"
  ].includes(relation);
};

const renderExternalProgress = (
  task: DeveloperTaskRecord,
  body: string,
  relation: string
): string | null => {
  const tail = task.id.slice(-6);

  if (relation === "task_started") {
    return `I picked up task ${tail}. Moving now: ${task.title}.`;
  }

  if (relation === "computer_shell_started") {
    return `Task ${tail}: running the shell step now.`;
  }

  if (relation === "computer_shell_completed") {
    return `Task ${tail}: shell step finished.\n${trimBody(body)}`;
  }

  if (relation === "computer_session_started") {
    return `Task ${tail}: opening the Mac operator path now.`;
  }

  if (relation === "desktop_session_started") {
    return `Task ${tail}: opening ${browserName(task)} and getting oriented.`;
  }

  if (relation === "desktop_chrome_opened") {
    return `Task ${tail}: ${browserName(task)} is open. I’m checking the page.`;
  }

  if (relation === "desktop_confirmation_required") {
    return body;
  }

  if (relation.startsWith("task_") || relation === "confirmation_requested") {
    return body;
  }

  return null;
};

const browserName = (task: DeveloperTaskRecord): string => {
  const structured = task.structured_request;
  const target = structured?.targetApp?.trim();

  if (target && !/^(chrome|google chrome|browser|google)$/i.test(target)) {
    return target;
  }

  return (
    process.env.LOCAL_BRIDGE_BROWSER_APP ||
    process.env.COMPUTER_CONTROL_BROWSER_APP ||
    "ChatGPT Atlas"
  );
};

const trimBody = (body: string): string => {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, 5).join("\n").slice(0, 1200);
};

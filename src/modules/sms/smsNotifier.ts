import { auditLog } from "../audit-log/auditLogService.js";
import { smsService } from "./smsService.js";
import type {
  ConfirmationRequestRecord,
  DeveloperTaskRecord,
  TaskStatus
} from "../../types/operator.js";

export const smsNotifier = {
  async taskNeedsConfirmation(
    task: DeveloperTaskRecord,
    confirmation: ConfirmationRequestRecord
  ): Promise<void> {
    await notify({
      task,
      eventType: "sms.confirmation_needed",
      body: `CallAI needs approval for ${task.title}. Risk: ${confirmation.risk}. Open the console or ask Jarvis to approve confirmation ${confirmation.id.slice(-6)}.`
    });
  },

  async taskFinished(
    task: DeveloperTaskRecord,
    status: Extract<TaskStatus, "succeeded" | "failed" | "blocked">,
    summary: string
  ): Promise<void> {
    const label =
      status === "succeeded" ? "completed" : status === "blocked" ? "blocked" : "failed";
    await notify({
      task,
      eventType: `sms.task_${status}`,
      body: `CallAI ${label}: ${task.title}. ${summary}`
    });
  }
};

const notify = async (input: {
  task: DeveloperTaskRecord;
  eventType: string;
  body: string;
}): Promise<void> => {
  if (!smsService.isConfigured()) {
    return;
  }

  const safeBody = redactSensitiveText(input.body);

  try {
    await smsService.sendOwnerMessage(safeBody);
    await auditLog.log({
      task_id: input.task.id,
      event_type: input.eventType,
      payload: {
        delivered: true,
        owner_phone_tail: smsService.configSummary().ownerPhoneTail
      }
    });
  } catch (error) {
    await auditLog.log({
      task_id: input.task.id,
      event_type: "sms.notification_failed",
      severity: "warn",
      payload: {
        source_event_type: input.eventType,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
};

const redactSensitiveText = (value: string): string => {
  const redacted = value
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, "[redacted OpenAI key]")
    .replace(/AC[a-fA-F0-9]{32}/g, "[redacted Twilio SID]")
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, "[redacted GitHub token]")
    .replace(/AKIA[A-Z0-9]{16}/g, "[redacted AWS key]")
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
      "$1=[redacted]"
    );

  return redacted.length > 900 ? `${redacted.slice(0, 897)}...` : redacted;
};

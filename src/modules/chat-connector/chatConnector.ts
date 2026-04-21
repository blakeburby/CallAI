import { auditLog } from "../audit-log/auditLogService.js";
import { database } from "../../services/dbService.js";

type SendProjectUpdateInput = {
  taskId?: string;
  channelHint?: string;
  message: string;
};

export const chatConnector = {
  async sendProjectUpdate(input: SendProjectUpdateInput): Promise<{
    delivered: boolean;
    channel: string;
    mode: "webhook" | "audit_only";
  }> {
    const channel = await database.findChatChannel(input.channelHint);
    const webhookUrl = process.env.CHAT_WEBHOOK_URL;

    if (webhookUrl) {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          task_id: input.taskId,
          channel_hint: input.channelHint,
          message: input.message
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error(`Chat webhook failed with ${response.status}.`);
      }

      await auditLog.log({
        task_id: input.taskId ?? null,
        event_type: "chat.update_sent",
        payload: {
          channel: channel?.display_name ?? input.channelHint ?? "webhook",
          mode: "webhook"
        }
      });

      return {
        delivered: true,
        channel: channel?.display_name ?? input.channelHint ?? "webhook",
        mode: "webhook"
      };
    }

    await auditLog.log({
      task_id: input.taskId ?? null,
      event_type: "chat.update_recorded",
      payload: {
        channel: channel?.display_name ?? input.channelHint ?? "audit log",
        message: input.message
      }
    });

    return {
      delivered: false,
      channel: channel?.display_name ?? input.channelHint ?? "audit log",
      mode: "audit_only"
    };
  }
};

import { auditLog } from "../audit-log/auditLogService.js";
import { jarvisChatService } from "../jarvis-chat/jarvisChatService.js";
import { database } from "../../services/dbService.js";

type HandleInboundInput = {
  from: string;
  body: string;
  messageSid: string | null;
};

type SmsKeyword = "start" | "stop" | null;

export const smsChatService = {
  async handleInbound(input: HandleInboundInput): Promise<string> {
    const keyword = smsKeyword(input.body);
    const existing = await database.findSmsConversationByPhone(input.from);
    const status =
      keyword === "stop"
        ? "stopped"
        : keyword === "start"
          ? "active"
          : existing?.status ?? "active";
    const conversation = await database.upsertSmsConversation({
      phone_e164: input.from,
      status
    });

    await database.appendSmsMessage({
      conversation_id: conversation.id,
      role: "user",
      body: input.body,
      provider_message_sid: input.messageSid,
      payload: {
        from_tail: input.from.slice(-4)
      }
    });

    await auditLog.log({
      event_type: "sms.message_received",
      payload: {
        conversation_id: conversation.id,
        from_tail: input.from.slice(-4),
        message_sid: input.messageSid,
        body_length: input.body.length
      }
    });

    const jarvisBody =
      keyword === "stop" ? "STOP" : keyword === "start" ? "START" : input.body;
    const result = await jarvisChatService.handleMessage({
      channelKind: "sms",
      externalId: input.from,
      displayName: `SMS ${input.from.slice(-4)}`,
      body: jarvisBody,
      providerMessageId: input.messageSid,
      payload: {
        original_body: input.body,
        sms_conversation_id: conversation.id,
        from_tail: input.from.slice(-4)
      }
    });

    await database.appendSmsMessage({
      conversation_id: conversation.id,
      role: "assistant",
      body: result.reply,
      payload: {
        to_tail: input.from.slice(-4)
      }
    });

    return result.reply;
  }
};

const smsKeyword = (body: string): SmsKeyword => {
  const normalized = body.trim().toLowerCase();

  if (/^(start|unstop)$/.test(normalized)) {
    return "start";
  }

  if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/.test(normalized)) {
    return "stop";
  }

  return null;
};

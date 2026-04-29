import { Router } from "express";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { jarvisChatService } from "../modules/jarvis-chat/jarvisChatService.js";
import { telegramService } from "../modules/telegram/telegramService.js";

export const telegramRouter = Router();

telegramRouter.post("/telegram/webhook", async (request, response, next) => {
  try {
    if (
      !telegramService.authorizeWebhook(
        request.get("x-telegram-bot-api-secret-token") ?? undefined
      )
    ) {
      response.status(403).json({ success: false, error: "Telegram webhook rejected." });
      return;
    }

    const message = telegramMessage(request.body);

    if (!message?.text) {
      response.json({ success: true, ignored: true });
      return;
    }

    if (!telegramService.isOwnerUser(message.fromId)) {
      await auditLog.log({
        event_type: "telegram.inbound_rejected",
        severity: "warn",
        payload: {
          reason: "non_owner_user",
          from_id: String(message.fromId ?? ""),
          chat_id_tail: String(message.chatId).slice(-6)
        }
      });
      response.json({ success: true, accepted: false });
      return;
    }

    const result = await jarvisChatService.handleMessage({
      channelKind: "telegram",
      externalId: String(message.chatId),
      displayName: message.displayName,
      body: message.text,
      providerMessageId: message.messageId ? String(message.messageId) : null,
      payload: {
        telegram_from_id: String(message.fromId),
        telegram_chat_type: message.chatType
      }
    });

    await telegramService.sendMessage(String(message.chatId), result.reply);
    response.json({
      success: true,
      accepted: true,
      task_id: result.taskId ?? null
    });
  } catch (error) {
    next(error);
  }
});

const telegramMessage = (
  payload: unknown
): {
  chatId: string | number;
  chatType: string | null;
  displayName: string;
  fromId: string | number | null;
  messageId: string | number | null;
  text: string;
} | null => {
  const record = payload as Record<string, unknown>;
  const message = (record.message ?? record.edited_message) as
    | Record<string, unknown>
    | undefined;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const chat = message?.chat as Record<string, unknown> | undefined;
  const from = message?.from as Record<string, unknown> | undefined;
  const chatId = chat?.id;

  if ((!chatId && chatId !== 0) || !text) {
    return null;
  }

  const personName = [stringField(from?.first_name), stringField(from?.last_name)]
    .filter(Boolean)
    .join(" ")
    .trim();
  const displayName =
    stringField(chat?.title) ||
    personName ||
    stringField(from?.username) ||
    "Telegram";

  return {
    chatId: chatId as string | number,
    chatType: stringField(chat?.type) ?? null,
    displayName: displayName || "Telegram",
    fromId: (from?.id as string | number | null | undefined) ?? null,
    messageId: (message?.message_id as string | number | null | undefined) ?? null,
    text
  };
};

const stringField = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

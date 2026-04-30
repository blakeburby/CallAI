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

    const callback = telegramCallback(request.body);

    if (callback) {
      if (!telegramService.isOwnerUser(callback.fromId)) {
        await auditLog.log({
          event_type: "telegram.inbound_rejected",
          severity: "warn",
          payload: {
            reason: "non_owner_callback",
            from_id: String(callback.fromId ?? ""),
            chat_id_tail: String(callback.chatId).slice(-6)
          }
        });
        response.json({ success: true, accepted: false });
        return;
      }

      const callbackMessage = callbackMessageText(callback.data);

      if (!callbackMessage) {
        await telegramService.answerCallbackQuery(
          String(callback.callbackId),
          "That Jarvis action is no longer available."
        );
        response.json({ success: true, accepted: true, ignored: true });
        return;
      }

      const result = await jarvisChatService.handleMessage({
        channelKind: "telegram",
        externalId: String(callback.chatId),
        displayName: callback.displayName,
        body: callbackMessage,
        providerMessageId: String(callback.callbackId),
        payload: {
          telegram_from_id: String(callback.fromId),
          telegram_chat_type: callback.chatType,
          telegram_callback_data: callback.data
        }
      });

      await telegramService.answerCallbackQuery(
        String(callback.callbackId),
        result.reply || "Queued for Jarvis."
      );
      if (result.reply) {
        await telegramService.sendMessage(String(callback.chatId), result.reply, {
          ...(result.confirmationId
            ? { replyMarkup: telegramService.approvalReplyMarkup(result.confirmationId) }
            : {})
        });
      }
      response.json({
        success: true,
        accepted: true,
        reply: result.reply,
        queued_reply_job_id: result.casualReplyJobId ?? null,
        task_id: result.taskId ?? null,
        confirmation_id: result.confirmationId ?? null
      });
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

    if (result.reply) {
      await telegramService.sendMessage(String(message.chatId), result.reply, {
        ...(result.confirmationId
          ? { replyMarkup: telegramService.approvalReplyMarkup(result.confirmationId) }
          : {})
      });
    }
    response.json({
      success: true,
      accepted: true,
      reply: result.reply,
      queued_reply_job_id: result.casualReplyJobId ?? null,
      confirmation_id: result.confirmationId ?? null,
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

const telegramCallback = (
  payload: unknown
): {
  callbackId: string | number;
  chatId: string | number;
  chatType: string | null;
  data: string;
  displayName: string;
  fromId: string | number | null;
} | null => {
  const record = payload as Record<string, unknown>;
  const callback = record.callback_query as Record<string, unknown> | undefined;
  const data = typeof callback?.data === "string" ? callback.data.trim() : "";
  const from = callback?.from as Record<string, unknown> | undefined;
  const message = callback?.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const chatId = chat?.id;
  const callbackId = callback?.id;

  if ((!chatId && chatId !== 0) || (!callbackId && callbackId !== 0) || !data) {
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
    callbackId: callbackId as string | number,
    chatId: chatId as string | number,
    chatType: stringField(chat?.type) ?? null,
    data,
    displayName,
    fromId: (from?.id as string | number | null | undefined) ?? null
  };
};

const callbackMessageText = (data: string): string | null => {
  const match = data.match(/^(approve|deny):([0-9a-f-]{6,80})$/i);

  if (!match) {
    return null;
  }

  return `${match[1]?.toLowerCase()} ${match[2]?.slice(-6)}`;
};

const stringField = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

import { auditLog } from "../audit-log/auditLogService.js";

export type TelegramSendResult = {
  ok: boolean;
  skipped?: boolean;
};

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramReplyMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export const telegramService = {
  authorizeWebhook(secret: string | undefined): boolean {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    return !expected || secret === expected;
  },

  isOwnerUser(userId: string | number | null | undefined): boolean {
    const allowed = new Set(
      (process.env.TELEGRAM_OWNER_USER_ID ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    );

    if (allowed.size === 0) {
      return false;
    }

    return allowed.has(String(userId ?? ""));
  },

  approvalReplyMarkup(confirmationId: string): TelegramReplyMarkup {
    const tail = confirmationId.slice(-6);
    return {
      inline_keyboard: [
        [
          {
            text: `Approve ${tail}`,
            callback_data: `approve:${confirmationId}`
          },
          {
            text: `Deny ${tail}`,
            callback_data: `deny:${confirmationId}`
          }
        ]
      ]
    };
  },

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string
  ): Promise<TelegramSendResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

    if (!token) {
      return { ok: false, skipped: true };
    }

    const response = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/answerCallbackQuery`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text: truncateTelegram(text).slice(0, 200) } : {})
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Telegram answerCallbackQuery failed with ${response.status}: ${detail}`
      );
    }

    return { ok: true };
  },

  async sendMessage(
    chatId: string,
    body: string,
    options: { replyMarkup?: TelegramReplyMarkup } = {}
  ): Promise<TelegramSendResult> {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

    if (!token) {
      await auditLog.log({
        event_type: "telegram.message_skipped",
        severity: "warn",
        payload: {
          reason: "missing_bot_token",
          chat_id_tail: chatId.slice(-6)
        }
      });
      return { ok: false, skipped: true };
    }

    const response = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          disable_web_page_preview: true,
          text: truncateTelegram(body),
          ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Telegram sendMessage failed with ${response.status}: ${detail}`);
    }

    return { ok: true };
  }
};

const truncateTelegram = (value: string): string => {
  return value.length > 3900 ? `${value.slice(0, 3897)}...` : value;
};

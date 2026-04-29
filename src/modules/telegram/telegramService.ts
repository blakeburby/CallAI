import { auditLog } from "../audit-log/auditLogService.js";

export type TelegramSendResult = {
  ok: boolean;
  skipped?: boolean;
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

  async sendMessage(chatId: string, body: string): Promise<TelegramSendResult> {
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
          text: truncateTelegram(body)
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

import { logger } from "../../utils/logger.js";

type SendSmsInput = {
  to: string;
  body: string;
};

type SmsConfigSummary = {
  enabled: boolean;
  ownerPhoneTail: string | null;
  fromNumberTail: string | null;
};

export const smsService = {
  isConfigured(): boolean {
    return Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM_NUMBER &&
        process.env.OWNER_PHONE_NUMBER
    );
  },

  configSummary(): SmsConfigSummary {
    return {
      enabled: smsService.isConfigured(),
      ownerPhoneTail: phoneTail(process.env.OWNER_PHONE_NUMBER),
      fromNumberTail: phoneTail(process.env.TWILIO_FROM_NUMBER)
    };
  },

  normalizePhone(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }

    const trimmed = value.trim();

    if (trimmed.startsWith("+")) {
      return `+${trimmed.slice(1).replace(/\D/g, "")}`;
    }

    const digits = trimmed.replace(/\D/g, "");

    if (digits.length === 10) {
      return `+1${digits}`;
    }

    if (digits.length > 0) {
      return `+${digits}`;
    }

    return "";
  },

  isOwnerPhone(value: unknown): boolean {
    const owner = smsService.normalizePhone(process.env.OWNER_PHONE_NUMBER);
    return Boolean(owner && smsService.normalizePhone(value) === owner);
  },

  twiml(message: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      message ? `<Message>${escapeXml(message)}</Message>` : "",
      "</Response>"
    ].join("");
  },

  async sendOwnerMessage(body: string): Promise<void> {
    const owner = smsService.normalizePhone(process.env.OWNER_PHONE_NUMBER);

    if (!owner) {
      return;
    }

    await smsService.sendSms({
      to: owner,
      body
    });
  },

  async sendSms(input: SendSmsInput): Promise<void> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = smsService.normalizePhone(process.env.TWILIO_FROM_NUMBER);
    const to = smsService.normalizePhone(input.to);

    if (!accountSid || !authToken || !from || !to) {
      logger.warn("SMS not sent: missing Twilio configuration or invalid phone number", {
        hasAccountSid: Boolean(accountSid),
        hasAuthToken: Boolean(authToken),
        hasFrom: Boolean(from),
        hasTo: Boolean(to)
      });
      return;
    }

    const params = new URLSearchParams({
      Body: truncateSms(input.body),
      From: from,
      To: to
    });
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString(
      "base64"
    );
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        accountSid
      )}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params,
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Twilio SMS failed with ${response.status}: ${detail}`);
    }
  }
};

const phoneTail = (value: string | undefined): string | null => {
  const normalized = smsService.normalizePhone(value);
  return normalized ? normalized.slice(-4) : null;
};

const truncateSms = (value: string): string => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1197)}...` : trimmed;
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

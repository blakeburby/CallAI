import { createHmac, timingSafeEqual } from "node:crypto";
import { database } from "../../services/dbService.js";
import { auditLog } from "../audit-log/auditLogService.js";
import type {
  AuditEventRecord,
  SmsConfigSummary,
  SmsDeliveryState,
  SmsHealthData,
  SmsHealthMessage,
  SmsMessageRecord,
  SmsVerificationState,
  SmsWebhookAuthMode
} from "../../types/operator.js";

type SendSmsInput = {
  to: string;
  body: string;
};

type SmsWebhookAuthInput = {
  params: Record<string, unknown>;
  signature?: string;
  suppliedSecret?: string;
  url: string;
};

type SmsWebhookAuthResult = {
  authorized: boolean;
  reason: string;
};

export type SmsSendResult = {
  sid: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  to: string | null;
  from: string | null;
  dateCreated: string | null;
  dateUpdated: string | null;
};

type TwilioMessageResource = SmsSendResult & {
  body: string | null;
  direction: string | null;
};

type CachedSmsHealth = {
  data: SmsHealthData;
  expiresAt: number;
};

const SMS_HEALTH_CACHE_TTL_MS = 30_000;
let cachedSmsHealth: CachedSmsHealth | null = null;

export const smsService = {
  isConfigured(): boolean {
    return Boolean(
      envValue("TWILIO_ACCOUNT_SID") &&
        envValue("TWILIO_AUTH_TOKEN") &&
        envValue("TWILIO_FROM_NUMBER") &&
        envValue("OWNER_PHONE_NUMBER")
    );
  },

  configSummary(): SmsConfigSummary {
    return {
      enabled: smsService.isConfigured(),
      ownerPhoneTail: phoneTail(envValue("OWNER_PHONE_NUMBER")),
      fromNumberTail: phoneTail(envValue("TWILIO_FROM_NUMBER"))
    };
  },

  webhookAuthMode(): SmsWebhookAuthMode {
    const hasSecret = Boolean(envValue("SMS_WEBHOOK_SECRET"));
    const hasTwilioSignature = Boolean(envValue("TWILIO_AUTH_TOKEN"));

    if (hasSecret && hasTwilioSignature) {
      return "mixed";
    }

    if (hasSecret) {
      return "query_secret";
    }

    if (hasTwilioSignature) {
      return "twilio_signature";
    }

    return "unknown";
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
    const owner = smsService.normalizePhone(envValue("OWNER_PHONE_NUMBER"));
    return Boolean(owner && smsService.normalizePhone(value) === owner);
  },

  authorizeWebhook(input: SmsWebhookAuthInput): SmsWebhookAuthResult {
    const configuredSecret = envValue("SMS_WEBHOOK_SECRET");
    const suppliedSecret = input.suppliedSecret ?? "";

    if (configuredSecret && suppliedSecret === configuredSecret) {
      return { authorized: true, reason: "query_secret" };
    }

    if (smsService.isValidTwilioSignature(input)) {
      return { authorized: true, reason: "twilio_signature" };
    }

    if (!configuredSecret && !envValue("TWILIO_AUTH_TOKEN")) {
      return { authorized: true, reason: "local_unprotected" };
    }

    if (configuredSecret && suppliedSecret !== configuredSecret) {
      return { authorized: false, reason: "missing_or_invalid_secret" };
    }

    return { authorized: false, reason: "missing_or_invalid_twilio_signature" };
  },

  isValidTwilioSignature(input: SmsWebhookAuthInput): boolean {
    const authToken = envValue("TWILIO_AUTH_TOKEN");
    const signature = input.signature;

    if (!authToken || !signature) {
      return false;
    }

    const signed = Object.keys(input.params)
      .sort()
      .reduce((accumulator, key) => {
        const value = input.params[key];
        const normalized = Array.isArray(value) ? value.join("") : String(value ?? "");
        return `${accumulator}${key}${normalized}`;
      }, input.url);

    const expected = createHmac("sha1", authToken).update(signed).digest("base64");
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);

    return (
      expectedBuffer.length === signatureBuffer.length &&
      timingSafeEqual(expectedBuffer, signatureBuffer)
    );
  },

  twiml(message: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      message ? `<Message>${escapeXml(message)}</Message>` : "",
      "</Response>"
    ].join("");
  },

  invalidateHealthCache(): void {
    cachedSmsHealth = null;
  },

  async sendOwnerMessage(body: string): Promise<SmsSendResult | null> {
    const owner = smsService.normalizePhone(envValue("OWNER_PHONE_NUMBER"));

    if (!owner) {
      return null;
    }

    const existingConversation = await database.findSmsConversationByPhone(owner);

    if (existingConversation?.status === "stopped") {
      return null;
    }

    const conversation =
      existingConversation ??
      (await database.upsertSmsConversation({
        phone_e164: owner,
        status: "active"
      }));
    const result = await smsService.sendSms({
      to: owner,
      body
    });

    await database.appendSmsMessage({
      conversation_id: conversation.id,
      role: "assistant",
      body,
      provider_message_sid: result.sid,
      payload: {
        direction: "outbound",
        from_tail: phoneTail(result.from),
        to_tail: phoneTail(result.to),
        twilio_error_code: result.errorCode,
        twilio_error_message: result.errorMessage,
        twilio_status: result.status
      }
    });

    smsService.invalidateHealthCache();
    return result;
  },

  async sendSms(input: SendSmsInput): Promise<SmsSendResult> {
    const accountSid = envValue("TWILIO_ACCOUNT_SID");
    const authToken = envValue("TWILIO_AUTH_TOKEN");
    const from = smsService.normalizePhone(envValue("TWILIO_FROM_NUMBER"));
    const to = smsService.normalizePhone(input.to);

    if (!accountSid || !authToken || !from || !to) {
      throw new Error("Twilio SMS is not fully configured.");
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

    const payload = (await response.json()) as Record<string, unknown>;
    smsService.invalidateHealthCache();

    return {
      sid: stringField(payload.sid),
      status: stringField(payload.status),
      errorCode: stringField(payload.error_code),
      errorMessage: stringField(payload.error_message),
      to: stringField(payload.to),
      from: stringField(payload.from),
      dateCreated: stringField(payload.date_created),
      dateUpdated: stringField(payload.date_updated)
    };
  },

  async getHealth(options: { bypassCache?: boolean } = {}): Promise<SmsHealthData> {
    if (
      !options.bypassCache &&
      cachedSmsHealth &&
      cachedSmsHealth.expiresAt > Date.now()
    ) {
      return cachedSmsHealth.data;
    }

    const configured = smsService.isConfigured();
    const summary = smsService.configSummary();
    const authMode = smsService.webhookAuthMode();
    const ownerPhone = smsService.normalizePhone(envValue("OWNER_PHONE_NUMBER"));
    const [events, conversation] = await Promise.all([
      database.listAuditEvents({ limit: 160 }),
      ownerPhone ? database.findSmsConversationByPhone(ownerPhone) : Promise.resolve(null)
    ]);
    const messages = conversation
      ? await database.listSmsMessages(conversation.id, 16)
      : [];
    const outboundSids = unique(
      [
        ...messages
          .filter((message) => message.role !== "user")
          .map((message) => message.provider_message_sid)
          .filter((value): value is string => Boolean(value)),
        ...events
          .filter((event) => event.event_type === "sms.outbound_sent")
          .map((event) => stringField(event.payload.message_sid))
          .filter((value): value is string => Boolean(value))
      ].slice(0, 5)
    );
    const twilioRecords = new Map<string, TwilioMessageResource>();

    if (configured) {
      const lookedUp = await Promise.all(
        outboundSids.map(async (sid) => {
          const record = await fetchTwilioMessage(sid);
          return record ? ([sid, record] as const) : null;
        })
      );

      lookedUp.forEach((entry) => {
        if (entry) {
          twilioRecords.set(entry[0], entry[1]);
        }
      });
    }

    const recentMessages = buildRecentMessages(messages, twilioRecords);
    const recentFailures = buildRecentFailures(events, recentMessages);
    const inboundEvent = events.find((event) => event.event_type === "sms.inbound_received");
    const inboundRejectedEvent = events.find(
      (event) => event.event_type === "sms.inbound_rejected"
    );
    const outboundEvent = events.find((event) => event.event_type === "sms.outbound_sent");
    const latestOutbound =
      recentMessages.find(
        (message) =>
          message.direction === "outbound" &&
          (message.sid || message.status || message.errorCode)
      ) ?? recentMessages.find((message) => message.direction === "outbound");
    const lastError =
      recentFailures.find((message) => message.direction === "outbound") ??
      recentFailures[0] ??
      null;
    const verificationState: SmsVerificationState = "unknown";
    const deliveryState = classifyDeliveryState(
      latestOutbound?.status ?? null,
      lastError?.errorCode ?? latestOutbound?.errorCode ?? null,
      configured
    );

    const data: SmsHealthData = {
      summary: {
        ...summary,
        configured,
        webhookAuthMode: authMode,
        verificationState,
        deliveryState,
        lastInboundAt:
          inboundEvent?.created_at ??
          messages
            .slice()
            .reverse()
            .find((message) => message.role === "user")?.created_at ??
          null,
        lastOutboundAt: latestOutbound?.createdAt ?? outboundEvent?.created_at ?? null,
        lastOutboundStatus:
          latestOutbound?.status ??
          stringField(outboundEvent?.payload.twilio_status) ??
          null,
        lastErrorCode:
          lastError?.errorCode ??
          latestOutbound?.errorCode ??
          stringField(outboundEvent?.payload.twilio_error_code) ??
          null,
        lastErrorMessage:
          lastError?.errorMessage ??
          latestOutbound?.errorMessage ??
          stringField(outboundEvent?.payload.twilio_error_message) ??
          null,
        attention: buildAttention({
          configured,
          authMode,
          deliveryState,
          inboundRejectedEvent,
          lastError,
          verificationState
        })
      },
      verification: {
        state: verificationState,
        source: configured ? "manual_console_required" : "not_configured",
        detail: configured
          ? "Twilio toll-free verification status is not reliably queryable from the current server path. Check Twilio Console for the live approval state."
          : "Twilio SMS is not fully configured in the environment yet.",
        checkedAt: new Date().toISOString()
      },
      webhook: {
        authMode,
        querySecretConfigured: Boolean(envValue("SMS_WEBHOOK_SECRET")),
        twilioSignatureConfigured: Boolean(envValue("TWILIO_AUTH_TOKEN")),
        ownerPhoneTail: summary.ownerPhoneTail,
        fromNumberTail: summary.fromNumberTail
      },
      recentMessages,
      recentFailures
    };

    cachedSmsHealth = {
      data,
      expiresAt: Date.now() + SMS_HEALTH_CACHE_TTL_MS
    };

    return data;
  }
};

const phoneTail = (value: string | undefined | null): string | null => {
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

const envValue = (name: string): string | undefined => {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : undefined;
};

const stringField = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length ? value.trim() : null;

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const previewBody = (value: string): string => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
};

const buildRecentMessages = (
  messages: SmsMessageRecord[],
  twilioRecords: Map<string, TwilioMessageResource>
): SmsHealthMessage[] => {
  return messages
    .slice()
    .reverse()
    .map((message) => {
      const payload = message.payload ?? {};
      const liveRecord = message.provider_message_sid
        ? twilioRecords.get(message.provider_message_sid)
        : null;
      const direction: SmsHealthMessage["direction"] =
        message.role === "user" ? "inbound" : "outbound";

      return {
        sid: message.provider_message_sid,
        direction,
        role: message.role,
        bodyPreview: previewBody(message.body),
        createdAt: message.created_at,
        status:
          liveRecord?.status ??
          stringField(payload.twilio_status) ??
          (direction === "inbound" ? "received" : null),
        errorCode:
          liveRecord?.errorCode ?? stringField(payload.twilio_error_code) ?? null,
        errorMessage:
          liveRecord?.errorMessage ??
          stringField(payload.twilio_error_message) ??
          null,
        source: liveRecord ? ("twilio_api" as const) : ("conversation" as const)
      };
    })
    .slice(0, 10);
};

const buildRecentFailures = (
  events: AuditEventRecord[],
  recentMessages: SmsHealthMessage[]
): SmsHealthMessage[] => {
  const failures = recentMessages.filter((message) =>
    isFailureStatus(message.status, message.errorCode)
  );

  events
    .filter((event) =>
      ["sms.notification_failed", "sms.inbound_rejected"].includes(event.event_type)
    )
    .slice(0, 6)
    .forEach((event) => {
      failures.push({
        sid: stringField(event.payload.message_sid),
        direction:
          event.event_type === "sms.inbound_rejected" ? "inbound" : "outbound",
        role: event.event_type === "sms.inbound_rejected" ? "user" : "system",
        bodyPreview:
          event.event_type === "sms.inbound_rejected"
            ? `Inbound rejected: ${stringField(event.payload.reason) ?? "unknown"}`
            : `Notification failed: ${
                stringField(event.payload.source_event_type) ?? "unknown"
              }`,
        createdAt: event.created_at,
        status: stringField(event.payload.twilio_status) ?? "failed",
        errorCode: stringField(event.payload.twilio_error_code),
        errorMessage:
          stringField(event.payload.twilio_error_message) ??
          stringField(event.payload.error),
        source: "audit"
      });
    });

  return failures
    .sort((left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
    )
    .slice(0, 8);
};

const classifyDeliveryState = (
  status: string | null,
  errorCode: string | null,
  configured: boolean
): SmsDeliveryState => {
  if (!configured) {
    return "unknown";
  }

  if (errorCode === "30032") {
    return "blocked";
  }

  const normalized = (status ?? "").toLowerCase();

  if (!normalized) {
    return "unknown";
  }

  if (["failed", "undelivered", "canceled"].includes(normalized)) {
    return "blocked";
  }

  if (["queued", "accepted", "sending", "scheduled"].includes(normalized)) {
    return "degraded";
  }

  if (["sent", "delivered", "received", "read"].includes(normalized)) {
    return "healthy";
  }

  return "unknown";
};

const isFailureStatus = (
  status: string | null,
  errorCode: string | null
): boolean => {
  if (errorCode) {
    return true;
  }

  return ["failed", "undelivered", "canceled"].includes(
    (status ?? "").toLowerCase()
  );
};

const buildAttention = (input: {
  configured: boolean;
  authMode: SmsWebhookAuthMode;
  deliveryState: SmsDeliveryState;
  inboundRejectedEvent: AuditEventRecord | undefined;
  lastError: SmsHealthMessage | null;
  verificationState: SmsVerificationState;
}): string[] => {
  const items: string[] = [];

  if (!input.configured) {
    items.push("Twilio env vars are incomplete, so SMS control is not fully active.");
    return items;
  }

  if (input.verificationState === "unknown") {
    items.push("Twilio verification status needs a manual console check.");
  }

  if (input.authMode === "unknown") {
    items.push("Inbound webhook auth is not configured.");
  }

  if (input.inboundRejectedEvent) {
    items.push(
      `Recent inbound text was rejected by webhook auth: ${
        stringField(input.inboundRejectedEvent.payload.reason) ?? "unknown reason"
      }.`
    );
  }

  if (input.lastError?.errorCode === "30032") {
    items.push(
      "Carrier or toll-free compliance is blocking delivery (Twilio 30032)."
    );
  } else if (input.deliveryState === "blocked" && input.lastError?.errorMessage) {
    items.push(`Recent SMS delivery failed: ${input.lastError.errorMessage}`);
  } else if (input.deliveryState === "degraded") {
    items.push("Recent outbound SMS is still queued or pending carrier delivery.");
  }

  return items;
};

const fetchTwilioMessage = async (
  sid: string
): Promise<TwilioMessageResource | null> => {
  const accountSid = envValue("TWILIO_ACCOUNT_SID");
  const authToken = envValue("TWILIO_AUTH_TOKEN");

  if (!accountSid || !authToken || !sid) {
    return null;
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      accountSid
    )}/Messages/${encodeURIComponent(sid)}.json`,
    {
      headers: {
        Authorization: `Basic ${credentials}`
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const record: TwilioMessageResource = {
    sid: stringField(payload.sid),
    status: stringField(payload.status),
    errorCode: stringField(payload.error_code),
    errorMessage: stringField(payload.error_message),
    to: stringField(payload.to),
    from: stringField(payload.from),
    dateCreated: stringField(payload.date_created),
    dateUpdated: stringField(payload.date_updated),
    body: stringField(payload.body),
    direction: stringField(payload.direction)
  };

  await auditLog
    .log({
      event_type: "sms.status_checked",
      payload: {
        checked_at: new Date().toISOString(),
        message_sid: record.sid,
        twilio_error_code: record.errorCode,
        twilio_error_message: record.errorMessage,
        twilio_status: record.status
      }
    })
    .catch(() => undefined);

  return record;
};

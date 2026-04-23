import { Router, type Request } from "express";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { smsChatService } from "../modules/sms/smsChatService.js";
import { smsService } from "../modules/sms/smsService.js";

export const smsRouter = Router();

smsRouter.post("/sms/inbound", async (request, response) => {
  try {
    const from = smsService.normalizePhone(request.body?.From);
    const body = String(request.body?.Body ?? "").trim();
    const messageSid =
      typeof request.body?.MessageSid === "string" ? request.body.MessageSid : null;
    const auth = smsService.authorizeWebhook({
      url: publicRequestUrl(request),
      params: request.body as Record<string, unknown>,
      signature: request.get("x-twilio-signature") ?? undefined,
      suppliedSecret: String(request.query.secret ?? "")
    });

    if (!auth.authorized) {
      await auditLog.log({
        event_type: "sms.inbound_rejected",
        severity: "warn",
        payload: {
          reason: auth.reason,
          from_tail: from ? from.slice(-4) : null,
          message_sid: messageSid
        }
      });
      response.type("text/xml").status(403).send(smsService.twiml(""));
      return;
    }

    if (!smsService.isOwnerPhone(from)) {
      await auditLog.log({
        event_type: "sms.inbound_rejected",
        severity: "warn",
        payload: {
          reason: "non_owner_phone",
          from_tail: from ? from.slice(-4) : null,
          message_sid: messageSid
        }
      });
      response.type("text/xml").send(smsService.twiml("Not authorized."));
      return;
    }

    if (!body) {
      await auditLog.log({
        event_type: "sms.inbound_rejected",
        severity: "warn",
        payload: {
          reason: "empty_body",
          from_tail: from.slice(-4),
          message_sid: messageSid
        }
      });
      response
        .type("text/xml")
        .send(smsService.twiml("Send Jarvis a message or developer task."));
      return;
    }

    await auditLog.log({
      event_type: "sms.inbound_received",
      payload: {
        auth_path: auth.reason,
        from_tail: from.slice(-4),
        message_sid: messageSid
      }
    });
    smsService.invalidateHealthCache();

    const reply = await smsChatService.handleInbound({
      from,
      body,
      messageSid
    });

    response.type("text/xml").send(smsService.twiml(reply));
  } catch (error) {
    await auditLog.log({
      event_type: "sms.handler_error",
      severity: "error",
      payload: {
        error: error instanceof Error ? error.message : String(error)
      }
    }).catch(() => undefined);
    response
      .type("text/xml")
      .status(200)
      .send(
        smsService.twiml(
          "I'm online, but I hit an issue handling that text. Try again in a moment."
        )
      );
  }
});

const publicRequestUrl = (request: Request): string => {
  const proto = String(request.headers["x-forwarded-proto"] ?? request.protocol)
    .split(",")[0]
    ?.trim();
  const host = request.get("host") ?? "localhost";
  return `${proto || "https"}://${host}${request.originalUrl}`;
};

import { Router } from "express";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { taskService } from "../modules/execution-engine/taskService.js";
import { smsService } from "../modules/sms/smsService.js";

export const smsRouter = Router();

smsRouter.post("/sms/inbound", async (request, response, next) => {
  try {
    const configuredSecret = process.env.SMS_WEBHOOK_SECRET;
    const suppliedSecret = String(request.query.secret ?? "");

    if (configuredSecret && suppliedSecret !== configuredSecret) {
      response.type("text/xml").status(403).send(smsService.twiml(""));
      return;
    }

    const from = smsService.normalizePhone(request.body?.From);
    const body = String(request.body?.Body ?? "").trim();
    const messageSid =
      typeof request.body?.MessageSid === "string" ? request.body.MessageSid : null;

    if (!smsService.isOwnerPhone(from)) {
      await auditLog.log({
        event_type: "sms.inbound_rejected",
        severity: "warn",
        payload: {
          from_tail: from ? from.slice(-4) : null,
          message_sid: messageSid
        }
      });
      response.type("text/xml").send(smsService.twiml("Not authorized."));
      return;
    }

    if (!body) {
      response
        .type("text/xml")
        .send(smsService.twiml("Send a CallAI task in plain English."));
      return;
    }

    const task = await taskService.createFromUtterance({
      utterance: body,
      source: "sms"
    });

    await auditLog.log({
      task_id: task.task_id,
      event_type: "sms.task_created",
      payload: {
        from_tail: from.slice(-4),
        message_sid: messageSid,
        status: task.status
      }
    });

    const reply = task.needs_confirmation
      ? `CallAI needs confirmation for ${task.interpreted_task.title}. Task ${task.task_id.slice(-6)}.`
      : `Queued: ${task.interpreted_task.title}. Task ${task.task_id.slice(-6)}.`;

    response.type("text/xml").send(smsService.twiml(reply));
  } catch (error) {
    next(error);
  }
});

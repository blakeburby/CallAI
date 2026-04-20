import { Router } from "express";
import { logger } from "../utils/logger.js";

export const webhookRouter = Router();

webhookRouter.post("/vapi/webhook", (request, response) => {
  const configuredSecret = process.env.VAPI_WEBHOOK_SECRET;
  const suppliedSecret =
    request.header("x-vapi-secret") ||
    request.header("x-webhook-secret") ||
    request.header("authorization")?.replace(/^Bearer\s+/i, "");

  if (configuredSecret && suppliedSecret !== configuredSecret) {
    logger.warn("Rejected Vapi webhook with invalid secret");
    response.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  logger.info("Received Vapi webhook", {
    headers: {
      "x-vapi-event": request.header("x-vapi-event"),
      "user-agent": request.header("user-agent")
    },
    body: request.body
  });

  response.json({ success: true });
});

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { voiceOrchestrator } from "../modules/voice-orchestrator/voiceOrchestrator.js";
import { logger } from "../utils/logger.js";

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests." }
});

export const webhookRouter = Router();

webhookRouter.post("/vapi/webhook", webhookLimiter, async (request, response, next) => {
  const configuredSecret = process.env.VAPI_WEBHOOK_SECRET;
  const suppliedSecret =
    request.header("x-vapi-secret") ||
    request.header("x-webhook-secret") ||
    request.header("authorization")?.replace(/^Bearer\s+/i, "");

  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    logger.warn("Rejected Vapi webhook with invalid secret");
    response.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  try {
    const result = await voiceOrchestrator.handleWebhook(request.body);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

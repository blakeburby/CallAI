import type { Request } from "express";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  createFrontendSessionCookie,
  frontendCookieOptions,
  frontendSessionCookieName,
  isFrontendAuthenticated
} from "../middleware/frontendSession.js";
import { smsService } from "../modules/sms/smsService.js";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, error: "Too many login attempts. Try again later." }
});

const DEFAULT_ASSISTANT_NAME = "CallAI Developer Operator";

export const frontendRouter = Router();

frontendRouter.post("/frontend/login", loginLimiter, (request, response) => {
  const passcode = process.env.FRONTEND_PASSCODE;
  const submitted = request.body?.passcode;

  if (!passcode) {
    response.status(503).json({
      success: false,
      error: "Frontend passcode is not configured."
    });
    return;
  }

  if (typeof submitted !== "string" || submitted !== passcode) {
    response.status(401).json({
      success: false,
      error: "Invalid passcode."
    });
    return;
  }

  const cookie = createFrontendSessionCookie(passcode);
  response.cookie(cookie.name, cookie.value, cookie.options);
  response.json({ success: true });
});

frontendRouter.post("/frontend/logout", (_request, response) => {
  response.clearCookie(frontendSessionCookieName, frontendCookieOptions());
  response.json({ success: true });
});

frontendRouter.get("/frontend/config", (request, response) => {
  if (!isFrontendAuthenticated(request)) {
    response.status(401).json({
      success: false,
      error: "Login required."
    });
    return;
  }

  const publicKey = process.env.VAPI_PUBLIC_KEY;

  if (!publicKey) {
    response.status(503).json({
      success: false,
      error: "Vapi public key is not configured."
    });
    return;
  }

  response.json({
    success: true,
    data: {
      assistantId: process.env.VAPI_ASSISTANT_ID,
      assistantName: process.env.VAPI_ASSISTANT_NAME || DEFAULT_ASSISTANT_NAME,
      backendUrl: getPublicOrigin(request),
      sms: smsService.configSummary(),
      vapiPublicKey: publicKey
    }
  });
});

const getPublicOrigin = (request: Request): string => {
  const proto = request.header("x-forwarded-proto") ?? request.protocol;
  return `${proto}://${request.get("host")}`;
};

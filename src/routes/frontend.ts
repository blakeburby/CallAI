import type { Request } from "express";
import { Router } from "express";
import {
  createFrontendSessionCookie,
  frontendCookieOptions,
  frontendSessionCookieName,
  isFrontendAuthenticated
} from "../middleware/frontendSession.js";
import { smsService } from "../modules/sms/smsService.js";

const ASSISTANT_ID = "fa6b7d3e-5fed-4137-acd9-87cef47e548a";
const ASSISTANT_NAME = "CallAI Developer Operator";

type FrontendConfig = {
  assistantId: string;
  assistantName: string;
  backendUrl: string;
  sms: ReturnType<typeof smsService.configSummary>;
  vapiPublicKey: string;
};

export const frontendRouter = Router();

frontendRouter.post("/frontend/login", (request, response) => {
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

frontendRouter.get("/frontend/bootstrap", (request, response) => {
  if (!isFrontendAuthenticated(request)) {
    response.json({
      success: true,
      data: {
        authenticated: false
      }
    });
    return;
  }

  const publicKey = process.env.VAPI_PUBLIC_KEY;

  if (!publicKey) {
    response.json({
      success: true,
      data: {
        authenticated: true,
        configError: "Vapi public key is not configured."
      }
    });
    return;
  }

  response.json({
    success: true,
    data: {
      authenticated: true,
      ...getFrontendConfig(request, publicKey)
    }
  });
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
    data: getFrontendConfig(request, publicKey)
  });
});

const getFrontendConfig = (
  request: Request,
  publicKey: string
): FrontendConfig => ({
  assistantId: process.env.VAPI_ASSISTANT_ID || ASSISTANT_ID,
  assistantName: process.env.VAPI_ASSISTANT_NAME || ASSISTANT_NAME,
  backendUrl: getPublicOrigin(request),
  sms: smsService.configSummary(),
  vapiPublicKey: publicKey
});

const getPublicOrigin = (request: Request): string => {
  const proto = request.header("x-forwarded-proto") ?? request.protocol;
  return `${proto}://${request.get("host")}`;
};

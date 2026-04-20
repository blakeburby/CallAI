import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { Router } from "express";

const ASSISTANT_ID = "fa6b7d3e-5fed-4137-acd9-87cef47e548a";
const ASSISTANT_NAME = "CallAI";
const SESSION_COOKIE = "callai_frontend_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

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

  if (typeof submitted !== "string" || !safeEqual(submitted, passcode)) {
    response.status(401).json({
      success: false,
      error: "Invalid passcode."
    });
    return;
  }

  response.cookie(SESSION_COOKIE, createSessionToken(passcode), {
    ...cookieOptions(),
    maxAge: SESSION_TTL_MS
  });
  response.json({ success: true });
});

frontendRouter.post("/frontend/logout", (_request, response) => {
  response.clearCookie(SESSION_COOKIE, cookieOptions());
  response.json({ success: true });
});

frontendRouter.get("/frontend/config", (request, response) => {
  if (!isAuthenticated(request)) {
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
      assistantId: ASSISTANT_ID,
      assistantName: ASSISTANT_NAME,
      backendUrl: getPublicOrigin(request),
      vapiPublicKey: publicKey
    }
  });
});

const isAuthenticated = (request: Request): boolean => {
  const passcode = process.env.FRONTEND_PASSCODE;
  const token = getSessionToken(request);

  if (!passcode || !token) {
    return false;
  }

  const [expiresAtRaw, nonce, signature] = token.split(".");
  const expiresAt = Number(expiresAtRaw);

  if (!expiresAt || !nonce || !signature || expiresAt <= Date.now()) {
    return false;
  }

  return safeEqual(signature, signSession(expiresAtRaw, nonce, passcode));
};

const createSessionToken = (passcode: string): string => {
  const expiresAt = String(Date.now() + SESSION_TTL_MS);
  const nonce = randomBytes(16).toString("base64url");

  return `${expiresAt}.${nonce}.${signSession(expiresAt, nonce, passcode)}`;
};

const signSession = (
  expiresAt: string,
  nonce: string,
  passcode: string
): string => {
  return createHmac("sha256", passcode)
    .update(`${expiresAt}.${nonce}`)
    .digest("base64url");
};

const getSessionToken = (request: Request): string | undefined => {
  const cookieHeader = request.header("cookie");

  if (!cookieHeader) {
    return undefined;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [name, ...value] = cookie.trim().split("=");

    if (name === SESSION_COOKIE) {
      return value.join("=");
    }
  }

  return undefined;
};

const cookieOptions = () => ({
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production"
});

const getPublicOrigin = (request: Request): string => {
  const proto = request.header("x-forwarded-proto") ?? request.protocol;
  return `${proto}://${request.get("host")}`;
};

const safeEqual = (value: string, expected: string): boolean => {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);

  if (valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(valueBuffer, expectedBuffer);
};

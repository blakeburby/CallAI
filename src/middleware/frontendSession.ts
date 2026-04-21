import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CookieOptions, NextFunction, Request, Response } from "express";

const SESSION_COOKIE = "callai_frontend_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export const requireFrontendSession = (
  request: Request,
  response: Response,
  next: NextFunction
): void => {
  if (!isFrontendAuthenticated(request)) {
    response.status(401).json({
      success: false,
      error: "Login required."
    });
    return;
  }

  next();
};

export const isFrontendAuthenticated = (request: Request): boolean => {
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

export const createFrontendSessionCookie = (
  passcode: string
): { name: string; value: string; options: CookieOptions } => {
  const expiresAt = String(Date.now() + SESSION_TTL_MS);
  const nonce = randomBytes(16).toString("base64url");

  return {
    name: SESSION_COOKIE,
    value: `${expiresAt}.${nonce}.${signSession(expiresAt, nonce, passcode)}`,
    options: {
      ...frontendCookieOptions(),
      maxAge: SESSION_TTL_MS
    }
  };
};

export const frontendCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production"
});

export const frontendSessionCookieName = SESSION_COOKIE;

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

const safeEqual = (value: string, expected: string): boolean => {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);

  if (valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(valueBuffer, expectedBuffer);
};

import type { NextFunction, Request, Response } from "express";

export const requireApiKey = (
  request: Request,
  response: Response,
  next: NextFunction
): void => {
  const configuredSecret = process.env.API_SECRET_KEY;
  const suppliedSecret = request.header("x-api-key");

  if (!configuredSecret || !suppliedSecret || suppliedSecret !== configuredSecret) {
    response.status(401).json({
      success: false,
      error: "Unauthorized",
      message: "I ran into an issue processing that request."
    });
    return;
  }

  next();
};

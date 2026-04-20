import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ZodError } from "zod";

export const validateBody =
  <T>(schema: ZodSchema<T>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({
        success: false,
        error: formatZodError(parsed.error),
        message: "I ran into an issue processing that request."
      });
      return;
    }

    request.body = parsed.data;
    next();
  };

const formatZodError = (error: ZodError): string => {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "body";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
};

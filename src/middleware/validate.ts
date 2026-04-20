import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ZodError } from "zod";
import {
  extractVapiToolCall,
  sendValidationError,
  setVapiToolLocals
} from "../utils/vapiTooling.js";

export const validateBody =
  <T>(schema: ZodSchema<T>, toolName?: string) =>
  (request: Request, response: Response, next: NextFunction): void => {
    const vapiToolCall = toolName
      ? extractVapiToolCall(request.body, toolName)
      : null;
    const body = vapiToolCall?.arguments ?? request.body;

    if (vapiToolCall) {
      setVapiToolLocals(response, vapiToolCall.id);
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      sendValidationError(response, formatZodError(parsed.error));
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

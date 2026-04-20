import type { Request, Response } from "express";
import { summarizeForVoice } from "../services/openaiService.js";
import { getSystemStatus } from "../services/tradingService.js";
import { logger } from "../utils/logger.js";

const ERROR_MESSAGE = "I ran into an issue processing that request.";

const sendToolError = (
  response: Response,
  error: unknown,
  toolName: string
): void => {
  const message = error instanceof Error ? error.message : "Unknown error";
  logger.error(`Tool execution failed: ${toolName}`, { error: message });

  response.status(500).json({
    success: false,
    error: message,
    message: ERROR_MESSAGE
  });
};

export const getStatus = async (
  _request: Request,
  response: Response
): Promise<void> => {
  try {
    const data = await getSystemStatus();
    const message = await summarizeForVoice("system_status", data);

    response.json({
      success: true,
      data,
      message
    });
  } catch (error) {
    sendToolError(response, error, "system_status");
  }
};

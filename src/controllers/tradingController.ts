import type { Request, Response } from "express";
import { summarizeForVoice } from "../services/openaiService.js";
import {
  getPositions,
  placeTrade,
  runScan
} from "../services/tradingService.js";
import { logger } from "../utils/logger.js";

const ERROR_MESSAGE = "I ran into an issue processing that request.";

type PlaceTradeBody = {
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  direction: "YES" | "NO";
  size: number;
};

type RunScanBody = {
  min_ev?: number;
};

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

export const runArbitrageScan = async (
  request: Request<object, object, RunScanBody>,
  response: Response
): Promise<void> => {
  try {
    const data = await runScan(request.body.min_ev);
    const message = await summarizeForVoice("run_arbitrage_scan", data);

    response.json({
      success: true,
      data,
      message
    });
  } catch (error) {
    sendToolError(response, error, "run_arbitrage_scan");
  }
};

export const getOpenPositions = async (
  _request: Request,
  response: Response
): Promise<void> => {
  try {
    const data = await getPositions();
    const message = await summarizeForVoice("get_open_positions", data);

    response.json({
      success: true,
      data,
      message
    });
  } catch (error) {
    sendToolError(response, error, "get_open_positions");
  }
};

export const executeTrade = async (
  request: Request<object, object, PlaceTradeBody>,
  response: Response
): Promise<void> => {
  try {
    const data = await placeTrade(
      request.body.asset,
      request.body.direction,
      request.body.size
    );
    const message = await summarizeForVoice("place_trade", data);

    response.json({
      success: true,
      data,
      message
    });
  } catch (error) {
    sendToolError(response, error, "place_trade");
  }
};

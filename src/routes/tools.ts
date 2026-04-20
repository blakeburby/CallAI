import { Router } from "express";
import { z } from "zod";
import {
  executeTrade,
  getOpenPositions,
  runArbitrageScan
} from "../controllers/tradingController.js";
import { getStatus } from "../controllers/systemController.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const emptyBodySchema = z.object({}).strict();

const runArbitrageScanSchema = z
  .object({
    min_ev: z.number().min(0).max(1).default(0.03)
  })
  .strict();

const placeTradeSchema = z
  .object({
    asset: z.enum(["BTC", "ETH", "SOL", "XRP"]),
    direction: z.enum(["YES", "NO"]),
    size: z.number().positive().max(0.05)
  })
  .strict();

export const toolsRouter = Router();

toolsRouter.use(requireApiKey);

toolsRouter.post(
  "/tools/run-arbitrage-scan",
  validateBody(runArbitrageScanSchema),
  runArbitrageScan
);

toolsRouter.post(
  "/tools/get-open-positions",
  validateBody(emptyBodySchema),
  getOpenPositions
);

toolsRouter.post(
  "/tools/place-trade",
  validateBody(placeTradeSchema),
  executeTrade
);

toolsRouter.post(
  "/tools/system-status",
  validateBody(emptyBodySchema),
  getStatus
);

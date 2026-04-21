import { Router } from "express";
import { z } from "zod";
import { startOutboundCall } from "../controllers/operatorController.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const outboundCallSchema = z
  .object({
    phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/),
    reason: z.string().min(3).max(1000),
    task_id: z.string().min(1).optional()
  })
  .strict();

export const voiceRouter = Router();

voiceRouter.post(
  "/voice/calls/outbound",
  requireApiKey,
  validateBody(outboundCallSchema),
  startOutboundCall
);

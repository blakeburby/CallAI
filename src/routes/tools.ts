import { Router } from "express";
import { z } from "zod";
import {
  approveAction,
  cancelTask,
  continueTask,
  createTask,
  getTaskStatus,
  sendProjectUpdate,
  startOutboundCall
} from "../controllers/operatorController.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

const createTaskSchema = z
  .object({
    utterance: z.string().min(3).max(5000),
    session_id: z.string().min(1).optional(),
    repo_hint: z.string().min(1).max(200).optional()
  })
  .strict();

const getTaskStatusSchema = z
  .object({
    task_id: z.string().min(1)
  })
  .strict();

const continueTaskSchema = z
  .object({
    task_id: z.string().min(1),
    instructions: z.string().min(1).max(5000).optional()
  })
  .strict();

const approveActionSchema = z
  .object({
    confirmation_id: z.string().min(1),
    decision: z.enum(["approved", "denied"])
  })
  .strict();

const cancelTaskSchema = z
  .object({
    task_id: z.string().min(1),
    reason: z.string().min(1).max(1000).optional()
  })
  .strict();

const sendProjectUpdateSchema = z
  .object({
    task_id: z.string().min(1).optional(),
    channel_hint: z.string().min(1).max(200).optional(),
    message: z.string().min(1).max(4000)
  })
  .strict();

const startOutboundCallSchema = z
  .object({
    phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/),
    reason: z.string().min(3).max(1000),
    task_id: z.string().min(1).optional()
  })
  .strict();

export const toolsRouter = Router();

toolsRouter.use("/tools", requireApiKey);

toolsRouter.post(
  "/tools/create-task",
  validateBody(createTaskSchema, "create_task"),
  createTask
);

toolsRouter.post(
  "/tools/get-task-status",
  validateBody(getTaskStatusSchema, "get_task_status"),
  getTaskStatus
);

toolsRouter.post(
  "/tools/continue-task",
  validateBody(continueTaskSchema, "continue_task"),
  continueTask
);

toolsRouter.post(
  "/tools/approve-action",
  validateBody(approveActionSchema, "approve_action"),
  approveAction
);

toolsRouter.post(
  "/tools/cancel-task",
  validateBody(cancelTaskSchema, "cancel_task"),
  cancelTask
);

toolsRouter.post(
  "/tools/send-project-update",
  validateBody(sendProjectUpdateSchema, "send_project_update"),
  sendProjectUpdate
);

toolsRouter.post(
  "/tools/start-outbound-call",
  validateBody(startOutboundCallSchema, "start_outbound_call"),
  startOutboundCall
);

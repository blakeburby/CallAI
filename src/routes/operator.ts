import { Router } from "express";
import { z } from "zod";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { taskService } from "../modules/execution-engine/taskService.js";
import { requireFrontendSession } from "../middleware/frontendSession.js";

const createTaskSchema = z.object({
  utterance: z.string().min(3).max(5000),
  repo_hint: z.string().min(1).max(200).optional()
});

const decisionSchema = z.object({
  decision: z.enum(["approved", "denied"])
});

const continueSchema = z.object({
  instructions: z.string().min(1).max(5000).optional()
});

const cancelSchema = z.object({
  reason: z.string().min(1).max(1000).optional()
});

export const operatorRouter = Router();

operatorRouter.use("/operator", requireFrontendSession);

operatorRouter.get("/operator/tasks", async (_request, response, next) => {
  try {
    const [tasks, confirmations] = await Promise.all([
      taskService.listTasks(),
      taskService.listPendingConfirmations()
    ]);

    response.json({
      success: true,
      data: {
        tasks,
        confirmations
      }
    });
  } catch (error) {
    next(error);
  }
});

operatorRouter.post("/operator/tasks", async (request, response, next) => {
  try {
    const body = createTaskSchema.parse(request.body);
    const data = await taskService.createFromUtterance({
      utterance: body.utterance,
      repoHint: body.repo_hint,
      source: "console"
    });

    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

operatorRouter.get("/operator/tasks/:taskId", async (request, response, next) => {
  try {
    const data = await taskService.getStatus(request.params.taskId);

    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

operatorRouter.post(
  "/operator/tasks/:taskId/continue",
  async (request, response, next) => {
    try {
      const body = continueSchema.parse(request.body);
      const data = await taskService.continueTask(
        request.params.taskId,
        body.instructions
      );

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.post(
  "/operator/tasks/:taskId/cancel",
  async (request, response, next) => {
    try {
      const body = cancelSchema.parse(request.body);
      const data = await taskService.cancelTask(request.params.taskId, body.reason);

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.get(
  "/operator/tasks/:taskId/events",
  async (request, response, next) => {
    try {
      const data = await auditLog.forTask(request.params.taskId, 80);

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.get(
  "/operator/confirmations",
  async (_request, response, next) => {
    try {
      const data = await taskService.listPendingConfirmations();

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

operatorRouter.post(
  "/operator/confirmations/:confirmationId",
  async (request, response, next) => {
    try {
      const body = decisionSchema.parse(request.body);
      const data = await taskService.approveAction(
        request.params.confirmationId,
        body.decision
      );

      response.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);

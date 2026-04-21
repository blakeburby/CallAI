import { Router } from "express";
import { z } from "zod";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { requireApiKey } from "../middleware/auth.js";

const heartbeatSchema = z.object({
  runner_id: z.string().min(1).max(200),
  active_run_ids: z.array(z.string().min(1)).max(100)
});

export const runnerRouter = Router();

runnerRouter.post("/runner/heartbeat", requireApiKey, async (request, response) => {
  const parsed = heartbeatSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({
      success: false,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ")
    });
    return;
  }

  await auditLog.log({
    event_type: "runner.heartbeat",
    payload: parsed.data
  });

  response.json({ success: true });
});

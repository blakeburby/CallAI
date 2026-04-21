import "dotenv/config";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { executionEngine } from "../modules/execution-engine/executionEngine.js";
import { database, isSupabaseConfigured } from "../services/dbService.js";
import { logger } from "../utils/logger.js";

const runnerId =
  process.env.RUNNER_ID ||
  `runner-${process.env.HOSTNAME || "local"}-${process.pid}`;
const pollIntervalMs = Number(process.env.RUNNER_POLL_INTERVAL_MS ?? 5000);

let stopping = false;

const main = async (): Promise<void> => {
  logger.info("CallAI agent runner starting", {
    runner_id: runnerId,
    supabase: isSupabaseConfigured() ? "configured" : "memory"
  });

  await auditLog.log({
    event_type: "runner.started",
    payload: {
      runner_id: runnerId
    }
  });

  while (!stopping) {
    try {
      const claimed = await database.claimNextQueuedTask("codex_local");

      if (!claimed) {
        await sleep(pollIntervalMs);
        continue;
      }

      const executor = executionEngine.chooseExecutor(claimed.task);
      const run =
        claimed.run.executor === executor
          ? claimed.run
          : await database.updateExecutionRun(claimed.run.id, { executor });

      await auditLog.log({
        task_id: claimed.task.id,
        run_id: run.id,
        event_type: "runner.claimed_task",
        payload: {
          runner_id: runnerId,
          executor
        }
      });

      await executionEngine.runTask(claimed.task, run);
    } catch (error) {
      logger.error("Runner loop error", {
        error: error instanceof Error ? error.message : String(error)
      });
      await sleep(pollIntervalMs);
    }
  }

  await auditLog.log({
    event_type: "runner.stopped",
    payload: {
      runner_id: runnerId
    }
  });
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

process.on("SIGINT", () => {
  stopping = true;
});

process.on("SIGTERM", () => {
  stopping = true;
});

void main().catch((error) => {
  logger.error("Runner crashed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});

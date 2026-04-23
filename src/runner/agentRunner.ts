import "dotenv/config";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { executionEngine } from "../modules/execution-engine/executionEngine.js";
import {
  checkDatabaseConnection,
  database,
  isDatabaseConfigured
} from "../services/dbService.js";
import type { RunnerTaskScope } from "../types/operator.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const runnerId =
  process.env.RUNNER_ID ||
  `runner-${process.env.HOSTNAME || "local"}-${process.pid}`;
const pollIntervalMs = Number(process.env.RUNNER_POLL_INTERVAL_MS ?? 5000);
const taskScope = parseTaskScope(process.env.RUNNER_TASK_SCOPE);
const desktopControlEnabled = isDesktopControlEnabled(runnerId);

let stopping = false;
let healthServer: Server | null = null;

const main = async (): Promise<void> => {
  logger.info("CallAI agent runner starting", {
    runner_id: runnerId,
    task_scope: taskScope,
    desktop_control: desktopControlEnabled ? "enabled" : "disabled",
    database: isDatabaseConfigured() ? "configured" : "memory"
  });

  healthServer = startHealthServer();
  await logPreflight();

  await auditLog.log({
    event_type: "runner.started",
    payload: {
      runner_id: runnerId,
      task_scope: taskScope
    }
  });

  while (!stopping) {
    try {
      const claimed = await database.claimNextQueuedTask("codex_local", taskScope, {
        allowDesktopControl: desktopControlEnabled
      });

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
          task_scope: taskScope,
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
      runner_id: runnerId,
      task_scope: taskScope,
      desktop_control: desktopControlEnabled
    }
  });

  healthServer?.close();
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const startHealthServer = (): Server | null => {
  if (process.env.RUNNER_DISABLE_HEALTH_SERVER === "true") {
    return null;
  }

  const configuredPort = process.env.RUNNER_HEALTH_PORT || process.env.PORT;

  if (!configuredPort) {
    return null;
  }

  const port = Number(configuredPort);

  if (!Number.isFinite(port) || port <= 0) {
    logger.warn("Runner health server disabled because port is invalid", {
      port: configuredPort
    });
    return null;
  }

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        runner_id: runnerId,
        task_scope: taskScope
      })
    );
  });

  server.on("error", (error) => {
    logger.error("Runner health server error", { error: error.message });
  });

  server.listen(port, () => {
    logger.info("Runner health server listening", { port });
  });

  return server;
};

const logPreflight = async (): Promise<void> => {
  const databaseHealth = await checkDatabaseConnection();
  const codexHealth = await checkCodexVersion();
  const payload = {
    runner_id: runnerId,
    database: databaseHealth,
    codex: codexHealth,
    workspace: {
      default_repo_owner: process.env.DEFAULT_REPO_OWNER || null,
      default_repo_name: process.env.DEFAULT_REPO_NAME || null,
      default_repo_path: process.env.DEFAULT_REPO_PATH || process.cwd(),
      task_scope: taskScope,
      desktop_control: desktopControlEnabled,
      code_execution_mode: process.env.CODEX_EXECUTION_MODE || "local"
    }
  };

  logger.info("Runner preflight complete", payload);
  await auditLog.log({
    event_type: "runner.preflight",
    severity: databaseHealth.ok && codexHealth.ok ? "info" : "warn",
    payload
  });
};

function parseTaskScope(value: string | undefined): RunnerTaskScope {
  if (value === "read_only" || value === "write" || value === "all") {
    return value;
  }

  return "all";
}

function isDesktopControlEnabled(id: string): boolean {
  if (process.env.RUNNER_ENABLE_DESKTOP_CONTROL === "true") {
    return true;
  }

  if (process.env.RUNNER_ENABLE_DESKTOP_CONTROL === "false") {
    return false;
  }

  return process.platform === "darwin" && id === "macbook-local-bridge";
}

const checkCodexVersion = async (): Promise<{
  ok: boolean;
  executable: string;
  version?: string;
  error?: string;
}> => {
  const executable = process.env.CODEX_EXECUTABLE || "codex";

  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: 10000
    });
    const version = (stdout || stderr).trim();
    return {
      ok: true,
      executable,
      version: version || "version output was empty"
    };
  } catch (error) {
    return {
      ok: false,
      executable,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

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

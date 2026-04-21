import { spawn } from "node:child_process";
import { auditLog } from "../audit-log/auditLogService.js";

type CodexDelegationInput = {
  runId: string;
  taskId: string;
  repoPath: string;
  prompt: string;
  branchName?: string;
  codexCloudEnvId?: string | null;
};

export const codexBridge = {
  async localExec(input: CodexDelegationInput): Promise<void> {
    const executable = process.env.CODEX_EXECUTABLE || "codex";
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--cd",
      input.repoPath,
      input.prompt
    ];

    await auditLog.log({
      task_id: input.taskId,
      run_id: input.runId,
      event_type: "codex.local_exec_started",
      payload: {
        executable,
        branch_name: input.branchName ?? null,
        repo_path: input.repoPath
      }
    });

    await runProcess({
      command: executable,
      args,
      cwd: input.repoPath,
      runId: input.runId,
      taskId: input.taskId,
      eventPrefix: "codex"
    });
  },

  async cloudExec(input: CodexDelegationInput): Promise<void> {
    if (!input.codexCloudEnvId) {
      throw new Error("Codex Cloud env id is not configured for this repo.");
    }

    const executable = process.env.CODEX_EXECUTABLE || "codex";
    const args = [
      "cloud",
      "exec",
      "--env",
      input.codexCloudEnvId,
      "--branch",
      input.branchName ?? "main",
      input.prompt
    ];

    await auditLog.log({
      task_id: input.taskId,
      run_id: input.runId,
      event_type: "codex.cloud_exec_started",
      payload: {
        executable,
        env_id: input.codexCloudEnvId,
        branch_name: input.branchName ?? null
      }
    });

    await runProcess({
      command: executable,
      args,
      cwd: input.repoPath,
      runId: input.runId,
      taskId: input.taskId,
      eventPrefix: "codex_cloud"
    });
  }
};

const runProcess = async (input: {
  command: string;
  args: string[];
  cwd: string;
  runId: string;
  taskId: string;
  eventPrefix: string;
}): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk: Buffer) => {
      void auditLog.log({
        task_id: input.taskId,
        run_id: input.runId,
        event_type: `${input.eventPrefix}.stdout`,
        payload: {
          text: chunk.toString("utf8").slice(0, 8000)
        }
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      void auditLog.log({
        task_id: input.taskId,
        run_id: input.runId,
        event_type: `${input.eventPrefix}.stderr`,
        severity: "warn",
        payload: {
          text: chunk.toString("utf8").slice(0, 8000)
        }
      });
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${input.command} exited with code ${code ?? "unknown"}.`));
    });
  });
};

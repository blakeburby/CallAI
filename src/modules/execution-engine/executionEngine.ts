import { auditLog } from "../audit-log/auditLogService.js";
import { codexBridge } from "../codex-bridge/codexBridge.js";
import { contextMemory } from "../context-memory/contextMemoryService.js";
import { chatConnector } from "../chat-connector/chatConnector.js";
import { smsNotifier } from "../sms/smsNotifier.js";
import { database } from "../../services/dbService.js";
import type {
  DeveloperTask,
  DeveloperTaskRecord,
  ExecutionRunRecord,
  ExecutorKind,
  RepoRecord
} from "../../types/operator.js";
import { gitService } from "./gitService.js";

export const executionEngine = {
  async runTask(
    task: DeveloperTaskRecord,
    run: ExecutionRunRecord
  ): Promise<void> {
    const structured = task.structured_request as DeveloperTask;
    const repo = task.repo_id
      ? await database.findRepoById(task.repo_id)
      : (await contextMemory.resolveRepo(structured)).repo;
    const runnerRepo = repo ? repoForCurrentRunner(repo) : null;

    if (!runnerRepo && structured.action !== "send_chat_message") {
      await blockTask(task, run, "No repo target was resolved for this task.");
      return;
    }

    try {
      await auditLog.log({
        task_id: task.id,
        run_id: run.id,
        event_type: "run.started",
        payload: {
          executor: run.executor,
          repo: runnerRepo ? contextMemory.describeRepo(runnerRepo) : null,
          repo_path: runnerRepo?.local_path ?? null
        }
      });

      const summary = await executeByAction(task, run, structured, runnerRepo);

      await database.updateExecutionRun(run.id, {
        status: "succeeded",
        finished_at: new Date().toISOString(),
        final_summary: summary
      });
      await database.updateTask(task.id, { status: "succeeded" });
      await auditLog.log({
        task_id: task.id,
        run_id: run.id,
        event_type: "run.succeeded",
        payload: { summary }
      });
      void smsNotifier.taskFinished(task, "succeeded", summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isRunnerConfigurationIssue(message)) {
        await blockTask(task, run, message);
        return;
      }

      await database.updateExecutionRun(run.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        final_summary: message
      });
      await database.updateTask(task.id, { status: "failed" });
      await auditLog.log({
        task_id: task.id,
        run_id: run.id,
        event_type: "run.failed",
        severity: "error",
        payload: { error: message }
      });
      void smsNotifier.taskFinished(task, "failed", message);
    }
  },

  chooseExecutor(task: DeveloperTaskRecord): ExecutorKind {
    const structured = task.structured_request as DeveloperTask;

    if (structured.action === "send_chat_message") {
      return "chat";
    }

    if (
      structured.action === "inspect_repo" ||
      structured.action === "summarize_project" ||
      structured.action === "query_logs" ||
      structured.action === "run_tests"
    ) {
      return "direct";
    }

    if (process.env.CODEX_EXECUTION_MODE === "cloud") {
      return "codex_cloud";
    }

    return "codex_local";
  }
};

const executeByAction = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask,
  repo: RepoRecord | null
): Promise<string> => {
  if (structured.action === "send_chat_message") {
    const result = await chatConnector.sendProjectUpdate({
      taskId: task.id,
      channelHint: structured.chatTarget,
      message: structured.instructions
    });

    return result.delivered
      ? `Project update sent to ${result.channel}.`
      : `Project update was recorded in the audit log for ${result.channel}.`;
  }

  if (!repo?.local_path) {
    throw new Error("Repo has no local_path configured for runner execution.");
  }

  await gitService.ensureRepo(
    repo.local_path,
    repo.clone_url,
    repo.default_branch
  );

  if (
    structured.action === "inspect_repo" ||
    structured.action === "summarize_project"
  ) {
    const [branch, status, files] = await Promise.all([
      gitService.currentBranch(repo.local_path),
      gitService.statusShort(repo.local_path),
      gitService.recentFiles(repo.local_path)
    ]);
    const summary = {
      branch,
      dirty: Boolean(status),
      status: status || "clean",
      sample_files: files.slice(0, 20)
    };

    await auditLog.log({
      task_id: task.id,
      run_id: run.id,
      event_type: "repo.inspected",
      payload: summary
    });

    return `Inspected ${repo.owner}/${repo.name} on ${branch}; working tree is ${summary.dirty ? "dirty" : "clean"}.`;
  }

  if (structured.action === "query_logs") {
    await auditLog.log({
      task_id: task.id,
      run_id: run.id,
      event_type: "logs.query_requested",
      payload: {
        instructions: structured.instructions
      }
    });

    return "Log query recorded; connect a deployment log adapter to fetch provider logs automatically.";
  }

  if (structured.action === "run_tests") {
    const result = await gitService.runConfiguredTests(repo.local_path);

    if (!result) {
      return "No package test or build script was found.";
    }

    await auditLog.log({
      task_id: task.id,
      run_id: run.id,
      event_type: "tests.completed",
      severity: result.code === 0 ? "info" : "error",
      payload: {
        code: result.code,
        stdout: result.stdout.slice(-12000),
        stderr: result.stderr.slice(-12000)
      }
    });

    if (result.code !== 0) {
      throw new Error("Configured tests failed.");
    }

    return "Configured tests completed successfully.";
  }

  const branchName = branchForTask(task);
  await gitService.createBranch(repo.local_path, branchName);
  await database.updateExecutionRun(run.id, { branch_name: branchName });
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "git.branch_created",
    payload: { branch_name: branchName }
  });

  const prompt = buildCodexPrompt(structured, branchName);

  if (run.executor === "codex_cloud") {
    await codexBridge.cloudExec({
      runId: run.id,
      taskId: task.id,
      repoPath: repo.local_path,
      prompt,
      branchName,
      codexCloudEnvId: repo.codex_cloud_env_id
    });
  } else {
    await codexBridge.localExec({
      runId: run.id,
      taskId: task.id,
      repoPath: repo.local_path,
      prompt,
      branchName
    });
  }

  const testResult = await gitService.runConfiguredTests(repo.local_path);

  if (testResult) {
    await auditLog.log({
      task_id: task.id,
      run_id: run.id,
      event_type: "tests.completed",
      severity: testResult.code === 0 ? "info" : "error",
      payload: {
        code: testResult.code,
        stdout: testResult.stdout.slice(-12000),
        stderr: testResult.stderr.slice(-12000)
      }
    });

    if (testResult.code !== 0) {
      throw new Error("Codex changes were made, but tests failed.");
    }
  }

  const diffSummary = await gitService.diffSummary(repo.local_path);
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "git.diff_summary",
    payload: { diff_summary: diffSummary }
  });

  return `Codex finished work on ${branchName}. ${diffSummary}`;
};

const blockTask = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  reason: string
): Promise<void> => {
  await database.updateExecutionRun(run.id, {
    status: "blocked",
    finished_at: new Date().toISOString(),
    final_summary: reason
  });
  await database.updateTask(task.id, { status: "blocked" });
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "run.blocked",
    severity: "warn",
    payload: { reason }
  });
  void smsNotifier.taskFinished(task, "blocked", reason);
};

const buildCodexPrompt = (task: DeveloperTask, branchName: string): string => {
  return [
    `You are executing a CallAI remote developer operator task on branch ${branchName}.`,
    `Task: ${task.title}`,
    `Instructions: ${task.instructions}`,
    `Acceptance criteria: ${task.acceptanceCriteria.join("; ")}`,
    "Keep changes tightly scoped. Run relevant validation when practical. Do not commit, push, merge, delete secrets, or deploy; the operator will ask for separate approval."
  ].join("\n");
};

const branchForTask = (task: DeveloperTaskRecord): string => {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);

  return `callai/${task.id.slice(0, 8)}-${slug || "task"}`;
};

const repoForCurrentRunner = (repo: RepoRecord): RepoRecord => {
  const overridePath = process.env.DEFAULT_REPO_PATH;

  if (
    process.env.RUNNER_ID === "macbook-local-bridge" &&
    overridePath &&
    repo.owner === (process.env.DEFAULT_REPO_OWNER || repo.owner) &&
    repo.name === (process.env.DEFAULT_REPO_NAME || repo.name)
  ) {
    return {
      ...repo,
      local_path: overridePath
    };
  }

  return repo;
};

const isRunnerConfigurationIssue = (message: string): boolean => {
  return /failed to start|enoent|no such file|command not found|not authenticated|authentication|log in|login|api key|openai_api_key|codex_home/i.test(
    message
  );
};

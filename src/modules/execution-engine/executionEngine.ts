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
  RepoRecord,
  TaskStatus
} from "../../types/operator.js";
import { gitService } from "./gitService.js";

type ExecutionResult = {
  summary: string;
  taskStatus?: Extract<TaskStatus, "needs_confirmation" | "succeeded">;
  notifyCompletion?: boolean;
};

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

      const result = await executeByAction(task, run, structured, runnerRepo);

      await database.updateExecutionRun(run.id, {
        status: "succeeded",
        finished_at: new Date().toISOString(),
        final_summary: result.summary
      });

      if (result.taskStatus === "needs_confirmation") {
        await database.updateTask(task.id, { status: "needs_confirmation" });
      } else {
        await database.updateTask(task.id, { status: "succeeded" });
      }

      await auditLog.log({
        task_id: task.id,
        run_id: run.id,
        event_type: "run.succeeded",
        payload: { summary: result.summary }
      });

      if (result.notifyCompletion !== false) {
        void smsNotifier.taskFinished(task, "succeeded", result.summary);
      }
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

    if (structured.postApprovalAction?.action === "open_pull_request") {
      return "github";
    }

    if (structured.postApprovalAction?.action === "commit_changes") {
      return "direct";
    }

    if (structured.action === "send_chat_message") {
      return "chat";
    }

    if (structured.action === "open_pull_request") {
      return "github";
    }

    if (
      structured.action === "inspect_repo" ||
      structured.action === "summarize_project" ||
      structured.action === "query_logs" ||
      structured.action === "run_tests" ||
      structured.action === "commit_changes"
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
): Promise<ExecutionResult> => {
  if (structured.action === "send_chat_message") {
    const result = await chatConnector.sendProjectUpdate({
      taskId: task.id,
      channelHint: structured.chatTarget,
      message: structured.instructions
    });

    return {
      summary: result.delivered
        ? `Project update sent to ${result.channel}.`
        : `Project update was recorded in the audit log for ${result.channel}.`
    };
  }

  if (!repo?.local_path) {
    throw new Error("Repo has no local_path configured for runner execution.");
  }

  await gitService.ensureRepo(
    repo.local_path,
    repo.clone_url,
    repo.default_branch
  );

  if (structured.postApprovalAction) {
    return executePostApprovalAction(task, run, structured, repo);
  }

  if (
    structured.action === "commit_changes" ||
    structured.action === "open_pull_request"
  ) {
    return executeGitPublication(task, run, structured, repo, {
      action: structured.action,
      commitMessage: buildCommitMessage(task, structured),
      pullRequestTitle: structured.title,
      pullRequestBody: buildPullRequestBody(task, structured),
      draft: true
    });
  }

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

    return {
      summary: `Inspected ${repo.owner}/${repo.name} on ${branch}; working tree is ${summary.dirty ? "dirty" : "clean"}.`
    };
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

    return {
      summary:
        "Log query recorded; connect a deployment log adapter to fetch provider logs automatically."
    };
  }

  if (structured.action === "run_tests") {
    const result = await gitService.runConfiguredTests(repo.local_path);

    if (!result) {
      return { summary: "No package test or build script was found." };
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

    return { summary: "Configured tests completed successfully." };
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

  if (diffSummary === "No file changes detected.") {
    return {
      summary: `Codex finished work on ${branchName}. No file changes detected.`
    };
  }

  await requestPublicationApproval(task, run, structured, branchName, diffSummary);

  return {
    summary: `Codex finished work on ${branchName}. Waiting for approval to commit, push, and open a draft pull request. ${diffSummary}`,
    taskStatus: "needs_confirmation",
    notifyCompletion: false
  };
};

const executePostApprovalAction = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask,
  repo: RepoRecord
): Promise<ExecutionResult> => {
  const action = structured.postApprovalAction;

  if (!action) {
    throw new Error("No post-approval action is pending.");
  }

  if (action.branchName) {
    await gitService.checkoutBranch(repo.local_path!, action.branchName);
  }

  const result = await executeGitPublication(task, run, structured, repo, {
    action: action.action,
    branchName: action.branchName,
    commitMessage: action.commitMessage ?? buildCommitMessage(task, structured),
    pullRequestTitle: action.pullRequestTitle ?? structured.title,
    pullRequestBody:
      action.pullRequestBody ?? buildPullRequestBody(task, structured),
    draft: action.draft ?? true
  });

  const { postApprovalAction: _completed, ...withoutPendingAction } = structured;
  await database.updateTask(task.id, {
    structured_request: withoutPendingAction
  });

  return result;
};

const executeGitPublication = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask,
  repo: RepoRecord,
  input: {
    action: "commit_changes" | "open_pull_request";
    branchName?: string;
    commitMessage: string;
    pullRequestTitle: string;
    pullRequestBody: string;
    draft?: boolean;
  }
): Promise<ExecutionResult> => {
  const branchName = input.branchName ?? (await gitService.currentBranch(repo.local_path!));
  assertPublishableBranch(branchName, repo.default_branch);

  if (input.branchName) {
    await gitService.checkoutBranch(repo.local_path!, input.branchName);
  }

  const testResult = await gitService.runConfiguredTests(repo.local_path!);

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
      throw new Error("Configured tests failed; refusing to publish changes.");
    }
  }

  const commitResult = await gitService.commitAll(
    repo.local_path!,
    sanitizeCommitMessage(input.commitMessage)
  );
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "git.commit_completed",
    payload: {
      branch_name: branchName,
      committed: Boolean(commitResult),
      detail: commitResult ?? "No local changes to commit."
    }
  });

  if (input.action === "commit_changes" && !mentionsPushOrPr(structured.instructions)) {
    return {
      summary: commitResult
        ? `Committed changes on ${branchName}.`
        : `No local changes were available to commit on ${branchName}.`
    };
  }

  await gitService.pushBranch(repo.local_path!, branchName);
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "git.branch_pushed",
    payload: { branch_name: branchName }
  });

  if (input.action === "commit_changes") {
    return {
      summary: commitResult
        ? `Committed and pushed ${branchName}.`
        : `Pushed ${branchName}; no new local commit was needed.`
    };
  }

  const prUrl = await gitService.createPullRequest({
    repoPath: repo.local_path!,
    branchName,
    baseBranch: repo.default_branch,
    title: input.pullRequestTitle,
    body: input.pullRequestBody,
    draft: input.draft
  });
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "github.pull_request_created",
    payload: {
      branch_name: branchName,
      base_branch: repo.default_branch,
      url: prUrl,
      draft: input.draft !== false
    }
  });

  return {
    summary: `Published ${branchName} and opened a draft pull request: ${prUrl}`
  };
};

const requestPublicationApproval = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask,
  branchName: string,
  diffSummary: string
): Promise<void> => {
  const updatedTask = await database.updateTask(task.id, {
    status: "needs_confirmation",
    permission_required: "full_write",
    structured_request: {
      ...structured,
      postApprovalAction: {
        action: "open_pull_request",
        branchName,
        commitMessage: buildCommitMessage(task, structured),
        pullRequestTitle: structured.title,
        pullRequestBody: buildPullRequestBody(task, structured, diffSummary),
        draft: true
      }
    }
  });
  const confirmation = await database.createConfirmation({
    task_id: task.id,
    prompt: `Codex finished changes on ${branchName}. Approve committing, pushing, and opening a draft pull request?`,
    risk: "This will create a local commit, push a branch to GitHub, and open a draft pull request.",
    expires_at: new Date(Date.now() + 1000 * 60 * 30).toISOString()
  });

  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "confirmation.requested",
    payload: {
      confirmation_id: confirmation.id,
      branch_name: branchName,
      requested_action: "open_pull_request"
    }
  });

  void smsNotifier.taskNeedsConfirmation(updatedTask, confirmation);
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

const assertPublishableBranch = (
  branchName: string,
  defaultBranch: string
): void => {
  const protectedBranches = new Set([
    defaultBranch,
    "main",
    "master",
    "production",
    "prod"
  ]);

  if (protectedBranches.has(branchName)) {
    throw new Error(
      `Refusing to commit, push, or open a PR directly from protected branch ${branchName}. Create a callai/* branch first.`
    );
  }
};

const mentionsPushOrPr = (value: string): boolean => {
  return /\b(push|pushed|github|pull request|pr|open pr|draft pr)\b/i.test(value);
};

const buildCommitMessage = (
  task: DeveloperTaskRecord,
  structured: DeveloperTask
): string => {
  return sanitizeCommitMessage(
    structured.postApprovalAction?.commitMessage ||
      structured.title ||
      task.title ||
      "CallAI task update"
  );
};

const buildPullRequestBody = (
  task: DeveloperTaskRecord,
  structured: DeveloperTask,
  diffSummary?: string
): string => {
  const criteria = structured.acceptanceCriteria
    .map((item) => `- ${item}`)
    .join("\n");
  const lines = [
    "Created by CallAI after explicit approval.",
    "",
    "Task:",
    structured.instructions,
    "",
    "Acceptance criteria:",
    criteria,
    "",
    `Task ID: ${task.id}`
  ];

  if (diffSummary) {
    lines.push("", "Diff summary:", "```", diffSummary, "```");
  }

  return lines.join("\n");
};

const sanitizeCommitMessage = (message: string): string => {
  const clean = message
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, 120);

  return clean || "CallAI task update";
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

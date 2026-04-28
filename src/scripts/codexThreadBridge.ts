import "dotenv/config";
import { auditLog } from "../modules/audit-log/auditLogService.js";
import { smsNotifier } from "../modules/sms/smsNotifier.js";
import { database } from "../services/dbService.js";

type BridgeResult = Record<string, unknown>;

const command = process.argv[2];

const main = async (): Promise<void> => {
  if (command === "claim") {
    return print(await claimTask());
  }

  if (command === "complete") {
    return print(await finishTask("succeeded"));
  }

  if (command === "fail") {
    return print(await finishTask("failed"));
  }

  print({
    success: false,
    error:
      "Usage: codexThreadBridge.ts claim | complete <task_id> <summary> | fail <task_id> <reason>"
  });
  process.exitCode = 1;
};

const claimTask = async (): Promise<BridgeResult> => {
  const claimed = await database.claimNextCodexThreadTask({
    thread_label: process.env.CODEX_THREAD_LABEL || "CallAI Codex thread"
  });

  if (!claimed) {
    return {
      success: true,
      claimed: false,
      message: "No Codex-thread tasks are waiting."
    };
  }

  await auditLog.log({
    task_id: claimed.task.id,
    run_id: claimed.run.id,
    event_type: "codex_thread.claimed",
    payload: {
      thread_label: claimed.job.thread_label,
      job_id: claimed.job.id
    }
  });

  return {
    success: true,
    claimed: true,
    task: claimed.task,
    run: claimed.run,
    job: claimed.job,
    instructions: [
      "Execute this CallAI task in the current Codex project.",
      "Keep changes scoped to the interpreted task.",
      "Do not commit, push, open a PR, delete files, deploy, or change secrets unless the task already has explicit approval.",
      "When finished, run npm run codex-thread:complete -- <task_id> <summary>.",
      "If blocked or failed, run npm run codex-thread:fail -- <task_id> <reason>."
    ]
  };
};

const finishTask = async (
  status: "succeeded" | "failed"
): Promise<BridgeResult> => {
  const taskId = process.argv[3];
  const summary = process.argv.slice(4).join(" ").trim();

  if (!taskId || !summary) {
    process.exitCode = 1;
    return {
      success: false,
      error: `Usage: codexThreadBridge.ts ${status === "succeeded" ? "complete" : "fail"} <task_id> <summary>`
    };
  }

  const result = await database.finishCodexThreadTask({
    task_id: taskId,
    status,
    summary
  });

  await auditLog.log({
    task_id: result.task.id,
    run_id: result.run?.id ?? null,
    event_type:
      status === "succeeded"
        ? "codex_thread.completed"
        : "codex_thread.failed",
    severity: status === "succeeded" ? "info" : "error",
    payload: {
      job_id: result.job?.id ?? null,
      summary
    }
  });

  await smsNotifier.taskFinished(result.task, status, summary);

  return {
    success: true,
    task_id: result.task.id,
    status,
    summary
  };
};

const print = (result: BridgeResult): void => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

void main().catch((error) => {
  print({
    success: false,
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});

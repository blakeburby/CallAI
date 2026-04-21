import "dotenv/config";
import path from "node:path";

const workspaceRoot =
  process.env.LOCAL_BRIDGE_REPO_PATH ||
  process.env.DEFAULT_REPO_PATH ||
  "/Users/blakeburby/Desktop/CallAI-main";

process.env.RUNNER_ID =
  process.env.LOCAL_BRIDGE_RUNNER_ID || "macbook-local-bridge";
process.env.CODEX_EXECUTABLE =
  process.env.LOCAL_BRIDGE_CODEX_EXECUTABLE ||
  "/Applications/Codex.app/Contents/Resources/codex";
process.env.CODEX_EXECUTION_MODE = "local";
process.env.DEFAULT_REPO_PATH = workspaceRoot;
process.env.DEFAULT_REPO_OWNER = process.env.DEFAULT_REPO_OWNER || "blakeburby";
process.env.DEFAULT_REPO_NAME = process.env.DEFAULT_REPO_NAME || "CallAI";
process.env.DEFAULT_REPO_URL =
  process.env.DEFAULT_REPO_URL || "https://github.com/blakeburby/CallAI.git";
process.env.DEFAULT_REPO_BRANCH = process.env.DEFAULT_REPO_BRANCH || "main";
process.env.RUNNER_TASK_SCOPE =
  process.env.LOCAL_BRIDGE_TASK_SCOPE ||
  process.env.RUNNER_TASK_SCOPE ||
  "all";

process.chdir(path.resolve(workspaceRoot));

await import("./agentRunner.js");

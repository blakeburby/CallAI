import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export const gitService = {
  async ensureRepo(repoPath: string): Promise<void> {
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoPath
    });

    if (result.code !== 0) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }
  },

  async currentBranch(repoPath: string): Promise<string> {
    const result = await runCommand("git", ["branch", "--show-current"], {
      cwd: repoPath
    });

    return result.stdout.trim() || "HEAD";
  },

  async createBranch(repoPath: string, branchName: string): Promise<void> {
    const result = await runCommand("git", ["checkout", "-B", branchName], {
      cwd: repoPath
    });

    if (result.code !== 0) {
      throw new Error(result.stderr || `Could not create branch ${branchName}.`);
    }
  },

  async statusShort(repoPath: string): Promise<string> {
    const result = await runCommand("git", ["status", "--short"], {
      cwd: repoPath
    });

    return result.stdout.trim();
  },

  async diffSummary(repoPath: string): Promise<string> {
    const result = await runCommand("git", ["diff", "--stat"], {
      cwd: repoPath
    });

    return result.stdout.trim() || "No file changes detected.";
  },

  async recentFiles(repoPath: string, limit = 80): Promise<string[]> {
    const result = await runCommand("git", ["ls-files"], {
      cwd: repoPath
    });

    if (result.code !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, limit);
  },

  async runConfiguredTests(repoPath: string): Promise<CommandResult | null> {
    const packageJsonPath = path.join(repoPath, "package.json");

    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        scripts?: Record<string, string>;
      };

      if (packageJson.scripts?.test) {
        return runCommand("npm", ["test"], {
          cwd: repoPath,
          timeoutMs: Number(process.env.RUNNER_TEST_TIMEOUT_MS ?? 180000)
        });
      }

      if (packageJson.scripts?.build) {
        return runCommand("npm", ["run", "build"], {
          cwd: repoPath,
          timeoutMs: Number(process.env.RUNNER_TEST_TIMEOUT_MS ?? 180000)
        });
      }
    } catch {
      return null;
    }

    return null;
  },

  runCommand
};

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : null;
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      resolve({
        code: 1,
        stdout,
        stderr: error.message
      });
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

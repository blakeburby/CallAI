import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export const gitService = {
  async ensureRepo(
    repoPath: string,
    cloneUrl?: string,
    defaultBranch?: string
  ): Promise<void> {
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoPath
    });

    if (result.code === 0) {
      return;
    }

    if (!cloneUrl) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    await cloneRepo(repoPath, cloneUrl, defaultBranch);
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

  async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
    const result = await runCommand("git", ["checkout", branchName], {
      cwd: repoPath
    });

    if (result.code !== 0) {
      throw new Error(result.stderr || `Could not checkout ${branchName}.`);
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

  async stagedDiffSummary(repoPath: string): Promise<string> {
    const result = await runCommand("git", ["diff", "--cached", "--stat"], {
      cwd: repoPath
    });

    return result.stdout.trim() || "No staged changes detected.";
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

  async commitAll(repoPath: string, message: string): Promise<string | null> {
    const status = await gitService.statusShort(repoPath);

    if (!status) {
      return null;
    }

    const add = await runCommand("git", ["add", "-A"], { cwd: repoPath });

    if (add.code !== 0) {
      throw new Error(add.stderr || "Could not stage changes.");
    }

    const stagedSummary = await gitService.stagedDiffSummary(repoPath);
    const commit = await runCommand("git", ["commit", "-m", message], {
      cwd: repoPath,
      timeoutMs: Number(process.env.RUNNER_GIT_TIMEOUT_MS ?? 180000)
    });

    if (commit.code !== 0) {
      throw new Error(commit.stderr || "Could not commit changes.");
    }

    const hash = await runCommand("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoPath
    });

    return `${hash.stdout.trim() || "commit created"}\n${stagedSummary}`;
  },

  async pushBranch(repoPath: string, branchName: string): Promise<void> {
    const result = await runCommand(
      "git",
      ["push", "--set-upstream", "origin", branchName],
      {
        cwd: repoPath,
        timeoutMs: Number(process.env.RUNNER_GIT_TIMEOUT_MS ?? 180000)
      }
    );

    if (result.code !== 0) {
      throw new Error(result.stderr || `Could not push ${branchName}.`);
    }
  },

  async createPullRequest(input: {
    repoPath: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<string> {
    const args = [
      "pr",
      "create",
      "--base",
      input.baseBranch,
      "--head",
      input.branchName,
      "--title",
      input.title,
      "--body",
      input.body
    ];

    if (input.draft !== false) {
      args.push("--draft");
    }

    const result = await runCommand("gh", args, {
      cwd: input.repoPath,
      timeoutMs: Number(process.env.RUNNER_GIT_TIMEOUT_MS ?? 180000)
    });

    if (result.code === 0) {
      return result.stdout.trim();
    }

    const existing = await gitService.getPullRequestUrl(input.repoPath, input.branchName);

    if (existing) {
      return existing;
    }

    throw new Error(result.stderr || "Could not create pull request.");
  },

  async getPullRequestUrl(
    repoPath: string,
    branchName: string
  ): Promise<string | null> {
    const result = await runCommand(
      "gh",
      ["pr", "view", branchName, "--json", "url", "--jq", ".url"],
      {
        cwd: repoPath,
        timeoutMs: Number(process.env.RUNNER_GIT_TIMEOUT_MS ?? 180000)
      }
    );

    if (result.code !== 0) {
      return null;
    }

    return result.stdout.trim() || null;
  },

  runCommand
};

async function cloneRepo(
  repoPath: string,
  cloneUrl: string,
  defaultBranch?: string
): Promise<void> {
  await mkdir(path.dirname(repoPath), { recursive: true });

  const existingFiles = await readdir(repoPath).catch(() => []);
  if (existingFiles.length > 0) {
    throw new Error(`Not a git repository and path is not empty: ${repoPath}`);
  }

  const args = ["clone", "--depth", "1"];

  if (defaultBranch) {
    args.push("--branch", defaultBranch);
  }

  args.push(cloneUrl, repoPath);

  const result = await runCommand("git", args, {
    cwd: path.dirname(repoPath),
    timeoutMs: Number(process.env.RUNNER_GIT_TIMEOUT_MS ?? 180000)
  });

  if (result.code !== 0) {
    throw new Error(result.stderr || `Could not clone ${cloneUrl}.`);
  }
}

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

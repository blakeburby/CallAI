import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { auditLog } from "../audit-log/auditLogService.js";
import { database } from "../../services/dbService.js";
import type {
  DeveloperTask,
  DeveloperTaskRecord,
  ExecutionRunRecord
} from "../../types/operator.js";

const execFileAsync = promisify(execFile);

type ComputerControlResult = {
  summary: string;
  currentUrl: string | null;
  pageTitle: string | null;
  targetUrl: string | null;
  steps: number;
  status: "completed" | "needs_confirmation" | "blocked";
  reason?: string;
};

export type ComputerRisk = "low" | "needs_confirmation" | "blocked";

const DEFAULT_SHELL_TIMEOUT_MS = 20000;
const DEFAULT_MAX_STEPS = 6;
const OUTPUT_LIMIT = 12000;

export const macComputerController = {
  async runTask(
    task: DeveloperTaskRecord,
    run: ExecutionRunRecord,
    structured: DeveloperTask
  ): Promise<ComputerControlResult> {
    if (process.platform !== "darwin") {
      throw new Error("Full computer control requires the macOS local bridge.");
    }

    if (structured.desktopMode === "local_shell" || structured.targetApp === "shell") {
      return runShellTask(task, run, structured);
    }

    return runGuiTask(task, run, structured);
  }
};

const runShellTask = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask
): Promise<ComputerControlResult> => {
  const command =
    structured.shellCommand ?? inferShellCommandFromInstructions(structured.instructions);
  const cwd = resolveShellCwd(structured.shellCwd);

  if (!command) {
    return blockComputerTask(
      task,
      run,
      structured,
      "I need an explicit shell command before running local shell control."
    );
  }

  const risk = maxRisk(
    structured.riskLevel ?? "low",
    classifyShellCommandRisk(command, cwd)
  );

  if (risk === "blocked") {
    return blockComputerTask(
      task,
      run,
      structured,
      "Local shell control blocked before handling secrets, credentials, banking, payment execution, credential harvesting, or security bypass."
    );
  }

  if (
    risk === "needs_confirmation" &&
    !structured.desktopApprovalGranted &&
    envBool("COMPUTER_CONTROL_CONFIRM_RISKY", true)
  ) {
    return needComputerConfirmation(
      task,
      run,
      structured,
      "Local shell control needs approval before running a command that can change files, settings, processes, or external state."
    );
  }

  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "computer.shell_started",
    payload: {
      cwd,
      command: redactComputerText(command)
    }
  });

  const { stdout, stderr } = await execFileAsync("/bin/zsh", ["-lc", command], {
    cwd,
    timeout: envInt("COMPUTER_CONTROL_SHELL_TIMEOUT_MS", DEFAULT_SHELL_TIMEOUT_MS),
    maxBuffer: 1024 * 1024
  });
  const redactedStdout = redactComputerText(stdout).slice(-OUTPUT_LIMIT);
  const redactedStderr = redactComputerText(stderr).slice(-OUTPUT_LIMIT);
  const summary = [
    `Shell command completed in ${cwd}.`,
    redactedStdout ? `stdout: ${redactedStdout}` : "",
    redactedStderr ? `stderr: ${redactedStderr}` : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1800);

  await database.upsertDesktopSnapshot({
    task_id: task.id,
    run_id: run.id,
    current_url: `shell://${cwd}`,
    page_title: "Local shell",
    latest_action: `Shell: ${redactComputerText(command).slice(0, 240)}`,
    step: 1,
    screenshot_data_url: null,
    redacted: true
  });

  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "computer.shell_completed",
    payload: {
      cwd,
      command: redactComputerText(command),
      stdout: redactedStdout,
      stderr: redactedStderr
    }
  });

  return {
    summary,
    currentUrl: `shell://${cwd}`,
    pageTitle: "Local shell",
    targetUrl: null,
    steps: 1,
    status: "completed"
  };
};

const runGuiTask = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask
): Promise<ComputerControlResult> => {
  const risk = maxRisk(
    structured.riskLevel ?? "low",
    classifyComputerInstructionRisk(structured.instructions)
  );

  if (risk === "blocked") {
    return blockComputerTask(
      task,
      run,
      structured,
      "Full Mac control blocked before handling passwords, 2FA, CAPTCHAs, secrets, banking, payment execution, credential harvesting, or security bypass."
    );
  }

  if (
    risk === "needs_confirmation" &&
    !structured.desktopApprovalGranted &&
    envBool("COMPUTER_CONTROL_CONFIRM_RISKY", true)
  ) {
    return needComputerConfirmation(
      task,
      run,
      structured,
      "Full Mac control needs approval before taking an externally visible, file-changing, settings-changing, or admin-like action."
    );
  }

  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "computer.session_started",
    payload: {
      target_app: structured.targetApp ?? "any",
      desktop_mode: structured.desktopMode ?? "full_mac",
      max_steps: envInt("COMPUTER_CONTROL_MAX_STEPS", DEFAULT_MAX_STEPS)
    }
  });

  const actions: string[] = [];
  const maxSteps = envInt("COMPUTER_CONTROL_MAX_STEPS", DEFAULT_MAX_STEPS);
  const runStep = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (actions.length >= maxSteps) {
      return;
    }

    await action();
    actions.push(label);
  };
  const folder = inferFolderPath(structured.instructions);
  const appName = normalizeAppName(structured.targetApp, structured.instructions);
  const targetUrl = structured.url;

  if (folder) {
    await runStep(`opened ${folder}`, async () => {
      await execFileAsync("open", [folder], {
        timeout: envInt("COMPUTER_CONTROL_STEP_TIMEOUT_MS", 15000)
      });
    });
  } else if (targetUrl) {
    await runStep(`opened ${targetUrl}`, async () => {
      await execFileAsync("open", [targetUrl], {
        timeout: envInt("COMPUTER_CONTROL_STEP_TIMEOUT_MS", 15000)
      });
    });
  } else if (appName && appName !== "any") {
    await runStep(`focused ${appName}`, async () => {
      await execFileAsync("open", ["-a", appName], {
        timeout: envInt("COMPUTER_CONTROL_STEP_TIMEOUT_MS", 15000)
      });
    });
  }

  const hotkey = inferHotkey(structured.instructions);
  if (hotkey) {
    await runStep(`pressed ${hotkey.label}`, async () => {
      await runAppleScript([
        'tell application "System Events"',
        `  key code ${hotkey.keyCode}${hotkey.modifiers.length ? ` using {${hotkey.modifiers.join(", ")}}` : ""}`,
        "end tell"
      ]);
    });
  }

  const text = inferTypedText(structured.instructions);
  if (text) {
    await runStep("typed requested text", async () => {
      await runAppleScript([
        'tell application "System Events"',
        `  keystroke "${escapeAppleScriptString(text)}"`,
        "end tell"
      ]);
    });
  }

  const point = inferClickPoint(structured.instructions);
  if (point) {
    await runStep(`clicked at ${point.x},${point.y}`, async () => {
      await runAppleScript([
        'tell application "System Events"',
        `  click at {${point.x}, ${point.y}}`,
        "end tell"
      ]);
    });
  }

  await wait(750);
  const observation = await observeFrontApp().catch(() => ({
    appName: appName ?? "Mac",
    windowTitle: null
  }));
  const snapshot = await recordMacSnapshot({
    task,
    run,
    structured,
    observation,
    latestAction: actions.length ? actions.join("; ") : "Observed the front Mac app",
    step: actions.length || 1
  });
  const summary = actions.length
    ? `Mac control completed: ${actions.join("; ")}.`
    : `Mac control observed ${observation.appName}${observation.windowTitle ? `: ${observation.windowTitle}` : ""}.`;

  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "computer.gui_completed",
    payload: {
      target_app: appName,
      actions,
      front_app: observation.appName,
      window_title: observation.windowTitle,
      screenshot_available: snapshot.snapshotAvailable,
      redacted: snapshot.redacted
    }
  });

  return {
    summary,
    currentUrl: `mac://${observation.appName}`,
    pageTitle: observation.windowTitle ?? observation.appName,
    targetUrl: structured.url ?? null,
    steps: Math.max(1, actions.length),
    status: "completed"
  };
};

const needComputerConfirmation = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask,
  reason: string
): Promise<ComputerControlResult> => {
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "computer.confirmation_required",
    severity: "warn",
    payload: {
      reason,
      target_app: structured.targetApp ?? null,
      desktop_mode: structured.desktopMode ?? null
    }
  });

  return {
    summary: reason,
    currentUrl: null,
    pageTitle: null,
    targetUrl: structured.url ?? null,
    steps: 0,
    status: "needs_confirmation",
    reason
  };
};

const blockComputerTask = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask,
  reason: string
): Promise<ComputerControlResult> => {
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "computer.blocked",
    severity: "warn",
    payload: {
      reason,
      target_app: structured.targetApp ?? null,
      desktop_mode: structured.desktopMode ?? null
    }
  });

  return {
    summary: reason,
    currentUrl: null,
    pageTitle: null,
    targetUrl: structured.url ?? null,
    steps: 0,
    status: "blocked",
    reason
  };
};

export const classifyShellCommandRisk = (
  command: string,
  cwd = ""
): ComputerRisk => {
  const combined = `${command} ${cwd}`.toLowerCase();

  if (
    /\b(password|passcode|secret|api[_ -]?key|token|credential|keychain|2fa|otp|captcha|bank|wire|payment|checkout|credit card|cvv|security bypass)\b/.test(
      combined
    ) ||
    /\b(cat|less|more|open|pbcopy)\b\s+.*(\.env|id_rsa|id_ed25519|keychain|credentials|secrets?)/.test(
      combined
    ) ||
    /curl\s+[^|]+[|]\s*(sh|bash|zsh)/.test(combined)
  ) {
    return "blocked";
  }

  if (
    /\b(rm|rmdir|mv|cp|chmod|chown|sudo|kill|killall|pkill|launchctl|defaults\s+write|diskutil|brew\s+(?:install|uninstall)|npm\s+(?:install|publish)|git\s+(?:commit|push|merge|reset|checkout|clean)|trash)\b/.test(
      combined
    )
  ) {
    return "needs_confirmation";
  }

  return "low";
};

export const classifyComputerInstructionRisk = (instructions: string): ComputerRisk => {
  const lower = instructions.toLowerCase();

  if (
    /\b(password|passcode|secret|api key|token|credential|2fa|otp|captcha|bank|wire|payment|purchase|buy|checkout|credit card|cvv|credential harvesting|security bypass)\b/.test(
      lower
    )
  ) {
    return "blocked";
  }

  if (
    /\b(send|post|reply|comment|publish|upload|attach|delete|remove|trash|move files|rename files|save settings|change settings|system settings|account settings|install|uninstall|admin|commit|push|deploy|merge)\b/.test(
      lower
    )
  ) {
    return "needs_confirmation";
  }

  return "low";
};

export const redactComputerText = (value: string): string => {
  return value
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSCODE|AUTH)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
      "$1=[redacted]"
    )
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, "[redacted OpenAI key]")
    .replace(/AC[a-fA-F0-9]{32}/g, "[redacted Twilio SID]")
    .replace(/[a-fA-F0-9]{32,}/g, "[redacted token]");
};

export const inferShellCommandFromInstructions = (instructions: string): string | null => {
  const match = instructions.match(
    /\b(?:run|execute)\s+(?:the\s+)?(?:shell\s+)?(?:command\s+)?[`"“]?(.+?)[`"”]?(?:\s+(?:on|in|from)\s+(?:my\s+)?(?:desktop|downloads|documents|home folder|home))?[.!?]?$/i
  );

  if (match?.[1]) {
    return match[1].trim();
  }

  if (/\b(list|show)\s+files\b/i.test(instructions)) {
    return "ls";
  }

  return null;
};

const recordMacSnapshot = async (input: {
  task: DeveloperTaskRecord;
  run: ExecutionRunRecord;
  structured: DeveloperTask;
  observation: { appName: string; windowTitle: string | null };
  latestAction: string;
  step: number;
}): Promise<{ snapshotAvailable: boolean; redacted: boolean }> => {
  const redacted = shouldRedactMacSnapshot(input);
  let screenshotDataUrl: string | null = null;

  if (!redacted && envBool("COMPUTER_CONTROL_CAPTURE_SCREENSHOTS", true)) {
    screenshotDataUrl = await captureScreen().catch(() => null);
  }

  await database.upsertDesktopSnapshot({
    task_id: input.task.id,
    run_id: input.run.id,
    current_url: `mac://${input.observation.appName}`,
    page_title: input.observation.windowTitle ?? input.observation.appName,
    latest_action: input.latestAction,
    step: input.step,
    screenshot_data_url: screenshotDataUrl,
    redacted
  });

  return {
    snapshotAvailable: Boolean(screenshotDataUrl),
    redacted
  };
};

const shouldRedactMacSnapshot = (input: {
  structured: DeveloperTask;
  observation: { appName: string; windowTitle: string | null };
  latestAction: string;
}): boolean => {
  const combined = [
    input.structured.instructions,
    input.structured.targetApp,
    input.structured.shellCommand,
    input.observation.appName,
    input.observation.windowTitle,
    input.latestAction
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\b(password|passcode|login|sign in|secret|api key|token|oauth|credit card|payment|billing|checkout|bank|2fa|otp|captcha|keychain|credential|security settings)\b/.test(
    combined
  );
};

const captureScreen = async (): Promise<string | null> => {
  const filePath = `/tmp/callai-mac-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.jpg`;

  try {
    await execFileAsync("screencapture", ["-x", "-t", "jpg", filePath], {
      timeout: 15000
    });
    await execFileAsync(
      "sips",
      ["-s", "format", "jpeg", "-s", "formatOptions", "45", "-Z", "1200", filePath, "--out", filePath],
      { timeout: 10000 }
    ).catch(() => {});
    const image = await readFile(filePath);
    return `data:image/jpeg;base64,${image.toString("base64")}`;
  } finally {
    await unlink(filePath).catch(() => {});
  }
};

const observeFrontApp = async (): Promise<{
  appName: string;
  windowTitle: string | null;
}> => {
  const output = await runAppleScript([
    'tell application "System Events"',
    "  set frontProcess to first application process whose frontmost is true",
    "  set appName to name of frontProcess",
    '  set windowTitle to ""',
    "  try",
    "    set windowTitle to name of front window of frontProcess",
    "  end try",
    "  return appName & linefeed & windowTitle",
    "end tell"
  ]);
  const [appName, windowTitle] = output.split(/\r?\n/);

  return {
    appName: appName?.trim() || "Mac",
    windowTitle: windowTitle?.trim() || null
  };
};

const runAppleScript = async (lines: string[]): Promise<string> => {
  const { stdout, stderr } = await execFileAsync(
    "osascript",
    lines.flatMap((line) => ["-e", line]),
    {
      timeout: envInt("COMPUTER_CONTROL_STEP_TIMEOUT_MS", 15000)
    }
  );

  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return stdout.trim();
};

const inferFolderPath = (instructions: string): string | null => {
  const lower = instructions.toLowerCase();
  const home = os.homedir();

  if (/\bdownloads\b/.test(lower)) {
    return path.join(home, "Downloads");
  }

  if (/\bdesktop\b/.test(lower)) {
    return path.join(home, "Desktop");
  }

  if (/\bdocuments\b/.test(lower)) {
    return path.join(home, "Documents");
  }

  if (/\bapplications folder\b/.test(lower)) {
    return "/Applications";
  }

  const explicit = instructions.match(/\b(?:open|show|reveal)\s+((?:\/|~\/)[^\n.!?]+)$/i)?.[1];
  return explicit ? resolveShellCwd(explicit.trim()) : null;
};

const normalizeAppName = (
  targetApp: string | undefined,
  instructions: string
): string | null => {
  const value = (targetApp ?? "").trim();

  if (value && value.toLowerCase() !== "any" && value.toLowerCase() !== "shell") {
    return appAlias(value);
  }

  const lower = instructions.toLowerCase();

  if (/\bfinder\b|\bdownloads\b|\bdocuments\b|\bdesktop\b/.test(lower)) {
    return "Finder";
  }

  if (/\bterminal\b/.test(lower)) {
    return "Terminal";
  }

  if (/\bsystem settings|system preferences|settings app\b/.test(lower)) {
    return "System Settings";
  }

  if (/\bmail\b/.test(lower)) {
    return "Mail";
  }

  if (/\bnotes\b/.test(lower)) {
    return "Notes";
  }

  if (/\bmessages\b/.test(lower)) {
    return "Messages";
  }

  return value || null;
};

const appAlias = (value: string): string => {
  const lower = value.toLowerCase();

  if (lower === "chrome" || lower === "google chrome") {
    return "Google Chrome";
  }

  if (lower === "settings" || lower === "system preferences") {
    return "System Settings";
  }

  return value;
};

const inferTypedText = (instructions: string): string | null => {
  return (
    instructions.match(/\btype\s+["“](.+?)["”]/i)?.[1]?.trim() ??
    instructions.match(/\btype\s+(.+?)\s+(?:into|in)\b/i)?.[1]?.trim() ??
    null
  );
};

const inferClickPoint = (instructions: string): { x: number; y: number } | null => {
  const match = instructions.match(/\bclick\s+(?:at\s+)?(\d{1,5})\s*,\s*(\d{1,5})\b/i);

  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  return {
    x: Number(match[1]),
    y: Number(match[2])
  };
};

const inferHotkey = (
  instructions: string
): { keyCode: number; modifiers: string[]; label: string } | null => {
  const lower = instructions.toLowerCase();

  if (!/\b(press|hotkey|shortcut|scroll)\b/.test(lower)) {
    return null;
  }

  if (/\bscroll down\b/.test(lower)) {
    return { keyCode: 121, modifiers: [], label: "Page Down" };
  }

  if (/\bscroll up\b/.test(lower)) {
    return { keyCode: 116, modifiers: [], label: "Page Up" };
  }

  if (/\b(command|cmd)\s*[+-]?\s*space\b/.test(lower)) {
    return { keyCode: 49, modifiers: ["command down"], label: "Command-Space" };
  }

  if (/\b(command|cmd)\s*[+-]?\s*l\b/.test(lower)) {
    return { keyCode: 37, modifiers: ["command down"], label: "Command-L" };
  }

  if (/\b(command|cmd)\s*[+-]?\s*tab\b/.test(lower)) {
    return { keyCode: 48, modifiers: ["command down"], label: "Command-Tab" };
  }

  if (/\bescape|esc\b/.test(lower)) {
    return { keyCode: 53, modifiers: [], label: "Escape" };
  }

  if (/\breturn|enter\b/.test(lower)) {
    return { keyCode: 36, modifiers: [], label: "Return" };
  }

  return null;
};

const resolveShellCwd = (value: string | undefined): string => {
  const cwd = value?.trim() || os.homedir();

  if (cwd === "~") {
    return os.homedir();
  }

  if (cwd.startsWith("~/")) {
    return path.join(os.homedir(), cwd.slice(2));
  }

  return path.resolve(cwd);
};

const maxRisk = (a: ComputerRisk, b: ComputerRisk): ComputerRisk => {
  const order: Record<ComputerRisk, number> = {
    low: 0,
    needs_confirmation: 1,
    blocked: 2
  };

  return order[a] >= order[b] ? a : b;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const escapeAppleScriptString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const envBool = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

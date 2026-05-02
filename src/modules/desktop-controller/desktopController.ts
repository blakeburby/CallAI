import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { auditLog } from "../audit-log/auditLogService.js";
import { jarvisChatNotifier } from "../jarvis-chat/jarvisChatNotifier.js";
import { database } from "../../services/dbService.js";
import type {
  DeveloperTask,
  DeveloperTaskRecord,
  ExecutionRunRecord
} from "../../types/operator.js";

const execFileAsync = promisify(execFile);

const desktopActionSchema = z
  .object({
    action: z.enum([
      "navigate",
      "click",
      "type",
      "select",
      "submit",
      "wait",
      "done",
      "ask_user",
      "blocked"
    ]),
    selector: z.string().min(1).max(800).optional(),
    label: z.string().min(1).max(300).optional(),
    value: z.string().min(0).max(1000).optional(),
    url: z.string().url().optional(),
    milliseconds: z.number().int().min(250).max(15000).optional(),
    summary: z.string().min(1).max(500).optional(),
    question: z.string().min(1).max(500).optional(),
    reason: z.string().min(1).max(500).optional(),
    rationale: z.string().min(1).max(500).optional()
  })
  .strict();

type DesktopAction = z.infer<typeof desktopActionSchema>;

type DesktopElement = {
  selector: string;
  tag: string;
  type: string | null;
  role: string | null;
  text: string;
  label: string;
  placeholder: string | null;
  name: string | null;
  href: string | null;
  visible: boolean;
};

type DesktopObservation = {
  title: string | null;
  url: string | null;
  text: string;
  elements: DesktopElement[];
};

type DesktopControlResult = {
  summary: string;
  currentUrl: string | null;
  pageTitle: string | null;
  targetUrl: string | null;
  steps: number;
  status: "completed" | "needs_confirmation" | "blocked";
  reason?: string;
};

type ActionHistoryItem = {
  step: number;
  action: DesktopAction["action"];
  label?: string;
  selector?: string;
  summary?: string;
};

type SnapshotResult = {
  snapshotAvailable: boolean;
  redacted: boolean;
};

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_STEP_TIMEOUT_MS = 15000;
const DEFAULT_BROWSER_APP = "ChatGPT Atlas";
const FALLBACK_BROWSER_APP = "Google Chrome";

const browserAppName = (structured?: DeveloperTask): string => {
  const configured =
    process.env.LOCAL_BRIDGE_BROWSER_APP ||
    process.env.COMPUTER_CONTROL_BROWSER_APP;

  if (configured?.trim()) {
    return configured.trim();
  }

  const requested = structured?.targetApp?.trim();

  if (
    requested &&
    !/^(chrome|google chrome|browser|google)$/i.test(requested)
  ) {
    return requested;
  }

  return DEFAULT_BROWSER_APP;
};

export const desktopController = {
  async runChromeTask(
    task: DeveloperTaskRecord,
    run: ExecutionRunRecord,
    structured: DeveloperTask
  ): Promise<DesktopControlResult> {
    if (process.platform !== "darwin") {
      throw new Error("Desktop control requires the macOS local bridge.");
    }

    const targetUrl = structured.url ?? inferUrl(structured.instructions);
    const browserApp = browserAppName(structured);
    const maxSteps = envInt("DESKTOP_MAX_STEPS", DEFAULT_MAX_STEPS);
    const fastAutonomy = envBool("DESKTOP_FAST_AUTONOMY", true);
    const history: ActionHistoryItem[] = [];

    await auditLog.log({
      task_id: task.id,
      run_id: run.id,
      event_type: "desktop.session_started",
      payload: {
        target_app: browserApp,
        desktop_mode: structured.desktopMode ?? "normal_chrome",
        requested_url: targetUrl,
        risk_level: structured.riskLevel ?? "low",
        fast_autonomy: fastAutonomy,
        max_steps: maxSteps
      }
    });
    void jarvisChatNotifier.taskProgress(
      task,
      `Opening ${browserApp} for task ${task.id.slice(-6)}: ${structured.title}.`,
      "desktop_session_started"
    );

    await openBrowser(browserApp);
    await auditLog.log({
      task_id: task.id,
      run_id: run.id,
      event_type: "desktop.chrome_opened",
      payload: {
        target_app: browserApp,
        desktop_mode: "normal_chrome"
      }
    });
    void jarvisChatNotifier.taskProgress(
      task,
      `${browserApp} is open. Checking the page and choosing the next move.`,
      "desktop_chrome_opened"
    );

    const javascriptAvailable = await chromeJavascriptAvailable(browserApp);

    if (!javascriptAvailable) {
      return runChromeWithoutDom(task, run, structured, targetUrl, browserApp);
    }

    for (let index = 0; index < maxSteps; index += 1) {
      const step = index + 1;
      const observation = await observeChrome(browserApp);
      const observedSnapshot = await recordDesktopSnapshot({
        task,
        run,
        observation,
        latestAction: "Observed page",
        step,
        structured
      });

      await auditLog.log({
        task_id: task.id,
        run_id: run.id,
        event_type: "desktop.observe",
        payload: {
          step,
          current_url: observation.url,
          page_title: observation.title,
          text_preview: observation.text.slice(0, 1200),
          elements: observation.elements.slice(0, 30).map(redactElement),
          snapshot_available: observedSnapshot.snapshotAvailable,
          redacted: observedSnapshot.redacted,
          latest_action_label: "Observed page"
        }
      });

      const planned = await planNextAction({
        structured,
        observation,
        targetUrl,
        history,
        step,
        maxSteps
      });

      await auditLog.log({
        task_id: task.id,
        run_id: run.id,
        event_type: "desktop.action_planned",
        payload: {
          step,
          action: redactAction(planned)
        }
      });

      const safety = evaluateSafety(planned, observation, structured, fastAutonomy);

      if (safety.status === "blocked") {
        const snapshot = await recordDesktopSnapshot({
          task,
          run,
          observation,
          latestAction: `Blocked: ${safety.reason}`,
          step,
          structured,
          action: planned
        });
        await logDesktopBlocked(task, run, safety.reason, step, planned, snapshot);
        return {
          summary: safety.reason,
          currentUrl: observation.url,
          pageTitle: observation.title,
          targetUrl,
          steps: step,
          status: "blocked",
          reason: safety.reason
        };
      }

      if (safety.status === "needs_confirmation") {
        const snapshot = await recordDesktopSnapshot({
          task,
          run,
          observation,
          latestAction: `Approval needed: ${safety.reason}`,
          step,
          structured,
          action: planned
        });
        await auditLog.log({
          task_id: task.id,
          run_id: run.id,
          event_type: "desktop.confirmation_required",
          severity: "warn",
          payload: {
            step,
            reason: safety.reason,
            action: redactAction(planned),
            current_url: observation.url,
            page_title: observation.title,
            snapshot_available: snapshot.snapshotAvailable,
            redacted: snapshot.redacted,
            latest_action_label: `Approval needed: ${safety.reason}`
          }
        });
        void jarvisChatNotifier.taskProgress(
          task,
          `${browserApp} hit an approval gate on task ${task.id.slice(-6)}: ${safety.reason}`,
          "desktop_confirmation_required"
        );
        return {
          summary: safety.reason,
          currentUrl: observation.url,
          pageTitle: observation.title,
          targetUrl,
          steps: step,
          status: "needs_confirmation",
          reason: safety.reason
        };
      }

      if (planned.action === "done") {
        const summary =
          planned.summary ??
          `Completed ${browserApp} task on ${observation.title || observation.url || "the current page"}.`;
        const snapshot = await recordDesktopSnapshot({
          task,
          run,
          observation,
          latestAction: `Done: ${summary}`,
          step,
          structured,
          action: planned
        });
        await auditLog.log({
          task_id: task.id,
          run_id: run.id,
          event_type: "desktop.action_completed",
          payload: {
            step,
            action: "done",
            current_url: observation.url,
            page_title: observation.title,
            summary,
            snapshot_available: snapshot.snapshotAvailable,
            redacted: snapshot.redacted,
            latest_action_label: `Done: ${summary}`
          }
        });
        void jarvisChatNotifier.taskProgress(
          task,
          `${browserApp} finished task ${task.id.slice(-6)}: ${summary}`,
          "desktop_action_completed"
        );
        return {
          summary,
          currentUrl: observation.url,
          pageTitle: observation.title,
          targetUrl,
          steps: step,
          status: "completed"
        };
      }

      const actionResult = await executeAction(planned, browserApp);
      await wait(actionWaitMs(planned));
      const afterObservation = await observeChrome(browserApp).catch(() => observation);
      const latestAction = actionLabel(planned, actionResult);
      const snapshot = await recordDesktopSnapshot({
        task,
        run,
        observation: afterObservation,
        latestAction,
        step,
        structured,
        action: planned
      });

      history.push({
        step,
        action: planned.action,
        label: planned.label,
        selector: planned.selector,
        summary: stringResult(actionResult.summary) ?? undefined
      });

      await auditLog.log({
        task_id: task.id,
        run_id: run.id,
        event_type: "desktop.action_completed",
        payload: {
          step,
          action: redactAction(planned),
          result: actionResult,
          current_url: afterObservation.url,
          page_title: afterObservation.title,
          snapshot_available: snapshot.snapshotAvailable,
          redacted: snapshot.redacted,
          latest_action_label: latestAction
        }
      });
      void jarvisChatNotifier.taskProgress(
        task,
        `${browserApp} step ${step} on task ${task.id.slice(-6)}: ${latestAction}.`,
        "desktop_action_completed"
      );
    }

    const finalObservation = await observeChrome(browserApp);
    await recordDesktopSnapshot({
      task,
      run,
      observation: finalObservation,
      latestAction: "Step limit reached",
      step: maxSteps,
      structured
    });
    return {
      summary: `${browserApp} task reached the ${maxSteps}-step limit on ${finalObservation.title || finalObservation.url || "the current page"}.`,
      currentUrl: finalObservation.url,
      pageTitle: finalObservation.title,
      targetUrl,
      steps: maxSteps,
      status: "completed"
    };
  }
};

const chromeJavascriptAvailable = async (browserApp: string): Promise<boolean> => {
  if (!envBool("DESKTOP_REQUIRE_CHROME_JS_EVENTS", true)) {
    return true;
  }

  try {
    await executeChromeJson(
      z.object({ ok: z.literal(true) }),
      "JSON.stringify({ ok: true })",
      browserApp
    );
    return true;
  } catch {
    return false;
  }
};

const runChromeWithoutDom = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  structured: DeveloperTask,
  targetUrl: string | null,
  browserApp: string
): Promise<DesktopControlResult> => {
  const reason =
    `${browserApp} DOM automation is unavailable from the background bridge. Simple navigation can continue, but clicking, typing, selecting, and form work need browser JavaScript Apple Events access for the LaunchAgent.`;

  if (!targetUrl || requiresDomAutomation(structured.instructions)) {
    await logDesktopBlocked(task, run, reason, 0, {
      action: "blocked",
      reason
    });
    return {
      summary: reason,
      currentUrl: null,
      pageTitle: null,
      targetUrl,
      steps: 0,
      status: "blocked",
      reason
    };
  }

  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "desktop.blocked",
    severity: "warn",
    payload: {
      step: 0,
      reason,
      fallback: "apple_script_navigation_only"
    }
  });

  await navigateChrome(targetUrl, browserApp);
  await wait(actionWaitMs({ action: "navigate", url: targetUrl }));
  const page = await inspectChromeBasic(browserApp);
  const snapshot = await recordDesktopSnapshot({
    task,
    run,
    observation: {
      title: page.title,
      url: page.url,
      text: "",
      elements: []
    },
    latestAction: `Navigated to ${page.title || page.url || targetUrl}`,
    step: 1,
    structured,
    action: {
      action: "navigate",
      url: targetUrl
    }
  });

  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "desktop.action_completed",
    payload: {
      step: 1,
      action: {
        action: "navigate",
        url: targetUrl,
        fallback: "apple_script_navigation_only"
      },
      current_url: page.url,
      page_title: page.title,
      snapshot_available: snapshot.snapshotAvailable,
      redacted: snapshot.redacted,
      latest_action_label: `Navigated to ${page.title || page.url || targetUrl}`
    }
  });
  void jarvisChatNotifier.taskProgress(
    task,
    `${browserApp} navigated for task ${task.id.slice(-6)}: ${page.title || page.url || targetUrl}.`,
    "desktop_action_completed"
  );

  return {
    summary: `Opened ${browserApp} and navigated to ${page.title || page.url || targetUrl}.`,
    currentUrl: page.url,
    pageTitle: page.title,
    targetUrl,
    steps: 1,
    status: "completed"
  };
};

const planNextAction = async (input: {
  structured: DeveloperTask;
  observation: DesktopObservation;
  targetUrl: string | null;
  history: ActionHistoryItem[];
  step: number;
  maxSteps: number;
}): Promise<DesktopAction> => {
  return fallbackAction(input);
};

const recordDesktopSnapshot = async (input: {
  task: DeveloperTaskRecord;
  run: ExecutionRunRecord;
  observation: DesktopObservation;
  latestAction: string;
  step: number;
  structured: DeveloperTask;
  action?: DesktopAction;
}): Promise<SnapshotResult> => {
  const redacted = shouldRedactSnapshot(input);
  let screenshotDataUrl: string | null = null;

  if (!redacted && envBool("DESKTOP_CAPTURE_SCREENSHOTS", true)) {
    try {
      screenshotDataUrl = await captureChromeScreenshot(browserAppName(input.structured));
    } catch (error) {
      await auditLog.log({
        task_id: input.task.id,
        run_id: input.run.id,
        event_type: "desktop.snapshot_failed",
        severity: "warn",
        payload: {
          step: input.step,
          error: reasonWithDetail("Screenshot capture failed.", error)
        }
      });
    }
  }

  await database.upsertDesktopSnapshot({
    task_id: input.task.id,
    run_id: input.run.id,
    current_url: sanitizeUrlForDisplay(input.observation.url),
    page_title: input.observation.title,
    latest_action: input.latestAction.slice(0, 600),
    step: input.step,
    screenshot_data_url: redacted ? null : screenshotDataUrl,
    redacted
  });

  return {
    snapshotAvailable: Boolean(screenshotDataUrl),
    redacted
  };
};

const shouldRedactSnapshot = (input: {
  observation: DesktopObservation;
  structured: DeveloperTask;
  latestAction: string;
  action?: DesktopAction;
}): boolean => {
  const combined = [
    input.observation.url,
    input.observation.title,
    input.observation.text.slice(0, 1600),
    input.structured.instructions,
    input.latestAction,
    input.action?.action,
    input.action?.label,
    input.action?.selector,
    input.action?.reason,
    input.action?.rationale
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\b(password|passcode|login|log in|sign in|signin|secret|api key|token|oauth|credit card|card number|cvv|payment|billing|checkout|bank|wire|ssn|social security|2fa|otp|captcha|account security|security settings|change password|credential)\b/i.test(
    combined
  );
};

const captureChromeScreenshot = async (browserApp: string): Promise<string | null> => {
  const region = await chromeWindowRegion(browserApp);

  if (!region) {
    return null;
  }

  const path = `/tmp/callai-desktop-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.jpg`;

  try {
    await execFileAsync("screencapture", ["-x", "-t", "jpg", "-R", region, path], {
      timeout: envInt("DESKTOP_STEP_TIMEOUT_MS", DEFAULT_STEP_TIMEOUT_MS)
    });
    await compressScreenshot(path);
    const image = await readFile(path);
    return `data:image/jpeg;base64,${image.toString("base64")}`;
  } finally {
    await unlink(path).catch(() => {});
  }
};

const compressScreenshot = async (path: string): Promise<void> => {
  await execFileAsync(
    "sips",
    ["-s", "format", "jpeg", "-s", "formatOptions", "48", "-Z", "1100", path, "--out", path],
    {
      timeout: 10000
    }
  ).catch(() => {});
};

const chromeWindowRegion = async (browserApp: string): Promise<string | null> => {
  const output = await runAppleScript([
    'tell application "System Events"',
    `  tell process "${escapeAppleScriptString(browserApp)}"`,
    '    if not (exists window 1) then return ""',
    "    set p to position of front window",
    "    set s to size of front window",
    "    set leftEdge to item 1 of p",
    "    set topEdge to item 2 of p",
    "    set rightEdge to leftEdge + item 1 of s",
    "    set bottomEdge to topEdge + item 2 of s",
    "    return (leftEdge as text) & \",\" & (topEdge as text) & \",\" & (rightEdge as text) & \",\" & (bottomEdge as text)",
    "  end tell",
    "end tell"
  ]);
  const [left, top, right, bottom] = output
    .split(/[,\s]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (
    left === undefined ||
    top === undefined ||
    right === undefined ||
    bottom === undefined
  ) {
    return null;
  }

  const x = Math.max(0, Math.round(left));
  const y = Math.max(0, Math.round(top));
  const width = Math.max(1, Math.round(right - left));
  const height = Math.max(1, Math.round(bottom - top));

  if (width < 80 || height < 80) {
    return null;
  }

  return `${x},${y},${width},${height}`;
};

const fallbackAction = (input: {
  structured: DeveloperTask;
  observation: DesktopObservation;
  targetUrl: string | null;
  history: ActionHistoryItem[];
}): DesktopAction => {
  const currentUrl = input.observation.url ?? "";

  if (
    input.targetUrl &&
    !sameNormalizedUrl(currentUrl, input.targetUrl) &&
    !input.history.some((item) => item.action === "navigate")
  ) {
    return {
      action: "navigate",
      url: input.targetUrl,
      rationale: "Navigate to the requested destination."
    };
  }

  const fill = input.structured.instructions.match(
    /\bfill(?: out)?(?: the)?\s+(.+?)\s+(?:field|box|input)?\s+with\s+(.+?)[.!?]?$/i
  );

  if (fill?.[1] && fill?.[2] && !input.history.some((item) => item.action === "type")) {
    return {
      action: "type",
      label: fill[1].trim(),
      value: fill[2].trim(),
      rationale: "Fill the requested non-sensitive field."
    };
  }

  return {
    action: "done",
    summary: `${browserAppName(input.structured)} is on ${input.observation.title || input.observation.url || "the requested page"}.`
  };
};

const executeAction = async (
  action: DesktopAction,
  browserApp: string
): Promise<Record<string, unknown>> => {
  switch (action.action) {
    case "navigate": {
      if (!action.url) {
        throw new Error("Desktop navigate action did not include a URL.");
      }
      await navigateChrome(action.url, browserApp);
      return { summary: `Navigated to ${action.url}.` };
    }
    case "click": {
      return executeChromeJson(
        z.object({
          ok: z.boolean(),
          clicked: z.string().nullable()
        }),
        buildClickScript(action),
        browserApp
      );
    }
    case "type": {
      return executeChromeJson(
        z.object({
          ok: z.boolean(),
          target: z.string().nullable()
        }),
        buildTypeScript(action),
        browserApp
      );
    }
    case "select": {
      return executeChromeJson(
        z.object({
          ok: z.boolean(),
          target: z.string().nullable(),
          selected: z.string().nullable()
        }),
        buildSelectScript(action),
        browserApp
      );
    }
    case "submit": {
      return executeChromeJson(
        z.object({
          ok: z.boolean(),
          submitted: z.string().nullable()
        }),
        buildSubmitScript(action),
        browserApp
      );
    }
    case "wait": {
      await wait(action.milliseconds ?? 1000);
      return { summary: `Waited ${action.milliseconds ?? 1000}ms.` };
    }
    case "ask_user":
    case "blocked":
    case "done":
      return { summary: action.summary ?? action.reason ?? action.action };
  }
};

const evaluateSafety = (
  action: DesktopAction,
  observation: DesktopObservation,
  structured: DeveloperTask,
  fastAutonomy: boolean
): { status: "allowed" | "needs_confirmation" | "blocked"; reason: string } => {
  const combined = [
    action.action,
    action.label,
    action.selector,
    action.reason,
    action.rationale,
    action.summary,
    structured.instructions,
    observation.title,
    observation.url,
    observation.text.slice(0, 1200)
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (action.action === "blocked" || hasBlockedRisk(combined)) {
    return {
      status: "blocked",
      reason:
        action.reason ??
        "Desktop control blocked before handling credentials, secrets, payments, banking, purchases, CAPTCHAs, or protected account changes."
    };
  }

  if (action.action === "ask_user") {
    return {
      status: "needs_confirmation",
      reason:
        action.question ??
        action.reason ??
        "Desktop control needs approval before taking the next website action."
    };
  }

  if (requiresConfirmation(action, combined) && !structured.desktopApprovalGranted) {
    return {
      status: "needs_confirmation",
      reason:
        "Desktop control needs approval before taking an externally visible or account-changing website action."
    };
  }

  if (!fastAutonomy && action.action === "submit" && !structured.desktopApprovalGranted) {
    return {
      status: "needs_confirmation",
      reason: "Desktop control needs approval before submitting this form."
    };
  }

  return { status: "allowed", reason: "allowed" };
};

const requiresConfirmation = (action: DesktopAction, combined: string): boolean => {
  if (action.action === "submit" && !isLowRiskSubmit(combined)) {
    return true;
  }

  if (action.action === "click" || action.action === "submit") {
    return /\b(send|post|reply|comment|publish|upload|attach|save settings|change settings|create account|sign up|log in|login|sign in|submit|delete|remove|deploy|merge)\b/i.test(
      combined
    );
  }

  if (action.action === "type") {
    return /\b(email|message|comment|reply|address|phone|account)\b/i.test(combined);
  }

  return false;
};

const hasBlockedRisk = (combined: string): boolean => {
  return /\b(password|passcode|secret|api key|token|credit card|card number|cvv|payment|bank|wire|ssn|social security|2fa|otp|captcha|delete account|change password|credential)\b/i.test(
    combined
  );
};

const isLowRiskSubmit = (combined: string): boolean => {
  return /\b(search|filter|find|lookup|query)\b/i.test(combined);
};

const requiresDomAutomation = (instructions: string): boolean => {
  return /\b(click|type|fill|select|choose|submit|press|form|field|button|dropdown|upload|attach|send|post|reply|comment)\b/i.test(
    instructions
  );
};

const observeChrome = async (browserApp: string): Promise<DesktopObservation> => {
  return executeChromeJson(
    z.object({
      title: z.string().nullable(),
      url: z.string().nullable(),
      text: z.string(),
      elements: z.array(
        z.object({
          selector: z.string(),
          tag: z.string(),
          type: z.string().nullable(),
          role: z.string().nullable(),
          text: z.string(),
          label: z.string(),
          placeholder: z.string().nullable(),
          name: z.string().nullable(),
          href: z.string().nullable(),
          visible: z.boolean()
        })
      )
    }),
    OBSERVE_SCRIPT,
    browserApp
  );
};

const openBrowser = async (browserApp: string): Promise<void> => {
  try {
    await runAppleScript([
      `tell application "${escapeAppleScriptString(browserApp)}"`,
      "  activate",
      "  if not (exists window 1) then make new window",
      "end tell"
    ]);
  } catch (error) {
    if (browserApp === FALLBACK_BROWSER_APP) {
      throw error;
    }

    await execFileAsync("open", ["-a", browserApp]).catch(async () => {
      await runAppleScript([
        `tell application "${FALLBACK_BROWSER_APP}"`,
        "  activate",
        "  if not (exists window 1) then make new window",
        "end tell"
      ]);
    });
  }
};

const navigateChrome = async (url: string, browserApp: string): Promise<void> => {
  try {
    await runAppleScript([
      `tell application "${escapeAppleScriptString(browserApp)}"`,
      "  activate",
      "  if not (exists window 1) then make new window",
      `  set URL of active tab of front window to "${escapeAppleScriptString(url)}"`,
      "end tell"
    ]);
  } catch (error) {
    await execFileAsync("open", ["-a", browserApp, url], {
      timeout: envInt("DESKTOP_STEP_TIMEOUT_MS", DEFAULT_STEP_TIMEOUT_MS)
    }).catch(async () => {
      if (browserApp === FALLBACK_BROWSER_APP) {
        throw error;
      }

      await execFileAsync("open", ["-a", FALLBACK_BROWSER_APP, url], {
        timeout: envInt("DESKTOP_STEP_TIMEOUT_MS", DEFAULT_STEP_TIMEOUT_MS)
      });
    });
  }
};

const inspectChromeBasic = async (
  browserApp: string
): Promise<{
  title: string | null;
  url: string | null;
}> => {
  const output = await runAppleScript([
    `tell application "${escapeAppleScriptString(browserApp)}"`,
    '  if not (exists window 1) then return ""',
    "  set pageTitle to title of active tab of front window",
    "  set pageUrl to URL of active tab of front window",
    "  return pageTitle & linefeed & pageUrl",
    "end tell"
  ]);
  const [title, url] = output.split(/\r?\n/).map((value) => value.trim());

  return {
    title: title || null,
    url: url || null
  };
};

const executeChromeJson = async <T>(
  schema: z.ZodType<T>,
  javascript: string,
  browserApp: string
): Promise<T> => {
  const raw = await runJxa(`
    const browser = Application(${JSON.stringify(browserApp)});
    browser.activate();
    if (browser.windows.length === 0) {
      throw new Error(${JSON.stringify(`${browserApp} has no open windows.`)});
    }
    browser.windows[0].activeTab.execute({
      javascript: ${JSON.stringify(javascript)}
    });
  `);

  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(reasonWithDetail(`${browserApp} returned an invalid automation result.`, error));
  }
};

const runJxa = async (script: string): Promise<string> => {
  const { stdout, stderr } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    timeout: envInt("DESKTOP_STEP_TIMEOUT_MS", DEFAULT_STEP_TIMEOUT_MS)
  });

  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return stdout.trim();
};

const runAppleScript = async (lines: string[]): Promise<string> => {
  const { stdout, stderr } = await execFileAsync(
    "osascript",
    lines.flatMap((line) => ["-e", line]),
    {
      timeout: envInt("DESKTOP_STEP_TIMEOUT_MS", DEFAULT_STEP_TIMEOUT_MS)
    }
  );

  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return stdout.trim();
};

const logDesktopBlocked = async (
  task: DeveloperTaskRecord,
  run: ExecutionRunRecord,
  reason: string,
  step: number,
  action: DesktopAction,
  snapshot: SnapshotResult = { snapshotAvailable: false, redacted: false }
): Promise<void> => {
  await auditLog.log({
    task_id: task.id,
    run_id: run.id,
    event_type: "desktop.blocked",
    severity: "warn",
    payload: {
      step,
      reason,
      action: redactAction(action),
      snapshot_available: snapshot.snapshotAvailable,
      redacted: snapshot.redacted,
      latest_action_label: `Blocked: ${reason}`
    }
  });
};

const buildClickScript = (action: DesktopAction): string => {
  return buildElementActionScript(action, `
    element.click();
    return JSON.stringify({ ok: true, clicked: describeElement(element) });
  `);
};

const buildTypeScript = (action: DesktopAction): string => {
  return buildElementActionScript(action, `
    const value = ${JSON.stringify(action.value ?? "")};
    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      element.focus();
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return JSON.stringify({ ok: true, target: describeElement(element) });
  `);
};

const buildSelectScript = (action: DesktopAction): string => {
  return buildElementActionScript(action, `
    const wanted = ${JSON.stringify(action.value ?? action.label ?? "")}.toLowerCase();
    let selected = null;
    if (element.tagName.toLowerCase() === "select") {
      for (const option of Array.from(element.options)) {
        const text = (option.textContent || "").trim().toLowerCase();
        const value = String(option.value || "").trim().toLowerCase();
        if (text === wanted || value === wanted || text.includes(wanted)) {
          element.value = option.value;
          selected = option.textContent || option.value;
          break;
        }
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return JSON.stringify({ ok: Boolean(selected), target: describeElement(element), selected });
  `);
};

const buildSubmitScript = (action: DesktopAction): string => {
  return buildElementActionScript(action, `
    const form = element.form || element.closest("form");
    if (form) {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return JSON.stringify({ ok: true, submitted: describeElement(form) });
    }
    element.click();
    return JSON.stringify({ ok: true, submitted: describeElement(element) });
  `);
};

const HELPER_SCRIPT = `
function cleanText(value) {
  return String(value || "").replace(/\\s+/g, " ").trim().slice(0, 500);
}
function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}
function labelFor(element) {
  const labels = [];
  if (element.id) {
    const label = document.querySelector("label[for='" + escapeCss(element.id) + "']");
    if (label) labels.push(label.innerText || label.textContent || "");
  }
  const parentLabel = element.closest("label");
  if (parentLabel) labels.push(parentLabel.innerText || parentLabel.textContent || "");
  labels.push(element.getAttribute("aria-label") || "");
  labels.push(element.getAttribute("placeholder") || "");
  labels.push(element.getAttribute("name") || "");
  labels.push(element.innerText || element.textContent || "");
  return cleanText(labels.find((value) => cleanText(value)) || "");
}
function cssPath(element) {
  if (element.id) return "#" + escapeCss(element.id);
  const parts = [];
  let node = element;
  while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    let selector = node.nodeName.toLowerCase();
    if (node.classList && node.classList.length) {
      selector += "." + Array.from(node.classList).slice(0, 2).map((item) => escapeCss(item)).join(".");
    }
    const parent = node.parentNode;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.nodeName === node.nodeName);
      if (siblings.length > 1) selector += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
    }
    parts.unshift(selector);
    node = node.parentElement;
  }
  return parts.join(" > ");
}
function escapeCss(value) {
  if (window.CSS && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
}
function normalized(value) {
  return cleanText(value).toLowerCase();
}
function describeElement(element) {
  return cleanText(labelFor(element) || element.tagName.toLowerCase());
}
function findElement(selector, label) {
  if (selector) {
    try {
      const selected = document.querySelector(selector);
      if (selected) return selected;
    } catch {}
  }
  const wanted = normalized(label);
  if (!wanted) return null;
  const candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']"))
    .filter(isVisible);
  return candidates.find((element) => normalized(labelFor(element)) === wanted)
    || candidates.find((element) => normalized(labelFor(element)).includes(wanted))
    || candidates.find((element) => wanted.includes(normalized(labelFor(element))));
}
`;

const buildElementActionScript = (action: DesktopAction, body: string): string => {
  return `
(() => {
  const selector = ${JSON.stringify(action.selector ?? "")};
  const label = ${JSON.stringify(action.label ?? "")};
  ${HELPER_SCRIPT}
  const element = findElement(selector, label);
  if (!element) {
    return JSON.stringify({ ok: false, clicked: null, target: null, selected: null, submitted: null });
  }
  ${body}
})()
`;
};

const OBSERVE_SCRIPT = `
(() => {
  try {
    ${HELPER_SCRIPT}
    const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']"))
      .filter(isVisible)
      .slice(0, 80)
      .map((element) => ({
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        role: element.getAttribute("role"),
        text: cleanText(element.innerText || element.textContent || element.getAttribute("aria-label") || ""),
        label: cleanText(labelFor(element)),
        placeholder: element.getAttribute("placeholder"),
        name: element.getAttribute("name"),
        href: element.href || null,
        visible: isVisible(element)
      }));
    const text = cleanText(document.body ? document.body.innerText || "" : "").slice(0, 5000);
    return JSON.stringify({
      title: document.title || null,
      url: location.href || null,
      text,
      elements
    });
  } catch (error) {
    return JSON.stringify({
      title: document.title || null,
      url: location.href || null,
      text: document.body ? String(document.body.innerText || "").slice(0, 5000) : "",
      elements: [],
      observe_error: String(error && error.message ? error.message : error)
    });
  }
})()
`;

const inferUrl = (instructions: string): string | null => {
  const explicit = instructions.match(/https?:\/\/[^\s"')]+/i)?.[0];

  if (explicit) {
    return normalizeUrl(explicit);
  }

  const domain = instructions.match(
    /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|org|net|ai|io|dev|app|co|edu|gov)(?:\/[^\s"')]+)?)\b/i
  )?.[1];

  if (domain) {
    return normalizeUrl(domain);
  }

  const lower = instructions.toLowerCase();
  const githubSearch = lower.match(/\b(?:github|git hub)\b.*\bsearch(?: for)?\s+(.+)$/i);

  if (githubSearch?.[1]) {
    return `https://github.com/search?q=${encodeURIComponent(
      cleanSearchQuery(githubSearch[1])
    )}&type=repositories`;
  }

  const search = lower.match(/\b(?:search|google)\s+(?:for\s+)?(.+)$/i);

  if (search?.[1]) {
    return `https://www.google.com/search?q=${encodeURIComponent(
      cleanSearchQuery(search[1])
    )}`;
  }

  return null;
};

const normalizeUrl = (value: string): string => {
  const clean = value.replace(/[.,!?]+$/g, "");
  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
};

const sameNormalizedUrl = (left: string, right: string): boolean => {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname.replace(/\/$/, "") === rightUrl.pathname.replace(/\/$/, "") &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return left.replace(/\/$/, "") === right.replace(/\/$/, "");
  }
};

const cleanSearchQuery = (value: string): string => {
  return value.replace(/[.!?]+$/g, "").trim();
};

const redactElement = (element: DesktopElement): DesktopElement => ({
  ...element,
  placeholder: isSensitiveText(element.placeholder) ? "[redacted]" : element.placeholder,
  name: isSensitiveText(element.name) ? "[redacted]" : element.name
});

const redactAction = (action: DesktopAction): Record<string, unknown> => ({
  ...action,
  value: action.value ? "[redacted]" : undefined
});

const actionLabel = (
  action: DesktopAction,
  result: Record<string, unknown>
): string => {
  const target =
    action.label ||
    action.url ||
    stringResult(result.clicked) ||
    stringResult(result.target) ||
    stringResult(result.selected) ||
    stringResult(result.submitted) ||
    stringResult(result.summary);

  if (!target) {
    return formatActionName(action.action);
  }

  return `${formatActionName(action.action)}: ${target}`.slice(0, 600);
};

const formatActionName = (action: DesktopAction["action"]): string =>
  action.replaceAll("_", " ");

const stringResult = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const sanitizeUrlForDisplay = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/secret|token|key|password|passcode|code|auth|session|sid/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return value.replace(
      /([?&][^=]*(?:secret|token|key|password|passcode|code|auth|session|sid)[^=]*=)[^&]+/gi,
      "$1[redacted]"
    );
  }
};

const isSensitiveText = (value: string | null | undefined): boolean =>
  Boolean(value && /\b(password|secret|token|key|credit|card|cvv|ssn|otp|2fa)\b/i.test(value));

const actionWaitMs = (action: DesktopAction): number => {
  if (action.action === "wait") {
    return action.milliseconds ?? 1000;
  }

  if (action.action === "navigate" || action.action === "submit" || action.action === "click") {
    return Number(process.env.DESKTOP_NAVIGATION_WAIT_MS ?? 1800);
  }

  return 500;
};

const envBool = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const envInt = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const escapeAppleScriptString = (value: string): string => {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
};

const reasonWithDetail = (message: string, error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);
  return detail ? `${message} ${detail}` : message;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

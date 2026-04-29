import type VapiClient from "@vapi-ai/web";
import "./styles.css";

type AppConfig = {
  assistantId: string;
  assistantName: string;
  backendUrl: string;
  sms: SmsConfigSnapshot;
  vapiPublicKey: string;
};

type FrontendBootstrap = {
  authenticated: boolean;
  configError?: string;
} & Partial<AppConfig>;

type SmsConfigSnapshot = {
  enabled: boolean;
  ownerPhoneTail: string | null;
  fromNumberTail: string | null;
};

type SmsOverview = SmsConfigSnapshot & {
  configured: boolean;
  webhookAuthMode: "query_secret" | "twilio_signature" | "mixed" | "unknown";
  verificationState: "approved" | "pending" | "rejected" | "unknown";
  deliveryState: "healthy" | "degraded" | "blocked" | "unknown";
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastOutboundStatus: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  attention: string[];
};

type SmsHealthMessage = {
  sid: string | null;
  direction: "inbound" | "outbound";
  role: "user" | "assistant" | "system";
  bodyPreview: string;
  createdAt: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  source: "conversation" | "twilio_api" | "audit";
};

type SmsHealthData = {
  summary: SmsOverview;
  verification: {
    state: "approved" | "pending" | "rejected" | "unknown";
    source: "twilio_api" | "manual_console_required" | "not_configured";
    detail: string;
    checkedAt: string;
  };
  webhook: {
    authMode: "query_secret" | "twilio_signature" | "mixed" | "unknown";
    querySecretConfigured: boolean;
    twilioSignatureConfigured: boolean;
    ownerPhoneTail: string | null;
    fromNumberTail: string | null;
  };
  recentMessages: SmsHealthMessage[];
  recentFailures: SmsHealthMessage[];
};

type Status = "locked" | "ready" | "connecting" | "in-call" | "ended" | "error";

type LogEntry = {
  at: string;
  title: string;
  detail?: string;
  tone?: "info" | "success" | "error" | "warn";
};

type DeveloperTask = {
  action: string;
  title: string;
  repoAlias?: string;
  permissionRequired: string;
  instructions: string;
  acceptanceCriteria: string[];
  targetApp?: "chrome";
  url?: string;
  riskLevel?: "low" | "needs_confirmation" | "blocked";
  desktopMode?: "normal_chrome";
  desktopApprovalGranted?: boolean;
  confidence: number;
};

type TaskRecord = {
  id: string;
  title: string;
  raw_request: string;
  normalized_action: string;
  structured_request: DeveloperTask;
  status: string;
  permission_required: string;
  execution_target: "runner" | "codex_thread";
  repo_id: string | null;
  created_at: string;
  updated_at: string;
};

type AuditEvent = {
  id: string;
  event_type: string;
  severity: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type Confirmation = {
  id: string;
  task_id: string;
  prompt: string;
  risk: string;
  status: string;
  expires_at: string;
};

type ExecutionRun = {
  id: string;
  executor: string;
  branch_name: string | null;
  status: string;
  final_summary: string | null;
};

type CodexThreadJob = {
  id: string;
  task_id: string;
  status: string;
  thread_label: string;
  claimed_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  final_summary: string | null;
  created_at: string;
  updated_at: string;
};

type DesktopState = {
  task_id: string;
  run_id: string | null;
  current_url: string | null;
  page_title: string | null;
  latest_action: string | null;
  step: number;
  screenshot_data_url: string | null;
  redacted: boolean;
  updated_at: string | null;
};

type TaskStatusData = {
  task: TaskRecord;
  latest_events: AuditEvent[];
  runs: ExecutionRun[];
  codex_thread_job?: CodexThreadJob;
  confirmation?: Confirmation;
  final_summary?: string;
};

type TaskListData = {
  tasks: TaskRecord[];
  confirmations: Confirmation[];
};

type OverviewData = TaskListData & {
  counts: Record<string, number>;
  runner: {
    status: string;
    runner_id: string | null;
    task_scope: string | null;
    last_event_type: string | null;
    last_seen_at: string | null;
    active_task_id: string | null;
    active_task_title: string | null;
  };
  codex_thread: {
    enabled: boolean;
    status: string;
    waiting_count: number;
    active_task_id: string | null;
    active_task_title: string | null;
    oldest_waiting_at: string | null;
    stale: boolean;
    last_event_type: string | null;
    last_seen_at: string | null;
  };
  sms: SmsOverview;
  database: {
    configured: boolean;
    ok: boolean;
    message: string;
  };
  last_activity_at: string | null;
};

type TaskCreationData = {
  task_id: string;
  status: string;
  interpreted_task: DeveloperTask;
  needs_confirmation: boolean;
  confirmation_id?: string;
};

type OutboundCallData = {
  call_id?: string;
  status: string;
  phone_number: string;
};

type QuickTask = {
  label: string;
  prompt: string;
  repoHint?: string;
};

const quickTasks: QuickTask[] = [
  {
    label: "Inspect main repo",
    prompt:
      "Inspect the main repo and tell me whether it is clean, healthy, and ready for work.",
    repoHint: "main repo"
  },
  {
    label: "Run checks",
    prompt:
      "Run the configured build and checks for the main repo, then summarize any failures clearly.",
    repoHint: "main repo"
  },
  {
    label: "Update README",
    prompt:
      "Update the README in the main repo on a new branch and prepare the change for review.",
    repoHint: "main repo"
  },
  {
    label: "Open Chrome",
    prompt: "Open Chrome on my Mac and go to example.com."
  },
  {
    label: "Search GitHub",
    prompt: "Open Chrome and search GitHub for CallAI."
  },
  {
    label: "Google Vapi",
    prompt: "Open Chrome, search Google for Vapi phone numbers, and summarize the page."
  },
  {
    label: "Summarize progress",
    prompt:
      "Summarize the latest CallAI task activity and tell me what still needs my attention."
  }
];

const state: {
  config: AppConfig | null;
  confirmations: Confirmation[];
  desktopState: DesktopState | null;
  error: string;
  logs: LogEntry[];
  muted: boolean;
  overview: OverviewData | null;
  outboundPhone: string;
  outboundReason: string;
  selectedTaskId: string | null;
  smsHealth: SmsHealthData | null;
  status: Status;
  statusDetail: string;
  taskDetail: TaskStatusData | null;
  tasks: TaskRecord[];
  taskDraft: string;
  repoHint: string;
  vapi: VapiClient | null;
} = {
  config: null,
  confirmations: [],
  desktopState: null,
  error: "",
  logs: [],
  muted: false,
  overview: null,
  outboundPhone: "+19712670353",
  outboundReason: "CallAI dashboard check-in",
  selectedTaskId: null,
  smsHealth: null,
  status: "locked",
  statusDetail: "Unlock the dashboard to control CallAI.",
  taskDetail: null,
  tasks: [],
  taskDraft: "",
  repoHint: "main repo",
  vapi: null
};

type VapiConstructor = new (apiToken: string) => VapiClient;

const app = document.querySelector<HTMLDivElement>("#app");
let refreshTimer: number | null = null;
let vapiConstructorPromise: Promise<VapiConstructor> | null = null;

if (!app) {
  throw new Error("App root was not found.");
}

const setStatus = (status: Status, detail: string): void => {
  state.status = status;
  state.statusDetail = detail;
  render();
};

const addLog = (
  title: string,
  detail?: unknown,
  tone: LogEntry["tone"] = "info"
): void => {
  state.logs = [
    {
      at: new Date().toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      }),
      detail: formatDetail(detail),
      title,
      tone
    },
    ...state.logs
  ].slice(0, 120);
  render();
};

const request = async <T>(
  path: string,
  options: RequestInit = {}
): Promise<T> => {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });
  const payload = (await response.json()) as {
    success: boolean;
    error?: string;
    data?: T;
  };

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload.data as T;
};

const loadConfig = async (): Promise<void> => {
  try {
    const bootstrap = await request<FrontendBootstrap>("/frontend/bootstrap");

    if (!bootstrap.authenticated) {
      showLockedDashboard();
      return;
    }

    if (!isAppConfig(bootstrap)) {
      throw new Error(
        bootstrap.configError || "Frontend configuration is incomplete."
      );
    }

    await activateConfig(bootstrap);
  } catch (error) {
    stopPolling();
    renderFatalBootError(error);
  }
};

const activateConfig = async (config: AppConfig): Promise<void> => {
  state.config = config;
  state.error = "";
  try {
    await createVapiClient(config);
  } catch (error) {
    state.vapi = null;
    state.error = getErrorMessage(error);
    addLog("Browser voice unavailable", state.error, "warn");
  }
  setStatus(
    "ready",
    state.vapi
      ? "Dashboard online. Voice, SMS, and task control are available."
      : "Dashboard online. SMS and task control are available; browser voice needs attention."
  );
  addLog("Dashboard ready", config.assistantName, "success");
  await refreshOperatorData();
  startPolling();
};

const showLockedDashboard = (): void => {
  stopPolling();
  state.config = null;
  state.vapi = null;
  state.status = "locked";
  state.statusDetail = "Unlock the dashboard to control CallAI.";
  state.error = "";
  render();
};

const isAppConfig = (value: FrontendBootstrap): value is FrontendBootstrap & AppConfig => {
  return (
    typeof value.assistantId === "string" &&
    typeof value.assistantName === "string" &&
    typeof value.backendUrl === "string" &&
    typeof value.vapiPublicKey === "string" &&
    Boolean(value.sms)
  );
};

const renderFatalBootError = (error: unknown): void => {
  state.config = null;
  state.vapi = null;
  state.status = "error";
  state.statusDetail = "The dashboard could not finish starting.";
  state.error = getErrorMessage(error);
  app.innerHTML = `
    <main class="lock-shell">
      <section class="lock-copy" aria-label="CallAI dashboard startup error">
        <p class="eyebrow">Startup Error</p>
        <h1>Jarvis Dashboard</h1>
        <p>The dashboard loaded, but startup did not finish. Reload the page, or show the login screen and try again.</p>
      </section>
      <section class="login-panel" aria-label="Startup recovery">
        <p class="error-text">${escapeHtml(state.error || "Unknown startup error.")}</p>
        <div class="login-row">
          <button class="primary" id="reload-page" type="button">Reload</button>
          <button id="show-login" type="button">Show Login</button>
        </div>
      </section>
    </main>
  `;
  document
    .querySelector<HTMLButtonElement>("#reload-page")
    ?.addEventListener("click", () => window.location.reload());
  document
    .querySelector<HTMLButtonElement>("#show-login")
    ?.addEventListener("click", showLockedDashboard);
};

const createVapiClient = async (config: AppConfig): Promise<void> => {
  state.vapi?.removeAllListeners();
  const Vapi = await loadVapiConstructor();
  const client = new Vapi(config.vapiPublicKey);

  client.on("call-start", () => {
    setStatus("in-call", "Browser voice connected. Jarvis is ready for developer work.");
    addLog("Browser call started", undefined, "success");
  });

  client.on("call-end", () => {
    state.muted = false;
    setStatus("ended", "Call ended. Queued work can continue on the runner.");
    addLog("Call ended");
    void refreshOperatorData();
  });

  client.on("call-start-progress", (event) => {
    addLog(`Start progress: ${event.stage}`, event.status);
  });

  client.on("call-start-success", (event) => {
    addLog("Call start succeeded", event, "success");
  });

  client.on("call-start-failed", (event) => {
    state.error = event.error;
    setStatus("error", "Call failed to start.");
    addLog("Call start failed", event, "error");
  });

  client.on("speech-start", () => addLog("Assistant speech started"));
  client.on("speech-end", () => addLog("Assistant speech ended"));
  client.on("volume-level", (volume) => updateVolume(volume));
  client.on("message", (message) => {
    addLog(describeMessage(message), message);
    void refreshOperatorData();
  });
  client.on("error", (error) => {
    state.error = getErrorMessage(error);
    setStatus("error", "Vapi reported an error.");
    addLog("Vapi error", error, "error");
  });

  state.vapi = client;
};

const loadVapiConstructor = async (): Promise<VapiConstructor> => {
  vapiConstructorPromise ??= import("@vapi-ai/web").then(resolveVapiConstructor);
  return vapiConstructorPromise;
};

const resolveVapiConstructor = (module: unknown): VapiConstructor => {
  const candidate = module as unknown;

  if (typeof candidate === "function") {
    return candidate as VapiConstructor;
  }

  const defaultExport = (candidate as { default?: unknown }).default;

  if (typeof defaultExport === "function") {
    return defaultExport as VapiConstructor;
  }

  throw new Error("Vapi web SDK did not export a browser constructor.");
};

const login = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const passcode = new FormData(form).get("passcode");

  if (typeof passcode !== "string" || passcode.trim().length === 0) {
    state.error = "Enter the frontend passcode.";
    render();
    return;
  }

  try {
    state.error = "";
    await request<never>("/frontend/login", {
      body: JSON.stringify({ passcode }),
      method: "POST"
    });
    form.reset();
    await loadConfig();
  } catch (error) {
    state.error = getErrorMessage(error);
    render();
  }
};

const logout = async (): Promise<void> => {
  stopPolling();

  if (state.status === "in-call" || state.status === "connecting") {
    await endCall();
  }

  await request<never>("/frontend/logout", { method: "POST" }).catch(() => {});
  state.config = null;
  state.confirmations = [];
  state.desktopState = null;
  state.error = "";
  state.logs = [];
  state.muted = false;
  state.overview = null;
  state.selectedTaskId = null;
  state.smsHealth = null;
  state.taskDetail = null;
  state.tasks = [];
  state.vapi = null;
  setStatus("locked", "Logged out.");
};

const startCall = async (): Promise<void> => {
  if (!state.config) {
    state.error = "Login is required before starting a call.";
    render();
    return;
  }

  if (!state.vapi) {
    state.error =
      "Browser voice is unavailable because the Vapi web SDK did not initialize. Refresh the page or use outbound calling.";
    addLog("Browser call unavailable", state.error, "warn");
    render();
    return;
  }

  try {
    state.error = "";
    setStatus("connecting", "Requesting microphone access and joining the browser call...");
    addLog("Starting browser call");
    const call = await state.vapi.start(state.config.assistantId);
    addLog("Call request created", call, "success");
  } catch (error) {
    state.error = getMicAwareError(error);
    setStatus("error", "Could not start the browser call.");
    addLog("Start call failed", state.error, "error");
  }
};

const endCall = async (): Promise<void> => {
  try {
    await state.vapi?.stop();
    state.muted = false;
    setStatus("ended", "Call ended.");
  } catch (error) {
    state.error = getErrorMessage(error);
    setStatus("error", "Could not end the call cleanly.");
    addLog("End call failed", state.error, "error");
  }
};

const toggleMute = (): void => {
  if (!state.vapi) {
    return;
  }

  state.muted = !state.muted;
  state.vapi.setMuted(state.muted);
  addLog(state.muted ? "Microphone muted" : "Microphone unmuted");
  render();
};

const refreshOperatorData = async (): Promise<void> => {
  if (!state.config) {
    return;
  }

  try {
    const [overview, smsHealth, data] = await Promise.all([
      request<OverviewData>("/operator/overview"),
      request<SmsHealthData>("/operator/sms/health"),
      request<TaskListData>("/operator/tasks")
    ]);
    state.overview = overview;
    state.smsHealth = smsHealth;
    state.tasks = overview.tasks.length ? overview.tasks : data.tasks;
    state.confirmations = overview.confirmations.length
      ? overview.confirmations
      : data.confirmations;

    if (!state.selectedTaskId && state.tasks[0]) {
      state.selectedTaskId = state.tasks[0].id;
    }

    if (state.selectedTaskId) {
      const [detail, desktopState] = await Promise.all([
        request<TaskStatusData>(
          `/operator/tasks/${encodeURIComponent(state.selectedTaskId)}`
        ),
        request<DesktopState>(
          `/operator/tasks/${encodeURIComponent(
            state.selectedTaskId
          )}/desktop-state`
        )
      ]);
      state.taskDetail = detail;
      state.desktopState =
        desktopState.updated_at || desktopState.current_url || desktopState.latest_action
          ? desktopState
          : null;
    } else {
      state.taskDetail = null;
      state.desktopState = null;
    }

    render();
  } catch (error) {
    state.error = getErrorMessage(error);
    render();
  }
};

const submitTask = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const utterance = String(new FormData(form).get("utterance") ?? "").trim();
  const repoHint = String(new FormData(form).get("repo_hint") ?? "").trim();

  if (!utterance) {
    state.error = "Describe the developer task first.";
    render();
    return;
  }

  await createTask(utterance, repoHint, form);
};

const createTask = async (
  utterance: string,
  repoHint?: string,
  form?: HTMLFormElement
): Promise<void> => {
  try {
    state.error = "";
    const data = await request<TaskCreationData>("/operator/tasks", {
      method: "POST",
      body: JSON.stringify({
        utterance,
        ...(repoHint ? { repo_hint: repoHint } : {})
      })
    });

    state.taskDraft = "";
    state.repoHint = repoHint || "main repo";
    state.selectedTaskId = data.task_id;
    form?.reset();
    addLog(
      data.needs_confirmation ? "Task needs approval" : "Task queued",
      data,
      data.needs_confirmation ? "warn" : "success"
    );
    await refreshOperatorData();
  } catch (error) {
    state.error = getErrorMessage(error);
    addLog("Task creation failed", state.error, "error");
    render();
  }
};

const submitQuickTask = async (index: number): Promise<void> => {
  const quickTask = quickTasks[index];

  if (!quickTask) {
    return;
  }

  await createTask(quickTask.prompt, quickTask.repoHint);
};

const startOutboundCall = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const phoneNumber = String(new FormData(form).get("phone_number") ?? "").trim();
  const reason = String(new FormData(form).get("reason") ?? "").trim();

  if (!phoneNumber || !reason) {
    state.error = "Enter a phone number and reason.";
    render();
    return;
  }

  try {
    state.error = "";
    const data = await request<OutboundCallData>("/operator/calls/outbound", {
      method: "POST",
      body: JSON.stringify({
        phone_number: phoneNumber,
        reason,
        ...(state.selectedTaskId ? { task_id: state.selectedTaskId } : {})
      })
    });
    state.outboundPhone = phoneNumber;
    state.outboundReason = reason;
    addLog("Outbound call started", data, "success");
    setStatus("ready", `Outbound call ${data.status}.`);
  } catch (error) {
    state.error = getErrorMessage(error);
    addLog("Outbound call failed", state.error, "error");
    render();
  }
};

const selectTask = async (taskId: string): Promise<void> => {
  state.selectedTaskId = taskId;
  state.taskDetail = null;
  state.desktopState = null;
  await refreshOperatorData();
};

const decideConfirmation = async (
  confirmationId: string,
  decision: "approved" | "denied"
): Promise<void> => {
  try {
    const data = await request<{ task_id: string; status: string }>(
      `/operator/confirmations/${encodeURIComponent(confirmationId)}`,
      {
        method: "POST",
        body: JSON.stringify({ decision })
      }
    );
    state.selectedTaskId = data.task_id;
    addLog(`Confirmation ${decision}`, data, decision === "approved" ? "success" : "warn");
    await refreshOperatorData();
  } catch (error) {
    state.error = getErrorMessage(error);
    render();
  }
};

const cancelSelectedTask = async (): Promise<void> => {
  if (!state.selectedTaskId) {
    return;
  }

  try {
    await request(`/operator/tasks/${encodeURIComponent(state.selectedTaskId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "Cancelled from operator console." })
    });
    addLog("Task cancelled", state.selectedTaskId, "warn");
    await refreshOperatorData();
  } catch (error) {
    state.error = getErrorMessage(error);
    render();
  }
};

const continueSelectedTask = async (): Promise<void> => {
  if (!state.selectedTaskId) {
    return;
  }

  try {
    await request(
      `/operator/tasks/${encodeURIComponent(state.selectedTaskId)}/continue`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
    addLog("Task queued again", state.selectedTaskId, "success");
    await refreshOperatorData();
  } catch (error) {
    state.error = getErrorMessage(error);
    render();
  }
};

const startPolling = (): void => {
  stopPolling();
  refreshTimer = window.setInterval(() => {
    void refreshOperatorData();
  }, 6000);
};

const stopPolling = (): void => {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
};

const render = (): void => {
  app.innerHTML = state.config ? renderDashboard() : renderLocked();
  bindEvents();
};

const renderLocked = (): string => `
  <main class="lock-shell">
    <section class="lock-copy" aria-label="CallAI dashboard login">
      <p class="eyebrow">CallAI Control</p>
      <h1>Jarvis Dashboard</h1>
      <p>Secure operator access for voice, SMS, local bridge execution, approvals, and repo work.</p>
    </section>
    <form class="login-panel" id="login-form">
      <label for="passcode">Passcode</label>
      <div class="login-row">
        <input id="passcode" name="passcode" type="password" autocomplete="one-time-code" placeholder="Enter passcode" />
        <button class="primary" type="submit">Unlock</button>
      </div>
      ${state.error ? `<p class="error-text">${escapeHtml(state.error)}</p>` : ""}
    </form>
  </main>
`;

const renderDashboard = (): string => `
  <main class="ops-shell">
    <header class="command-bar">
      <div class="brand-block">
        <p class="eyebrow">CallAI Mission Control</p>
        <h1>Jarvis</h1>
        <span>${escapeHtml(state.config?.assistantName ?? "Developer operator")}</span>
      </div>

      <form id="task-form" class="command-form">
        <label for="command-input">Command</label>
        <textarea id="command-input" name="utterance" rows="2" placeholder="Ask Jarvis to inspect a repo, run checks, control Chrome, check status, or continue work.">${escapeHtml(state.taskDraft)}</textarea>
        <div class="command-row">
          <input name="repo_hint" value="${escapeHtml(state.repoHint)}" placeholder="target: main repo / current project / Chrome" />
          <button class="primary" type="submit">Queue</button>
        </div>
      </form>

      <section class="channel-controls" aria-label="Voice and call controls">
        <div class="control-row">
          <button class="primary" id="start-call" ${isBusyOrInCall() || !state.vapi ? "disabled" : ""}>Voice</button>
          <button id="mute-call" ${state.status !== "in-call" ? "disabled" : ""}>${state.muted ? "Unmute" : "Mute"}</button>
          <button id="end-call" ${state.status !== "in-call" && state.status !== "connecting" ? "disabled" : ""}>End</button>
        </div>
        <div class="meter" aria-hidden="true"><span id="volume-meter"></span></div>
        <form id="outbound-form" class="outbound-form">
          <input id="phone-number" name="phone_number" value="${escapeHtml(state.outboundPhone)}" placeholder="+19712670353" aria-label="Outbound phone" />
          <input id="call-reason" name="reason" value="${escapeHtml(state.outboundReason)}" placeholder="Call reason" aria-label="Call reason" />
          <button type="submit">Call</button>
        </form>
      </section>

      <div class="topbar-actions">
        <button id="refresh" title="Refresh dashboard" aria-label="Refresh dashboard">Refresh</button>
        <button id="logout" title="Logout" aria-label="Logout">Logout</button>
      </div>
    </header>

    ${state.error ? `<div class="notice error-text">${escapeHtml(state.error)}</div>` : ""}

    <section class="quick-strip" aria-label="Quick tasks">
      ${quickTasks
        .map(
          (task, index) =>
            `<button class="quick-action" data-quick-task="${index}">${escapeHtml(task.label)}</button>`
        )
        .join("")}
    </section>

    <section class="system-strip" aria-label="System strip">
      ${renderSystemPill("VOICE", formatStatus(state.status), state.statusDetail, statusTone(state.status))}
      ${renderSystemPill("SMS", smsStatusLabel(), smsStatusDetail(), smsTone())}
      ${renderSystemPill("VAPI", shortId(state.config?.assistantId ?? ""), state.config?.backendUrl ?? "", state.vapi ? "ok" : "warn")}
      ${renderSystemPill("CODEX CHAT", codexThreadStatusLabel(), codexThreadStatusDetail(), codexThreadTone())}
      ${renderSystemPill("LOCAL BRIDGE", runnerStatusLabel(), runnerStatusDetail(), runnerTone())}
      ${renderSystemPill("RAILWAY DB", databaseStatusLabel(), databaseStatusDetail(), databaseTone())}
      ${renderSystemPill("APPROVALS", `${state.confirmations.length} pending`, approvalDetail(), state.confirmations.length ? "warn" : "ok")}
    </section>

    ${renderAttentionBanner()}

    <section class="mission-grid">
      <aside class="panel queue-panel">
        <div class="panel-heading">
          <div>
            <p class="section-label">Queue</p>
            <h2>${openWorkCount()} active / ${state.tasks.length} recent</h2>
          </div>
          <span>${escapeHtml(lastActivityLabel())}</span>
        </div>
        ${renderTaskGroups()}
      </aside>

      <section class="panel detail-panel">
        ${renderTaskDetail()}
      </section>

      <aside class="right-rail">
        <section class="panel desktop-panel">
          ${renderDesktopPreview()}
        </section>

        <section class="panel approvals-panel">
          <div class="panel-heading">
            <div>
              <p class="section-label">Human Gate</p>
              <h2>Approvals</h2>
            </div>
            <span>${state.confirmations.length} pending</span>
          </div>
          <div class="approval-list">
            ${
              state.confirmations.length
                ? state.confirmations.map(renderConfirmation).join("")
                : '<p class="empty">No pending approvals.</p>'
            }
          </div>
        </section>

        <section class="panel sms-panel">
          ${renderSmsPanel()}
        </section>

        <section class="panel event-panel">
          <div class="log-heading">
            <div>
              <p class="section-label">Event Stream</p>
              <h2>${state.taskDetail ? "Selected task audit" : "Browser events"}</h2>
            </div>
            <button id="clear-log">Clear</button>
          </div>
          ${renderEventStream()}
        </section>
      </aside>
    </section>

    <nav class="mobile-action-bar" aria-label="Task actions">
      <button data-task-control="continue" ${!state.selectedTaskId || state.taskDetail?.task.status === "running" ? "disabled" : ""}>Continue</button>
      <button data-task-control="cancel" ${!state.selectedTaskId || state.taskDetail?.task.status === "cancelled" || state.taskDetail?.task.status === "succeeded" ? "disabled" : ""}>Cancel</button>
      ${renderMobileApprovalButtons()}
    </nav>
  </main>
`;

type UiTone = "ok" | "warn" | "danger" | "idle" | "active";

const renderSystemPill = (
  label: string,
  value: string,
  detail: string,
  tone: UiTone
): string => `
  <article class="system-pill ${tone}">
    <span></span>
    <div>
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value || "Unknown")}</strong>
      <p>${escapeHtml(detail || "No detail reported.")}</p>
    </div>
  </article>
`;

const renderAttentionBanner = (): string => {
  const items: string[] = [];

  if (state.confirmations.length) {
    items.push(`${state.confirmations.length} approval${state.confirmations.length === 1 ? "" : "s"} waiting.`);
  }

  if (
    state.tasks.some(
      (task) => task.status === "queued" && task.execution_target === "runner"
    ) &&
    runnerTone() === "warn"
  ) {
    items.push("Queued work is waiting for the local bridge or runner.");
  }

  if (state.overview?.codex_thread.waiting_count) {
    items.push(
      `${state.overview.codex_thread.waiting_count} task${state.overview.codex_thread.waiting_count === 1 ? "" : "s"} waiting for this Codex chat.`
    );
  }

  if (state.overview?.codex_thread.stale) {
    items.push("A Codex chat task has been waiting longer than expected.");
  }

  if (!state.smsHealth?.summary.configured) {
    items.push("SMS control is not fully configured.");
  }

  state.overview?.sms.attention.forEach((item) => items.push(item));

  if (selectedTask()?.normalized_action === "desktop_control" && !state.desktopState) {
    items.push("Desktop preview will appear after the Mac bridge observes Chrome.");
  }

  if (!items.length) {
    return "";
  }

  return `<section class="attention-strip">${items
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join("")}</section>`;
};

const renderTaskGroups = (): string => {
  const groups = [
    {
      key: "running",
      title: "Running",
      tasks: state.tasks.filter((task) => task.status === "running")
    },
    {
      key: "needs-approval",
      title: "Needs Approval",
      tasks: state.tasks.filter((task) => task.status === "needs_confirmation")
    },
    {
      key: "queued",
      title: "Queued",
      tasks: state.tasks.filter((task) => task.status === "queued")
    },
    {
      key: "blocked",
      title: "Blocked / Failed",
      tasks: state.tasks.filter((task) =>
        ["blocked", "failed"].includes(task.status)
      )
    },
    {
      key: "done",
      title: "Done",
      tasks: state.tasks.filter((task) =>
        ["succeeded", "cancelled"].includes(task.status)
      )
    }
  ];

  return groups
    .map(
      (group) => `
        <section class="task-group ${group.key}">
          <header>
            <span>${escapeHtml(group.title)}</span>
            <b>${group.tasks.length}</b>
          </header>
          <div class="task-list">
            ${
              group.tasks.length
                ? group.tasks.map(renderTaskRow).join("")
                : '<p class="empty compact">Clear.</p>'
            }
          </div>
        </section>
      `
    )
    .join("");
};

const renderTaskRow = (task: TaskRecord): string => {
  const active = state.selectedTaskId === task.id ? "active" : "";
  const runner =
    active && state.taskDetail ? describeRunner(state.taskDetail) : taskOwnerLabel(task);
  const latestDesktop =
    active && task.normalized_action === "desktop_control"
      ? state.desktopState?.latest_action
      : null;

  return `
    <button class="task-row ${active}" data-task-id="${escapeHtml(task.id)}">
      <span class="badge ${escapeHtml(task.status)}">${escapeHtml(formatLabel(task.status))}</span>
      <strong>${escapeHtml(task.title)}</strong>
      <small>${escapeHtml(formatLabel(task.normalized_action))} · ${escapeHtml(formatTime(task.updated_at))}</small>
      <em>${escapeHtml(latestDesktop || runner)}</em>
    </button>
  `;
};

const renderTaskDetail = (): string => {
  const detail = state.taskDetail;

  if (!detail) {
    return `
      <p class="section-label">Task Detail</p>
      <p class="empty">Select a task to inspect status, runner, latest action, and required next step.</p>
    `;
  }

  const task = detail.task;
  const structured = task.structured_request;
  const confirmation = selectedConfirmation();

  return `
    <div class="panel-heading">
      <div>
        <p class="section-label">Interpreted Task</p>
        <h2>${escapeHtml(task.title)}</h2>
      </div>
      <span class="badge ${escapeHtml(task.status)}">${escapeHtml(formatLabel(task.status))}</span>
    </div>
    <div class="task-command-line">
      <span>${escapeHtml(shortId(task.id))}</span>
      <strong>${escapeHtml(nextActionLabel(detail))}</strong>
    </div>
    <dl class="detail-grid">
      <div><dt>Action</dt><dd>${escapeHtml(formatLabel(task.normalized_action))}</dd></div>
      <div><dt>Target</dt><dd>${escapeHtml(formatLabel(task.execution_target))}</dd></div>
      <div><dt>Permission</dt><dd>${escapeHtml(formatLabel(task.permission_required))}</dd></div>
      <div><dt>Confidence</dt><dd>${escapeHtml(formatPercent(structured.confidence))}</dd></div>
      <div><dt>Repo Hint</dt><dd>${escapeHtml(structured.repoAlias ?? "No explicit hint")}</dd></div>
      ${renderDesktopFields(structured)}
      <div><dt>Runner</dt><dd>${escapeHtml(describeRunner(detail))}</dd></div>
      ${renderCodexThreadFields(detail)}
      <div><dt>Updated</dt><dd>${escapeHtml(formatTime(task.updated_at))}</dd></div>
    </dl>
    ${
      confirmation
        ? `<div class="approval-callout">
            <strong>${escapeHtml(confirmation.prompt)}</strong>
            <p>${escapeHtml(confirmation.risk)}</p>
            <div class="button-row compact">
              <button class="primary" data-confirmation-id="${escapeHtml(confirmation.id)}" data-decision="approved">Approve</button>
              <button data-confirmation-id="${escapeHtml(confirmation.id)}" data-decision="denied">Deny</button>
            </div>
          </div>`
        : ""
    }
    ${detail.final_summary ? `<p class="summary">${escapeHtml(detail.final_summary)}</p>` : ""}
    <p class="instructions">${escapeHtml(structured.instructions)}</p>
    <ul class="criteria">
      ${structured.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
    <div class="button-row compact">
      <button id="continue-task" ${task.status === "running" ? "disabled" : ""}>Continue</button>
      <button id="cancel-task" ${task.status === "cancelled" || task.status === "succeeded" ? "disabled" : ""}>Cancel</button>
    </div>
    <div class="runs">
      <p class="section-label">Runs</p>
      ${
        detail.runs.length
          ? detail.runs.map(renderRun).join("")
          : '<p class="empty">Runner has not claimed this task yet.</p>'
      }
    </div>
  `;
};

const renderRun = (run: ExecutionRun): string => `
  <article class="run-row">
    <span class="badge ${escapeHtml(run.status)}">${escapeHtml(formatLabel(run.status))}</span>
    <strong>${escapeHtml(formatLabel(run.executor))}</strong>
    <small>${escapeHtml(run.branch_name ?? "No branch yet")}</small>
    ${run.final_summary ? `<p>${escapeHtml(run.final_summary)}</p>` : ""}
  </article>
`;

const renderDesktopFields = (task: DeveloperTask): string => {
  if (task.action !== "desktop_control") {
    return "";
  }

  return `
    <div><dt>Desktop App</dt><dd>${escapeHtml(task.targetApp ?? "chrome")}</dd></div>
    <div><dt>Mode</dt><dd>${escapeHtml(formatLabel(task.desktopMode ?? "normal_chrome"))}</dd></div>
    <div><dt>Target URL</dt><dd>${escapeHtml(task.url ?? "Open/focus Chrome")}</dd></div>
    <div><dt>Risk</dt><dd>${escapeHtml(formatLabel(task.riskLevel ?? "low"))}</dd></div>
    <div><dt>Approved</dt><dd>${task.desktopApprovalGranted ? "Yes" : "No"}</dd></div>
    <div><dt>Current URL</dt><dd>${escapeHtml(state.desktopState?.current_url ?? "Waiting for browser state")}</dd></div>
  `;
};

const renderCodexThreadFields = (detail: TaskStatusData): string => {
  if (detail.task.execution_target !== "codex_thread") {
    return "";
  }

  const job = detail.codex_thread_job;

  return `
    <div><dt>Codex Chat</dt><dd>${escapeHtml(jobStatusLabel(job))}</dd></div>
    <div><dt>Thread Seen</dt><dd>${escapeHtml(job?.heartbeat_at ? formatTime(job.heartbeat_at) : "Waiting for heartbeat")}</dd></div>
  `;
};

const renderDesktopPreview = (): string => {
  const task = selectedTask();
  const stateLabel = state.desktopState?.updated_at
    ? `Updated ${formatTime(state.desktopState.updated_at)}`
    : "Awaiting first snapshot";

  if (!task || task.normalized_action !== "desktop_control") {
    return `
      <div class="panel-heading">
        <div>
          <p class="section-label">Desktop Preview</p>
          <h2>No desktop task selected</h2>
        </div>
        <span>Chrome</span>
      </div>
      <div class="preview-placeholder">Select a Chrome automation task to see the latest page state.</div>
    `;
  }

  const desktop = state.desktopState;
  const image = desktop?.screenshot_data_url
    ? `<img src="${desktop.screenshot_data_url}" alt="Latest Chrome preview" />`
    : `<div class="preview-placeholder ${desktop?.redacted ? "redacted" : ""}">${
        desktop?.redacted
          ? "Preview withheld for privacy."
          : "No screenshot captured yet."
      }</div>`;

  return `
    <div class="panel-heading">
      <div>
        <p class="section-label">Desktop Preview</p>
        <h2>${escapeHtml(desktop?.page_title ?? "Chrome")}</h2>
      </div>
      <span>${escapeHtml(stateLabel)}</span>
    </div>
    <div class="preview-frame">${image}</div>
    <dl class="preview-meta">
      <div><dt>URL</dt><dd>${escapeHtml(desktop?.current_url ?? "Unknown")}</dd></div>
      <div><dt>Latest Action</dt><dd>${escapeHtml(desktop?.latest_action ?? "Waiting for action")}</dd></div>
      <div><dt>Step</dt><dd>${escapeHtml(String(desktop?.step ?? 0))}</dd></div>
      <div><dt>Privacy</dt><dd>${desktop?.redacted ? "Redacted" : "Visible"}</dd></div>
    </dl>
  `;
};

const renderEventStream = (): string => {
  if (state.taskDetail) {
    return `
      <div class="event-stream">
        ${
          state.taskDetail.latest_events.length
            ? state.taskDetail.latest_events.map(renderAuditEvent).join("")
            : '<p class="empty">No audit events yet.</p>'
        }
      </div>
    `;
  }

  return `
    <div class="logs">
      ${
        state.logs.length
          ? state.logs.map(renderLogEntry).join("")
          : '<p class="empty">No live events in this browser session.</p>'
      }
    </div>
  `;
};

const renderMobileApprovalButtons = (): string => {
  const confirmation = selectedConfirmation();

  if (!confirmation) {
    return "";
  }

  return `
    <button class="primary" data-confirmation-id="${escapeHtml(confirmation.id)}" data-decision="approved">Approve</button>
    <button data-confirmation-id="${escapeHtml(confirmation.id)}" data-decision="denied">Deny</button>
  `;
};

const renderSmsPanel = (): string => {
  const health = state.smsHealth;

  if (!health) {
    return `
      <div class="panel-heading">
        <div>
          <p class="section-label">SMS Ops</p>
          <h2>Loading</h2>
        </div>
        <span>Twilio</span>
      </div>
      <p class="empty">Waiting for SMS health details.</p>
    `;
  }

  const summary = health.summary;
  const recentMessages = health.recentMessages.length
    ? health.recentMessages.map(renderSmsMessageRow).join("")
    : '<p class="empty compact">No recent SMS messages recorded.</p>';
  const recentFailures = health.recentFailures.length
    ? health.recentFailures.slice(0, 4).map(renderSmsMessageRow).join("")
    : '<p class="empty compact">No recent SMS failures.</p>';

  return `
    <div class="panel-heading">
      <div>
        <p class="section-label">SMS Ops</p>
        <h2>${escapeHtml(smsStatusLabel())}</h2>
      </div>
      <span>${escapeHtml(summary.lastOutboundStatus ?? "No recent outbound")}</span>
    </div>
    <dl class="sms-summary-grid">
      <div><dt>Delivery</dt><dd>${renderInlineChip(summary.deliveryState)}</dd></div>
      <div><dt>Verification</dt><dd>${renderInlineChip(summary.verificationState)}</dd></div>
      <div><dt>Webhook</dt><dd>${escapeHtml(formatLabel(health.webhook.authMode))}</dd></div>
      <div><dt>Numbers</dt><dd>...${escapeHtml(summary.fromNumberTail ?? "----")} -> ...${escapeHtml(summary.ownerPhoneTail ?? "----")}</dd></div>
      <div><dt>Inbound</dt><dd>${escapeHtml(summary.lastInboundAt ? formatTime(summary.lastInboundAt) : "No recent inbound")}</dd></div>
      <div><dt>Outbound</dt><dd>${escapeHtml(summary.lastOutboundAt ? formatTime(summary.lastOutboundAt) : "No recent outbound")}</dd></div>
      <div><dt>Error Code</dt><dd>${escapeHtml(summary.lastErrorCode ?? "None")}</dd></div>
      <div><dt>Checked</dt><dd>${escapeHtml(formatTime(health.verification.checkedAt))}</dd></div>
    </dl>
    <p class="sms-detail">${escapeHtml(health.verification.detail)}</p>
    ${
      summary.attention.length
        ? `<ul class="sms-attention-list">${summary.attention
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul>`
        : '<p class="empty compact">No SMS follow-up needed right now.</p>'
    }
    <div class="sms-section">
      <p class="section-label">Recent Messages</p>
      <div class="sms-message-list">${recentMessages}</div>
    </div>
    <div class="sms-section">
      <p class="section-label">Recent Failures</p>
      <div class="sms-message-list">${recentFailures}</div>
    </div>
  `;
};

const renderSmsMessageRow = (message: SmsHealthMessage): string => `
  <article class="sms-message-row">
    <div class="sms-message-meta">
      <strong>${escapeHtml(formatLabel(message.direction))}</strong>
      <span>${escapeHtml(formatTime(message.createdAt))}</span>
    </div>
    <p>${escapeHtml(message.bodyPreview)}</p>
    <small>
      ${escapeHtml(message.status ?? "No status")}
      ${message.errorCode ? ` · ${escapeHtml(message.errorCode)}` : ""}
      ${message.sid ? ` · ${escapeHtml(shortId(message.sid))}` : ""}
    </small>
  </article>
`;

const renderInlineChip = (value: string): string =>
  `<span class="inline-chip ${escapeHtml(inlineChipTone(value))}">${escapeHtml(
    formatLabel(value)
  )}</span>`;

const describeRunner = (detail: TaskStatusData): string => {
  if (detail.task.execution_target === "codex_thread") {
    return jobStatusLabel(detail.codex_thread_job);
  }

  const claimed = detail.latest_events.find(
    (event) => event.event_type === "runner.claimed_task"
  );
  const runnerId = stringField(claimed?.payload.runner_id);
  const scope = stringField(claimed?.payload.task_scope);

  if (runnerId) {
    return `${runnerId}${scope ? ` (${formatLabel(scope)})` : ""}`;
  }

  const run = detail.runs[0];

  if (run) {
    return `${formatLabel(run.executor)} pending runner metadata`;
  }

  return "Not claimed yet";
};

const jobStatusLabel = (job?: CodexThreadJob): string => {
  if (!job) {
    return "Waiting for Codex chat job";
  }

  if (job.status === "queued") {
    return "Waiting for Codex chat";
  }

  if (job.status === "running") {
    return `Claimed by ${job.thread_label}`;
  }

  if (job.final_summary) {
    return job.final_summary;
  }

  return `${formatLabel(job.status)} in ${job.thread_label}`;
};

const renderAuditEvent = (event: AuditEvent): string => {
  const payload = safePayload(event.payload);
  const title = eventTitle(event);
  const summary = eventSummary(event, payload);

  return `
    <article class="audit-row ${escapeHtml(event.severity)}">
      <time>${escapeHtml(formatTime(event.created_at))}</time>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(summary)}</p>
        <details>
          <summary>raw</summary>
          <pre>${escapeHtml(formatDetail(payload) ?? "{}")}</pre>
        </details>
      </div>
    </article>
  `;
};

const renderConfirmation = (confirmation: Confirmation): string => `
  <article class="confirmation-row">
    <strong>${escapeHtml(confirmation.prompt)}</strong>
    <p>${escapeHtml(confirmation.risk)}</p>
    <small>Expires ${escapeHtml(formatTime(confirmation.expires_at))}</small>
    <div class="button-row compact">
      <button class="primary" data-confirmation-id="${escapeHtml(confirmation.id)}" data-decision="approved">Approve</button>
      <button data-confirmation-id="${escapeHtml(confirmation.id)}" data-decision="denied">Deny</button>
    </div>
  </article>
`;

const renderLogEntry = (entry: LogEntry): string => `
  <article class="log-entry ${entry.tone ?? "info"}">
    <time>${escapeHtml(entry.at)}</time>
    <div>
      <strong>${escapeHtml(entry.title)}</strong>
      ${entry.detail ? `<pre>${escapeHtml(entry.detail)}</pre>` : ""}
    </div>
  </article>
`;

const bindEvents = (): void => {
  document.querySelector<HTMLFormElement>("#login-form")?.addEventListener("submit", login);
  document.querySelector<HTMLFormElement>("#task-form")?.addEventListener("submit", submitTask);
  document.querySelector<HTMLFormElement>("#outbound-form")?.addEventListener("submit", startOutboundCall);
  document.querySelector<HTMLButtonElement>("#start-call")?.addEventListener("click", startCall);
  document.querySelector<HTMLButtonElement>("#end-call")?.addEventListener("click", endCall);
  document.querySelector<HTMLButtonElement>("#mute-call")?.addEventListener("click", toggleMute);
  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", logout);
  document.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", () => void refreshOperatorData());
  document
    .querySelectorAll<HTMLButtonElement>('#continue-task,[data-task-control="continue"]')
    .forEach((button) =>
      button.addEventListener("click", () => void continueSelectedTask())
    );
  document
    .querySelectorAll<HTMLButtonElement>('#cancel-task,[data-task-control="cancel"]')
    .forEach((button) =>
      button.addEventListener("click", () => void cancelSelectedTask())
    );
  document.querySelector<HTMLButtonElement>("#clear-log")?.addEventListener("click", () => {
    state.logs = [];
    render();
  });
  document
    .querySelector<HTMLTextAreaElement>("#command-input")
    ?.addEventListener("input", (event) => {
      state.taskDraft = (event.currentTarget as HTMLTextAreaElement).value;
    });
  document
    .querySelector<HTMLInputElement>('[name="repo_hint"]')
    ?.addEventListener("input", (event) => {
      state.repoHint = (event.currentTarget as HTMLInputElement).value;
    });

  document.querySelectorAll<HTMLButtonElement>(".task-row").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = button.dataset.taskId;
      if (taskId) {
        void selectTask(taskId);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-quick-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.quickTask);
      void submitQuickTask(index);
    });
  });

  document
    .querySelectorAll<HTMLButtonElement>("[data-confirmation-id][data-decision]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const confirmationId = button.dataset.confirmationId;
        const decision = button.dataset.decision;

        if (
          confirmationId &&
          (decision === "approved" || decision === "denied")
        ) {
          void decideConfirmation(confirmationId, decision);
        }
      });
    });
};

const updateVolume = (volume: number): void => {
  const meter = document.querySelector<HTMLSpanElement>("#volume-meter");

  if (!meter) {
    return;
  }

  meter.style.width = `${Math.max(2, Math.min(100, Math.round(volume * 100)))}%`;
};

const isBusyOrInCall = (): boolean => {
  return state.status === "connecting" || state.status === "in-call";
};

const openWorkCount = (): number => {
  return state.tasks.filter((task) =>
    ["needs_confirmation", "queued", "running", "blocked"].includes(task.status)
  ).length;
};

const selectedTask = (): TaskRecord | null =>
  state.tasks.find((task) => task.id === state.selectedTaskId) ?? null;

const selectedConfirmation = (): Confirmation | null => {
  if (!state.selectedTaskId) {
    return null;
  }

  return (
    state.confirmations.find(
      (confirmation) => confirmation.task_id === state.selectedTaskId
    ) ?? null
  );
};

const nextActionLabel = (detail: TaskStatusData): string => {
  if (detail.confirmation || selectedConfirmation()) {
    return "Approval required before the next sensitive action.";
  }

  if (
    detail.task.execution_target === "codex_thread" &&
    detail.task.status === "queued"
  ) {
    return "Waiting for this Codex chat to claim the task.";
  }

  if (
    detail.task.execution_target === "codex_thread" &&
    detail.task.status === "running"
  ) {
    return "Claimed by this Codex chat.";
  }

  if (detail.task.status === "queued") {
    return "Waiting for a runner to claim the task.";
  }

  if (detail.task.status === "running") {
    return state.desktopState?.latest_action || "Runner is working.";
  }

  if (detail.task.status === "blocked" || detail.task.status === "failed") {
    return detail.final_summary || "Needs review before continuing.";
  }

  if (detail.task.status === "succeeded") {
    return detail.final_summary || "Completed.";
  }

  return "Standing by.";
};

const taskOwnerLabel = (task: TaskRecord): string => {
  if (task.execution_target === "codex_thread") {
    if (task.status === "queued") {
      return "Waiting for Codex chat";
    }

    if (task.status === "running") {
      return "Claimed by Codex chat";
    }

    return "Codex chat";
  }

  return "Awaiting claim";
};

const approvalDetail = (): string => {
  if (!state.confirmations.length) {
    return "No risky action is waiting on you.";
  }

  return "Review before commit, push, PR, or higher-risk work proceeds.";
};

const lastActivityLabel = (): string => {
  const activity = state.overview?.last_activity_at;
  return activity ? formatTime(activity) : "No activity";
};

const smsStatusLabel = (): string => {
  const summary = state.smsHealth?.summary;

  if (!summary?.configured) {
    return "Not configured";
  }

  if (summary.deliveryState === "blocked") {
    return "Delivery blocked";
  }

  if (summary.deliveryState === "degraded") {
    return "Delivery pending";
  }

  if (summary.verificationState === "unknown") {
    return "Manual check";
  }

  return "Healthy";
};

const smsStatusDetail = (): string => {
  const summary = state.smsHealth?.summary;

  if (!summary?.configured) {
    return "Text control needs Twilio env vars.";
  }

  if (summary.lastErrorCode === "30032") {
    return "Carrier or toll-free compliance is blocking delivery.";
  }

  if (summary.lastErrorMessage) {
    return summary.lastErrorMessage;
  }

  return `Texts route from ...${summary.fromNumberTail ?? "----"} to ...${summary.ownerPhoneTail ?? "----"}.`;
};

const smsTone = (): UiTone => {
  const summary = state.smsHealth?.summary;

  if (!summary?.configured) {
    return "danger";
  }

  if (summary.deliveryState === "blocked") {
    return "danger";
  }

  if (summary.deliveryState === "degraded") {
    return "warn";
  }

  if (summary.deliveryState === "healthy") {
    return "ok";
  }

  return "idle";
};

const codexThreadStatusLabel = (): string => {
  const bridge = state.overview?.codex_thread;

  if (!bridge?.enabled) {
    return "Disabled";
  }

  if (bridge.status === "claimed") {
    return "Claimed";
  }

  if (bridge.status === "waiting_stale") {
    return "Waiting stale";
  }

  if (bridge.status === "waiting") {
    return `${bridge.waiting_count} waiting`;
  }

  return bridge.last_seen_at ? "Standing by" : "No heartbeat";
};

const codexThreadStatusDetail = (): string => {
  const bridge = state.overview?.codex_thread;

  if (!bridge?.enabled) {
    return "Set CODEX_THREAD_BRIDGE_ENABLED=true to route repo work here.";
  }

  if (bridge.active_task_title) {
    return bridge.active_task_title;
  }

  if (bridge.waiting_count) {
    return `Oldest task waiting since ${formatTime(bridge.oldest_waiting_at)}.`;
  }

  if (bridge.last_seen_at) {
    return `${bridge.last_event_type ?? "codex thread event"} at ${formatTime(bridge.last_seen_at)}.`;
  }

  return "No Codex-thread claim event seen yet.";
};

const codexThreadTone = (): UiTone => {
  const bridge = state.overview?.codex_thread;

  if (!bridge?.enabled) {
    return "idle";
  }

  if (bridge.status === "claimed") {
    return "active";
  }

  if (bridge.status === "waiting_stale") {
    return "danger";
  }

  if (bridge.status === "waiting") {
    return "warn";
  }

  return bridge.last_seen_at ? "ok" : "idle";
};

const runnerStatusLabel = (): string => {
  const runner = state.overview?.runner;
  const task = state.tasks.find(
    (item) => item.status === "running" && item.execution_target === "runner"
  );

  if (task) {
    return runner?.runner_id || "Running";
  }

  if (runner?.runner_id) {
    return runner.runner_id;
  }

  if (
    state.tasks.some(
      (item) => item.status === "queued" && item.execution_target === "runner"
    )
  ) {
    return "Waiting";
  }

  return "Standing by";
};

const runnerStatusDetail = (): string => {
  const runner = state.overview?.runner;
  const running = state.tasks.find(
    (task) => task.status === "running" && task.execution_target === "runner"
  );

  if (running) {
    return running.title;
  }

  const queued = state.tasks.filter(
    (task) => task.status === "queued" && task.execution_target === "runner"
  ).length;

  if (queued) {
    return `${queued} queued task${queued === 1 ? "" : "s"} ready for pickup.`;
  }

  if (state.taskDetail) {
    return describeRunner(state.taskDetail);
  }

  if (runner?.last_seen_at) {
    return `${runner.last_event_type ?? "runner event"} at ${formatTime(runner.last_seen_at)}.`;
  }

  return "No runner heartbeat seen in recent events.";
};

const runnerTone = (): UiTone => {
  if (
    state.tasks.some(
      (task) => task.status === "running" && task.execution_target === "runner"
    )
  ) {
    return "active";
  }

  if (
    state.tasks.some(
      (task) => task.status === "queued" && task.execution_target === "runner"
    )
  ) {
    return state.overview?.runner.runner_id ? "warn" : "danger";
  }

  return state.overview?.runner.runner_id ? "ok" : "idle";
};

const inlineChipTone = (value: string): "ok" | "warn" | "danger" | "muted" => {
  const normalized = value.toLowerCase();

  if (["healthy", "approved", "delivered", "sent"].includes(normalized)) {
    return "ok";
  }

  if (
    ["blocked", "rejected", "failed", "undelivered", "canceled"].includes(
      normalized
    )
  ) {
    return "danger";
  }

  if (["degraded", "unknown", "pending", "queued", "accepted"].includes(normalized)) {
    return "warn";
  }

  return "muted";
};

const databaseStatusLabel = (): string =>
  state.overview?.database.ok ? "Connected" : "Needs attention";

const databaseStatusDetail = (): string =>
  state.overview?.database.message ?? "Database state has not loaded.";

const databaseTone = (): UiTone =>
  state.overview?.database.ok ? "ok" : "danger";

const statusTone = (status: Status): UiTone => {
  if (status === "in-call") {
    return "active";
  }

  if (status === "ready" || status === "ended") {
    return "ok";
  }

  if (status === "connecting") {
    return "warn";
  }

  return status === "error" ? "danger" : "idle";
};

const formatStatus = (status: Status): string => {
  const labels: Record<Status, string> = {
    connecting: "Connecting",
    ended: "Ended",
    error: "Needs Attention",
    "in-call": "In Call",
    locked: "Locked",
    ready: "Ready"
  };

  return labels[status];
};

const describeMessage = (message: any): string => {
  if (message?.type === "transcript") {
    return `${message.role ?? "speaker"} transcript`;
  }

  if (message?.type === "tool-calls") {
    return "Tool call requested";
  }

  if (message?.type === "function-call") {
    return "Function call requested";
  }

  return message?.type ? `Message: ${message.type}` : "Message";
};

const eventTitle = (event: AuditEvent): string => {
  const labels: Record<string, string> = {
    "desktop.observe": "Desktop observed page",
    "desktop.action_planned": "Desktop planned next step",
    "desktop.action_completed": "Desktop action completed",
    "desktop.confirmation_required": "Desktop approval required",
    "desktop.blocked": "Desktop blocked",
    "desktop.snapshot_failed": "Desktop snapshot failed",
    "codex_thread.claimed": "Codex chat claimed task",
    "codex_thread.completed": "Codex chat completed task",
    "codex_thread.failed": "Codex chat failed task",
    "runner.claimed_task": "Runner claimed task",
    "run.started": "Run started",
    "run.succeeded": "Run succeeded",
    "run.failed": "Run failed",
    "run.blocked": "Run blocked",
    "confirmation.requested": "Approval requested",
    "git.branch_created": "Branch created",
    "git.diff_summary": "Diff summarized",
    "tests.completed": "Checks completed",
    "repo.inspected": "Repo inspected"
  };

  return labels[event.event_type] ?? formatLabel(event.event_type);
};

const eventSummary = (
  event: AuditEvent,
  payload: Record<string, unknown>
): string => {
  const summary =
    stringField(payload.latest_action_label) ||
    stringField(payload.summary) ||
    stringField(payload.reason) ||
    stringField(payload.error) ||
    stringField(payload.final_summary);

  if (summary) {
    return summary;
  }

  if (event.event_type === "runner.claimed_task") {
    return `${stringField(payload.runner_id) ?? "Runner"} claimed this task.`;
  }

  if (event.event_type === "codex_thread.claimed") {
    return `${stringField(payload.thread_label) ?? "Codex chat"} claimed this task.`;
  }

  if (event.event_type === "desktop.observe") {
    return `${stringField(payload.page_title) ?? "Page"} at ${stringField(payload.current_url) ?? "unknown URL"}.`;
  }

  if (event.event_type === "desktop.action_planned") {
    const action = payload.action as Record<string, unknown> | undefined;
    return `Next step: ${formatLabel(String(action?.action ?? "unknown"))}.`;
  }

  if (event.event_type === "tests.completed") {
    return `Exit code ${String(payload.code ?? "unknown")}.`;
  }

  return "Event recorded.";
};

const getMicAwareError = (error: unknown): string => {
  const message = getErrorMessage(error);

  if (/permission|microphone|notallowed|audio/i.test(message)) {
    return "Microphone permission was blocked or unavailable. Allow microphone access and try again.";
  }

  return message;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return formatDetail(error) || "Something went wrong.";
};

const formatDetail = (detail: unknown): string | undefined => {
  if (detail === undefined) {
    return undefined;
  }

  if (typeof detail === "string") {
    return detail;
  }

  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
};

const safePayload = (payload: Record<string, unknown>): Record<string, unknown> =>
  redactValue(payload) as Record<string, unknown>;

const redactValue = (value: unknown, key = ""): unknown => {
  if (/secret|token|api_?key|password|passcode|auth|credential/i.test(key)) {
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey)
      ])
    );
  }

  if (typeof value === "string" && /sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/.test(value)) {
    return "[redacted]";
  }

  return value;
};

const formatLabel = (value: string): string => {
  return value.replaceAll("_", " ");
};

const formatPercent = (value: number): string => {
  return `${Math.round(value * 100)}%`;
};

const formatTime = (value: string | null | undefined): string => {
  if (!value) {
    return "Unknown";
  }

  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
};

const shortId = (value: string): string => {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
};

const stringField = (value: unknown): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const escapeHtml = (value: string): string => {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
};

const boot = (): void => {
  render();
  void loadConfig();
};

window.addEventListener("error", (event) => {
  renderFatalBootError(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  renderFatalBootError(event.reason);
});

boot();

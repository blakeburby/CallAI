import VapiModule from "@vapi-ai/web";
import type VapiClient from "@vapi-ai/web";
import "./styles.css";

type AppConfig = {
  assistantId: string;
  assistantName: string;
  backendUrl: string;
  sms: {
    enabled: boolean;
    ownerPhoneTail: string | null;
    fromNumberTail: string | null;
  };
  vapiPublicKey: string;
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

type TaskStatusData = {
  task: TaskRecord;
  latest_events: AuditEvent[];
  runs: ExecutionRun[];
  confirmation?: Confirmation;
  final_summary?: string;
};

type TaskListData = {
  tasks: TaskRecord[];
  confirmations: Confirmation[];
};

type TaskCreationData = {
  task_id: string;
  status: string;
  interpreted_task: DeveloperTask;
  needs_confirmation: boolean;
  confirmation_id?: string;
};

const state: {
  config: AppConfig | null;
  confirmations: Confirmation[];
  error: string;
  logs: LogEntry[];
  muted: boolean;
  selectedTaskId: string | null;
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
  error: "",
  logs: [],
  muted: false,
  selectedTaskId: null,
  status: "locked",
  statusDetail: "Log in to load the CallAI operator console.",
  taskDetail: null,
  tasks: [],
  taskDraft: "",
  repoHint: "",
  vapi: null
};

type VapiConstructor = new (apiToken: string) => VapiClient;

const app = document.querySelector<HTMLDivElement>("#app");
let refreshTimer: number | null = null;

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
    const config = await request<AppConfig>("/frontend/config");
    state.config = config;
    state.error = "";
    createVapiClient(config);
    setStatus("ready", "Ready for browser voice or typed remote tasks.");
    addLog("Operator console ready", config.assistantName, "success");
    await refreshOperatorData();
    startPolling();
  } catch (error) {
    stopPolling();
    state.config = null;
    state.vapi = null;
    state.status = "locked";
    state.statusDetail = "Log in to load the CallAI operator console.";
    state.error =
      getErrorMessage(error) === "Login required." ? "" : getErrorMessage(error);
    render();
  }
};

const createVapiClient = (config: AppConfig): void => {
  state.vapi?.removeAllListeners();
  const Vapi = resolveVapiConstructor();
  const client = new Vapi(config.vapiPublicKey);

  client.on("call-start", () => {
    setStatus("in-call", "Call connected. Give CallAI a developer task.");
    addLog("Call started", undefined, "success");
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

const resolveVapiConstructor = (): VapiConstructor => {
  const candidate = VapiModule as unknown;

  if (typeof candidate === "function") {
    return candidate as VapiConstructor;
  }

  const defaultExport = (candidate as { default?: unknown }).default;

  if (typeof defaultExport === "function") {
    return defaultExport as VapiConstructor;
  }

  throw new Error("Vapi web SDK did not export a constructor.");
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
  state.error = "";
  state.logs = [];
  state.muted = false;
  state.selectedTaskId = null;
  state.taskDetail = null;
  state.tasks = [];
  state.vapi = null;
  setStatus("locked", "Logged out.");
};

const startCall = async (): Promise<void> => {
  if (!state.config || !state.vapi) {
    state.error = "Login is required before starting a call.";
    render();
    return;
  }

  try {
    state.error = "";
    setStatus("connecting", "Requesting microphone and joining the call...");
    addLog("Starting call");
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
    const data = await request<TaskListData>("/operator/tasks");
    state.tasks = data.tasks;
    state.confirmations = data.confirmations;

    if (!state.selectedTaskId && state.tasks[0]) {
      state.selectedTaskId = state.tasks[0].id;
    }

    if (state.selectedTaskId) {
      state.taskDetail = await request<TaskStatusData>(
        `/operator/tasks/${encodeURIComponent(state.selectedTaskId)}`
      );
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
    state.repoHint = "";
    state.selectedTaskId = data.task_id;
    form.reset();
    addLog(
      data.needs_confirmation ? "Task needs confirmation" : "Task queued",
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

const selectTask = async (taskId: string): Promise<void> => {
  state.selectedTaskId = taskId;
  state.taskDetail = null;
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
  app.innerHTML = `
    <main class="shell">
      <section class="hero" aria-label="CallAI operator console">
        <div class="hero-copy">
          <p class="eyebrow">CallAI Remote Developer Operator</p>
          <h1>Talk to an agent that can work in repos.</h1>
          <p class="subcopy">Start a voice session, queue coding tasks, approve sensitive actions, and watch Codex-ready execution logs from one deployed control plane.</p>
        </div>
        <div class="status-panel">
          <span class="status-dot ${state.status}"></span>
          <div>
            <p class="status-label">${formatStatus(state.status)}</p>
            <p class="status-detail">${escapeHtml(state.statusDetail)}</p>
          </div>
        </div>
      </section>

      ${state.config ? renderConsole() : renderLogin()}
    </main>
  `;

  bindEvents();
};

const renderLogin = (): string => `
  <section class="login-layout">
    <form class="login-card" id="login-form">
      <label for="passcode">Frontend passcode</label>
      <div class="input-row">
        <input id="passcode" name="passcode" type="password" autocomplete="current-password" placeholder="Enter passcode" />
        <button type="submit">Unlock</button>
      </div>
      ${state.error ? `<p class="error-text">${escapeHtml(state.error)}</p>` : ""}
    </form>
  </section>
`;

const renderConsole = (): string => `
  <section class="workspace">
    <section class="controls panel">
      <div>
        <p class="section-label">Voice Session</p>
        <h2>${escapeHtml(state.config?.assistantName ?? "CallAI")}</h2>
      </div>
      <div class="button-row">
        <button class="primary" id="start-call" ${isBusyOrInCall() ? "disabled" : ""}>Start Call</button>
        <button id="mute-call" ${state.status !== "in-call" ? "disabled" : ""}>${state.muted ? "Unmute" : "Mute"}</button>
        <button id="end-call" ${state.status !== "in-call" && state.status !== "connecting" ? "disabled" : ""}>End</button>
        <button id="refresh">Refresh</button>
        <button id="logout">Logout</button>
      </div>
      ${state.error ? `<p class="error-text">${escapeHtml(state.error)}</p>` : ""}
      <div class="meter" aria-hidden="true"><span id="volume-meter"></span></div>
    </section>

    <aside class="metadata panel">
      <p class="section-label">Assistant</p>
      <dl>
        <div><dt>Name</dt><dd>${escapeHtml(state.config?.assistantName ?? "")}</dd></div>
        <div><dt>ID</dt><dd>${escapeHtml(state.config?.assistantId ?? "")}</dd></div>
        <div><dt>Backend</dt><dd>${escapeHtml(state.config?.backendUrl ?? "")}</dd></div>
        <div><dt>Text Control</dt><dd>${renderSmsStatus()}</dd></div>
      </dl>
    </aside>

    <section class="task-intake panel">
      <p class="section-label">New Task</p>
      <form id="task-form">
        <textarea name="utterance" rows="4" placeholder="Example: Open the main repo, update the README on a new branch, and run the build."></textarea>
        <div class="input-row">
          <input name="repo_hint" placeholder="Repo hint, optional" />
          <button class="primary" type="submit">Queue Task</button>
        </div>
      </form>
    </section>

    <section class="queue panel">
      <div class="panel-heading">
        <p class="section-label">Task Queue</p>
        <span>${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}</span>
      </div>
      <div class="task-list">
        ${
          state.tasks.length
            ? state.tasks.map(renderTaskRow).join("")
            : '<p class="empty">No developer tasks yet.</p>'
        }
      </div>
    </section>

    <section class="detail panel">
      ${renderTaskDetail()}
    </section>

    <section class="confirmations panel">
      <div class="panel-heading">
        <p class="section-label">Confirmations</p>
        <span>${state.confirmations.length} pending</span>
      </div>
      ${
        state.confirmations.length
          ? state.confirmations.map(renderConfirmation).join("")
          : '<p class="empty">No pending approvals.</p>'
      }
    </section>

    <section class="log-panel panel">
      <div class="log-heading">
        <p class="section-label">Live Call Events</p>
        <button id="clear-log">Clear</button>
      </div>
      <div class="logs">
        ${
          state.logs.length
            ? state.logs.map(renderLogEntry).join("")
            : '<p class="empty">Start a call or queue a task to see events.</p>'
        }
      </div>
    </section>
  </section>
`;

const renderTaskRow = (task: TaskRecord): string => {
  const active = state.selectedTaskId === task.id ? "active" : "";

  return `
    <button class="task-row ${active}" data-task-id="${escapeHtml(task.id)}">
      <span class="badge ${escapeHtml(task.status)}">${formatLabel(task.status)}</span>
      <strong>${escapeHtml(task.title)}</strong>
      <small>${escapeHtml(formatLabel(task.normalized_action))} · ${escapeHtml(formatTime(task.updated_at))}</small>
    </button>
  `;
};

const renderTaskDetail = (): string => {
  const detail = state.taskDetail;

  if (!detail) {
    return '<p class="empty">Select a task to inspect status, runs, and audit logs.</p>';
  }

  const task = detail.task;
  const structured = task.structured_request;

  return `
    <div class="panel-heading">
      <div>
        <p class="section-label">Interpreted Task</p>
        <h2>${escapeHtml(task.title)}</h2>
      </div>
      <span class="badge ${escapeHtml(task.status)}">${escapeHtml(formatLabel(task.status))}</span>
    </div>
    <dl class="detail-grid">
      <div><dt>Action</dt><dd>${escapeHtml(formatLabel(task.normalized_action))}</dd></div>
      <div><dt>Permission</dt><dd>${escapeHtml(formatLabel(task.permission_required))}</dd></div>
      <div><dt>Confidence</dt><dd>${escapeHtml(formatPercent(structured.confidence))}</dd></div>
      <div><dt>Repo Hint</dt><dd>${escapeHtml(structured.repoAlias ?? "No explicit hint")}</dd></div>
      <div><dt>Runner</dt><dd>${escapeHtml(describeRunner(detail))}</dd></div>
    </dl>
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
    <div class="audit">
      <p class="section-label">Audit Timeline</p>
      ${
        detail.latest_events.length
          ? detail.latest_events.map(renderAuditEvent).join("")
          : '<p class="empty">No audit events yet.</p>'
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

const renderSmsStatus = (): string => {
  const sms = state.config?.sms;

  if (!sms?.enabled) {
    return '<span class="status-chip muted">Not configured</span>';
  }

  return `<span class="status-chip ok">Enabled</span><small> From ...${escapeHtml(
    sms.fromNumberTail ?? "----"
  )} to ...${escapeHtml(sms.ownerPhoneTail ?? "----")}</small>`;
};

const describeRunner = (detail: TaskStatusData): string => {
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

const renderAuditEvent = (event: AuditEvent): string => `
  <article class="audit-row ${escapeHtml(event.severity)}">
    <time>${escapeHtml(formatTime(event.created_at))}</time>
    <div>
      <strong>${escapeHtml(event.event_type)}</strong>
      <pre>${escapeHtml(formatDetail(event.payload) ?? "{}")}</pre>
    </div>
  </article>
`;

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
  document.querySelector<HTMLButtonElement>("#start-call")?.addEventListener("click", startCall);
  document.querySelector<HTMLButtonElement>("#end-call")?.addEventListener("click", endCall);
  document.querySelector<HTMLButtonElement>("#mute-call")?.addEventListener("click", toggleMute);
  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", logout);
  document.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", () => void refreshOperatorData());
  document.querySelector<HTMLButtonElement>("#continue-task")?.addEventListener("click", () => void continueSelectedTask());
  document.querySelector<HTMLButtonElement>("#cancel-task")?.addEventListener("click", () => void cancelSelectedTask());
  document.querySelector<HTMLButtonElement>("#clear-log")?.addEventListener("click", () => {
    state.logs = [];
    render();
  });

  document.querySelectorAll<HTMLButtonElement>(".task-row").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = button.dataset.taskId;
      if (taskId) {
        void selectTask(taskId);
      }
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

const formatLabel = (value: string): string => {
  return value.replaceAll("_", " ");
};

const formatPercent = (value: number): string => {
  return `${Math.round(value * 100)}%`;
};

const formatTime = (value: string): string => {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
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

void loadConfig();

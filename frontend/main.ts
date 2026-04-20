import VapiModule from "@vapi-ai/web";
import type VapiClient from "@vapi-ai/web";
import "./styles.css";

type AppConfig = {
  assistantId: string;
  assistantName: string;
  backendUrl: string;
  vapiPublicKey: string;
};

type Status = "locked" | "ready" | "connecting" | "in-call" | "ended" | "error";

type LogEntry = {
  at: string;
  title: string;
  detail?: string;
  tone?: "info" | "success" | "error";
};

const state: {
  config: AppConfig | null;
  error: string;
  logs: LogEntry[];
  muted: boolean;
  status: Status;
  statusDetail: string;
  vapi: VapiClient | null;
} = {
  config: null,
  error: "",
  logs: [],
  muted: false,
  status: "locked",
  statusDetail: "Log in to load the CallAI voice console.",
  vapi: null
};

const app = document.querySelector<HTMLDivElement>("#app");

type VapiConstructor = new (apiToken: string) => VapiClient;

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
  ].slice(0, 80);
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
    setStatus("ready", "Ready to start a browser voice call.");
    addLog("Voice console ready", config.assistantName, "success");
  } catch (error) {
    state.config = null;
    state.vapi = null;
    state.status = "locked";
    state.statusDetail = "Log in to load the CallAI voice console.";
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
    setStatus("in-call", "Call connected. Speak naturally to CallAI.");
    addLog("Call started", undefined, "success");
  });

  client.on("call-end", () => {
    state.muted = false;
    setStatus("ended", "Call ended.");
    addLog("Call ended");
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
  client.on("message", (message) => addLog(describeMessage(message), message));
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
  if (state.status === "in-call" || state.status === "connecting") {
    await endCall();
  }

  await request<never>("/frontend/logout", { method: "POST" }).catch(() => {});
  state.config = null;
  state.error = "";
  state.logs = [];
  state.muted = false;
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

const render = (): void => {
  app.innerHTML = `
    <main class="shell">
      <section class="hero" aria-label="CallAI voice console">
        <div class="hero-copy">
          <p class="eyebrow">CallAI Voice Console</p>
          <h1>Talk to your trading assistant.</h1>
          <p class="subcopy">Run a live browser voice session against the deployed Vapi assistant and production tool server.</p>
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
    <div class="controls">
      <div>
        <p class="section-label">Session</p>
        <h2>${escapeHtml(state.config?.assistantName ?? "CallAI")}</h2>
      </div>
      <div class="button-row">
        <button class="primary" id="start-call" ${isBusyOrInCall() ? "disabled" : ""}>Start Call</button>
        <button id="mute-call" ${state.status !== "in-call" ? "disabled" : ""}>${state.muted ? "Unmute" : "Mute"}</button>
        <button id="end-call" ${state.status !== "in-call" && state.status !== "connecting" ? "disabled" : ""}>End</button>
        <button id="logout">Logout</button>
      </div>
      ${state.error ? `<p class="error-text">${escapeHtml(state.error)}</p>` : ""}
      <div class="meter" aria-hidden="true"><span id="volume-meter"></span></div>
    </div>

    <aside class="metadata">
      <p class="section-label">Assistant</p>
      <dl>
        <div><dt>Name</dt><dd>${escapeHtml(state.config?.assistantName ?? "")}</dd></div>
        <div><dt>ID</dt><dd>${escapeHtml(state.config?.assistantId ?? "")}</dd></div>
        <div><dt>Backend</dt><dd>${escapeHtml(state.config?.backendUrl ?? "")}</dd></div>
      </dl>
    </aside>

    <section class="log-panel">
      <div class="log-heading">
        <p class="section-label">Live Events</p>
        <button id="clear-log">Clear</button>
      </div>
      <div class="logs">
        ${
          state.logs.length
            ? state.logs.map(renderLogEntry).join("")
            : '<p class="empty">Start a call to see transcript and tool events.</p>'
        }
      </div>
    </section>
  </section>
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
  document.querySelector<HTMLButtonElement>("#start-call")?.addEventListener("click", startCall);
  document.querySelector<HTMLButtonElement>("#end-call")?.addEventListener("click", endCall);
  document.querySelector<HTMLButtonElement>("#mute-call")?.addEventListener("click", toggleMute);
  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", logout);
  document.querySelector<HTMLButtonElement>("#clear-log")?.addEventListener("click", () => {
    state.logs = [];
    render();
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

const escapeHtml = (value: string): string => {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
};

void loadConfig();

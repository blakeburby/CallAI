import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditLog } from "../audit-log/auditLogService.js";
import { telegramService } from "../telegram/telegramService.js";
import { database } from "../../services/dbService.js";
import { JARVIS_TELEGRAM_REPLY_PROMPT } from "./jarvisSoul.js";
import { logger } from "../../utils/logger.js";
import type {
  ChatConversationRecord,
  ChatMessageRecord,
  JarvisChatReplyJobRecord
} from "../../types/operator.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_HISTORY_LIMIT = 8;
const DEFAULT_CHAT_MODEL = "gpt-5.4-mini";
const DEFAULT_REASONING_EFFORT = "low";
const MAX_HISTORY_MESSAGES_IN_PROMPT = 8;
const MAX_PROMPT_CHARACTERS = 8_000;
const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;
let lastWorkerHeartbeatAt = 0;

type ProcessNextInput = {
  claimNextJob?: (
    runnerId: string,
    timeoutMs: number
  ) => Promise<JarvisChatReplyJobRecord | null>;
  expireJobs?: () => Promise<JarvisChatReplyJobRecord[]>;
  generateReply?: (input: GenerateReplyInput) => Promise<string>;
  runnerId: string;
};

type GenerateReplyInput = {
  conversation: ChatConversationRecord;
  history: ChatMessageRecord[];
  inboundMessage: ChatMessageRecord;
  job: JarvisChatReplyJobRecord;
};

export const jarvisCodexChatService = {
  isEnabled(): boolean {
    return process.env.JARVIS_CODEX_CHAT_ENABLED !== "false";
  },

  timeoutMs(): number {
    return positiveInteger(process.env.JARVIS_CODEX_CHAT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  },

  historyLimit(): number {
    return positiveInteger(process.env.JARVIS_CODEX_CHAT_HISTORY_LIMIT) ?? DEFAULT_HISTORY_LIMIT;
  },

  modelName(): string {
    return process.env.JARVIS_CODEX_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
  },

  reasoningEffort(): string {
    return (
      process.env.JARVIS_CODEX_CHAT_REASONING_EFFORT?.trim() ||
      DEFAULT_REASONING_EFFORT
    );
  },

  async queueReply(input: {
    conversationId: string;
    inboundMessageId: string;
  }): Promise<JarvisChatReplyJobRecord> {
    const job = await database.createJarvisChatReplyJob({
      conversation_id: input.conversationId,
      inbound_message_id: input.inboundMessageId,
      expires_at: new Date(Date.now() + this.timeoutMs()).toISOString()
    });

    await auditLog.log({
      event_type: "jarvis.codex_chat_reply_queued",
      payload: {
        conversation_id: input.conversationId,
        inbound_message_id: input.inboundMessageId,
        job_id: job.id
      }
    });

    return job;
  },

  async processNext(input: ProcessNextInput): Promise<boolean> {
    await expireJobsSafely(input.expireJobs);

    const job = await retryTransientDatabaseOperation(
      "claim Jarvis chat reply job",
      () =>
        (input.claimNextJob ?? database.claimNextJarvisChatReplyJob.bind(database))(
          input.runnerId,
          this.timeoutMs()
        )
    );

    if (!job) {
      logWorkerHeartbeat(input.runnerId, "idle");
      return false;
    }

    logWorkerHeartbeat(input.runnerId, "claimed", { job_id: job.id });

    try {
      const context = await retryTransientDatabaseOperation(
        "load Jarvis chat reply context",
        () => loadJobContext(job)
      );
      const reply = sanitizeCodexReply(
        await (input.generateReply ?? generateCodexReply)(context)
      );

      await appendAndSendReply(job, reply, "codex_casual_reply");
      await retryTransientDatabaseOperation("finish Jarvis chat reply job", () =>
        database.finishJarvisChatReplyJob(job.id, {
          status: "succeeded",
          reply_body: reply
        })
      );
      await auditLog.log({
        event_type: "jarvis.codex_chat_reply_completed",
        payload: {
          job_id: job.id,
          conversation_id: job.conversation_id
        }
      });
    } catch (error) {
      const failure = formatFailureDetails(error);
      const fallback = fallbackReply();
      await appendAndSendReplySafely(job, fallback, "codex_casual_reply_failed");
      await retryTransientDatabaseOperation("fail Jarvis chat reply job", () =>
        database.finishJarvisChatReplyJob(job.id, {
          status: "failed",
          reply_body: fallback,
          error: truncateErrorDetails(failure)
        })
      );
      logger.warn("Jarvis Codex chat reply failed", {
        job_id: job.id,
        conversation_id: job.conversation_id,
        ...failure
      });
      await auditLog.log({
        event_type: "jarvis.codex_chat_reply_failed",
        severity: "warn",
        payload: {
          job_id: job.id,
          conversation_id: job.conversation_id,
          ...failure
        }
      });
    }

    return true;
  }
};

const expireJobs = async (
  expireOperation = database.expireJarvisChatReplyJobs.bind(database)
): Promise<void> => {
  const expired = await retryTransientDatabaseOperation(
    "expire Jarvis chat reply jobs",
    expireOperation
  );

  for (const job of expired) {
    await appendAndSendReplySafely(
      job,
      fallbackReply(),
      "codex_casual_reply_expired"
    );
  }
};

const expireJobsSafely = async (
  expireOperation?: () => Promise<JarvisChatReplyJobRecord[]>
): Promise<void> => {
  try {
    await expireJobs(expireOperation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Jarvis chat reply expiry failed; continuing to claim jobs", {
      error: message
    });
    await auditLog.log({
      event_type: "jarvis.codex_chat_reply_expiry_failed",
      severity: "warn",
      payload: { error: message }
    });
  }
};

const loadJobContext = async (
  job: JarvisChatReplyJobRecord
): Promise<GenerateReplyInput> => {
  const [conversation, inboundMessage] = await Promise.all([
    database.getChatConversation(job.conversation_id),
    database.getChatMessage(job.inbound_message_id)
  ]);

  if (!conversation) {
    throw new Error(`Jarvis chat conversation not found: ${job.conversation_id}`);
  }

  if (!inboundMessage) {
    throw new Error(`Jarvis inbound chat message not found: ${job.inbound_message_id}`);
  }

  const history = await database.listChatMessages({
    conversation_id: conversation.id,
    limit: jarvisCodexChatService.historyLimit()
  });

  return { conversation, history, inboundMessage, job };
};

const generateCodexReply = async (input: GenerateReplyInput): Promise<string> => {
  const executable = process.env.CODEX_EXECUTABLE || "codex";
  const repoPath = process.env.DEFAULT_REPO_PATH || process.cwd();
  const tempDir = await mkdtemp(path.join(tmpdir(), "jarvis-codex-chat-"));
  const outputPath = path.join(tempDir, "reply.txt");
  const prompt = buildCodexCasualPrompt(input);
  const runtimeConfig = buildRuntimeConfig();
  const args = buildCodexExecArgs({
    outputPath,
    repoPath,
    runtimeConfig
  });
  const startedAt = Date.now();

  try {
    await runCodexExec({
      args,
      executable,
      prompt,
      runtimeConfig,
      timeoutMs: jarvisCodexChatService.timeoutMs()
    });

    const reply = (await readFile(outputPath, "utf8")).trim();

    if (!reply) {
      throw new JarvisCodexChatError("Codex produced an empty Jarvis chat reply.", {
        duration_ms: Date.now() - startedAt,
        model: runtimeConfig.model,
        reasoning_effort: runtimeConfig.reasoningEffort
      });
    }

    return reply;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
};

const appendAndSendReply = async (
  job: JarvisChatReplyJobRecord,
  reply: string,
  intent: string
): Promise<void> => {
  const conversation = await database.getChatConversation(job.conversation_id);
  const channel = conversation
    ? await database.getChatChannel(conversation.channel_id)
    : null;

  await database.appendChatMessage({
    conversation_id: job.conversation_id,
    direction: "outbound",
    role: "assistant",
    body: reply,
    payload: {
      intent,
      jarvis_chat_reply_job_id: job.id
    }
  });

  if (channel?.kind === "telegram") {
    await telegramService.sendMessage(channel.external_id, reply);
  }
};

const appendAndSendReplySafely = async (
  job: JarvisChatReplyJobRecord,
  reply: string,
  intent: string
): Promise<void> => {
  try {
    await appendAndSendReply(job, reply, intent);
  } catch (error) {
    logger.warn("Jarvis chat reply fallback delivery failed", {
      job_id: job.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const buildCodexCasualPrompt = (input: GenerateReplyInput): string => {
  const history = meaningfulHistory(input)
    .map((message) => {
      const label = message.role === "assistant" ? "Jarvis" : "Blake";
      return `${label}: ${message.body}`;
    })
    .join("\n");

  return [
    "You are writing the next Telegram reply as Jarvis.",
    "",
    "Use this compact identity and tone source:",
    JARVIS_TELEGRAM_REPLY_PROMPT,
    "",
    "Style rules:",
    "- Reply as Jarvis, not as an assistant explaining Jarvis.",
    "- No 'As an AI'. No boilerplate. No repeated safety lecture.",
    "- Be direct, useful, and human. Light wit is good; forced banter is not.",
    "- Keep the reply short: 1 to 4 sentences.",
    "- Output only the final Telegram message.",
    "",
    "Recent conversation:",
    history || "(no prior messages)",
    "",
    `Blake's latest message: ${input.inboundMessage.body}`
  ]
    .join("\n")
    .slice(0, MAX_PROMPT_CHARACTERS);
};

const sanitizeCodexReply = (value: string): string => {
  const cleaned = value
    .replace(/\bas an ai\b/gi, "as Jarvis")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  return cleaned.length > 1200 ? `${cleaned.slice(0, 1197)}...` : cleaned;
};

const fallbackReply = (): string =>
  "Still here. The sharper reply path tripped, but I caught it. Try me again in a second.";

type RuntimeConfig = {
  model: string;
  reasoningEffort: string;
};

type CodexExecArgsInput = {
  outputPath: string;
  repoPath: string;
  runtimeConfig: RuntimeConfig;
};

type CodexExecInput = {
  args: string[];
  executable: string;
  prompt: string;
  runtimeConfig: RuntimeConfig;
  timeoutMs: number;
};

type CodexExecResult = {
  code: number | null;
  durationMs: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

class JarvisCodexChatError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "JarvisCodexChatError";
    this.details = details;
  }
}

const buildRuntimeConfig = (): RuntimeConfig => ({
  model: jarvisCodexChatService.modelName(),
  reasoningEffort: jarvisCodexChatService.reasoningEffort()
});

const buildCodexExecArgs = (input: CodexExecArgsInput): string[] => [
  "exec",
  "--ephemeral",
  "--sandbox",
  "read-only",
  "--cd",
  input.repoPath,
  "-m",
  input.runtimeConfig.model,
  "-c",
  `model_reasoning_effort="${escapeTomlString(input.runtimeConfig.reasoningEffort)}"`,
  "--output-last-message",
  input.outputPath,
  "-"
];

const runCodexExec = async (input: CodexExecInput): Promise<void> => {
  const result = await runProcessWithStdin(input);

  if (result.code === 0 && !result.timedOut) {
    return;
  }

  throw new JarvisCodexChatError(
    result.timedOut
      ? "Codex Jarvis chat reply timed out."
      : `Codex Jarvis chat reply exited with code ${result.code ?? "null"}.`,
    {
      code: result.code,
      duration_ms: result.durationMs,
      model: input.runtimeConfig.model,
      reasoning_effort: input.runtimeConfig.reasoningEffort,
      signal: result.signal,
      stderr_tail: tail(result.stderr),
      stdout_tail: tail(result.stdout),
      timed_out: result.timedOut
    }
  );
};

const runProcessWithStdin = async (
  input: CodexExecInput
): Promise<CodexExecResult> => {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const finish = (result: CodexExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 3_000);
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = truncateProcessOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = truncateProcessOutput(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(
        new JarvisCodexChatError(error.message, {
          duration_ms: Date.now() - startedAt,
          model: input.runtimeConfig.model,
          reasoning_effort: input.runtimeConfig.reasoningEffort,
          timed_out: timedOut
        })
      );
    });
    child.on("close", (code, signal) => {
      finish({
        code,
        durationMs: Date.now() - startedAt,
        signal,
        stderr,
        stdout,
        timedOut
      });
    });

    child.stdin.end(input.prompt);
  });
};

const meaningfulHistory = (input: GenerateReplyInput): ChatMessageRecord[] => {
  return input.history
    .filter((message) => message.id !== input.inboundMessage.id)
    .filter((message) => !isNoisyAssistantMessage(message))
    .slice(-MAX_HISTORY_MESSAGES_IN_PROMPT);
};

const isNoisyAssistantMessage = (message: ChatMessageRecord): boolean => {
  if (message.role !== "assistant") {
    return false;
  }

  const intent = typeof message.payload?.intent === "string"
    ? message.payload.intent
    : "";
  const normalized = message.body.toLowerCase();

  return (
    intent === "queued_casual_reply_ack" ||
    intent === "codex_casual_reply_failed" ||
    intent === "codex_casual_reply_expired" ||
    normalized.includes("thinking for a second") ||
    normalized.includes("hit a snag generating") ||
    normalized.includes("sharper reply path tripped")
  );
};

const formatFailureDetails = (error: unknown): Record<string, unknown> => {
  if (error instanceof JarvisCodexChatError) {
    return {
      error: error.message,
      ...error.details
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error)
  };
};

const truncateErrorDetails = (details: Record<string, unknown>): string => {
  const serialized = JSON.stringify(details);
  return serialized.length > 4000 ? `${serialized.slice(0, 3997)}...` : serialized;
};

const tail = (value: string, maxLength = 2000): string =>
  value.length > maxLength ? value.slice(-maxLength) : value;

const truncateProcessOutput = (value: string, maxLength = 32_000): string =>
  value.length > maxLength ? value.slice(-maxLength) : value;

const escapeTomlString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const retryTransientDatabaseOperation = async <T>(
  label: string,
  operation: () => Promise<T>
): Promise<T> => {
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !isTransientDatabaseError(error)) {
        throw error;
      }

      logger.warn("Transient database operation failed; retrying", {
        label,
        attempt,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleep(350 * attempt);
    }
  }

  throw lastError;
};

const isTransientDatabaseError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return [
    "connection error",
    "connection terminated",
    "econnreset",
    "etimedout",
    "eaddrnotavail",
    "enotfound",
    "not queryable",
    "timeout"
  ].some((pattern) => normalized.includes(pattern));
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const logWorkerHeartbeat = (
  runnerId: string,
  state: "idle" | "claimed",
  extra: Record<string, unknown> = {}
): void => {
  const timestamp = Date.now();

  if (
    state === "idle" &&
    timestamp - lastWorkerHeartbeatAt < WORKER_HEARTBEAT_INTERVAL_MS
  ) {
    return;
  }

  lastWorkerHeartbeatAt = timestamp;
  logger.info("Jarvis chat reply worker heartbeat", {
    runner_id: runnerId,
    state,
    ...extra
  });
};

const positiveInteger = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const __jarvisCodexChatInternals = {
  buildCodexExecArgs,
  buildCodexCasualPrompt,
  buildRuntimeConfig,
  fallbackReply,
  meaningfulHistory,
  sanitizeCodexReply
};

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { auditLog } from "../audit-log/auditLogService.js";
import { telegramService } from "../telegram/telegramService.js";
import { database } from "../../services/dbService.js";
import { JARVIS_SOUL_PROMPT } from "./jarvisSoul.js";
import type {
  ChatConversationRecord,
  ChatMessageRecord,
  JarvisChatReplyJobRecord
} from "../../types/operator.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 16;

type ProcessNextInput = {
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
    await expireJobs();

    const job = await database.claimNextJarvisChatReplyJob(
      input.runnerId,
      this.timeoutMs()
    );

    if (!job) {
      return false;
    }

    try {
      const context = await loadJobContext(job);
      const reply = sanitizeCodexReply(
        await (input.generateReply ?? generateCodexReply)(context)
      );

      await appendAndSendReply(job, reply, "codex_casual_reply");
      await database.finishJarvisChatReplyJob(job.id, {
        status: "succeeded",
        reply_body: reply
      });
      await auditLog.log({
        event_type: "jarvis.codex_chat_reply_completed",
        payload: {
          job_id: job.id,
          conversation_id: job.conversation_id
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = fallbackReply();
      await appendAndSendReply(job, fallback, "codex_casual_reply_failed");
      await database.finishJarvisChatReplyJob(job.id, {
        status: "failed",
        reply_body: fallback,
        error: message
      });
      await auditLog.log({
        event_type: "jarvis.codex_chat_reply_failed",
        severity: "warn",
        payload: {
          job_id: job.id,
          conversation_id: job.conversation_id,
          error: message
        }
      });
    }

    return true;
  }
};

const expireJobs = async (): Promise<void> => {
  const expired = await database.expireJarvisChatReplyJobs();

  for (const job of expired) {
    await appendAndSendReply(job, fallbackReply(), "codex_casual_reply_expired");
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

  try {
    await execFileAsync(
      executable,
      [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--cd",
        repoPath,
        "--output-last-message",
        outputPath,
        prompt
      ],
      {
        env: process.env,
        maxBuffer: 1024 * 1024,
        timeout: jarvisCodexChatService.timeoutMs()
      }
    );

    const reply = (await readFile(outputPath, "utf8")).trim();

    if (!reply) {
      throw new Error("Codex produced an empty Jarvis chat reply.");
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

const buildCodexCasualPrompt = (input: GenerateReplyInput): string => {
  const history = input.history
    .map((message) => {
      const label = message.role === "assistant" ? "Jarvis" : "Blake";
      return `${label}: ${message.body}`;
    })
    .join("\n");

  return [
    "You are writing the next Telegram reply as Jarvis.",
    "",
    "Use this identity and tone source:",
    JARVIS_SOUL_PROMPT,
    "",
    "Current capability rules:",
    "- You can talk through Telegram, SMS, and the website.",
    "- You can check status and handle approvals directly.",
    "- You can operate Blake's Mac through the local bridge when he starts the request with `task`.",
    "- Do not claim you already did work unless the conversation history says so.",
    "- Do not create or queue tasks in this reply. You are only writing a conversational reply.",
    "- Mention the `task ...` trigger only if Blake is asking you to execute an action.",
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
  ].join("\n");
};

const sanitizeCodexReply = (value: string): string => {
  const cleaned = value
    .replace(/\bas an ai\b/gi, "as Jarvis")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  return cleaned.length > 1200 ? `${cleaned.slice(0, 1197)}...` : cleaned;
};

const fallbackReply = (): string =>
  "I hit a snag generating the sharper reply. I'm still here; talk normally, or start with `task` when you want me to act.";

const positiveInteger = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const __jarvisCodexChatInternals = {
  buildCodexCasualPrompt,
  fallbackReply,
  sanitizeCodexReply
};

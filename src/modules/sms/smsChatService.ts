import { z } from "zod";
import { auditLog } from "../audit-log/auditLogService.js";
import { taskService } from "../execution-engine/taskService.js";
import { completeJson } from "../../services/openaiService.js";
import { database } from "../../services/dbService.js";
import type {
  ConfirmationRequestRecord,
  DeveloperTaskRecord,
  SmsConversationRecord,
  SmsMessageRecord,
  TaskStatusResult
} from "../../types/operator.js";

type HandleInboundInput = {
  from: string;
  body: string;
  messageSid: string | null;
};

const smsIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("chat_reply"),
      reply: z.string().min(1).max(1000)
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_task"),
      utterance: z.string().min(3).max(5000),
      repoHint: z.string().min(1).max(200).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("get_task_status"),
      taskId: z.string().min(1).max(80).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("approve_confirmation"),
      confirmationRef: z.string().min(1).max(80).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("deny_confirmation"),
      confirmationRef: z.string().min(1).max(80).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("continue_task"),
      taskId: z.string().min(1).max(80).optional(),
      instructions: z.string().min(1).max(5000).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancel_task"),
      taskId: z.string().min(1).max(80).optional(),
      reason: z.string().min(1).max(1000).optional()
    })
    .strict()
]);

type SmsIntent = z.infer<typeof smsIntentSchema>;

const OPENAI_TIMEOUT_MS = 6500;
const FALLBACK_REPLY =
  "I'm online, but I need you to rephrase that as a task or status request.";
const HELP_REPLY =
  "CallAI/Jarvis help: text a developer task, ask for status, or reply approve/deny plus the approval code. Reply STOP to opt out.";
const START_REPLY =
  "CallAI SMS is active. Text hello, status, or a developer task when you need Jarvis.";
const STOP_REPLY =
  "You are opted out of CallAI SMS messages. Reply START to resume.";
const OPTED_OUT_REPLY =
  "You are opted out of CallAI SMS messages. Reply START to resume.";

type SmsKeyword = "help" | "start" | "stop";

export const smsChatService = {
  async handleInbound(input: HandleInboundInput): Promise<string> {
    const keyword = smsKeyword(input.body);
    const existing = await database.findSmsConversationByPhone(input.from);
    const status =
      keyword === "stop"
        ? "stopped"
        : keyword === "start"
          ? "active"
          : existing?.status ?? "active";
    const conversation = await database.upsertSmsConversation({
      phone_e164: input.from,
      status
    });

    await database.appendSmsMessage({
      conversation_id: conversation.id,
      role: "user",
      body: input.body,
      provider_message_sid: input.messageSid,
      payload: {
        from_tail: input.from.slice(-4)
      }
    });

    await auditLog.log({
      event_type: "sms.message_received",
      payload: {
        conversation_id: conversation.id,
        from_tail: input.from.slice(-4),
        message_sid: input.messageSid,
        body_length: input.body.length
      }
    });

    const reply = await routeMessage(conversation, input.body);

    await database.appendSmsMessage({
      conversation_id: conversation.id,
      role: "assistant",
      body: reply,
      payload: {
        to_tail: input.from.slice(-4)
      }
    });

    return reply;
  }
};

const routeMessage = async (
  conversation: SmsConversationRecord,
  body: string
): Promise<string> => {
  const keyword = smsKeyword(body);

  if (keyword) {
    await auditLog.log({
      event_type: "sms.keyword_handled",
      payload: {
        conversation_id: conversation.id,
        keyword
      }
    });

    if (keyword === "help") {
      return HELP_REPLY;
    }

    if (keyword === "start") {
      return START_REPLY;
    }

    return STOP_REPLY;
  }

  if (conversation.status === "stopped") {
    return OPTED_OUT_REPLY;
  }

  try {
    const history = await database.listSmsMessages(conversation.id, 10);
    const intent = await classifySmsIntent(body, history);
    const reply = await dispatchIntent(intent);

    await auditLog.log({
      event_type: "sms.intent_handled",
      payload: {
        conversation_id: conversation.id,
        intent: intent.kind
      }
    });

    return sanitizeSmsReply(reply);
  } catch (error) {
    await auditLog.log({
      event_type: "sms.intent_failed",
      severity: "warn",
      payload: {
        conversation_id: conversation.id,
        error: error instanceof Error ? error.message : String(error)
      }
    });

    return FALLBACK_REPLY;
  }
};

const classifySmsIntent = async (
  body: string,
  history: SmsMessageRecord[]
): Promise<SmsIntent> => {
  const fallback = heuristicIntent(body);

  try {
    const parsed = await withTimeout(
      completeJson<unknown>({
        model: process.env.SMS_INTENT_MODEL ?? "gpt-4o-mini",
        maxTokens: 500,
        system:
          "You classify Jarvis SMS messages. Return only JSON matching one intent. Use chat_reply for greetings, small talk, capability questions, or unclear casual messages. Use create_task only when Blake asks Jarvis to do concrete developer work. Use status, approval, denial, continue, or cancel intents when the text clearly asks for those. Keep chat replies concise, precise, and useful. Never include secrets.",
        user: JSON.stringify({
          message: body,
          recentMessages: history.map((message) => ({
            role: message.role,
            body: message.body
          }))
        })
      }),
      OPENAI_TIMEOUT_MS
    );

    if (parsed) {
      return smsIntentSchema.parse(parsed);
    }
  } catch {
    return fallback;
  }

  return fallback;
};

const dispatchIntent = async (intent: SmsIntent): Promise<string> => {
  switch (intent.kind) {
    case "chat_reply":
      return intent.reply;
    case "create_task":
      return createTaskReply(intent.utterance, intent.repoHint);
    case "get_task_status":
      return statusReply(intent.taskId);
    case "approve_confirmation":
      return confirmationReply(intent.confirmationRef, "approved");
    case "deny_confirmation":
      return confirmationReply(intent.confirmationRef, "denied");
    case "continue_task":
      return continueReply(intent.taskId, intent.instructions);
    case "cancel_task":
      return cancelReply(intent.taskId, intent.reason);
  }
};

const createTaskReply = async (
  utterance: string,
  repoHint?: string
): Promise<string> => {
  const task = await taskService.createFromUtterance({
    utterance,
    repoHint,
    source: "sms"
  });

  await auditLog.log({
    task_id: task.task_id,
    event_type: "sms.task_created",
    payload: {
      status: task.status,
      needs_confirmation: task.needs_confirmation
    }
  });

  const tail = task.task_id.slice(-6);

  if (task.needs_confirmation && task.confirmation_id) {
    const confirmationTail = task.confirmation_id.slice(-6);
    return `Approval needed: ${task.interpreted_task.title}. Reply approve ${confirmationTail} or deny ${confirmationTail}.`;
  }

  return `Queued: ${task.interpreted_task.title}. Task ${tail}. I'll text you when it finishes.`;
};

const statusReply = async (taskRef?: string): Promise<string> => {
  const task = await resolveTask(taskRef);

  if (!task) {
    return "No CallAI tasks are in the queue yet.";
  }

  const status = await taskService.getStatus(task.id);
  return formatTaskStatus(status);
};

const confirmationReply = async (
  confirmationRef: string | undefined,
  decision: "approved" | "denied"
): Promise<string> => {
  const confirmation = await resolveConfirmation(confirmationRef);

  if (confirmation.kind === "none") {
    return "No pending approval is waiting right now.";
  }

  if (confirmation.kind === "ambiguous") {
    return `I found ${confirmation.count} pending approvals. Reply with approve plus the 6-character approval code.`;
  }

  const result = await taskService.approveAction(confirmation.record.id, decision);
  const label = decision === "approved" ? "Approved" : "Denied";

  await auditLog.log({
    task_id: result.task_id,
    event_type: "sms.confirmation_decided",
    payload: {
      decision,
      confirmation_id: confirmation.record.id
    }
  });

  return `${label}. Task ${result.task_id.slice(-6)} is now ${formatLabel(
    result.status
  )}.`;
};

const continueReply = async (
  taskRef: string | undefined,
  instructions?: string
): Promise<string> => {
  const task = await resolveTask(taskRef);

  if (!task) {
    return "I couldn't find a task to continue.";
  }

  const result = await taskService.continueTask(task.id, instructions);
  return `Queued again: ${result.task.title}. Task ${result.task.id.slice(-6)}.`;
};

const cancelReply = async (
  taskRef: string | undefined,
  reason?: string
): Promise<string> => {
  const task = await resolveTask(taskRef);

  if (!task) {
    return "I couldn't find a task to cancel.";
  }

  const result = await taskService.cancelTask(task.id, reason ?? "Cancelled by SMS.");
  return `Cancelled task ${result.task_id.slice(-6)}.`;
};

const resolveTask = async (
  taskRef?: string
): Promise<DeveloperTaskRecord | null> => {
  const tasks = await taskService.listTasks();
  const ref = normalizeRef(taskRef);

  if (ref) {
    return (
      tasks.find((task) => task.id.toLowerCase().endsWith(ref)) ??
      tasks.find((task) => task.title.toLowerCase().includes(ref)) ??
      null
    );
  }

  return (
    tasks.find((task) =>
      ["running", "queued", "needs_confirmation", "blocked"].includes(task.status)
    ) ??
    tasks[0] ??
    null
  );
};

const resolveConfirmation = async (
  confirmationRef?: string
): Promise<
  | { kind: "found"; record: ConfirmationRequestRecord }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" }
> => {
  const confirmations = await taskService.listPendingConfirmations();
  const ref = normalizeRef(confirmationRef);

  if (ref) {
    const match = confirmations.find(
      (confirmation) =>
        confirmation.id.toLowerCase().endsWith(ref) ||
        confirmation.task_id.toLowerCase().endsWith(ref)
    );

    return match ? { kind: "found", record: match } : { kind: "none" };
  }

  if (confirmations.length === 1 && confirmations[0]) {
    return { kind: "found", record: confirmations[0] };
  }

  if (confirmations.length > 1) {
    return { kind: "ambiguous", count: confirmations.length };
  }

  return { kind: "none" };
};

const formatTaskStatus = (status: TaskStatusResult): string => {
  const task = status.task;
  const tail = task.id.slice(-6);
  const summary = status.final_summary ? ` ${status.final_summary}` : "";

  if (status.confirmation) {
    const confirmationTail = status.confirmation.id.slice(-6);
    return `Task ${tail} needs approval: ${task.title}. Reply approve ${confirmationTail} or deny ${confirmationTail}.`;
  }

  return `Task ${tail} is ${formatLabel(task.status)}: ${task.title}.${summary}`;
};

const heuristicIntent = (body: string): SmsIntent => {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  const ref = lower.match(/\b(?:task|approval|confirmation)?\s*([a-f0-9]{4,12})\b/i)?.[1];

  if (/^(hi|hello|hey|yo|test|ping)[!. ]*$/i.test(trimmed)) {
    return {
      kind: "chat_reply",
      reply:
        "Online. I can chat, queue repo work, check status, and handle approvals by text."
    };
  }

  if (/\b(help|what can you do|commands|how does this work)\b/.test(lower)) {
    return {
      kind: "chat_reply",
      reply:
        "Text me developer tasks, ask for status, or reply approve/deny plus the approval code when I ask."
    };
  }

  if (/^\s*(yes|approve|approved|go ahead|proceed)\b/.test(lower)) {
    return { kind: "approve_confirmation", ...(ref ? { confirmationRef: ref } : {}) };
  }

  if (/^\s*(no|deny|denied|stop|do not)\b/.test(lower)) {
    return { kind: "deny_confirmation", ...(ref ? { confirmationRef: ref } : {}) };
  }

  if (/\b(status|what'?s running|progress|finished|done yet)\b/.test(lower)) {
    return { kind: "get_task_status", ...(ref ? { taskId: ref } : {}) };
  }

  if (/\b(continue|resume|keep going|try again)\b/.test(lower)) {
    return {
      kind: "continue_task",
      ...(ref ? { taskId: ref } : {}),
      instructions: trimmed
    };
  }

  if (/\b(cancel|stop task|kill task)\b/.test(lower)) {
    return {
      kind: "cancel_task",
      ...(ref ? { taskId: ref } : {}),
      reason: trimmed
    };
  }

  if (
    /\b(inspect|check|run|test|fix|update|edit|build|commit|push|open pr|pull request|summarize|repo|readme|deploy|logs?|chrome|browser|website|go to|navigate|search)\b/.test(
      lower
    ) ||
    /\b[a-z0-9-]+\.(?:com|org|net|ai|io|dev|app|co|edu|gov)\b/.test(lower)
  ) {
    return { kind: "create_task", utterance: trimmed };
  }

  return {
    kind: "chat_reply",
    reply:
      "I'm here. Tell me what you want checked, changed, summarized, or ask for task status."
  };
};

const smsKeyword = (body: string): SmsKeyword | null => {
  const normalized = body.trim().toLowerCase();

  if (/^(help|info)$/.test(normalized)) {
    return "help";
  }

  if (/^(start|unstop)$/.test(normalized)) {
    return "start";
  }

  if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/.test(normalized)) {
    return "stop";
  }

  return null;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SMS intent classification timed out.")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const normalizeRef = (value: string | undefined): string => {
  return (value ?? "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");
};

const formatLabel = (value: string): string => value.replaceAll("_", " ");

const sanitizeSmsReply = (value: string): string => {
  const redacted = value
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, "[redacted OpenAI key]")
    .replace(/AC[a-fA-F0-9]{32}/g, "[redacted Twilio SID]")
    .replace(/[a-fA-F0-9]{32,}/g, "[redacted token]")
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
      "$1=[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim();

  return redacted.length > 1000 ? `${redacted.slice(0, 997)}...` : redacted;
};

import { z } from "zod";
import { auditLog } from "../audit-log/auditLogService.js";
import { taskService } from "../execution-engine/taskService.js";
import { database } from "../../services/dbService.js";
import { JARVIS_SOUL_PROMPT } from "./jarvisSoul.js";
import { jarvisCodexChatService } from "./jarvisCodexChatService.js";
import type {
  ChatChannelKind,
  ChatConversationRecord,
  ChatMessageRecord,
  DeveloperTaskRecord,
  JarvisChatMessageView,
  TaskStatusResult
} from "../../types/operator.js";

type HandleMessageInput = {
  channelKind: ChatChannelKind;
  externalId: string;
  displayName: string;
  body: string;
  providerMessageId?: string | null;
  repoHint?: string;
  payload?: Record<string, unknown>;
};

type HandleMessageResult = {
  conversation: ChatConversationRecord;
  intent: JarvisIntent["kind"] | "queued_casual_reply";
  reply: string;
  casualReplyJobId?: string;
  confirmationId?: string;
  taskId?: string;
  messages: JarvisChatMessageView[];
};

const jarvisIntentSchema = z.discriminatedUnion("kind", [
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

type JarvisIntent = z.infer<typeof jarvisIntentSchema>;

const FALLBACK_REPLY =
  "I'm here. Talk normally, ask for status, or start a real command with task. That last word is the clutch so I don't accidentally start moving your Mac around because you were thinking out loud.";
const CODEX_CASUAL_RECEIPT = "Got it. Thinking for a second.";
const HELP_REPLY =
  "I can chat through Telegram, SMS, and the website; check status; handle approvals; and use the Mac bridge for Chrome, Finder, apps, screenshots, and safe shell commands. To queue work, start with task. Risky moves still stop for approval.";
const START_REPLY =
  "Back online. Send hello, status, or start with task when you want me to actually do work.";
const STOP_REPLY =
  "Jarvis chat is paused for this channel. Send START to resume.";
const OPTED_OUT_REPLY =
  "Jarvis chat is paused for this channel. Send START to resume.";
const GREETING_REPLY =
  "Here. Jarvis online. Chat normally; say task when you want me to touch the queue. Keeps the cockpit from turning every stray thought into a launch sequence.";
const IDENTITY_REPLY =
  "I'm Jarvis, Blake's engineering intelligence for CallAI, repo work, status checks, approvals, and Mac local-bridge operations. Calm mission control, slightly more caffeinated than the dashboard.";
const COMPUTER_CONTROL_REPLY =
  "Yes. I can operate the Mac through the local bridge: Chrome, Finder, visible apps, screenshots, and safe shell/file commands. Start with task when you want me to act. Risky moves still hit the approval gate.";
const OPENCLAW_REPLY =
  "That's the intended shape: Telegram, SMS, and the website all feed one Jarvis thread, then I route real work into CallAI tasks, Codex-thread jobs, or the local bridge. Messaging app on the front, operator system underneath.";
const SELF_ROUTING_REPLY =
  "Yes. That's the right boundary. I'll only queue new work when your message starts with task, /task, or task:. Everything else stays conversational unless it's status, approve, deny, continue, or cancel.";
const SOUL_TONE = {
  direct: JARVIS_SOUL_PROMPT.includes("Direct. Zero filler."),
  noSycophancy: JARVIS_SOUL_PROMPT.includes("No sycophancy"),
  neverAsAi: JARVIS_SOUL_PROMPT.includes("As an AI")
};

type ChatReplyContext = {
  body: string;
  history: ChatMessageRecord[];
};

type ChatKeyword = "help" | "start" | "stop";

const shouldQueueCodexCasualReply = (input: {
  body: string;
  channelKind: ChatChannelKind;
  conversation: ChatConversationRecord;
  keyword: ChatKeyword | null;
}): boolean => {
  return (
    input.channelKind === "telegram" &&
    jarvisCodexChatService.isEnabled() &&
    input.conversation.status !== "stopped" &&
    !input.keyword &&
    !isCommandLikeMessage(input.body) &&
    !looksLikeActionRequest(input.body)
  );
};

export const jarvisChatService = {
  async handleMessage(input: HandleMessageInput): Promise<HandleMessageResult> {
    const body = input.body.trim();
    const keyword = chatKeyword(body);
    const channel = await database.upsertChatChannel({
      kind: input.channelKind,
      external_id: input.externalId,
      display_name: input.displayName
    });
    const conversation = await database.upsertChatConversation({
      channel_id: channel.id,
      status: keyword === "stop" ? "stopped" : keyword === "start" ? "active" : undefined,
      title: "Jarvis"
    });

    const inbound = await database.appendChatMessage({
      conversation_id: conversation.id,
      direction: "inbound",
      role: "user",
      body,
      provider_message_id: input.providerMessageId ?? null,
      payload: {
        channel_kind: input.channelKind,
        ...(input.payload ?? {})
      }
    });

    if (
      shouldQueueCodexCasualReply({
        body,
        channelKind: input.channelKind,
        conversation,
        keyword
      })
    ) {
      const job = await jarvisCodexChatService.queueReply({
        conversationId: conversation.id,
        inboundMessageId: inbound.id
      });
      const receipt = await database.appendChatMessage({
        conversation_id: conversation.id,
        direction: "outbound",
        role: "assistant",
        body: CODEX_CASUAL_RECEIPT,
        payload: {
          intent: "queued_casual_reply_ack",
          jarvis_chat_reply_job_id: job.id
        }
      });

      await auditLog.log({
        event_type: "jarvis.chat_handled",
        payload: {
          channel_kind: input.channelKind,
          conversation_id: conversation.id,
          intent: "queued_casual_reply",
          jarvis_chat_reply_job_id: job.id
        }
      });

      return {
        conversation,
        intent: "queued_casual_reply",
        reply: receipt.body,
        casualReplyJobId: job.id,
        messages: await jarvisChatService.listMessages()
      };
    }

    const dispatch = await routeMessage({
      body,
      channelKind: input.channelKind,
      conversation,
      keyword,
      repoHint: input.repoHint
    });

    const assistant = await database.appendChatMessage({
      conversation_id: conversation.id,
      direction: "outbound",
      role: "assistant",
      body: sanitizeReply(dispatch.reply),
      task_id: dispatch.taskId ?? null,
      payload: {
        intent: dispatch.intent
      }
    });

    if (dispatch.taskId) {
      await database.linkChatMessageTask({
        message_id: assistant.id,
        task_id: dispatch.taskId,
        relation: dispatch.intent === "create_task" ? "created" : "referenced"
      });
    }

    await auditLog.log({
      task_id: dispatch.taskId ?? null,
      event_type: "jarvis.chat_handled",
      payload: {
        channel_kind: input.channelKind,
        conversation_id: conversation.id,
        intent: dispatch.intent
      }
    });

    return {
      conversation,
      intent: dispatch.intent,
      reply: assistant.body,
      ...(dispatch.confirmationId ? { confirmationId: dispatch.confirmationId } : {}),
      ...(dispatch.taskId ? { taskId: dispatch.taskId } : {}),
      messages: await jarvisChatService.listMessages()
    };
  },

  async listMessages(limit = 80): Promise<JarvisChatMessageView[]> {
    const messages = await database.listChatMessages({ limit });
    return hydrateMessages(messages);
  },

  async appendTaskUpdate(input: {
    conversationId: string;
    taskId: string;
    body: string;
    relation: string;
  }): Promise<void> {
    const message = await database.appendChatMessage({
      conversation_id: input.conversationId,
      direction: "outbound",
      role: "assistant",
      body: sanitizeReply(input.body),
      task_id: input.taskId,
      payload: {
        event: input.relation
      }
    });
    await database.linkChatMessageTask({
      message_id: message.id,
      task_id: input.taskId,
      relation: input.relation
    });
  }
};

const routeMessage = async (input: {
  body: string;
  channelKind: ChatChannelKind;
  conversation: ChatConversationRecord;
  keyword: ChatKeyword | null;
  repoHint?: string;
}): Promise<{
  confirmationId?: string;
  intent: JarvisIntent["kind"];
  reply: string;
  taskId?: string;
}> => {
  if (input.keyword) {
    await auditLog.log({
      event_type: "jarvis.keyword_handled",
      payload: {
        conversation_id: input.conversation.id,
        keyword: input.keyword
      }
    });

    if (input.keyword === "help") {
      return { intent: "chat_reply", reply: HELP_REPLY };
    }

    if (input.keyword === "start") {
      return { intent: "chat_reply", reply: START_REPLY };
    }

    return { intent: "chat_reply", reply: STOP_REPLY };
  }

  if (input.conversation.status === "stopped") {
    return { intent: "chat_reply", reply: OPTED_OUT_REPLY };
  }

  const history = await database.listChatMessages({ limit: 12 });
  const deterministicReply = isCommandLikeMessage(input.body)
    ? null
    : deterministicChatReply(input.body);

  if (deterministicReply) {
    return { intent: "chat_reply", reply: deterministicReply };
  }

  try {
    const intent = await classifyIntent(input.body, history);
    return dispatchIntent(intent, input.channelKind, input.repoHint, {
      body: input.body,
      history
    });
  } catch (error) {
    await auditLog.log({
      event_type: "jarvis.intent_failed",
      severity: "warn",
      payload: {
        conversation_id: input.conversation.id,
        error: error instanceof Error ? error.message : String(error)
      }
    });

    return { intent: "chat_reply", reply: FALLBACK_REPLY };
  }
};

const classifyIntent = async (
  body: string,
  history: ChatMessageRecord[]
): Promise<JarvisIntent> => {
  return heuristicIntent(body);
};

const dispatchIntent = async (
  intent: JarvisIntent,
  channelKind: ChatChannelKind,
  repoHint?: string,
  chatContext?: ChatReplyContext
): Promise<{
  confirmationId?: string;
  intent: JarvisIntent["kind"];
  reply: string;
  taskId?: string;
}> => {
  switch (intent.kind) {
    case "chat_reply":
      return chatReply(
        chatContext?.body ?? intent.reply,
        chatContext?.history ?? [],
        intent.reply
      );
    case "create_task":
      return createTaskReply(intent.utterance, intent.repoHint ?? repoHint, channelKind);
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

const chatReply = async (
  body: string,
  history: ChatMessageRecord[],
  classifierReply?: string
): Promise<{ intent: "chat_reply"; reply: string }> => {
  const deterministicReply = deterministicChatReply(body);

  if (deterministicReply) {
    return { intent: "chat_reply", reply: deterministicReply };
  }

  if (classifierReply && !isGenericChatReply(classifierReply)) {
    return { intent: "chat_reply", reply: classifierReply };
  }

  return { intent: "chat_reply", reply: await fallbackCasualReply(body) };
};

const createTaskReply = async (
  utterance: string,
  repoHint: string | undefined,
  channelKind: ChatChannelKind
): Promise<{
  confirmationId?: string;
  intent: "create_task";
  reply: string;
  taskId: string;
}> => {
  const task = await taskService.createFromUtterance({
    utterance,
    repoHint,
    source:
      channelKind === "sms"
        ? "sms"
        : channelKind === "telegram"
          ? "telegram"
          : "web_chat"
  });
  const tail = task.task_id.slice(-6);

  await auditLog.log({
    task_id: task.task_id,
    event_type: "jarvis.task_created",
    payload: {
      channel_kind: channelKind,
      status: task.status,
      needs_confirmation: task.needs_confirmation
    }
  });

  if (task.needs_confirmation && task.confirmation_id) {
    const confirmationTail = task.confirmation_id.slice(-6);
    return {
      intent: "create_task",
      confirmationId: task.confirmation_id,
      taskId: task.task_id,
      reply: `Approval gate. Task ${tail}: ${task.interpreted_task.title}. Reply approve ${confirmationTail} or deny ${confirmationTail}.`
    };
  }

  if (task.status === "blocked") {
    return {
      intent: "create_task",
      taskId: task.task_id,
      reply: `Hard stop on task ${tail}: ${task.interpreted_task.title}. I do not handle passwords, 2FA, CAPTCHAs, secrets, banking, payment execution, credential harvesting, or security bypass.`
    };
  }

  if (task.execution_target === "codex_thread") {
    return {
      intent: "create_task",
      taskId: task.task_id,
      reply: `Got it. I sent task ${tail} to the Codex chat: ${task.interpreted_task.title}. I'll report back here when it moves.`
    };
  }

  return {
    intent: "create_task",
    taskId: task.task_id,
    reply: `Got it. I queued task ${tail}: ${task.interpreted_task.title}. I'll report back here when it moves.`
  };
};

const statusReply = async (
  taskRef?: string
): Promise<{ intent: "get_task_status"; reply: string; taskId?: string }> => {
  const task = await resolveTask(taskRef);

  if (!task) {
    return { intent: "get_task_status", reply: "No Jarvis tasks are in the queue yet." };
  }

  const status = await taskService.getStatus(task.id);
  return {
    intent: "get_task_status",
    taskId: task.id,
    reply: formatTaskStatus(status)
  };
};

const confirmationReply = async (
  confirmationRef: string | undefined,
  decision: "approved" | "denied"
): Promise<{
  intent: "approve_confirmation" | "deny_confirmation";
  reply: string;
  taskId?: string;
}> => {
  const confirmation = await resolveConfirmation(confirmationRef);
  const intent =
    decision === "approved" ? "approve_confirmation" : "deny_confirmation";

  if (confirmation.kind === "none") {
    return { intent, reply: "No pending approval is waiting right now." };
  }

  if (confirmation.kind === "ambiguous") {
    return {
      intent,
      reply: `I found ${confirmation.count} pending approvals. Reply with approve plus the 6-character approval code.`
    };
  }

  const result = await taskService.approveAction(confirmation.record.id, decision);
  const label = decision === "approved" ? "Approved" : "Denied";

  await auditLog.log({
    task_id: result.task_id,
    event_type: "jarvis.confirmation_decided",
    payload: {
      decision,
      confirmation_id: confirmation.record.id
    }
  });

  return {
    intent,
    taskId: result.task_id,
    reply: `${label}. Task ${result.task_id.slice(-6)} is now ${formatLabel(
      result.status
    )}.`
  };
};

const continueReply = async (
  taskRef: string | undefined,
  instructions?: string
): Promise<{ intent: "continue_task"; reply: string; taskId?: string }> => {
  const task = await resolveTask(taskRef);

  if (!task) {
    return { intent: "continue_task", reply: "I couldn't find a task to continue." };
  }

  const result = await taskService.continueTask(task.id, instructions);
  return {
    intent: "continue_task",
    taskId: result.task.id,
    reply: `Queued again: ${result.task.title}. Task ${result.task.id.slice(-6)}.`
  };
};

const cancelReply = async (
  taskRef: string | undefined,
  reason?: string
): Promise<{ intent: "cancel_task"; reply: string; taskId?: string }> => {
  const task = await resolveTask(taskRef);

  if (!task) {
    return { intent: "cancel_task", reply: "I couldn't find a task to cancel." };
  }

  const result = await taskService.cancelTask(task.id, reason ?? "Cancelled by Jarvis chat.");
  return {
    intent: "cancel_task",
    taskId: result.task_id,
    reply: `Cancelled task ${result.task_id.slice(-6)}.`
  };
};

const hydrateMessages = async (
  messages: ChatMessageRecord[]
): Promise<JarvisChatMessageView[]> => {
  const hydrated: JarvisChatMessageView[] = [];

  for (const message of messages) {
    const channel = await channelForMessage(message);
    const task = message.task_id ? await database.getTask(message.task_id) : null;

    hydrated.push({
      ...message,
      channel_kind: channel?.kind ?? "web",
      channel_display_name: channel?.display_name ?? "Jarvis",
      ...(task
        ? {
            task: {
              id: task.id,
              title: task.title,
              status: task.status,
              normalized_action: task.normalized_action,
              execution_target: task.execution_target,
              updated_at: task.updated_at
            }
          }
        : {})
    });
  }

  return hydrated;
};

const channelForMessage = async (
  message: ChatMessageRecord
): Promise<{ kind: ChatChannelKind; display_name: string } | null> => {
  const conversation = await database.getChatConversation(message.conversation_id);
  const directChannel = conversation
    ? await database.getChatChannel(conversation.channel_id)
    : null;

  if (directChannel) {
    return {
      kind: directChannel.kind,
      display_name: directChannel.display_name
    };
  }

  const origins = message.task_id
    ? await database.listChatTaskOrigins(message.task_id)
    : [];
  const origin = origins.find((item) => item.conversation_id === message.conversation_id);

  if (origin) {
    return {
      kind: origin.channel_kind,
      display_name: origin.display_name
    };
  }

  return null;
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
  | { kind: "found"; record: Awaited<ReturnType<typeof taskService.listPendingConfirmations>>[number] }
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

const explicitTaskRequest = (body: string): string | null => {
  const trimmed = body.trim();
  const match = trimmed.match(/^(?:jarvis[,\s]+)?(?:please\s+)?(?:\/task|task)\b(?:\s*[:\-]\s*|\s+)([\s\S]+)$/i);
  const utterance = match?.[1]?.trim();
  return utterance && utterance.length >= 3 ? utterance : null;
};

const isCommandLikeMessage = (body: string): boolean => {
  const lower = body.trim().toLowerCase();

  return (
    explicitTaskRequest(body) !== null ||
    /^\s*(yes|approve|approved|go ahead|proceed)\b/.test(lower) ||
    /^\s*(no|deny|denied|do not)\b/.test(lower) ||
    /\b(status|what'?s running|progress|finished|done yet)\b/.test(lower) ||
    /\b(continue|resume|keep going|try again)\b/.test(lower) ||
    /\b(cancel|stop task|kill task)\b/.test(lower)
  );
};

const looksLikeActionRequest = (body: string): boolean => {
  const lower = body.trim().toLowerCase();

  return (
    /\b(inspect|check|run|test|fix|update|edit|build|commit|push|open pr|pull request|summarize|repo|readme|deploy|logs?|chrome|browser|website|go to|navigate|search|open|finder|terminal|system settings|settings app|mail|messages|notes|calendar|desktop|downloads|documents|screenshot|screen shot|shell command|list files|show files)\b/.test(
      lower
    ) ||
    /\b[a-z0-9-]+\.(?:com|org|net|ai|io|dev|app|co|edu|gov)\b/.test(lower)
  );
};

const deterministicChatReply = (body: string): string | null => {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();

  if (
    /^(hi|hello|hey|yo|sup|test|ping|\/start)\b[!. ,a-z]*$/i.test(trimmed) &&
    !looksLikeActionRequest(trimmed)
  ) {
    return GREETING_REPLY;
  }

  if (
    /\b(code|program|change|adjust|make)\b.*\b(only|just)\b.*\b(task)\b/.test(
      lower
    ) ||
    /\b(use|say|include)\b.*\b(word ['"]?task['"]?)\b/.test(lower)
  ) {
    return SELF_ROUTING_REPLY;
  }

  if (
    /\b(what'?s|what is|who are|who r)\b.*\b(name|you)\b/.test(lower) ||
    /\b(your name|who am i talking to)\b/.test(lower)
  ) {
    return IDENTITY_REPLY;
  }

  if (/\b(openclaw|open claw)\b/.test(lower)) {
    return OPENCLAW_REPLY;
  }

  if (
    /\b(can|could|able|will)\b.*\b(control|use|operate|drive)\b.*\b(computer|mac|desktop|chrome|browser)\b/.test(
      lower
    ) ||
    /\b(control|use|operate|drive)\b.*\b(my )?(computer|mac|desktop)\b/.test(lower)
  ) {
    return COMPUTER_CONTROL_REPLY;
  }

  if (/\b(help|what can you do|commands|how does this work)\b/.test(lower)) {
    return HELP_REPLY;
  }

  if (looksLikeActionRequest(trimmed) && !explicitTaskRequest(trimmed)) {
    return taskTriggerReply(trimmed);
  }

  return null;
};

const fallbackCasualReply = async (body: string): Promise<string> => {
  const lower = body.trim().toLowerCase();

  if (/\b(what did you do|what'd you do|did you actually|what happened|what changed)\b/.test(lower)) {
    return latestWorkReply();
  }

  if (lower.includes("?")) {
    return "Short version: I can talk through it, check status, and run real work when you start with task. Risky moves still pause for approval. Boring rule, useful outcome.";
  }

  return FALLBACK_REPLY;
};

const latestWorkReply = async (): Promise<string> => {
  const latest = await resolveTask();

  if (!latest) {
    return "Nothing moved yet. The queue is clean. If you want action, start with task and I'll take the wheel.";
  }

  const status = await taskService.getStatus(latest.id);
  const summary = status.final_summary
    ? ` ${status.final_summary}`
    : status.runs[0]?.final_summary
      ? ` ${status.runs[0].final_summary}`
      : "";

  if (latest.status === "succeeded") {
    return `I finished task ${latest.id.slice(-6)}: ${latest.title}.${summary}`;
  }

  if (latest.status === "running") {
    return `I'm still moving on task ${latest.id.slice(-6)}: ${latest.title}. ${nextTaskHint(status)}`;
  }

  if (latest.status === "queued") {
    return `Task ${latest.id.slice(-6)} is queued: ${latest.title}. It has not been picked up yet.`;
  }

  if (latest.status === "needs_confirmation") {
    return formatTaskStatus(status);
  }

  return `Latest task ${latest.id.slice(-6)} is ${formatLabel(latest.status)}: ${latest.title}.${summary}`;
};

const nextTaskHint = (status: TaskStatusResult): string => {
  if (status.latest_events[0]) {
    return `Last signal: ${formatLabel(status.latest_events[0].event_type)}.`;
  }

  return "No useful event signal yet.";
};

const taskTriggerReply = (body: string): string => {
  const example = explicitTaskExample(body);
  return `I can do that. Start it with task so I know you want execution, not discussion. Example: ${example}`;
};

const explicitTaskExample = (body: string): string => {
  const cleaned = body.trim().replace(/[.?!]+$/, "");
  return `task ${cleaned}`;
};

const isGenericChatReply = (reply: string): boolean => {
  const normalized = reply.trim().toLowerCase();

  return (
    normalized === FALLBACK_REPLY.toLowerCase() ||
    normalized.includes("tell me what you want checked") ||
    normalized.includes("rephrase that as a task") ||
    normalized.includes("ask for task status")
  );
};

const heuristicIntent = (body: string): JarvisIntent => {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  const ref = lower.match(/\b(?:task|approval|confirmation)?\s*([a-f0-9]{4,12})\b/i)?.[1];
  const taskRequest = explicitTaskRequest(trimmed);

  if (/^\s*(yes|approve|approved|go ahead|proceed)\b/.test(lower)) {
    return { kind: "approve_confirmation", ...(ref ? { confirmationRef: ref } : {}) };
  }

  if (/^\s*(no|deny|denied|do not)\b/.test(lower)) {
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

  const deterministicReply = deterministicChatReply(body);

  if (deterministicReply) {
    return { kind: "chat_reply", reply: deterministicReply };
  }

  if (taskRequest) {
    return { kind: "create_task", utterance: taskRequest };
  }

  if (looksLikeActionRequest(trimmed)) {
    return {
      kind: "chat_reply",
      reply: taskTriggerReply(trimmed)
    };
  }

  return {
    kind: "chat_reply",
    reply: FALLBACK_REPLY
  };
};

const chatKeyword = (body: string): ChatKeyword | null => {
  const normalized = body.trim().toLowerCase().replace(/^\//, "");

  if (/^(help|info)$/.test(normalized)) {
    return "help";
  }

  if (/^(start|unstop)$/.test(normalized)) {
    return "start";
  }

  if (/^(stop|stopall|unsubscribe|end|quit)$/.test(normalized)) {
    return "stop";
  }

  return null;
};

const normalizeRef = (value: string | undefined): string => {
  return (value ?? "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");
};

const formatLabel = (value: string): string => value.replaceAll("_", " ");

const sanitizeReply = (value: string): string => {
  const redacted = value
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSCODE|AUTH)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
      "$1=[redacted]"
    )
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, "[redacted API key]")
    .replace(/AC[a-fA-F0-9]{32}/g, "[redacted Twilio SID]")
    .replace(/[a-fA-F0-9]{32,}/g, "[redacted token]");

  const toned = applySoulTone(redacted);
  return toned.length > 1000 ? `${toned.slice(0, 997)}...` : toned;
};

const applySoulTone = (value: string): string => {
  let reply = value;

  if (SOUL_TONE.direct) {
    reply = reply
      .replace(/^(great question|certainly|sure thing|of course)[!. ]+/i, "")
      .trim();
  }

  if (SOUL_TONE.neverAsAi) {
    reply = reply.replace(/\bas an ai\b/gi, "as Jarvis");
  }

  if (SOUL_TONE.noSycophancy) {
    reply = reply.replace(/\byou'?re absolutely right\b/gi, "Right");
  }

  return reply;
};

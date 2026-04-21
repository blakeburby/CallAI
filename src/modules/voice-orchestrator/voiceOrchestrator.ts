import { auditLog } from "../audit-log/auditLogService.js";
import { taskService } from "../execution-engine/taskService.js";
import { database } from "../../services/dbService.js";

type NormalizedVapiEvent = {
  type: string;
  callId: string | null;
  sessionId: string | null;
  role?: string;
  text?: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  raw: Record<string, unknown>;
};

export const voiceOrchestrator = {
  async handleWebhook(body: unknown): Promise<Record<string, unknown>> {
    const event = normalizeVapiEvent(body);
    const session = await database.upsertVoiceSession({
      vapi_call_id: event.callId,
      channel: "vapi",
      status: event.type === "call-ended" ? "ended" : "active"
    });

    await auditLog.log({
      session_id: session.id,
      event_type: `vapi.${event.type}`,
      payload: {
        call_id: event.callId,
        raw: event.raw
      }
    });

    if (event.text) {
      await database.appendTranscript({
        session_id: session.id,
        role: event.role ?? "unknown",
        text: event.text
      });
    }

    if (event.type === "call-ended") {
      await database.endVoiceSession(session.id);
    }

    if (event.toolCalls.length > 0) {
      const results = await Promise.all(
        event.toolCalls.map(async (toolCall) => ({
          toolCallId: toolCall.id,
          result: await handleWebhookToolCall(toolCall, session.id)
        }))
      );

      return { results };
    }

    return { success: true };
  }
};

const handleWebhookToolCall = async (
  toolCall: NormalizedVapiEvent["toolCalls"][number],
  sessionId: string
): Promise<Record<string, unknown>> => {
  if (toolCall.name !== "create_task") {
    return {
      success: false,
      error: `Unsupported webhook tool call: ${toolCall.name}`,
      message: "I ran into an issue processing that request."
    };
  }

  const utterance =
    typeof toolCall.arguments.utterance === "string"
      ? toolCall.arguments.utterance
      : "";
  const repoHint =
    typeof toolCall.arguments.repo_hint === "string"
      ? toolCall.arguments.repo_hint
      : undefined;

  const data = await taskService.createFromUtterance({
    utterance,
    sessionId,
    repoHint
  });

  return {
    success: true,
    data,
    message: data.needs_confirmation
      ? "I need one confirmation before I start that task."
      : "I created the task and queued it for the runner."
  };
};

const normalizeVapiEvent = (body: unknown): NormalizedVapiEvent => {
  const root = asRecord(body) ?? {};
  const message = asRecord(root.message) ?? root;
  const call = asRecord(message.call) ?? asRecord(root.call);
  const type = stringValue(message.type) ?? stringValue(root.type) ?? "unknown";
  const text =
    stringValue(message.transcript) ??
    stringValue(message.text) ??
    stringValue(root.transcript);
  const role =
    stringValue(message.role) ??
    stringValue(message.transcriptType) ??
    stringValue(root.role);
  const callId =
    stringValue(call?.id) ??
    stringValue(message.callId) ??
    stringValue(root.callId) ??
    null;
  const toolCalls = [
    ...collectToolCalls(message.toolCalls),
    ...collectToolCalls(message.toolCallList),
    ...collectNestedToolCalls(message.toolWithToolCallList)
  ];

  return {
    type,
    callId,
    sessionId: callId,
    ...(role ? { role } : {}),
    ...(text ? { text } : {}),
    toolCalls,
    raw: root
  };
};

const collectToolCalls = (
  value: unknown
): NormalizedVapiEvent["toolCalls"] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = asRecord(item);
    const fn = asRecord(record?.function);
    const id = stringValue(record?.id);
    const name = stringValue(record?.name) ?? stringValue(fn?.name);

    if (!record || !id || !name) {
      return [];
    }

    return [
      {
        id,
        name,
        arguments: parseArgs(record.arguments ?? fn?.arguments ?? {})
      }
    ];
  });
};

const collectNestedToolCalls = (
  value: unknown
): NormalizedVapiEvent["toolCalls"] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = asRecord(item);
    const toolCall = asRecord(record?.toolCall);
    const fn = asRecord(toolCall?.function);
    const id = stringValue(toolCall?.id);
    const name =
      stringValue(record?.name) ??
      stringValue(toolCall?.name) ??
      stringValue(fn?.name);

    if (!id || !name) {
      return [];
    }

    return [
      {
        id,
        name,
        arguments: parseArgs(fn?.parameters ?? fn?.arguments ?? {})
      }
    ];
  });
};

const parseArgs = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return asRecord(value) ?? {};
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const stringValue = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

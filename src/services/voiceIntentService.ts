const INTENT_NAMES = [
  "create_task",
  "get_task_status",
  "continue_task",
  "approve_action",
  "cancel_task",
  "send_project_update",
  "start_outbound_call"
] as const;

type IntentName = (typeof INTENT_NAMES)[number];

export const summarizeForVoice = async (
  toolName: string,
  data: unknown
): Promise<string> => {
  return fallbackSummary(toolName, data);
};

export const resolveIntent = async (transcript: string): Promise<string> => {
  const lower = transcript.toLowerCase();

  if (/\b(status|progress|running|done|finished)\b/.test(lower)) {
    return "get_task_status";
  }

  if (/^\s*(yes|approve|approved|go ahead|proceed)\b/.test(lower)) {
    return "approve_action";
  }

  if (/^\s*(no|deny|denied|do not|cancel)\b/.test(lower)) {
    return "cancel_task";
  }

  if (/\b(continue|resume|keep going|try again)\b/.test(lower)) {
    return "continue_task";
  }

  return "create_task";
};

const fallbackSummary = (toolName: string, data: unknown): string => {
  if (toolName === "create_task") {
    const record = asRecord(data);
    const status = stringValue(record?.status) ?? "queued";
    const target = stringValue(record?.execution_target);

    if (target === "codex_thread" && status === "queued") {
      return "I understood the task and sent it to the Codex project thread.";
    }

    return `I understood the task and it is now ${status.replaceAll("_", " ")}.`;
  }

  if (toolName === "get_task_status") {
    const record = asRecord(data);
    const task = asRecord(record?.task);
    const status = stringValue(task?.status) ?? "unknown";
    return `That task is currently ${status.replaceAll("_", " ")}.`;
  }

  return "I completed that developer operation.";
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const stringValue = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

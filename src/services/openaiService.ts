import OpenAI from "openai";

const VOICE_SUMMARY_SYSTEM_PROMPT =
  "You are a remote developer operations assistant. Convert JSON task or execution data into one concise spoken sentence. No markdown. No numbers beyond 2 decimal places. Sound natural, not robotic. Never read secrets aloud.";

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

let client: OpenAI | null = null;

export const getOpenAIClient = (): OpenAI | null => {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  client ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  return client;
};

export const summarizeForVoice = async (
  toolName: string,
  data: unknown
): Promise<string> => {
  const openai = getOpenAIClient();

  if (!openai) {
    return fallbackSummary(toolName, data);
  }

  const completion = await openai.chat.completions.create({
    model: process.env.VOICE_SUMMARY_MODEL ?? "gpt-4o",
    max_tokens: 120,
    messages: [
      {
        role: "system",
        content: VOICE_SUMMARY_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify({
          toolName,
          data
        })
      }
    ]
  });

  return (
    completion.choices[0]?.message?.content?.trim() ||
    fallbackSummary(toolName, data)
  );
};

export const resolveIntent = async (transcript: string): Promise<string> => {
  const openai = getOpenAIClient();

  if (!openai) {
    return transcript.toLowerCase().includes("status")
      ? "get_task_status"
      : "create_task";
  }

  const completion = await openai.chat.completions.create({
    model: process.env.INTENT_MODEL ?? "gpt-4o-mini",
    max_tokens: 30,
    messages: [
      {
        role: "system",
        content:
          "Map the user's developer-operator command to exactly one function name. Return only one of: create_task, get_task_status, continue_task, approve_action, cancel_task, send_project_update, start_outbound_call."
      },
      {
        role: "user",
        content: transcript
      }
    ]
  });

  const resolved = completion.choices[0]?.message?.content?.trim() as IntentName;

  if (INTENT_NAMES.includes(resolved)) {
    return resolved;
  }

  return "create_task";
};

export const completeJson = async <T>(input: {
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T | null> => {
  const openai = getOpenAIClient();

  if (!openai) {
    return null;
  }

  const completion = await openai.chat.completions.create({
    model: input.model ?? process.env.TASK_PARSER_MODEL ?? "gpt-4o-mini",
    max_tokens: input.maxTokens ?? 700,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: input.system
      },
      {
        role: "user",
        content: input.user
      }
    ]
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    return null;
  }

  return JSON.parse(content) as T;
};

const fallbackSummary = (toolName: string, data: unknown): string => {
  if (toolName === "create_task") {
    const record = asRecord(data);
    const status = stringValue(record?.status) ?? "queued";
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

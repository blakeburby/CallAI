import type { Response } from "express";

const ERROR_MESSAGE = "I ran into an issue processing that request.";

type JsonRecord = Record<string, unknown>;

type ToolResponsePayload = {
  success: boolean;
  data?: unknown;
  error?: string;
  message: string;
};

type VapiToolCall = {
  id: string;
  arguments: unknown;
};

export const extractVapiToolCall = (
  body: unknown,
  toolName: string
): VapiToolCall | null => {
  const message = asRecord(body)?.message;
  const messageRecord = asRecord(message);

  if (!messageRecord) {
    return null;
  }

  const candidates = [
    ...collectToolCalls(messageRecord.toolCallList),
    ...collectToolCalls(messageRecord.toolCalls),
    ...collectNestedToolCalls(messageRecord.toolWithToolCallList)
  ];

  const match =
    candidates.find((candidate) => candidate.name === toolName) ??
    candidates[0];

  if (!match?.id) {
    return null;
  }

  return {
    id: match.id,
    arguments: parseArguments(match.arguments)
  };
};

export const setVapiToolLocals = (
  response: Response,
  toolCallId: string
): void => {
  response.locals.vapiToolCallId = toolCallId;
};

export const sendToolPayload = (
  response: Response,
  payload: ToolResponsePayload,
  statusCode = 200
): void => {
  const toolCallId = response.locals.vapiToolCallId;

  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    response.json({
      results: [
        {
          toolCallId,
          result: payload
        }
      ]
    });
    return;
  }

  response.status(statusCode).json(payload);
};

export const sendValidationError = (
  response: Response,
  error: string
): void => {
  sendToolPayload(
    response,
    {
      success: false,
      error,
      message: ERROR_MESSAGE
    },
    400
  );
};

const asRecord = (value: unknown): JsonRecord | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return null;
};

const collectToolCalls = (value: unknown): Array<{
  id?: string;
  name?: string;
  arguments?: unknown;
}> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    const record = asRecord(item);
    const fn = asRecord(record?.function);

    return {
      id: stringValue(record?.id),
      name: stringValue(record?.name) ?? stringValue(fn?.name),
      arguments: record?.arguments ?? fn?.arguments ?? fn?.parameters ?? {}
    };
  });
};

const collectNestedToolCalls = (value: unknown): Array<{
  id?: string;
  name?: string;
  arguments?: unknown;
}> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    const record = asRecord(item);
    const toolCall = asRecord(record?.toolCall);
    const fn = asRecord(toolCall?.function);

    return {
      id: stringValue(toolCall?.id),
      name:
        stringValue(record?.name) ??
        stringValue(toolCall?.name) ??
        stringValue(fn?.name),
      arguments: fn?.parameters ?? fn?.arguments ?? {}
    };
  });
};

const parseArguments = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value ?? {};
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
};

const stringValue = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

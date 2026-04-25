import type { Request, Response } from "express";
import { chatConnector } from "../modules/chat-connector/chatConnector.js";
import { taskService } from "../modules/execution-engine/taskService.js";
import { vapiCallService } from "../modules/voice-calls/vapiCallService.js";
import { summarizeForVoice } from "../services/openaiService.js";
import { logger } from "../utils/logger.js";
import { sendToolPayload } from "../utils/vapiTooling.js";

const ERROR_MESSAGE = "I ran into an issue processing that request.";

type CreateTaskBody = {
  utterance: string;
  session_id?: string;
  repo_hint?: string;
};

type TaskIdBody = {
  task_id: string;
};

type ContinueTaskBody = TaskIdBody & {
  instructions?: string;
};

type ApproveActionBody = {
  confirmation_id: string;
  decision: "approved" | "denied";
};

type CancelTaskBody = TaskIdBody & {
  reason?: string;
};

type SendProjectUpdateBody = {
  task_id?: string;
  channel_hint?: string;
  message: string;
};

type StartOutboundCallBody = {
  phone_number: string;
  reason: string;
  task_id?: string;
};

export const createTask = async (
  request: Request<object, object, CreateTaskBody>,
  response: Response
): Promise<void> => {
  await sendToolResult(response, "create_task", async () =>
    taskService.createFromUtterance({
      utterance: request.body.utterance,
      sessionId: request.body.session_id,
      repoHint: request.body.repo_hint,
      source: "tool"
    })
  );
};

export const getTaskStatus = async (
  request: Request<object, object, TaskIdBody>,
  response: Response
): Promise<void> => {
  await sendToolResult(response, "get_task_status", async () =>
    taskService.getStatus(request.body.task_id)
  );
};

export const continueTask = async (
  request: Request<object, object, ContinueTaskBody>,
  response: Response
): Promise<void> => {
  await sendToolResult(response, "continue_task", async () =>
    taskService.continueTask(request.body.task_id, request.body.instructions)
  );
};

export const approveAction = async (
  request: Request<object, object, ApproveActionBody>,
  response: Response
): Promise<void> => {
  await sendToolResult(response, "approve_action", async () =>
    taskService.approveAction(request.body.confirmation_id, request.body.decision)
  );
};

export const cancelTask = async (
  request: Request<object, object, CancelTaskBody>,
  response: Response
): Promise<void> => {
  await sendToolResult(response, "cancel_task", async () =>
    taskService.cancelTask(request.body.task_id, request.body.reason)
  );
};

export const sendProjectUpdate = async (
  request: Request<object, object, SendProjectUpdateBody>,
  response: Response
): Promise<void> => {
  await sendToolResult(response, "send_project_update", async () =>
    chatConnector.sendProjectUpdate({
      taskId: request.body.task_id,
      channelHint: request.body.channel_hint,
      message: request.body.message
    })
  );
};

export const startOutboundCall = async (
  request: Request<object, object, StartOutboundCallBody>,
  response: Response
): Promise<void> => {
  await sendToolResult(response, "start_outbound_call", async () =>
    vapiCallService.startOutboundCall({
      phone_number: request.body.phone_number,
      reason: request.body.reason,
      task_id: request.body.task_id
    })
  );
};

const sendToolResult = async (
  response: Response,
  toolName: string,
  execute: () => Promise<unknown>
): Promise<void> => {
  try {
    const data = await execute();
    const message = await summarizeForVoice(toolName, data);

    sendToolPayload(response, {
      success: true,
      data,
      message
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    logger.error(`Tool execution failed: ${toolName}`, { error: detail });

    const isUserError =
      /not found|cannot be continued|already|expired|confirmation/i.test(detail);

    sendToolPayload(
      response,
      {
        success: false,
        error: isUserError ? detail : "An internal error occurred.",
        message: ERROR_MESSAGE
      },
      isUserError ? 400 : 500
    );
  }
};

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

process.env.DATABASE_URL = "";
process.env.FRONTEND_PASSCODE = "test-passcode";
process.env.OPENAI_API_KEY = "sk-invalid-runtime-should-not-be-used";
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_OWNER_USER_ID = "12345";
process.env.TELEGRAM_WEBHOOK_SECRET = "telegram-secret";
process.env.VAPI_PUBLIC_KEY = "public-test-key";
process.env.VAPI_ASSISTANT_ID = "assistant-test-id";
process.env.VAPI_ASSISTANT_NAME = "Jarvis Test";

const { app } = await import("./app.js");
const { database } = await import("./services/dbService.js");
const { smsChatService } = await import("./modules/sms/smsChatService.js");
const { taskService } = await import("./modules/execution-engine/taskService.js");
const {
  classifyComputerInstructionRisk,
  classifyShellCommandRisk,
  inferShellCommandFromInstructions,
  redactComputerText
} = await import("./modules/mac-computer-controller/macComputerController.js");

const withServer = async <T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> => {
  const server = app.listen(0);

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

const login = async (baseUrl: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/frontend/login`, {
    body: JSON.stringify({ passcode: "test-passcode" }),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie;
};

const taskCount = async (): Promise<number> => {
  return (await database.listTasks(200)).length;
};

test("frontend bootstrap returns logged-out 200 and authenticated config", async () => {
  await withServer(async (baseUrl) => {
    const loggedOut = await fetch(`${baseUrl}/frontend/bootstrap`);
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(await loggedOut.json(), {
      success: true,
      data: {
        authenticated: false
      }
    });

    const protectedConfig = await fetch(`${baseUrl}/frontend/config`);
    assert.equal(protectedConfig.status, 401);

    const cookie = await login(baseUrl);

    const loggedIn = await fetch(`${baseUrl}/frontend/bootstrap`, {
      headers: { cookie }
    });
    assert.equal(loggedIn.status, 200);
    const payload = await loggedIn.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.authenticated, true);
    assert.equal(payload.data.assistantId, "assistant-test-id");
    assert.equal(payload.data.assistantName, "Jarvis Test");
    assert.equal(payload.data.vapiPublicKey, "public-test-key");
    assert.match(payload.data.backendUrl, /^http:\/\/127\.0\.0\.1:/);
  });
});

test("codex-thread heartbeat refreshes the active job and run without duplicate claim", async () => {
  const task = await database.createTask({
    execution_target: "codex_thread",
    normalized_action: "inspect_repo",
    permission_required: "safe_write",
    raw_request: "Inspect the repo",
    status: "queued",
    structured_request: {
      acceptanceCriteria: [],
      action: "inspect_repo",
      instructions: "Inspect the repo",
      permissionRequired: "safe_write",
      title: "Inspect repo"
    },
    title: "Inspect repo"
  });
  await database.createCodexThreadJob({ task_id: task.id });

  const claimed = await database.claimNextCodexThreadTask({
    thread_label: "test bridge"
  });
  assert.ok(claimed);
  assert.equal(claimed.task.id, task.id);
  assert.equal(claimed.job.status, "running");
  assert.equal(claimed.run.status, "running");

  const firstHeartbeat = claimed.job.heartbeat_at;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const heartbeat = await database.heartbeatCodexThreadTask({
    task_id: task.id
  });
  assert.ok(heartbeat.job?.heartbeat_at);
  assert.ok(heartbeat.run?.heartbeat_at);
  assert.notEqual(heartbeat.job?.heartbeat_at, firstHeartbeat);

  const duplicateClaim = await database.claimNextCodexThreadTask({
    thread_label: "test bridge"
  });
  assert.equal(duplicateClaim, null);
});

test("full-computer parser and runner claim gates route Mac tasks safely", async () => {
  const finder = await taskService.createFromUtterance({
    utterance: "Open Finder and show my Downloads",
    source: "telegram"
  });
  assert.equal(finder.status, "queued");
  assert.equal(finder.execution_target, "runner");
  assert.equal(finder.interpreted_task.action, "desktop_control");
  assert.equal(finder.interpreted_task.desktopMode, "full_mac");
  assert.equal(finder.interpreted_task.targetApp, "Finder");

  const shell = await taskService.createFromUtterance({
    utterance: "run ls on Desktop",
    source: "telegram"
  });
  assert.equal(shell.status, "queued");
  assert.equal(shell.interpreted_task.action, "desktop_control");
  assert.equal(shell.interpreted_task.desktopMode, "local_shell");
  assert.equal(shell.interpreted_task.targetApp, "shell");
  assert.equal(shell.interpreted_task.shellCommand, "ls");
  assert.equal(shell.interpreted_task.shellCwd, "~/Desktop");

  const risky = await taskService.createFromUtterance({
    utterance: "Open Mail and send this email to the team",
    source: "telegram"
  });
  assert.equal(risky.status, "needs_confirmation");
  assert.equal(risky.interpreted_task.desktopMode, "full_mac");
  assert.equal(risky.interpreted_task.riskLevel, "needs_confirmation");
  assert.ok(await database.getPendingConfirmationForTask(risky.task_id));

  const blocked = await taskService.createFromUtterance({
    utterance: "Enter my password and solve the captcha",
    source: "telegram"
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.interpreted_task.riskLevel, "blocked");
  assert.equal(await database.getPendingConfirmationForTask(blocked.task_id), null);

  const firstClaim = await database.claimNextQueuedTask("codex_local", "all", {
    allowDesktopControl: true,
    allowFullComputerControl: false
  });
  assert.equal(firstClaim?.task.id, undefined);

  const fullClaim = await database.claimNextQueuedTask("codex_local", "all", {
    allowDesktopControl: true,
    allowFullComputerControl: true
  });
  assert.equal(fullClaim?.task.id, finder.task_id);
});

test("deterministic runtime ignores invalid OpenAI API keys", async () => {
  const task = await taskService.createFromUtterance({
    utterance: "Open Finder and show my Downloads",
    source: "telegram"
  });
  assert.equal(task.status, "queued");
  assert.equal(task.interpreted_task.action, "desktop_control");
  assert.equal(task.interpreted_task.desktopMode, "full_mac");
  assert.equal(task.interpreted_task.targetApp, "Finder");

  const shell = await taskService.createFromUtterance({
    utterance: "run ls on Desktop",
    source: "sms"
  });
  assert.equal(shell.status, "queued");
  assert.equal(shell.interpreted_task.desktopMode, "local_shell");
  assert.equal(shell.interpreted_task.shellCommand, "ls");
});

test("Mac computer controller safety helpers classify shell and GUI risk", () => {
  assert.equal(classifyShellCommandRisk("ls -la", "/Users/blakeburby/Desktop"), "low");
  assert.equal(classifyShellCommandRisk("rm -rf ~/Desktop/test"), "needs_confirmation");
  assert.equal(classifyShellCommandRisk("cat .env"), "blocked");
  assert.equal(classifyComputerInstructionRisk("open Finder and show Downloads"), "low");
  assert.equal(
    classifyComputerInstructionRisk("delete files from Downloads"),
    "needs_confirmation"
  );
  assert.equal(classifyComputerInstructionRisk("enter my password"), "blocked");
  assert.equal(inferShellCommandFromInstructions("run ls on Desktop"), "ls");
  assert.equal(redactComputerText("API_KEY=sk-secretvalue123456789"), "API_KEY=[redacted]");
});

test("operator chat shares Jarvis history and only creates tasks for task requests", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await login(baseUrl);
    const unauthenticated = await fetch(`${baseUrl}/operator/chat/messages`);
    assert.equal(unauthenticated.status, 401);

    const beforeCasualTasks = await taskCount();
    const casualChecks = [
      {
        message: "hello",
        pattern: /Jarvis|task queue/i
      },
      {
        message: "what's your name",
        pattern: /Jarvis|engineering intelligence/i
      },
      {
        message: "can you control my computer?",
        pattern: /Mac local bridge|local bridge|safe shell/i
      }
    ];

    for (const check of casualChecks) {
      const response = await fetch(`${baseUrl}/operator/chat/messages`, {
        body: JSON.stringify({ message: check.message }),
        headers: {
          "Content-Type": "application/json",
          cookie
        },
        method: "POST"
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.success, true);
      assert.equal(payload.data.task_id, null);
      assert.match(payload.data.reply, check.pattern);
    }

    assert.equal(await taskCount(), beforeCasualTasks);

    const task = await fetch(`${baseUrl}/operator/chat/messages`, {
      body: JSON.stringify({
        message: "Inspect this repo and list its package scripts"
      }),
      headers: {
        "Content-Type": "application/json",
        cookie
      },
      method: "POST"
    });
    assert.equal(task.status, 200);
    const taskPayload = await task.json();
    assert.equal(taskPayload.success, true);
    assert.ok(taskPayload.data.task_id);

    const taskRecord = await database.getTask(taskPayload.data.task_id);
    assert.ok(taskRecord);
    assert.equal(await taskCount(), beforeCasualTasks + 1);

    assert.ok(
      taskPayload.data.messages.some(
        (message: { task?: { id: string }; channel_kind: string }) =>
          message.task?.id === taskPayload.data.task_id &&
          message.channel_kind === "web"
      )
    );

    const origins = await database.listChatTaskOrigins(taskPayload.data.task_id);
    assert.equal(origins.length, 1);
    assert.equal(origins[0]?.channel_kind, "web");
  });
});

test("operator chat approval commands keep dangerous tasks behind gates", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await login(baseUrl);
    const create = await fetch(`${baseUrl}/operator/chat/messages`, {
      body: JSON.stringify({
        message: "Commit and push all current changes in this repo"
      }),
      headers: {
        "Content-Type": "application/json",
        cookie
      },
      method: "POST"
    });
    assert.equal(create.status, 200);
    const createPayload = await create.json();
    assert.ok(createPayload.data.task_id);
    assert.match(createPayload.data.reply, /Approval needed/i);

    const confirmation = await database.getPendingConfirmationForTask(
      createPayload.data.task_id
    );
    assert.ok(confirmation);
    const deny = await fetch(`${baseUrl}/operator/chat/messages`, {
      body: JSON.stringify({ message: `deny ${confirmation.id.slice(-6)}` }),
      headers: {
        "Content-Type": "application/json",
        cookie
      },
      method: "POST"
    });
    assert.equal(deny.status, 200);
    const denyPayload = await deny.json();
    assert.match(denyPayload.data.reply, /Denied/i);

    const deniedTask = await database.getTask(createPayload.data.task_id);
    assert.equal(deniedTask?.status, "cancelled");
  });
});

test("telegram webhook rejects non-owner users and accepts owner chat", async () => {
  await withServer(async (baseUrl) => {
    const rejected = await fetch(`${baseUrl}/telegram/webhook`, {
      body: JSON.stringify(telegramUpdate(999, 123, "hello")),
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-secret"
      },
      method: "POST"
    });
    assert.equal(rejected.status, 200);
    assert.deepEqual(await rejected.json(), {
      success: true,
      accepted: false
    });

    const beforeOwnerTasks = await taskCount();
    const accepted = await fetch(`${baseUrl}/telegram/webhook`, {
      body: JSON.stringify(telegramUpdate(12345, 67890, "hello", 42)),
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-secret"
      },
      method: "POST"
    });
    assert.equal(accepted.status, 200);
    const acceptedPayload = await accepted.json();
    assert.deepEqual(acceptedPayload, {
      success: true,
      accepted: true,
      task_id: null
    });
    assert.equal(await taskCount(), beforeOwnerTasks);

    const control = await fetch(`${baseUrl}/telegram/webhook`, {
      body: JSON.stringify(
        telegramUpdate(12345, 67890, "can you control my computer?", 43)
      ),
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-secret"
      },
      method: "POST"
    });
    assert.equal(control.status, 200);
    assert.deepEqual(await control.json(), {
      success: true,
      accepted: true,
      task_id: null
    });
    assert.equal(await taskCount(), beforeOwnerTasks);

    const taskRequest = await fetch(`${baseUrl}/telegram/webhook`, {
      body: JSON.stringify(telegramUpdate(12345, 67890, "run ls on Desktop", 44)),
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-secret"
      },
      method: "POST"
    });
    assert.equal(taskRequest.status, 200);
    const taskPayload = await taskRequest.json();
    assert.equal(taskPayload.success, true);
    assert.equal(taskPayload.accepted, true);
    assert.ok(taskPayload.task_id);

    const sharedMessages = await database.listChatMessages({ limit: 20 });
    assert.ok(
      sharedMessages.some(
        (message) => message.provider_message_id === "42" && message.body === "hello"
      )
    );
    assert.ok(
      sharedMessages.some(
        (message) =>
          message.role === "assistant" &&
          /Mac local bridge|local bridge|safe shell/i.test(message.body)
      )
    );
  });
});

test("sms chat delegates message interpretation to the shared Jarvis service", async () => {
  const beforeSmsTasks = await taskCount();
  const reply = await smsChatService.handleInbound({
    from: "+15555550123",
    body: "hello",
    messageSid: "SMsharedchat"
  });
  assert.match(reply, /Online|Jarvis/i);
  assert.equal(await taskCount(), beforeSmsTasks);

  const messages = await database.listChatMessages({ limit: 20 });
  assert.ok(
    messages.some(
      (message) =>
        message.provider_message_id === "SMsharedchat" && message.body === "hello"
    )
  );

  const stopReply = await smsChatService.handleInbound({
    from: "+15555550123",
    body: "STOP",
    messageSid: "SMsharedstop"
  });
  assert.match(stopReply, /paused/i);

  const pausedReply = await smsChatService.handleInbound({
    from: "+15555550123",
    body: "hello",
    messageSid: "SMsharedpaused"
  });
  assert.match(pausedReply, /paused/i);

  const startReply = await smsChatService.handleInbound({
    from: "+15555550123",
    body: "START",
    messageSid: "SMsharedstart"
  });
  assert.match(startReply, /active/i);

  const beforeSmsTask = await taskCount();
  const taskReply = await smsChatService.handleInbound({
    from: "+15555550123",
    body: "run ls on Desktop",
    messageSid: "SMsharedtask"
  });
  assert.match(taskReply, /Queued|task|work/i);
  assert.equal(await taskCount(), beforeSmsTask + 1);
});

const telegramUpdate = (
  fromId: number,
  chatId: number,
  text: string,
  messageId = 42
): Record<string, unknown> => ({
  update_id: 1,
  message: {
    message_id: messageId,
    from: {
      id: fromId,
      first_name: "Blake",
      is_bot: false
    },
    chat: {
      id: chatId,
      first_name: "Blake",
      type: "private"
    },
    date: 1770000000,
    text
  }
});

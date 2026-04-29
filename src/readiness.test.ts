import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

process.env.DATABASE_URL = "";
process.env.FRONTEND_PASSCODE = "test-passcode";
process.env.VAPI_PUBLIC_KEY = "public-test-key";
process.env.VAPI_ASSISTANT_ID = "assistant-test-id";
process.env.VAPI_ASSISTANT_NAME = "Jarvis Test";

const { app } = await import("./app.js");
const { database } = await import("./services/dbService.js");

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

    const login = await fetch(`${baseUrl}/frontend/login`, {
      body: JSON.stringify({ passcode: "test-passcode" }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.ok(cookie);

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

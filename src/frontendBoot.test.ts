import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("frontend boots through public bootstrap and has a fatal fallback", async () => {
  const source = await readFile("frontend/main.ts", "utf8");
  const html = await readFile("index.html", "utf8");

  assert.match(source, /request<FrontendBootstrap>\("\/frontend\/bootstrap"\)/);
  assert.doesNotMatch(source, /request<AppConfig>\("\/frontend\/config"\)/);
  assert.match(source, /const renderFatalBootError = /);
  assert.match(source, /Startup Error/);
  assert.match(source, /window\.addEventListener\("unhandledrejection"/);
  assert.match(source, /render\(\);\s+void loadConfig\(\);/);
  assert.match(html, /<div id="app">[\s\S]+Jarvis Dashboard/);
  assert.match(html, /JavaScript is required to unlock the dashboard/);
});

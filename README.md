# CallAI Remote Developer Operator

CallAI is a Vapi-powered voice and text control plane for remote developer operations. The Vercel app hosts the browser voice console, Vapi tool endpoints, SMS webhook, task APIs, and audit views. Long-running repo work runs through Railway Postgres and can be claimed by either the Railway `agent-runner` worker or Blake's local Mac bridge using the desktop Codex CLI/auth environment.

## Architecture

```mermaid
flowchart LR
  User["Voice or browser user"] --> Vapi["Vapi assistant"]
  Vapi --> API["Vercel Express API"]
  Browser["Operator console"] --> API
  SMS["Twilio SMS"] --> API
  API --> Parser["task-parser"]
  Parser --> Memory["context-memory"]
  API --> RailwayDB["Railway Postgres tasks and audit log"]
  Runner["Railway agent-runner"] --> RailwayDB
  MacBridge["Mac local bridge"] --> RailwayDB
  Runner --> Repo["Repo workspace"]
  MacBridge --> LocalRepo["Local repo workspace"]
  Runner --> Codex["codex-bridge"]
  MacBridge --> LocalCodex["Local Codex CLI"]
  Codex --> Repo
  LocalCodex --> LocalRepo
  Runner --> Chat["chat-connector"]
```

## Local Setup

```bash
npm install
cp .env.example .env
npm run build
npm start
```

For local development:

```bash
npm run dev
npm run frontend:dev
```

Run the persistent task worker in a separate terminal:

```bash
npm run build
npm run runner
```

For local runner development without a build, use `npm run runner:dev`.

Run Blake's local desktop bridge manually:

```bash
npm run build
npm run local-bridge
```

For local bridge development without a build, use `npm run local-bridge:dev`.

## Required Production Services

- Vercel hosts the public Express API and built Vite frontend.
- Railway Postgres stores sessions, transcripts, tasks, execution runs, confirmations, and audit events.
- A persistent Railway worker runs with Codex CLI authenticated and repo workspace access.
- Vapi routes browser, inbound, and outbound voice calls to the deployed server URLs.

## Vapi Tool Endpoints

Configure each Vapi function tool with `x-api-key: <API_SECRET_KEY>` and these deployed URLs:

- `create_task` -> `POST /tools/create-task`
- `get_task_status` -> `POST /tools/get-task-status`
- `continue_task` -> `POST /tools/continue-task`
- `approve_action` -> `POST /tools/approve-action`
- `cancel_task` -> `POST /tools/cancel-task`
- `send_project_update` -> `POST /tools/send-project-update`
- `start_outbound_call` -> `POST /tools/start-outbound-call`

Configure the webhook URL:

- `POST /vapi/webhook`

For outbound phone calls, set `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, and `VAPI_PHONE_NUMBER_ID`, then call:

```bash
curl -X POST https://YOUR_SERVER_URL/voice/calls/outbound \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_SECRET_KEY" \
  -d '{"phone_number":"+15551234567","reason":"Task update"}'
```

## Railway Postgres

Create a Railway project, add a Postgres service, and copy its connection string into `DATABASE_URL`.

Use Railway's public Postgres URL in Vercel production env so the public API can read and write tasks. Use Railway's private/internal Postgres URL for the Railway worker when available.

Run the generic Postgres migration once:

```bash
DATABASE_URL=postgresql://... npm run db:migrate
DATABASE_URL=postgresql://... npm run db:seed
```

The migration lives at `db/migrations/001_remote_developer_operator.sql`.
The seed command inserts the default repo and aliases from `DEFAULT_REPO_*`.

The browser never receives `DATABASE_URL`, OpenAI keys, Vapi private keys, or tool secrets.

## Railway Worker

Deploy a second Railway service from this same GitHub repo as a worker. Set the start command to:

```bash
npm run runner
```

The checked-in `railway.toml` sets that worker command. Configure the worker with:

- `DATABASE_URL`
- `DATABASE_SSL=auto`
- `OPENAI_API_KEY`
- `CODEX_EXECUTABLE=codex`
- `CODEX_EXECUTION_MODE=local`
- `DEFAULT_REPO_OWNER`, `DEFAULT_REPO_NAME`, `DEFAULT_REPO_URL`, `DEFAULT_REPO_PATH`, and `DEFAULT_REPO_BRANCH`
- any GitHub/Codex auth variables needed for non-interactive repo work

If the Mac local bridge is the write-capable executor, set the Railway worker to read-only background work:

```bash
RUNNER_ID=railway-runner
RUNNER_TASK_SCOPE=read_only
```

Only one write-capable runner should normally be active. The task queue uses `FOR UPDATE SKIP LOCKED`, so duplicate claiming is protected, but one write-capable runner keeps repo branches, Codex auth, and local workspaces predictable.

## Local Desktop Codex Bridge

The local bridge uses the same Railway Postgres queue as Vercel and Railway, but executes on this Mac with:

- `RUNNER_ID=macbook-local-bridge`
- `CODEX_EXECUTABLE=/Applications/Codex.app/Contents/Resources/codex`
- `DEFAULT_REPO_PATH=/Users/blakeburby/Desktop/CallAI-main`
- `CODEX_EXECUTION_MODE=local`

It claims queued tasks, logs runner metadata to the audit timeline, creates `callai/*` branches for write tasks, and invokes:

```bash
codex exec --json --sandbox workspace-write --cd <repo> <prompt>
```

Manual preflight:

```bash
npm run build
npm run local-bridge
```

LaunchAgent setup, after `.env` contains `DATABASE_URL`, `OPENAI_API_KEY`, and the bridge env values:

```bash
mkdir -p logs ~/Library/LaunchAgents
cp launchd/com.blake.callai.local-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.blake.callai.local-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.blake.callai.local-bridge
tail -f logs/local-bridge.out.log logs/local-bridge.err.log
```

Stop/unload:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.blake.callai.local-bridge.plist
```

The Mac must be awake, online, and logged in for this LaunchAgent to run.

## SMS Text Control

Two-way text control uses Twilio. Configure these Vercel production env vars:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `OWNER_PHONE_NUMBER`
- `SMS_WEBHOOK_SECRET`

Set the Twilio Messaging webhook for the SMS-capable Twilio number to:

```text
https://callai-iota.vercel.app/sms/inbound?secret=<SMS_WEBHOOK_SECRET>
```

Inbound SMS is accepted only from `OWNER_PHONE_NUMBER`. Texts are parsed into CallAI tasks, then Vercel replies with a concise queued or confirmation-needed message. Completion, failure, blocked, and confirmation-needed notifications are sent back by SMS when Twilio env is configured.

The browser console exposes only whether text control is configured and the last four digits of the owner/from numbers. It never exposes Twilio tokens, OpenAI keys, Vapi private keys, or `DATABASE_URL`.

## Runner

The runner logs a startup preflight for database connectivity, `codex --version`, and workspace settings. Then it polls for `tasks.status = 'queued'`, atomically claims one task with `FOR UPDATE SKIP LOCKED`, creates an execution run, and:

- inspects repos directly for read-only tasks
- runs configured package tests for test tasks
- creates a `callai/*` branch for write tasks
- delegates code edits to `codex exec --json --sandbox workspace-write --cd <repo>`
- writes progress, stdout, stderr, diffs, and final summaries to the audit log

If Codex CLI or auth is missing, coding tasks are marked `blocked` with an audit event. The runner does not commit, push, merge, deploy, or change secrets without separate approval.

## Safety Model

- `read_only`: inspect repos, read files, query logs, summarize.
- `safe_write`: create branch/worktree, edit files, docs/tests, run tests.
- `full_write`: commit, push branches, open PRs, send external updates.
- `destructive_admin`: delete files, force push, merge to main, production deploy, env/secrets changes, mass rewrites.

`full_write` and `destructive_admin` actions create expiring confirmation requests before execution.

import { randomUUID } from "node:crypto";
import type { Pool as PgPool, PoolClient, QueryResultRow } from "pg";
import type {
  AuditEventRecord,
  ChatChannelRecord,
  CodexThreadJobRecord,
  ConfirmationRequestRecord,
  DesktopSnapshotRecord,
  DeveloperTaskRecord,
  ExecutionRunRecord,
  ExecutorKind,
  MemoryRecord,
  PermissionLevel,
  RepoRecord,
  RunnerTaskScope,
  SmsConversationRecord,
  SmsMessageRecord,
  TaskExecutionTarget,
  TaskStatus,
  VoiceSessionRecord
} from "../types/operator.js";
import { createPostgresPool } from "./postgresService.js";
import { logger } from "../utils/logger.js";

type JsonRecord = Record<string, unknown>;
type Queryable = Pick<PgPool | PoolClient, "query">;

type CreateTaskRow = {
  session_id?: string | null;
  user_id?: string | null;
  repo_id?: string | null;
  title: string;
  raw_request: string;
  normalized_action: string;
  structured_request: JsonRecord;
  status: TaskStatus;
  permission_required: PermissionLevel;
  execution_target?: TaskExecutionTarget;
};

type AuditInput = {
  task_id?: string | null;
  run_id?: string | null;
  session_id?: string | null;
  event_type: string;
  severity?: AuditEventRecord["severity"];
  payload?: JsonRecord;
};

type VoiceSessionInput = {
  vapi_call_id?: string | null;
  user_id?: string | null;
  channel: string;
  status: string;
};

type ExecutionRunInput = {
  task_id: string;
  executor: ExecutorKind;
  branch_name?: string | null;
  status?: TaskStatus;
  started_at?: string | null;
  finished_at?: string | null;
  final_summary?: string | null;
};

type DesktopSnapshotInput = {
  task_id: string;
  run_id?: string | null;
  current_url?: string | null;
  page_title?: string | null;
  latest_action?: string | null;
  step?: number;
  screenshot_data_url?: string | null;
  redacted?: boolean;
};

type ClaimTaskOptions = {
  allowDesktopControl?: boolean;
};

type SmsConversationInput = {
  phone_e164: string;
  status?: string;
};

type SmsMessageInput = {
  conversation_id: string;
  role: SmsMessageRecord["role"];
  body: string;
  provider_message_sid?: string | null;
  payload?: JsonRecord;
};

type InMemoryStore = {
  auditEvents: AuditEventRecord[];
  chatChannels: ChatChannelRecord[];
  codexThreadJobs: CodexThreadJobRecord[];
  confirmations: ConfirmationRequestRecord[];
  desktopSnapshots: DesktopSnapshotRecord[];
  executionRuns: ExecutionRunRecord[];
  memories: MemoryRecord[];
  repos: RepoRecord[];
  repoAliases: Array<{ id: string; repo_id: string; alias: string }>;
  smsConversations: SmsConversationRecord[];
  smsMessages: SmsMessageRecord[];
  tasks: DeveloperTaskRecord[];
  voiceSessions: VoiceSessionRecord[];
  transcripts: Array<{
    id: string;
    session_id: string;
    role: string;
    text: string;
    occurred_at: string;
  }>;
};

type DatabaseHealth = {
  configured: boolean;
  ok: boolean;
  message: string;
};

const now = (): string => new Date().toISOString();

export const db = createPostgresPool();

const memoryStore: InMemoryStore = {
  auditEvents: [],
  chatChannels: [],
  codexThreadJobs: [],
  confirmations: [],
  desktopSnapshots: [],
  executionRuns: [],
  memories: [],
  repos: [],
  repoAliases: [],
  smsConversations: [],
  smsMessages: [],
  tasks: [],
  transcripts: [],
  voiceSessions: []
};

if (!db) {
  seedMemoryStore();
}

export const isDatabaseConfigured = (): boolean => Boolean(db);

export const checkDatabaseConnection = async (): Promise<DatabaseHealth> => {
  if (!db) {
    return {
      configured: false,
      ok: true,
      message: "DATABASE_URL is not set; using in-memory fallback."
    };
  }

  try {
    await db.query("select 1");
    return {
      configured: true,
      ok: true,
      message: "Database connection succeeded."
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: errorMessage(error)
    };
  }
};

export const database = {
  async upsertVoiceSession(
    input: VoiceSessionInput
  ): Promise<VoiceSessionRecord> {
    if (db) {
      if (input.vapi_call_id) {
        return queryRequired<VoiceSessionRecord>(
          `insert into voice_sessions (vapi_call_id, user_id, channel, status)
           values ($1, $2, $3, $4)
           on conflict (vapi_call_id) do update
             set user_id = coalesce(excluded.user_id, voice_sessions.user_id),
                 channel = excluded.channel,
                 status = excluded.status
           returning *`,
          [
            input.vapi_call_id,
            input.user_id ?? null,
            input.channel,
            input.status
          ],
          "upsert voice session"
        );
      }

      return queryRequired<VoiceSessionRecord>(
        `insert into voice_sessions (user_id, channel, status)
         values ($1, $2, $3)
         returning *`,
        [input.user_id ?? null, input.channel, input.status],
        "create voice session"
      );
    }

    const existing =
      input.vapi_call_id &&
      memoryStore.voiceSessions.find(
        (session) => session.vapi_call_id === input.vapi_call_id
      );

    if (existing) {
      existing.status = input.status;
      existing.channel = input.channel;
      existing.user_id = input.user_id ?? existing.user_id;
      return existing;
    }

    const session: VoiceSessionRecord = {
      id: randomUUID(),
      vapi_call_id: input.vapi_call_id ?? null,
      user_id: input.user_id ?? null,
      channel: input.channel,
      status: input.status,
      started_at: now(),
      ended_at: null
    };
    memoryStore.voiceSessions.unshift(session);
    return session;
  },

  async endVoiceSession(sessionId: string): Promise<void> {
    if (db) {
      await execute(
        `update voice_sessions
         set status = 'ended', ended_at = now()
         where id = $1`,
        [sessionId],
        "end voice session"
      );
      return;
    }

    const session = memoryStore.voiceSessions.find((item) => item.id === sessionId);
    if (session) {
      session.status = "ended";
      session.ended_at = now();
    }
  },

  async appendTranscript(input: {
    session_id: string;
    role: string;
    text: string;
  }): Promise<void> {
    if (db) {
      await execute(
        `insert into transcripts (session_id, role, text)
         values ($1, $2, $3)`,
        [input.session_id, input.role, input.text],
        "append transcript"
      );
      return;
    }

    memoryStore.transcripts.unshift({
      id: randomUUID(),
      occurred_at: now(),
      ...input
    });
  },

  async upsertSmsConversation(
    input: SmsConversationInput
  ): Promise<SmsConversationRecord> {
    if (db) {
      return queryRequired<SmsConversationRecord>(
        `insert into sms_conversations (phone_e164, status, last_message_at)
         values ($1, $2, now())
         on conflict (phone_e164) do update
           set status = excluded.status,
               last_message_at = now(),
               updated_at = now()
         returning *`,
        [input.phone_e164, input.status ?? "active"],
        "upsert sms conversation"
      );
    }

    const existing = memoryStore.smsConversations.find(
      (conversation) => conversation.phone_e164 === input.phone_e164
    );

    if (existing) {
      existing.status = input.status ?? existing.status;
      existing.last_message_at = now();
      existing.updated_at = now();
      return existing;
    }

    const timestamp = now();
    const conversation: SmsConversationRecord = {
      id: randomUUID(),
      phone_e164: input.phone_e164,
      status: input.status ?? "active",
      last_message_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp
    };
    memoryStore.smsConversations.unshift(conversation);
    return conversation;
  },

  async findSmsConversationByPhone(
    phoneE164: string
  ): Promise<SmsConversationRecord | null> {
    if (db) {
      return queryOne<SmsConversationRecord>(
        `select * from sms_conversations
         where phone_e164 = $1
         limit 1`,
        [phoneE164],
        "find sms conversation by phone"
      );
    }

    return (
      memoryStore.smsConversations.find(
        (conversation) => conversation.phone_e164 === phoneE164
      ) ?? null
    );
  },

  async appendSmsMessage(input: SmsMessageInput): Promise<SmsMessageRecord> {
    if (db) {
      return queryRequired<SmsMessageRecord>(
        `insert into sms_messages (
           conversation_id, role, body, provider_message_sid, payload
         )
         values ($1, $2, $3, $4, $5::jsonb)
         returning *`,
        [
          input.conversation_id,
          input.role,
          input.body,
          input.provider_message_sid ?? null,
          JSON.stringify(input.payload ?? {})
        ],
        "append sms message"
      );
    }

    const message: SmsMessageRecord = {
      id: randomUUID(),
      conversation_id: input.conversation_id,
      role: input.role,
      body: input.body,
      provider_message_sid: input.provider_message_sid ?? null,
      payload: input.payload ?? {},
      created_at: now()
    };
    memoryStore.smsMessages.unshift(message);
    return message;
  },

  async listSmsMessages(
    conversationId: string,
    limit = 12
  ): Promise<SmsMessageRecord[]> {
    if (db) {
      const rows = await queryMany<SmsMessageRecord>(
        `select * from sms_messages
         where conversation_id = $1
         order by created_at desc
         limit $2`,
        [conversationId, limit],
        "list sms messages"
      );

      return rows.reverse();
    }

    return memoryStore.smsMessages
      .filter((message) => message.conversation_id === conversationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-limit);
  },

  async createTask(input: CreateTaskRow): Promise<DeveloperTaskRecord> {
    if (db) {
      return queryRequired<DeveloperTaskRecord>(
        `insert into tasks (
           session_id, user_id, repo_id, title, raw_request,
           normalized_action, structured_request, status, permission_required,
           execution_target
         )
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         returning *`,
        [
          input.session_id ?? null,
          input.user_id ?? null,
          input.repo_id ?? null,
          input.title,
          input.raw_request,
          input.normalized_action,
          JSON.stringify(input.structured_request),
          input.status,
          input.permission_required,
          input.execution_target ?? "runner"
        ],
        "create task"
      );
    }

    const timestamp = now();
    const task: DeveloperTaskRecord = {
      id: randomUUID(),
      session_id: input.session_id ?? null,
      user_id: input.user_id ?? null,
      repo_id: input.repo_id ?? null,
      title: input.title,
      raw_request: input.raw_request,
      normalized_action: input.normalized_action as DeveloperTaskRecord["normalized_action"],
      structured_request:
        input.structured_request as DeveloperTaskRecord["structured_request"],
      status: input.status,
      permission_required: input.permission_required,
      execution_target: input.execution_target ?? "runner",
      created_at: timestamp,
      updated_at: timestamp
    };
    memoryStore.tasks.unshift(task);
    return task;
  },

  async getTask(taskId: string): Promise<DeveloperTaskRecord | null> {
    if (db) {
      return queryOne<DeveloperTaskRecord>(
        "select * from tasks where id = $1 limit 1",
        [taskId],
        "get task"
      );
    }

    return memoryStore.tasks.find((task) => task.id === taskId) ?? null;
  },

  async listTasks(limit = 25): Promise<DeveloperTaskRecord[]> {
    if (db) {
      return queryMany<DeveloperTaskRecord>(
        `select * from tasks
         order by updated_at desc
         limit $1`,
        [limit],
        "list tasks"
      );
    }

    return memoryStore.tasks.slice(0, limit);
  },

  async updateTask(
    taskId: string,
    patch: Partial<
      Pick<
        DeveloperTaskRecord,
        | "repo_id"
        | "status"
        | "structured_request"
        | "title"
        | "permission_required"
        | "execution_target"
      >
    >
  ): Promise<DeveloperTaskRecord> {
    if (db) {
      const update = buildUpdate(
        {
          repo_id: patch.repo_id,
          status: patch.status,
          structured_request:
            patch.structured_request === undefined
              ? undefined
              : JSON.stringify(patch.structured_request),
          title: patch.title,
          permission_required: patch.permission_required,
          execution_target: patch.execution_target
        },
        {
          structured_request: "jsonb"
        }
      );

      return queryRequired<DeveloperTaskRecord>(
        `update tasks
         set ${update.setSql}, updated_at = now()
         where id = $1
         returning *`,
        [taskId, ...update.values],
        "update task"
      );
    }

    const task = memoryStore.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    Object.assign(task, {
      ...patch,
      updated_at: now()
    });
    return task;
  },

  async createExecutionRun(
    input: ExecutionRunInput
  ): Promise<ExecutionRunRecord> {
    if (db) {
      return queryRequired<ExecutionRunRecord>(
        `insert into execution_runs (
           task_id, executor, branch_name, status, started_at, finished_at, final_summary
         )
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [
          input.task_id,
          input.executor,
          input.branch_name ?? null,
          input.status ?? "queued",
          input.started_at ?? null,
          input.finished_at ?? null,
          input.final_summary ?? null
        ],
        "create execution run"
      );
    }

    const run: ExecutionRunRecord = {
      id: randomUUID(),
      task_id: input.task_id,
      executor: input.executor,
      branch_name: input.branch_name ?? null,
      status: input.status ?? "queued",
      started_at: input.started_at ?? null,
      finished_at: input.finished_at ?? null,
      final_summary: input.final_summary ?? null
    };
    memoryStore.executionRuns.unshift(run);
    return run;
  },

  async updateExecutionRun(
    runId: string,
    patch: Partial<ExecutionRunRecord>
  ): Promise<ExecutionRunRecord> {
    if (db) {
      const update = buildUpdate({
        executor: patch.executor,
        branch_name: patch.branch_name,
        status: patch.status,
        started_at: patch.started_at,
        finished_at: patch.finished_at,
        final_summary: patch.final_summary
      });

      return queryRequired<ExecutionRunRecord>(
        `update execution_runs
         set ${update.setSql}
         where id = $1
         returning *`,
        [runId, ...update.values],
        "update execution run"
      );
    }

    const run = memoryStore.executionRuns.find((item) => item.id === runId);
    if (!run) {
      throw new Error(`Execution run not found: ${runId}`);
    }

    Object.assign(run, patch);
    return run;
  },

  async listExecutionRuns(taskId: string): Promise<ExecutionRunRecord[]> {
    if (db) {
      return queryMany<ExecutionRunRecord>(
        `select * from execution_runs
         where task_id = $1
         order by started_at desc nulls last`,
        [taskId],
        "list execution runs"
      );
    }

    return memoryStore.executionRuns.filter((run) => run.task_id === taskId);
  },

  async createCodexThreadJob(input: {
    task_id: string;
    thread_label?: string;
  }): Promise<CodexThreadJobRecord> {
    if (db) {
      return queryRequired<CodexThreadJobRecord>(
        `insert into codex_thread_jobs (task_id, thread_label)
         values ($1, $2)
         on conflict (task_id) do update
           set thread_label = excluded.thread_label,
               status = 'queued',
               claimed_at = null,
               completed_at = null,
               heartbeat_at = null,
               final_summary = null,
               updated_at = now()
         returning *`,
        [input.task_id, input.thread_label ?? "CallAI Codex thread"],
        "create codex thread job"
      );
    }

    const existing = memoryStore.codexThreadJobs.find(
      (job) => job.task_id === input.task_id
    );

    if (existing) {
      existing.thread_label = input.thread_label ?? existing.thread_label;
      existing.status = "queued";
      existing.claimed_at = null;
      existing.completed_at = null;
      existing.heartbeat_at = null;
      existing.final_summary = null;
      existing.updated_at = now();
      return existing;
    }

    const timestamp = now();
    const job: CodexThreadJobRecord = {
      id: randomUUID(),
      task_id: input.task_id,
      status: "queued",
      thread_label: input.thread_label ?? "CallAI Codex thread",
      claimed_at: null,
      completed_at: null,
      heartbeat_at: null,
      final_summary: null,
      created_at: timestamp,
      updated_at: timestamp
    };
    memoryStore.codexThreadJobs.unshift(job);
    return job;
  },

  async getCodexThreadJob(
    taskId: string
  ): Promise<CodexThreadJobRecord | null> {
    if (db) {
      return queryOne<CodexThreadJobRecord>(
        `select * from codex_thread_jobs
         where task_id = $1
         limit 1`,
        [taskId],
        "get codex thread job"
      );
    }

    return memoryStore.codexThreadJobs.find((job) => job.task_id === taskId) ?? null;
  },

  async claimNextCodexThreadTask(input: {
    thread_label?: string;
  } = {}): Promise<{
    task: DeveloperTaskRecord;
    run: ExecutionRunRecord;
    job: CodexThreadJobRecord;
  } | null> {
    const threadLabel = input.thread_label ?? "CallAI Codex thread";
    const staleMs = Number(process.env.CODEX_THREAD_STALE_AFTER_MS ?? 15 * 60 * 1000);

    if (db) {
      const client = await db.connect();

      try {
        await client.query("begin");

        // Reset stale running jobs back to queued so they can be reclaimed.
        const staleJobs = await queryMany<{ task_id: string }>(
          `update codex_thread_jobs
           set status = 'queued',
               claimed_at = null,
               heartbeat_at = null,
               updated_at = now()
           where status = 'running'
             and heartbeat_at < now() - ($1 * interval '1 millisecond')
           returning task_id`,
          [staleMs],
          "reset stale codex thread jobs",
          client
        );

        if (staleJobs.length > 0) {
          const staleTaskIds = staleJobs.map((row: { task_id: string }) => row.task_id);
          await client.query(
            `update tasks set status = 'queued', updated_at = now()
             where id = any($1) and status = 'running'`,
            [staleTaskIds]
          );
        }

        const task = await queryOne<DeveloperTaskRecord>(
          `select tasks.*
           from tasks
           join codex_thread_jobs on codex_thread_jobs.task_id = tasks.id
           where tasks.status = 'queued'
             and tasks.execution_target = 'codex_thread'
             and codex_thread_jobs.status = 'queued'
           order by tasks.created_at asc
           for update of tasks, codex_thread_jobs skip locked
           limit 1`,
          [],
          "claim codex thread task lookup",
          client
        );

        if (!task) {
          await client.query("commit");
          return null;
        }

        const claimedTask = await queryRequired<DeveloperTaskRecord>(
          `update tasks
           set status = 'running', updated_at = now()
           where id = $1
           returning *`,
          [task.id],
          "claim codex thread task",
          client
        );

        const job = await queryRequired<CodexThreadJobRecord>(
          `update codex_thread_jobs
           set status = 'running',
               thread_label = $2,
               claimed_at = now(),
               heartbeat_at = now(),
               updated_at = now()
           where task_id = $1
           returning *`,
          [task.id, threadLabel],
          "claim codex thread job",
          client
        );

        const run = await queryRequired<ExecutionRunRecord>(
          `insert into execution_runs (task_id, executor, status, started_at)
           values ($1, 'codex_thread', 'running', now())
           returning *`,
          [task.id],
          "create codex thread run",
          client
        );

        await client.query("commit");
        return { task: claimedTask, run, job };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    // Reset stale running jobs back to queued in the in-memory store.
    const staleThreshold = new Date(Date.now() - staleMs).toISOString();
    for (const staleJob of memoryStore.codexThreadJobs) {
      if (
        staleJob.status === "running" &&
        staleJob.heartbeat_at !== null &&
        staleJob.heartbeat_at < staleThreshold
      ) {
        staleJob.status = "queued";
        staleJob.claimed_at = null;
        staleJob.heartbeat_at = null;
        staleJob.updated_at = now();
        const staleTask = memoryStore.tasks.find((t) => t.id === staleJob.task_id);
        if (staleTask && staleTask.status === "running") {
          staleTask.status = "queued";
          staleTask.updated_at = now();
        }
      }
    }

    const task = memoryStore.tasks
      .slice()
      .reverse()
      .find((item) => {
        const job = memoryStore.codexThreadJobs.find(
          (candidate) => candidate.task_id === item.id
        );
        return (
          item.status === "queued" &&
          item.execution_target === "codex_thread" &&
          job?.status === "queued"
        );
      });

    if (!task) {
      return null;
    }

    const job = memoryStore.codexThreadJobs.find(
      (candidate) => candidate.task_id === task.id
    );

    if (!job) {
      return null;
    }

    task.status = "running";
    task.updated_at = now();
    Object.assign(job, {
      status: "running" as TaskStatus,
      thread_label: threadLabel,
      claimed_at: now(),
      heartbeat_at: now(),
      updated_at: now()
    });

    const run = await database.createExecutionRun({
      task_id: task.id,
      executor: "codex_thread",
      status: "running",
      started_at: now()
    });

    return { task, run, job };
  },

  async finishCodexThreadTask(input: {
    task_id: string;
    status: Extract<TaskStatus, "succeeded" | "failed" | "blocked">;
    summary: string;
  }): Promise<{
    task: DeveloperTaskRecord;
    job: CodexThreadJobRecord | null;
    run: ExecutionRunRecord | null;
  }> {
    if (db) {
      const client = await db.connect();

      try {
        await client.query("begin");
        const task = await queryRequired<DeveloperTaskRecord>(
          `update tasks
           set status = $2, updated_at = now()
           where id = $1
           returning *`,
          [input.task_id, input.status],
          "finish codex thread task",
          client
        );
        const job = await queryOne<CodexThreadJobRecord>(
          `update codex_thread_jobs
           set status = $2,
               completed_at = now(),
               heartbeat_at = now(),
               final_summary = $3,
               updated_at = now()
           where task_id = $1
           returning *`,
          [input.task_id, input.status, input.summary],
          "finish codex thread job",
          client
        );
        const run = await queryOne<ExecutionRunRecord>(
          `update execution_runs
           set status = $2,
               finished_at = now(),
               final_summary = $3
           where id = (
             select id from execution_runs
             where task_id = $1 and executor = 'codex_thread'
             order by started_at desc nulls last
             limit 1
           )
           returning *`,
          [input.task_id, input.status, input.summary],
          "finish codex thread run",
          client
        );

        await client.query("commit");
        return { task, job, run };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    const task = memoryStore.tasks.find((item) => item.id === input.task_id);

    if (!task) {
      throw new Error(`Task not found: ${input.task_id}`);
    }

    task.status = input.status;
    task.updated_at = now();

    const job =
      memoryStore.codexThreadJobs.find((item) => item.task_id === input.task_id) ??
      null;

    if (job) {
      Object.assign(job, {
        status: input.status,
        completed_at: now(),
        heartbeat_at: now(),
        final_summary: input.summary,
        updated_at: now()
      });
    }

    const run =
      memoryStore.executionRuns.find(
        (item) => item.task_id === input.task_id && item.executor === "codex_thread"
      ) ?? null;

    if (run) {
      Object.assign(run, {
        status: input.status,
        finished_at: now(),
        final_summary: input.summary
      });
    }

    return { task, job, run };
  },

  async upsertDesktopSnapshot(
    input: DesktopSnapshotInput
  ): Promise<DesktopSnapshotRecord> {
    const snapshot = {
      task_id: input.task_id,
      run_id: input.run_id ?? null,
      current_url: input.current_url ?? null,
      page_title: input.page_title ?? null,
      latest_action: input.latest_action ?? null,
      step: input.step ?? 0,
      screenshot_data_url: input.screenshot_data_url ?? null,
      redacted: input.redacted ?? false
    };

    if (db) {
      return queryRequired<DesktopSnapshotRecord>(
        `insert into desktop_snapshots (
           task_id, run_id, current_url, page_title, latest_action,
           step, screenshot_data_url, redacted
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (task_id) do update
           set run_id = excluded.run_id,
               current_url = excluded.current_url,
               page_title = excluded.page_title,
               latest_action = excluded.latest_action,
               step = excluded.step,
               screenshot_data_url = excluded.screenshot_data_url,
               redacted = excluded.redacted,
               updated_at = now()
         returning *`,
        [
          snapshot.task_id,
          snapshot.run_id,
          snapshot.current_url,
          snapshot.page_title,
          snapshot.latest_action,
          snapshot.step,
          snapshot.screenshot_data_url,
          snapshot.redacted
        ],
        "upsert desktop snapshot"
      );
    }

    const existing = memoryStore.desktopSnapshots.find(
      (item) => item.task_id === input.task_id
    );
    const row: DesktopSnapshotRecord = {
      ...snapshot,
      updated_at: now()
    };

    if (existing) {
      Object.assign(existing, row);
      return existing;
    }

    memoryStore.desktopSnapshots.unshift(row);
    return row;
  },

  async getDesktopSnapshot(taskId: string): Promise<DesktopSnapshotRecord | null> {
    if (db) {
      return queryOne<DesktopSnapshotRecord>(
        `select * from desktop_snapshots
         where task_id = $1
         limit 1`,
        [taskId],
        "get desktop snapshot"
      );
    }

    return (
      memoryStore.desktopSnapshots.find((item) => item.task_id === taskId) ?? null
    );
  },

  async claimNextQueuedTask(
    executor: ExecutorKind,
    scope: RunnerTaskScope = "all",
    options: ClaimTaskOptions = {}
  ): Promise<{ task: DeveloperTaskRecord; run: ExecutionRunRecord } | null> {
    if (db) {
      const client = await db.connect();
      const scopeFilter = taskScopeFilter(scope);
      const desktopFilter = options.allowDesktopControl
        ? ""
        : "and (structured_request->>'action') is distinct from 'desktop_control'";

      try {
        await client.query("begin");
        const task = await queryOne<DeveloperTaskRecord>(
          `select * from tasks
           where status = 'queued'
             and execution_target = 'runner'
             ${scopeFilter.sql}
             ${desktopFilter}
           order by created_at asc
           for update skip locked
           limit 1`,
          scopeFilter.values,
          "claim task lookup",
          client
        );

        if (!task) {
          await client.query("commit");
          return null;
        }

        const claimedTask = await queryRequired<DeveloperTaskRecord>(
          `update tasks
           set status = 'running', updated_at = now()
           where id = $1
           returning *`,
          [task.id],
          "claim task",
          client
        );

        const run = await queryRequired<ExecutionRunRecord>(
          `insert into execution_runs (task_id, executor, status, started_at)
           values ($1, $2, 'running', now())
           returning *`,
          [claimedTask.id, executor],
          "create claimed execution run",
          client
        );

        await client.query("commit");
        return { task: claimedTask, run };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    const task = memoryStore.tasks
      .slice()
      .reverse()
      .find(
        (item) =>
          item.status === "queued" &&
          item.execution_target === "runner" &&
          taskMatchesScope(item, scope) &&
          (options.allowDesktopControl ||
            item.structured_request.action !== "desktop_control")
      );

    if (!task) {
      return null;
    }

    task.status = "running";
    task.updated_at = now();

    const run = await database.createExecutionRun({
      task_id: task.id,
      executor,
      status: "running",
      started_at: now()
    });

    return { task, run };
  },

  async createAuditEvent(input: AuditInput): Promise<AuditEventRecord> {
    const row = {
      task_id: input.task_id ?? null,
      run_id: input.run_id ?? null,
      session_id: input.session_id ?? null,
      event_type: input.event_type,
      severity: input.severity ?? "info",
      payload: input.payload ?? {}
    };

    if (db) {
      return queryRequired<AuditEventRecord>(
        `insert into audit_events (
           task_id, run_id, session_id, event_type, severity, payload
         )
         values ($1, $2, $3, $4, $5, $6::jsonb)
         returning *`,
        [
          row.task_id,
          row.run_id,
          row.session_id,
          row.event_type,
          row.severity,
          JSON.stringify(row.payload)
        ],
        "create audit event"
      );
    }

    const event: AuditEventRecord = {
      id: randomUUID(),
      created_at: now(),
      ...row
    };
    memoryStore.auditEvents.unshift(event);
    return event;
  },

  async listAuditEvents(filter: {
    taskId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<AuditEventRecord[]> {
    const limit = filter.limit ?? 50;

    if (db) {
      const clauses: string[] = [];
      const values: unknown[] = [];

      if (filter.taskId) {
        values.push(filter.taskId);
        clauses.push(`task_id = $${values.length}`);
      }

      if (filter.sessionId) {
        values.push(filter.sessionId);
        clauses.push(`session_id = $${values.length}`);
      }

      values.push(limit);
      return queryMany<AuditEventRecord>(
        `select * from audit_events
         ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
         order by created_at desc
         limit $${values.length}`,
        values,
        "list audit events"
      );
    }

    return memoryStore.auditEvents
      .filter((event) => {
        return (
          (!filter.taskId || event.task_id === filter.taskId) &&
          (!filter.sessionId || event.session_id === filter.sessionId)
        );
      })
      .slice(0, limit);
  },

  async createConfirmation(input: {
    task_id: string;
    prompt: string;
    risk: string;
    expires_at: string;
  }): Promise<ConfirmationRequestRecord> {
    if (db) {
      return queryRequired<ConfirmationRequestRecord>(
        `insert into confirmation_requests (task_id, prompt, risk, expires_at)
         values ($1, $2, $3, $4)
         returning *`,
        [input.task_id, input.prompt, input.risk, input.expires_at],
        "create confirmation"
      );
    }

    const confirmation: ConfirmationRequestRecord = {
      id: randomUUID(),
      status: "pending",
      decided_at: null,
      ...input
    };
    memoryStore.confirmations.unshift(confirmation);
    return confirmation;
  },

  async getConfirmation(
    confirmationId: string
  ): Promise<ConfirmationRequestRecord | null> {
    if (db) {
      return queryOne<ConfirmationRequestRecord>(
        "select * from confirmation_requests where id = $1 limit 1",
        [confirmationId],
        "get confirmation"
      );
    }

    return (
      memoryStore.confirmations.find((item) => item.id === confirmationId) ?? null
    );
  },

  async getPendingConfirmationForTask(
    taskId: string
  ): Promise<ConfirmationRequestRecord | null> {
    if (db) {
      return queryOne<ConfirmationRequestRecord>(
        `select * from confirmation_requests
         where task_id = $1 and status = 'pending'
         order by expires_at desc
         limit 1`,
        [taskId],
        "get pending confirmation"
      );
    }

    return (
      memoryStore.confirmations.find(
        (item) => item.task_id === taskId && item.status === "pending"
      ) ?? null
    );
  },

  async listPendingConfirmations(
    limit = 25
  ): Promise<ConfirmationRequestRecord[]> {
    if (db) {
      return queryMany<ConfirmationRequestRecord>(
        `select * from confirmation_requests
         where status = 'pending'
         order by expires_at asc
         limit $1`,
        [limit],
        "list confirmations"
      );
    }

    return memoryStore.confirmations
      .filter((item) => item.status === "pending")
      .slice(0, limit);
  },

  async updateConfirmation(
    confirmationId: string,
    status: ConfirmationRequestRecord["status"]
  ): Promise<ConfirmationRequestRecord> {
    const decidedAt = ["approved", "denied", "expired"].includes(status)
      ? now()
      : null;

    if (db) {
      return queryRequired<ConfirmationRequestRecord>(
        `update confirmation_requests
         set status = $2, decided_at = $3
         where id = $1
         returning *`,
        [confirmationId, status, decidedAt],
        "update confirmation"
      );
    }

    const confirmation = memoryStore.confirmations.find(
      (item) => item.id === confirmationId
    );

    if (!confirmation) {
      throw new Error(`Confirmation not found: ${confirmationId}`);
    }

    confirmation.status = status;
    confirmation.decided_at = decidedAt;
    return confirmation;
  },

  async findRepoById(repoId: string): Promise<RepoRecord | null> {
    if (db) {
      return queryOne<RepoRecord>(
        "select * from repos where id = $1 limit 1",
        [repoId],
        "find repo by id"
      );
    }

    return memoryStore.repos.find((repo) => repo.id === repoId) ?? null;
  },

  async findRepoByAlias(alias: string): Promise<RepoRecord | null> {
    const normalized = normalizeAlias(alias);

    if (db) {
      const aliasRow = await queryOne<{ repo_id: string }>(
        `select repo_id from repo_aliases
         where alias = any($1::text[])
         limit 1`,
        [[normalized, alias.trim().toLowerCase(), alias.trim()]],
        "find repo alias"
      );

      if (aliasRow) {
        return database.findRepoById(aliasRow.repo_id);
      }

      const likeTerm = `%${escapeLike(alias.trim() || normalized)}%`;
      return queryOne<RepoRecord>(
        `select * from repos
         where lower(name) = lower($1)
            or lower(owner || '/' || name) = lower($1)
            or name ilike $2 escape '\\'
            or owner ilike $2 escape '\\'
         order by created_at desc
         limit 1`,
        [alias.trim(), likeTerm],
        "find repo by name"
      );
    }

    const aliasRow = memoryStore.repoAliases.find(
      (item) => item.alias === normalized
    );

    if (aliasRow) {
      return database.findRepoById(aliasRow.repo_id);
    }

    return (
      memoryStore.repos.find((repo) => {
        return (
          normalizeAlias(repo.name) === normalized ||
          `${normalizeAlias(repo.owner)}/${normalizeAlias(repo.name)}` === normalized
        );
      }) ?? null
    );
  },

  async listRepos(): Promise<RepoRecord[]> {
    if (db) {
      return queryMany<RepoRecord>(
        "select * from repos order by created_at desc",
        [],
        "list repos"
      );
    }

    return [...memoryStore.repos];
  },

  async findChatChannel(
    hint?: string
  ): Promise<ChatChannelRecord | null> {
    if (db) {
      if (hint) {
        return queryOne<ChatChannelRecord>(
          `select * from chat_channels
           where display_name ilike $1 escape '\\'
           order by display_name asc
           limit 1`,
          [`%${escapeLike(hint)}%`],
          "find chat channel"
        );
      }

      return queryOne<ChatChannelRecord>(
        "select * from chat_channels order by display_name asc limit 1",
        [],
        "find chat channel"
      );
    }

    if (!hint) {
      return memoryStore.chatChannels[0] ?? null;
    }

    return (
      memoryStore.chatChannels.find((channel) =>
        channel.display_name.toLowerCase().includes(hint.toLowerCase())
      ) ?? null
    );
  }
};

function buildUpdate(
  input: Record<string, unknown>,
  casts: Record<string, string> = {}
): {
  setSql: string;
  values: unknown[];
} {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);

  if (!entries.length) {
    throw new Error("No fields provided for update.");
  }

  return {
    setSql: entries
      .map(([field], index) => `${field} = $${index + 2}`)
      .map((assignment, index) => {
        const field = entries[index]?.[0];
        return field && casts[field] ? `${assignment}::${casts[field]}` : assignment;
      })
      .join(", "),
    values: entries.map(([, value]) => value)
  };
}

function taskScopeFilter(scope: RunnerTaskScope): {
  sql: string;
  values: unknown[];
} {
  if (scope === "read_only") {
    return {
      sql: "and permission_required = $1",
      values: ["read_only"]
    };
  }

  if (scope === "write") {
    return {
      sql: "and permission_required <> $1",
      values: ["read_only"]
    };
  }

  return {
    sql: "",
    values: []
  };
}

function taskMatchesScope(
  task: DeveloperTaskRecord,
  scope: RunnerTaskScope
): boolean {
  if (scope === "read_only") {
    return task.permission_required === "read_only";
  }

  if (scope === "write") {
    return task.permission_required !== "read_only";
  }

  return true;
}

async function queryMany<T>(
  text: string,
  values: unknown[],
  label: string,
  client?: Queryable
): Promise<T[]> {
  const target = client ?? requireDb();

  try {
    const result = await target.query<QueryResultRow>(text, values);
    return result.rows as T[];
  } catch (error) {
    throw new Error(`${label} failed: ${errorMessage(error)}`);
  }
}

async function queryOne<T>(
  text: string,
  values: unknown[],
  label: string,
  client?: Queryable
): Promise<T | null> {
  const rows = await queryMany<T>(text, values, label, client);
  return rows[0] ?? null;
}

async function queryRequired<T>(
  text: string,
  values: unknown[],
  label: string,
  client?: Queryable
): Promise<T> {
  const row = await queryOne<T>(text, values, label, client);

  if (!row) {
    throw new Error(`${label} failed: no rows returned.`);
  }

  return row;
}

async function execute(
  text: string,
  values: unknown[],
  label: string
): Promise<void> {
  await queryMany(text, values, label);
}

function requireDb(): PgPool {
  if (!db) {
    throw new Error("DATABASE_URL is required for persistent database access.");
  }

  return db;
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, "-");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seedMemoryStore(): void {
  const defaultPath = process.env.DEFAULT_REPO_PATH || process.cwd();
  const defaultName =
    process.env.DEFAULT_REPO_NAME || defaultPath.split("/").filter(Boolean).pop();

  if (!defaultName) {
    return;
  }

  const owner = process.env.DEFAULT_REPO_OWNER || "local";
  const repo: RepoRecord = {
    id: randomUUID(),
    provider: "github",
    owner,
    name: defaultName,
    clone_url:
      process.env.DEFAULT_REPO_URL ||
      `https://github.com/${owner}/${defaultName}.git`,
    default_branch: process.env.DEFAULT_REPO_BRANCH || "main",
    local_path: defaultPath,
    codex_cloud_env_id: process.env.DEFAULT_CODEX_CLOUD_ENV_ID || null,
    created_at: now()
  };

  memoryStore.repos.push(repo);

  const aliases = [
    "main repo",
    "current repo",
    "this repo",
    "callai",
    defaultName,
    ...(process.env.DEFAULT_REPO_ALIASES?.split(",") ?? [])
  ];

  for (const alias of aliases) {
    const normalized = normalizeAlias(alias);
    if (!normalized) {
      continue;
    }

    memoryStore.repoAliases.push({
      id: randomUUID(),
      repo_id: repo.id,
      alias: normalized
    });
  }

  logger.info("Using in-memory operator database fallback", {
    repo: `${repo.owner}/${repo.name}`,
    local_path: repo.local_path
  });
}

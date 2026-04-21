import { randomUUID } from "node:crypto";
import type { Pool as PgPool, PoolClient, QueryResultRow } from "pg";
import type {
  AuditEventRecord,
  ChatChannelRecord,
  ConfirmationRequestRecord,
  DeveloperTaskRecord,
  ExecutionRunRecord,
  ExecutorKind,
  MemoryRecord,
  PermissionLevel,
  RepoRecord,
  RunnerTaskScope,
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

type InMemoryStore = {
  auditEvents: AuditEventRecord[];
  chatChannels: ChatChannelRecord[];
  confirmations: ConfirmationRequestRecord[];
  executionRuns: ExecutionRunRecord[];
  memories: MemoryRecord[];
  repos: RepoRecord[];
  repoAliases: Array<{ id: string; repo_id: string; alias: string }>;
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
  confirmations: [],
  executionRuns: [],
  memories: [],
  repos: [],
  repoAliases: [],
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

  async createTask(input: CreateTaskRow): Promise<DeveloperTaskRecord> {
    if (db) {
      return queryRequired<DeveloperTaskRecord>(
        `insert into tasks (
           session_id, user_id, repo_id, title, raw_request,
           normalized_action, structured_request, status, permission_required
         )
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
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
          input.permission_required
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
        "repo_id" | "status" | "structured_request" | "title" | "permission_required"
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
          permission_required: patch.permission_required
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

  async claimNextQueuedTask(
    executor: ExecutorKind,
    scope: RunnerTaskScope = "all"
  ): Promise<{ task: DeveloperTaskRecord; run: ExecutionRunRecord } | null> {
    if (db) {
      const client = await db.connect();
      const scopeFilter = taskScopeFilter(scope);

      try {
        await client.query("begin");
        const task = await queryOne<DeveloperTaskRecord>(
          `select * from tasks
           where status = 'queued'
             ${scopeFilter.sql}
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
      .find((item) => item.status === "queued" && taskMatchesScope(item, scope));

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

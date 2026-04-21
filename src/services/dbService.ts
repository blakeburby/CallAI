import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
  TaskStatus,
  VoiceSessionRecord
} from "../types/operator.js";
import { logger } from "../utils/logger.js";

type JsonRecord = Record<string, unknown>;

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

const now = (): string => new Date().toISOString();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

export const createSupabaseClient = (): SupabaseClient | null => {
  const key = supabaseServiceRoleKey || supabaseAnonKey;

  if (!supabaseUrl || !key) {
    return null;
  }

  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
};

export const db = createSupabaseClient();

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

seedMemoryStore();

export const isSupabaseConfigured = (): boolean => Boolean(db);

export const database = {
  async upsertVoiceSession(
    input: VoiceSessionInput
  ): Promise<VoiceSessionRecord> {
    if (db) {
      if (input.vapi_call_id) {
        const existing = await selectOne<VoiceSessionRecord>(
          db
            .from("voice_sessions")
            .select("*")
            .eq("vapi_call_id", input.vapi_call_id)
            .maybeSingle(),
          "find voice session"
        );

        if (existing) {
          return updateVoiceSession(existing.id, { status: input.status });
        }
      }

      return insertOne<VoiceSessionRecord>(
        db.from("voice_sessions").insert(input).select("*").single(),
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
        db
          .from("voice_sessions")
          .update({ status: "ended", ended_at: now() })
          .eq("id", sessionId),
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
        db.from("transcripts").insert({
          session_id: input.session_id,
          role: input.role,
          text: input.text
        }),
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
      return insertOne<DeveloperTaskRecord>(
        db.from("tasks").insert(input).select("*").single(),
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
      return selectOne<DeveloperTaskRecord>(
        db.from("tasks").select("*").eq("id", taskId).maybeSingle(),
        "get task"
      );
    }

    return memoryStore.tasks.find((task) => task.id === taskId) ?? null;
  },

  async listTasks(limit = 25): Promise<DeveloperTaskRecord[]> {
    if (db) {
      const { data, error } = await db
        .from("tasks")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(limit);

      if (error) {
        throw new Error(`list tasks failed: ${error.message}`);
      }

      return (data ?? []) as DeveloperTaskRecord[];
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
    const update = {
      ...patch,
      updated_at: now()
    };

    if (db) {
      return updateOne<DeveloperTaskRecord>(
        db.from("tasks").update(update).eq("id", taskId).select("*").single(),
        "update task"
      );
    }

    const task = memoryStore.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    Object.assign(task, update);
    return task;
  },

  async createExecutionRun(
    input: ExecutionRunInput
  ): Promise<ExecutionRunRecord> {
    if (db) {
      return insertOne<ExecutionRunRecord>(
        db.from("execution_runs").insert(input).select("*").single(),
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
      return updateOne<ExecutionRunRecord>(
        db
          .from("execution_runs")
          .update(patch)
          .eq("id", runId)
          .select("*")
          .single(),
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
      const { data, error } = await db
        .from("execution_runs")
        .select("*")
        .eq("task_id", taskId)
        .order("started_at", { ascending: false, nullsFirst: false });

      if (error) {
        throw new Error(`list execution runs failed: ${error.message}`);
      }

      return (data ?? []) as ExecutionRunRecord[];
    }

    return memoryStore.executionRuns.filter((run) => run.task_id === taskId);
  },

  async claimNextQueuedTask(
    executor: ExecutorKind
  ): Promise<{ task: DeveloperTaskRecord; run: ExecutionRunRecord } | null> {
    if (db) {
      const { data: candidates, error } = await db
        .from("tasks")
        .select("*")
        .eq("status", "queued")
        .order("created_at", { ascending: true })
        .limit(1);

      if (error) {
        throw new Error(`claim task lookup failed: ${error.message}`);
      }

      const candidate = (candidates?.[0] ?? null) as DeveloperTaskRecord | null;
      if (!candidate) {
        return null;
      }

      const { data: claimedRows, error: claimError } = await db
        .from("tasks")
        .update({ status: "running", updated_at: now() })
        .eq("id", candidate.id)
        .eq("status", "queued")
        .select("*");

      if (claimError) {
        throw new Error(`claim task failed: ${claimError.message}`);
      }

      const task = (claimedRows?.[0] ?? null) as DeveloperTaskRecord | null;
      if (!task) {
        return null;
      }

      const run = await database.createExecutionRun({
        task_id: task.id,
        executor,
        status: "running",
        started_at: now()
      });

      return { task, run };
    }

    const task = memoryStore.tasks
      .slice()
      .reverse()
      .find((item) => item.status === "queued");

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
      return insertOne<AuditEventRecord>(
        db.from("audit_events").insert(row).select("*").single(),
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
      let query = db
        .from("audit_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (filter.taskId) {
        query = query.eq("task_id", filter.taskId);
      }

      if (filter.sessionId) {
        query = query.eq("session_id", filter.sessionId);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`list audit events failed: ${error.message}`);
      }

      return (data ?? []) as AuditEventRecord[];
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
      return insertOne<ConfirmationRequestRecord>(
        db
          .from("confirmation_requests")
          .insert(input)
          .select("*")
          .single(),
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
      return selectOne<ConfirmationRequestRecord>(
        db
          .from("confirmation_requests")
          .select("*")
          .eq("id", confirmationId)
          .maybeSingle(),
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
      return selectOne<ConfirmationRequestRecord>(
        db
          .from("confirmation_requests")
          .select("*")
          .eq("task_id", taskId)
          .eq("status", "pending")
          .order("expires_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
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
      const { data, error } = await db
        .from("confirmation_requests")
        .select("*")
        .eq("status", "pending")
        .order("expires_at", { ascending: true })
        .limit(limit);

      if (error) {
        throw new Error(`list confirmations failed: ${error.message}`);
      }

      return (data ?? []) as ConfirmationRequestRecord[];
    }

    return memoryStore.confirmations
      .filter((item) => item.status === "pending")
      .slice(0, limit);
  },

  async updateConfirmation(
    confirmationId: string,
    status: ConfirmationRequestRecord["status"]
  ): Promise<ConfirmationRequestRecord> {
    const patch = {
      status,
      decided_at: ["approved", "denied", "expired"].includes(status)
        ? now()
        : null
    };

    if (db) {
      return updateOne<ConfirmationRequestRecord>(
        db
          .from("confirmation_requests")
          .update(patch)
          .eq("id", confirmationId)
          .select("*")
          .single(),
        "update confirmation"
      );
    }

    const confirmation = memoryStore.confirmations.find(
      (item) => item.id === confirmationId
    );

    if (!confirmation) {
      throw new Error(`Confirmation not found: ${confirmationId}`);
    }

    Object.assign(confirmation, patch);
    return confirmation;
  },

  async findRepoById(repoId: string): Promise<RepoRecord | null> {
    if (db) {
      return selectOne<RepoRecord>(
        db.from("repos").select("*").eq("id", repoId).maybeSingle(),
        "find repo by id"
      );
    }

    return memoryStore.repos.find((repo) => repo.id === repoId) ?? null;
  },

  async findRepoByAlias(alias: string): Promise<RepoRecord | null> {
    const normalized = normalizeAlias(alias);

    if (db) {
      const aliasRow = await selectOne<{ repo_id: string }>(
        db
          .from("repo_aliases")
          .select("repo_id")
          .in("alias", [
            normalized,
            alias.trim().toLowerCase(),
            alias.trim()
          ])
          .maybeSingle(),
        "find repo alias"
      );

      if (aliasRow) {
        return database.findRepoById(aliasRow.repo_id);
      }

      const direct = await selectOne<RepoRecord>(
        db
          .from("repos")
          .select("*")
          .or(`name.ilike.${escapeIlike(normalized)},owner.ilike.${escapeIlike(normalized)}`)
          .limit(1)
          .maybeSingle(),
        "find repo by name"
      );

      return direct;
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
      const { data, error } = await db
        .from("repos")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        throw new Error(`list repos failed: ${error.message}`);
      }

      return (data ?? []) as RepoRecord[];
    }

    return [...memoryStore.repos];
  },

  async findChatChannel(
    hint?: string
  ): Promise<ChatChannelRecord | null> {
    if (db) {
      let query = db.from("chat_channels").select("*").limit(1);

      if (hint) {
        query = query.ilike("display_name", `%${hint}%`);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`find chat channel failed: ${error.message}`);
      }

      return (data?.[0] ?? null) as ChatChannelRecord | null;
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

const updateVoiceSession = async (
  sessionId: string,
  patch: Partial<VoiceSessionRecord>
): Promise<VoiceSessionRecord> => {
  if (!db) {
    throw new Error("Supabase client missing");
  }

  return updateOne<VoiceSessionRecord>(
    db
      .from("voice_sessions")
      .update(patch)
      .eq("id", sessionId)
      .select("*")
      .single(),
    "update voice session"
  );
};

const insertOne = async <T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string
): Promise<T> => {
  const { data, error } = await query;

  if (error) {
    throw new Error(`${label} failed: ${error.message}`);
  }

  return data as T;
};

const updateOne = insertOne;

const selectOne = async <T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string
): Promise<T | null> => {
  const { data, error } = await query;

  if (error) {
    throw new Error(`${label} failed: ${error.message}`);
  }

  return (data ?? null) as T | null;
};

const execute = async (
  query: PromiseLike<{ error: { message: string } | null }>,
  label: string
): Promise<void> => {
  const { error } = await query;

  if (error) {
    throw new Error(`${label} failed: ${error.message}`);
  }
};

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, "-");
}

function escapeIlike(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
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

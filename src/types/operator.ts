export const normalizedActions = [
  "inspect_repo",
  "edit_files",
  "run_tests",
  "create_branch",
  "commit_changes",
  "open_pull_request",
  "send_chat_message",
  "summarize_project",
  "query_logs",
  "delegate_to_codex",
  "continue_existing_task"
] as const;

export const permissionLevels = [
  "read_only",
  "safe_write",
  "full_write",
  "destructive_admin"
] as const;

export const taskStatuses = [
  "draft",
  "needs_confirmation",
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export const executorKinds = [
  "direct",
  "codex_local",
  "codex_cloud",
  "github",
  "chat"
] as const;

export type NormalizedAction = (typeof normalizedActions)[number];
export type PermissionLevel = (typeof permissionLevels)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type ExecutorKind = (typeof executorKinds)[number];

export type DeveloperTask = {
  action: NormalizedAction;
  title: string;
  repoAlias?: string;
  repoId?: string;
  branchPolicy: "new_branch_required";
  permissionRequired: PermissionLevel;
  instructions: string;
  acceptanceCriteria: string[];
  chatTarget?: string;
  confidence: number;
};

export type RepoRecord = {
  id: string;
  provider: string;
  owner: string;
  name: string;
  clone_url: string;
  default_branch: string;
  local_path: string | null;
  codex_cloud_env_id: string | null;
  created_at: string;
};

export type VoiceSessionRecord = {
  id: string;
  vapi_call_id: string | null;
  user_id: string | null;
  channel: string;
  status: string;
  started_at: string;
  ended_at: string | null;
};

export type DeveloperTaskRecord = {
  id: string;
  session_id: string | null;
  user_id: string | null;
  repo_id: string | null;
  title: string;
  raw_request: string;
  normalized_action: NormalizedAction;
  structured_request: DeveloperTask;
  status: TaskStatus;
  permission_required: PermissionLevel;
  created_at: string;
  updated_at: string;
};

export type ExecutionRunRecord = {
  id: string;
  task_id: string;
  executor: ExecutorKind;
  branch_name: string | null;
  status: TaskStatus;
  started_at: string | null;
  finished_at: string | null;
  final_summary: string | null;
};

export type AuditEventRecord = {
  id: string;
  task_id: string | null;
  run_id: string | null;
  session_id: string | null;
  event_type: string;
  severity: "debug" | "info" | "warn" | "error";
  payload: Record<string, unknown>;
  created_at: string;
};

export type ConfirmationRequestRecord = {
  id: string;
  task_id: string;
  prompt: string;
  risk: string;
  status: "pending" | "approved" | "denied" | "expired";
  expires_at: string;
  decided_at: string | null;
};

export type MemoryRecord = {
  id: string;
  user_id: string | null;
  scope: string;
  key: string;
  value: Record<string, unknown>;
  confidence: number;
  updated_at: string;
};

export type ChatChannelRecord = {
  id: string;
  kind: string;
  external_id: string;
  display_name: string;
  repo_id: string | null;
};

export type CreateTaskInput = {
  utterance: string;
  sessionId?: string;
  repoHint?: string;
  userId?: string;
};

export type TaskCreationResult = {
  task_id: string;
  status: TaskStatus;
  interpreted_task: DeveloperTask;
  needs_confirmation: boolean;
  confirmation_id?: string;
  repo?: Pick<RepoRecord, "id" | "owner" | "name" | "local_path">;
};

export type TaskStatusResult = {
  task: DeveloperTaskRecord;
  latest_events: AuditEventRecord[];
  runs: ExecutionRunRecord[];
  confirmation?: ConfirmationRequestRecord;
  final_summary?: string;
};

export type OutboundCallRequest = {
  phone_number: string;
  reason: string;
  task_id?: string;
};

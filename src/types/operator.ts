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
  "desktop_control",
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
  "chat",
  "codex_thread"
] as const;

export const runnerTaskScopes = ["all", "read_only", "write"] as const;
export const taskExecutionTargets = ["runner", "codex_thread"] as const;
export const chatChannelKinds = ["web", "sms", "telegram"] as const;
export const chatMessageDirections = ["inbound", "outbound", "system"] as const;
export const chatMessageRoles = ["user", "assistant", "system"] as const;

export type NormalizedAction = (typeof normalizedActions)[number];
export type PermissionLevel = (typeof permissionLevels)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type ExecutorKind = (typeof executorKinds)[number];
export type RunnerTaskScope = (typeof runnerTaskScopes)[number];
export type TaskExecutionTarget = (typeof taskExecutionTargets)[number];
export type ChatChannelKind = (typeof chatChannelKinds)[number];
export type ChatMessageDirection = (typeof chatMessageDirections)[number];
export type ChatMessageRole = (typeof chatMessageRoles)[number];

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
  targetApp?: string;
  url?: string;
  riskLevel?: "low" | "needs_confirmation" | "blocked";
  desktopMode?: "normal_chrome" | "full_mac" | "local_shell";
  desktopApprovalGranted?: boolean;
  shellCommand?: string;
  shellCwd?: string;
  confidence: number;
  postApprovalAction?: {
    action: "commit_changes" | "open_pull_request";
    branchName?: string;
    commitMessage?: string;
    pullRequestTitle?: string;
    pullRequestBody?: string;
    draft?: boolean;
  };
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

export type SmsConversationRecord = {
  id: string;
  phone_e164: string;
  status: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
};

export type SmsMessageRecord = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  body: string;
  provider_message_sid: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type SmsWebhookAuthMode =
  | "query_secret"
  | "twilio_signature"
  | "mixed"
  | "unknown";

export type SmsVerificationState = "approved" | "pending" | "rejected" | "unknown";
export type SmsDeliveryState = "healthy" | "degraded" | "blocked" | "unknown";

export type SmsConfigSummary = {
  enabled: boolean;
  ownerPhoneTail: string | null;
  fromNumberTail: string | null;
};

export type SmsOverview = SmsConfigSummary & {
  configured: boolean;
  webhookAuthMode: SmsWebhookAuthMode;
  verificationState: SmsVerificationState;
  deliveryState: SmsDeliveryState;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastOutboundStatus: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  attention: string[];
};

export type SmsHealthMessage = {
  sid: string | null;
  direction: "inbound" | "outbound";
  role: SmsMessageRecord["role"];
  bodyPreview: string;
  createdAt: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  source: "conversation" | "twilio_api" | "audit";
};

export type SmsHealthData = {
  summary: SmsOverview;
  verification: {
    state: SmsVerificationState;
    source: "twilio_api" | "manual_console_required" | "not_configured";
    detail: string;
    checkedAt: string;
  };
  webhook: {
    authMode: SmsWebhookAuthMode;
    querySecretConfigured: boolean;
    twilioSignatureConfigured: boolean;
    ownerPhoneTail: string | null;
    fromNumberTail: string | null;
  };
  recentMessages: SmsHealthMessage[];
  recentFailures: SmsHealthMessage[];
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
  execution_target: TaskExecutionTarget;
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
  heartbeat_at: string | null;
  final_summary: string | null;
};

export type CodexThreadJobRecord = {
  id: string;
  task_id: string;
  status: TaskStatus;
  thread_label: string;
  claimed_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  final_summary: string | null;
  created_at: string;
  updated_at: string;
};

export type DesktopSnapshotRecord = {
  task_id: string;
  run_id: string | null;
  current_url: string | null;
  page_title: string | null;
  latest_action: string | null;
  step: number;
  screenshot_data_url: string | null;
  redacted: boolean;
  updated_at: string;
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
  kind: ChatChannelKind;
  external_id: string;
  display_name: string;
  repo_id: string | null;
};

export type ChatConversationRecord = {
  id: string;
  channel_id: string;
  scope: string;
  status: string;
  title: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
};

export type ChatMessageRecord = {
  id: string;
  conversation_id: string;
  task_id: string | null;
  direction: ChatMessageDirection;
  role: ChatMessageRole;
  body: string;
  provider_message_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ChatMessageTaskLinkRecord = {
  message_id: string;
  task_id: string;
  relation: string;
  created_at: string;
};

export type ChatTaskOriginRecord = {
  conversation_id: string;
  channel_kind: ChatChannelKind;
  external_id: string;
  display_name: string;
};

export type JarvisChatMessageView = ChatMessageRecord & {
  channel_kind: ChatChannelKind;
  channel_display_name: string;
  task?: Pick<
    DeveloperTaskRecord,
    "id" | "title" | "status" | "normalized_action" | "execution_target" | "updated_at"
  >;
};

export type CreateTaskInput = {
  utterance: string;
  sessionId?: string;
  repoHint?: string;
  userId?: string;
  source?: "console" | "sms" | "telegram" | "web_chat" | "tool" | "voice";
};

export type TaskCreationResult = {
  task_id: string;
  status: TaskStatus;
  execution_target: TaskExecutionTarget;
  interpreted_task: DeveloperTask;
  needs_confirmation: boolean;
  confirmation_id?: string;
  repo?: Pick<RepoRecord, "id" | "owner" | "name" | "local_path">;
};

export type TaskStatusResult = {
  task: DeveloperTaskRecord;
  latest_events: AuditEventRecord[];
  runs: ExecutionRunRecord[];
  codex_thread_job?: CodexThreadJobRecord;
  confirmation?: ConfirmationRequestRecord;
  final_summary?: string;
};

export type OutboundCallRequest = {
  phone_number: string;
  reason: string;
  task_id?: string;
};

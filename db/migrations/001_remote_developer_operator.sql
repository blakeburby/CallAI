create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type task_status as enum ('draft','needs_confirmation','queued','running','blocked','succeeded','failed','cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'permission_level') then
    create type permission_level as enum ('read_only','safe_write','full_write','destructive_admin');
  end if;

  if not exists (select 1 from pg_type where typname = 'executor_kind') then
    create type executor_kind as enum ('direct','codex_local','codex_cloud','github','chat');
  end if;
end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone_e164 text unique,
  default_permission permission_level not null default 'safe_write',
  created_at timestamptz not null default now()
);

create table if not exists repos (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'github',
  owner text not null,
  name text not null,
  clone_url text not null,
  default_branch text not null default 'main',
  local_path text,
  codex_cloud_env_id text,
  created_at timestamptz not null default now(),
  unique(owner, name)
);

create table if not exists repo_aliases (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  alias text not null unique
);

create table if not exists voice_sessions (
  id uuid primary key default gen_random_uuid(),
  vapi_call_id text unique,
  user_id uuid references users(id),
  channel text not null,
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists transcripts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references voice_sessions(id) on delete cascade,
  role text not null,
  text text not null,
  occurred_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references voice_sessions(id),
  user_id uuid references users(id),
  repo_id uuid references repos(id),
  title text not null,
  raw_request text not null,
  normalized_action text not null,
  structured_request jsonb not null,
  status task_status not null default 'draft',
  permission_required permission_level not null default 'safe_write',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists execution_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  executor executor_kind not null,
  branch_name text,
  status task_status not null default 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  final_summary text
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete set null,
  run_id uuid references execution_runs(id) on delete set null,
  session_id uuid references voice_sessions(id) on delete set null,
  event_type text not null,
  severity text not null default 'info',
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists confirmation_requests (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  prompt text not null,
  risk text not null,
  status text not null default 'pending',
  expires_at timestamptz not null,
  decided_at timestamptz
);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  scope text not null,
  key text not null,
  value jsonb not null,
  confidence numeric not null default 1,
  updated_at timestamptz not null default now(),
  unique(user_id, scope, key)
);

create table if not exists chat_channels (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  external_id text not null,
  display_name text not null,
  repo_id uuid references repos(id),
  unique(kind, external_id)
);

create index if not exists tasks_status_created_at_idx on tasks(status, created_at);
create index if not exists execution_runs_task_started_at_idx on execution_runs(task_id, started_at desc nulls last);
create index if not exists audit_events_task_created_at_idx on audit_events(task_id, created_at desc);
create index if not exists audit_events_session_created_at_idx on audit_events(session_id, created_at desc);
create index if not exists confirmation_requests_status_expires_at_idx on confirmation_requests(status, expires_at);
create index if not exists transcripts_session_occurred_at_idx on transcripts(session_id, occurred_at desc);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_tasks_updated_at on tasks;
create trigger set_tasks_updated_at
before update on tasks
for each row
execute function set_updated_at();

drop trigger if exists set_memories_updated_at on memories;
create trigger set_memories_updated_at
before update on memories
for each row
execute function set_updated_at();

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_execution_target') then
    create type task_execution_target as enum ('runner','codex_thread');
  end if;
end $$;

do $$
begin
  alter type executor_kind add value if not exists 'codex_thread';
exception
  when duplicate_object then null;
end $$;

alter table tasks
  add column if not exists execution_target task_execution_target not null default 'runner';

create table if not exists codex_thread_jobs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  status task_status not null default 'queued',
  thread_label text not null default 'CallAI Codex thread',
  claimed_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz,
  final_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(task_id)
);

create index if not exists tasks_execution_target_status_created_at_idx
  on tasks(execution_target, status, created_at);

create index if not exists codex_thread_jobs_status_created_at_idx
  on codex_thread_jobs(status, created_at);

drop trigger if exists set_codex_thread_jobs_updated_at on codex_thread_jobs;
create trigger set_codex_thread_jobs_updated_at
before update on codex_thread_jobs
for each row
execute function set_updated_at();

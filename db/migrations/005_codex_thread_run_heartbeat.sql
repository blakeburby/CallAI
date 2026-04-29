alter table execution_runs
  add column if not exists heartbeat_at timestamptz;

create table if not exists desktop_snapshots (
  task_id uuid primary key references tasks(id) on delete cascade,
  run_id uuid references execution_runs(id) on delete set null,
  current_url text,
  page_title text,
  latest_action text,
  step integer not null default 0,
  screenshot_data_url text,
  redacted boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists desktop_snapshots_updated_at_idx
  on desktop_snapshots(updated_at desc);

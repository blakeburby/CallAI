create table if not exists jarvis_chat_reply_jobs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  inbound_message_id uuid not null references chat_messages(id) on delete cascade,
  status text not null default 'queued',
  worker_id text,
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '60 seconds',
  reply_body text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(inbound_message_id)
);

create index if not exists jarvis_chat_reply_jobs_status_created_at_idx
  on jarvis_chat_reply_jobs(status, created_at asc);

create index if not exists jarvis_chat_reply_jobs_conversation_created_at_idx
  on jarvis_chat_reply_jobs(conversation_id, created_at desc);

drop trigger if exists set_jarvis_chat_reply_jobs_updated_at on jarvis_chat_reply_jobs;
create trigger set_jarvis_chat_reply_jobs_updated_at
before update on jarvis_chat_reply_jobs
for each row
execute function set_updated_at();

create table if not exists chat_conversations (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references chat_channels(id) on delete cascade,
  scope text not null default 'jarvis',
  status text not null default 'active',
  title text not null default 'Jarvis',
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(channel_id, scope)
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  direction text not null,
  role text not null,
  body text not null,
  provider_message_id text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists chat_message_tasks (
  message_id uuid not null references chat_messages(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  relation text not null default 'related',
  created_at timestamptz not null default now(),
  primary key (message_id, task_id, relation)
);

create index if not exists chat_conversations_last_message_at_idx
  on chat_conversations(last_message_at desc);

create index if not exists chat_messages_conversation_created_at_idx
  on chat_messages(conversation_id, created_at desc);

create index if not exists chat_messages_task_created_at_idx
  on chat_messages(task_id, created_at desc);

create index if not exists chat_message_tasks_task_id_idx
  on chat_message_tasks(task_id);

drop trigger if exists set_chat_conversations_updated_at on chat_conversations;
create trigger set_chat_conversations_updated_at
before update on chat_conversations
for each row
execute function set_updated_at();

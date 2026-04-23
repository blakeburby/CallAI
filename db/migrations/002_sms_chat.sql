create table if not exists sms_conversations (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  status text not null default 'active',
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sms_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references sms_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  body text not null,
  provider_message_sid text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists sms_conversations_last_message_at_idx
  on sms_conversations(last_message_at desc);

create index if not exists sms_messages_conversation_created_at_idx
  on sms_messages(conversation_id, created_at desc);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_sms_conversations_updated_at on sms_conversations;
create trigger set_sms_conversations_updated_at
before update on sms_conversations
for each row
execute function set_updated_at();

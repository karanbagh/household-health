create table chat_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id uuid not null references members(id),
  user_id uuid not null references users(id),
  conversation_key text not null,
  title text not null,
  turns jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(household_id,member_id,user_id,conversation_key)
);
create index chat_sessions_member_user on chat_sessions(member_id,user_id,updated_at desc);
alter table chat_sessions enable row level security;
alter table chat_sessions force row level security;
create policy chat_sessions_read on chat_sessions for select using(household_id=app_household_id() and user_id=app_user_id());
-- Saving a conversation is allowed for viewers; changing health records still requires write permission.
create policy chat_sessions_insert on chat_sessions for insert with check(household_id=app_household_id() and user_id=app_user_id());
create policy chat_sessions_update on chat_sessions for update using(household_id=app_household_id() and user_id=app_user_id()) with check(household_id=app_household_id() and user_id=app_user_id());
grant select,insert,update on chat_sessions to hh_app;

-- Household Health: initial schema
-- Tenancy: every clinical row carries household_id, enforced by Row-Level Security.
-- Audit:   every INSERT/UPDATE on clinical tables is captured by trigger into audit_log;
--          reads and AI queries are written by the app. audit_log is append-only and hash-chained.

create extension if not exists pgcrypto;
create extension if not exists vector;   -- reserved for document embeddings (not used in v0)

-- The application role. It does not own tables and cannot bypass RLS.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hh_app') then
    create role hh_app login;
  end if;
end $$;

-- Session context helpers (set per transaction by the app with set_config(..., true))
create or replace function app_household_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.household_id', true), '')::uuid $$;
create or replace function app_user_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function app_can_write() returns boolean language sql stable as
$$ select coalesce(current_setting('app.role', true), '') in ('owner', 'editor') $$;

-- ───────────────────────── identity and tenancy ─────────────────────────
create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'America/New_York',
  unit_system text not null default 'us' check (unit_system in ('us', 'metric')),
  created_at  timestamptz not null default now()
);

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  display_name text not null,
  created_at   timestamptz not null default now()
);

create table household_users (
  household_id uuid not null references households(id),
  user_id      uuid not null references users(id),
  role         text not null check (role in ('owner', 'editor', 'viewer')),
  primary key (household_id, user_id)
);

-- People whose health records are kept (Harshal is one member of a household)
create table members (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id),
  full_name      text not null,
  preferred_name text,
  date_of_birth  date,
  sex            text check (sex in ('female', 'male', 'other', 'unknown')),
  blood_type     text check (blood_type in ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users(id),
  deleted_at     timestamptz
);

-- ───────────────────────── clinical records ─────────────────────────
create table allergies (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id    uuid not null references members(id),
  substance    text not null,
  reaction     text,
  severity     text not null default 'unknown' check (severity in ('mild','moderate','severe','unknown')),
  noted_on     date,
  status       text not null default 'active' check (status in ('active','inactive')),
  source_text  text,
  created_at   timestamptz not null default now(),
  created_by   uuid references users(id),
  deleted_at   timestamptz
);

create table medications (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id    uuid not null references members(id),
  name         text not null,
  dose_value   numeric,
  dose_unit    text,
  route        text,
  frequency    text,
  prescriber   text,
  reason       text,
  start_date   date,
  end_date     date,
  stop_reason  text,
  status       text not null default 'active' check (status in ('active','stopped')),
  source_text  text,
  created_at   timestamptz not null default now(),
  created_by   uuid references users(id),
  deleted_at   timestamptz,
  check (end_date is null or start_date is null or end_date >= start_date)
);

-- One row per measured value. Blood pressure is stored as two rows (systolic, diastolic) sharing panel_id.
-- value/unit are canonical (UCUM); original_value/original_unit are exactly what the parent entered.
create table vitals (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id),
  member_id      uuid not null references members(id),
  vital_type     text not null check (vital_type in
                   ('weight','height','temperature','heart_rate','respiratory_rate',
                    'spo2','bp_systolic','bp_diastolic','blood_glucose','head_circumference')),
  loinc          text not null,
  value          numeric not null,
  unit           text not null,
  original_value numeric not null,
  original_unit  text not null,
  measured_at    timestamptz not null,
  panel_id       uuid,
  source_text    text,
  created_at     timestamptz not null default now(),
  created_by     uuid references users(id),
  deleted_at     timestamptz
);
create index vitals_member_type_time on vitals (member_id, vital_type, measured_at desc);

create table appointments (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id),
  member_id     uuid not null references members(id),
  starts_at     timestamptz not null,
  provider_name text,
  specialty     text,
  location      text,
  reason        text,
  status        text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  outcome_notes text,
  source_text   text,
  created_at    timestamptz not null default now(),
  created_by    uuid references users(id),
  deleted_at    timestamptz
);
create index appointments_member_time on appointments (member_id, starts_at);

-- LLM-proposed entries awaiting a parent's one-tap confirmation
create table pending_entries (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id),
  member_id       uuid not null references members(id),
  created_by      uuid not null references users(id),
  source_text     text not null,
  proposals       jsonb not null,
  status          text not null default 'pending' check (status in ('pending','confirmed','discarded','undone')),
  created_records jsonb,
  trace_id        text,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

-- ───────────────────────── audit ─────────────────────────
create table audit_log (
  id            bigserial primary key,
  at            timestamptz not null default clock_timestamp(),
  household_id  uuid not null,
  actor_user_id uuid,
  member_id     uuid,
  action        text not null check (action in ('create','update','delete','read','ai_query','entry_proposed','entry_confirmed','entry_discarded','entry_undone')),
  entity        text not null,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  details       jsonb,
  request_id    text,
  trace_id      text,
  prev_hash     bytea,
  hash          bytea not null
);
create index audit_household_time on audit_log (household_id, at desc);
create index audit_entity on audit_log (entity, entity_id);

-- Hash chain per household: hash = sha256(prev_hash || canonical row content). Tampering breaks the chain.
create or replace function audit_row_digest(prev bytea, r audit_log) returns bytea language sql immutable as $$
  select digest(
    coalesce(prev, ''::bytea) ||
    convert_to(jsonb_build_object(
      'at', (r.at at time zone 'UTC'), 'household_id', r.household_id, 'actor', r.actor_user_id,
      'member_id', r.member_id, 'action', r.action, 'entity', r.entity,
      'entity_id', r.entity_id, 'before', r.before, 'after', r.after,
      'details', r.details, 'request_id', r.request_id, 'trace_id', r.trace_id)::text, 'UTF8'),
    'sha256')
$$;

create or replace function audit_chain() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.household_id::text, 42));
  select hash into new.prev_hash from audit_log
   where household_id = new.household_id order by id desc limit 1;
  new.hash := audit_row_digest(new.prev_hash, new);
  return new;
end $$;

-- Returns the id of the first audit row whose hash does not verify, or null if the chain is intact.
create or replace function audit_verify(p_household uuid) returns bigint language plpgsql stable security definer set search_path = public as $$
declare r audit_log; prev bytea := null;
begin
  for r in select * from audit_log where household_id = p_household order by id loop
    if r.prev_hash is distinct from prev or r.hash <> audit_row_digest(prev, r) then return r.id; end if;
    prev := r.hash;
  end loop;
  return null;
end $$;
create trigger audit_chain before insert on audit_log for each row execute function audit_chain();

create or replace function audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_no_update before update or delete on audit_log for each row execute function audit_immutable();

-- Data-change capture for clinical tables. Runs as definer so it can write audit_log.
create or replace function audit_row_change() returns trigger language plpgsql security definer set search_path = public as $$
declare
  act text;
  b jsonb := null;
  a jsonb := null;
begin
  if tg_op = 'INSERT' then
    act := 'create'; a := to_jsonb(new);
  else
    b := to_jsonb(old); a := to_jsonb(new);
    act := case when old.deleted_at is null and new.deleted_at is not null then 'delete' else 'update' end;
  end if;
  insert into audit_log (household_id, actor_user_id, member_id, action, entity, entity_id, before, after, request_id, trace_id)
  values (new.household_id, app_user_id(),
          case when tg_table_name = 'members' then new.id else (to_jsonb(new)->>'member_id')::uuid end,
          act, tg_table_name, new.id, b, a,
          nullif(current_setting('app.request_id', true), ''),
          nullif(current_setting('app.trace_id', true), ''));
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['members','allergies','medications','vitals','appointments'] loop
    execute format('create trigger audit_%1$s after insert or update on %1$I for each row execute function audit_row_change()', t);
  end loop;
end $$;

-- Hard deletes are not allowed on clinical data; use deleted_at.
create or replace function forbid_delete() returns trigger language plpgsql as $$
begin raise exception 'hard delete not allowed on %; set deleted_at instead', tg_table_name; end $$;
do $$ declare t text; begin
  foreach t in array array['members','allergies','medications','vitals','appointments'] loop
    execute format('create trigger no_delete_%1$s before delete on %1$I for each row execute function forbid_delete()', t);
  end loop;
end $$;

-- ───────────────────────── row-level security ─────────────────────────
alter table households enable row level security;
alter table households force row level security;
create policy households_tenant on households using (id = app_household_id());

alter table household_users enable row level security;
alter table household_users force row level security;
create policy household_users_tenant on household_users using (household_id = app_household_id());

do $$ declare t text; begin
  foreach t in array array['members','allergies','medications','vitals','appointments','pending_entries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %1$s_read on %1$I for select using (household_id = app_household_id())', t);
    execute format('create policy %1$s_insert on %1$I for insert with check (household_id = app_household_id() and app_can_write())', t);
    execute format('create policy %1$s_update on %1$I for update using (household_id = app_household_id() and app_can_write()) with check (household_id = app_household_id())', t);
  end loop;
end $$;

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_read on audit_log for select using (household_id = app_household_id());
create policy audit_insert on audit_log for insert with check (household_id = app_household_id());

-- Login-time lookup: which households does this user belong to? (runs before a tenant is set)
create or replace function auth_memberships(p_email text)
returns table (user_id uuid, display_name text, household_id uuid, household_name text, role text)
language sql stable security definer set search_path = public as $$
  select u.id, u.display_name, h.id, h.name, hu.role
    from users u
    join household_users hu on hu.user_id = u.id
    join households h on h.id = hu.household_id
   where lower(u.email) = lower(p_email)
$$;

-- ───────────────────────── grants ─────────────────────────
grant usage on schema public to hh_app;
grant select on households, household_users to hh_app;  -- users is reachable only through auth_memberships()
grant select, insert, update on members, allergies, medications, vitals, appointments, pending_entries to hh_app;
grant select, insert on audit_log to hh_app;
grant usage on sequence audit_log_id_seq to hh_app;
grant execute on function auth_memberships(text), app_household_id(), app_user_id(), app_can_write() to hh_app;
revoke execute on function audit_verify(uuid) from public;
revoke update, delete, truncate on audit_log from hh_app;

-- Original reports, reviewed results, and their semantic index live in PostgreSQL.
create table lab_reports (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id uuid not null references members(id),
  title text not null,
  report_date date,
  lab_name text,
  patient_name text,
  original_text text not null,
  file_name text,
  file_mime text,
  file_data bytea,
  content_hash text not null,
  results jsonb not null default '[]',
  notes text not null default '',
  warnings jsonb not null default '[]',
  status text not null default 'draft' check(status in ('draft','confirmed')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  deleted_at timestamptz,
  unique(id, household_id, member_id)
);
create index lab_reports_member_date on lab_reports(member_id, report_date desc);

create table lab_chunks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  member_id uuid not null,
  report_id uuid not null,
  revision integer not null,
  chunk_no integer not null,
  content text not null,
  embedding vector(1536) not null,
  embedding_model text not null,
  foreign key(report_id, household_id, member_id) references lab_reports(id, household_id, member_id),
  unique(report_id, revision, chunk_no)
);
create index lab_chunks_member_report on lab_chunks(member_id, report_id);
-- Exact cosine search is deliberate: household-scale collections are small, and tenant
-- filtering must happen before ranking rather than dropping matches from a global ANN index.

do $$ declare t text; begin
  foreach t in array array['lab_reports','lab_chunks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %1$s_read on %1$I for select using (household_id = app_household_id())', t);
    execute format('create policy %1$s_insert on %1$I for insert with check (household_id = app_household_id() and app_can_write())', t);
    execute format('create policy %1$s_update on %1$I for update using (household_id = app_household_id() and app_can_write()) with check (household_id = app_household_id())', t);
  end loop;
end $$;
create policy lab_chunks_delete on lab_chunks for delete using(household_id = app_household_id() and app_can_write());
grant select, insert, update on lab_reports to hh_app;
grant select, insert, delete on lab_chunks to hh_app;

-- Audit metadata and reviewed values, without duplicating binary files or source transcripts.
create function audit_lab_report_change() returns trigger language plpgsql security definer set search_path = public as $$
declare b jsonb; a jsonb; act text;
begin
  a := to_jsonb(new) - 'file_data' - 'original_text';
  if tg_op = 'INSERT' then act := 'create';
  else
    b := to_jsonb(old) - 'file_data' - 'original_text';
    act := case when old.deleted_at is null and new.deleted_at is not null then 'delete' else 'update' end;
  end if;
  insert into audit_log(household_id, actor_user_id, member_id, action, entity, entity_id, before, after, request_id)
  values(new.household_id, app_user_id(), new.member_id, act, 'lab_reports', new.id, b, a,
    nullif(current_setting('app.request_id', true), ''));
  return new;
end $$;
create trigger audit_lab_reports after insert or update on lab_reports for each row execute function audit_lab_report_change();
create trigger no_delete_lab_reports before delete on lab_reports for each row execute function forbid_delete();

-- PostgreSQL table renames preserve rows, IDs, foreign keys, RLS policies and grants.
alter table lab_reports rename to reports;
alter table lab_chunks rename to report_chunks;
alter index lab_reports_member_date rename to reports_member_date;
alter index lab_chunks_member_report rename to report_chunks_member_report;

-- Use the current table name for future audit events. Historical audit rows and
-- their hash chain remain untouched.
create or replace function audit_lab_report_change() returns trigger language plpgsql security definer set search_path = public as $$
declare b jsonb; a jsonb; act text;
begin
  a := to_jsonb(new) - 'file_data' - 'original_text';
  if tg_op = 'INSERT' then act := 'create';
  else
    b := to_jsonb(old) - 'file_data' - 'original_text';
    act := case when old.deleted_at is null and new.deleted_at is not null then 'delete' else 'update' end;
  end if;
  insert into audit_log(household_id, actor_user_id, member_id, action, entity, entity_id, before, after, request_id)
  values(new.household_id, app_user_id(), new.member_id, act, tg_table_name, new.id, b, a,
    nullif(current_setting('app.request_id', true), ''));
  return new;
end $$;
alter function audit_lab_report_change() rename to audit_report_change;
alter trigger audit_lab_reports on reports rename to audit_reports;
alter trigger no_delete_lab_reports on reports rename to no_delete_reports;

-- Rename the associated constraints and policies without recreating them.
do $$
declare item record; renamed text;
begin
  for item in select conrelid::regclass as tbl, conname from pg_constraint
    where conrelid in ('reports'::regclass, 'report_chunks'::regclass) loop
    renamed := replace(replace(item.conname, 'lab_reports', 'reports'), 'lab_chunks', 'report_chunks');
    if renamed <> item.conname then
      execute format('alter table %s rename constraint %I to %I', item.tbl, item.conname, renamed);
    end if;
  end loop;
  for item in select polrelid::regclass as tbl, polname from pg_policy
    where polrelid in ('reports'::regclass, 'report_chunks'::regclass) loop
    renamed := replace(replace(item.polname, 'lab_reports', 'reports'), 'lab_chunks', 'report_chunks');
    if renamed <> item.polname then
      execute format('alter policy %I on %s rename to %I', item.polname, item.tbl, renamed);
    end if;
  end loop;
end $$;

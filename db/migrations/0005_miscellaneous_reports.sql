-- Keep existing lab report IDs, originals and indexes while supporting narrative documents.
alter table lab_reports add column report_type text not null default 'lab'
  check (report_type in ('lab','surgery','discharge','recommendation','other'));
alter table lab_reports add column sections jsonb not null default '[]';

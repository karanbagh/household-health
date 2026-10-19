alter table audit_log drop constraint audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action in (
  'create','update','delete','read','ai_query','entry_proposed','entry_confirmed','entry_discarded','entry_undone',
  'invitation_created','invitation_resent','invitation_revoked','invitation_accepted','access_updated','access_removed',
  'gmail_connected','gmail_disconnected','email_sent','email_failed','email_unknown'
));

create table household_invitations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  email text not null check (email=lower(email)),
  role text not null check (role in ('editor','viewer')),
  token_hash text not null unique,
  invited_by uuid not null references users(id),
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  expires_at timestamptz not null default now()+interval '7 days',
  created_at timestamptz not null default now()
);
create unique index household_invitation_pending on household_invitations(household_id,email) where status='pending';
alter table household_invitations enable row level security;
create policy invitation_owner on household_invitations for all to hh_app
  using (household_id=app_household_id() and current_setting('app.role',true)='owner')
  with check (household_id=app_household_id() and current_setting('app.role',true)='owner' and invited_by=app_user_id());
grant select,insert,update on household_invitations to hh_app;

create table household_mailboxes (
  household_id uuid primary key references households(id),
  email text not null,
  refresh_token_encrypted text not null,
  connected_by uuid not null references users(id),
  updated_at timestamptz not null default now()
);
alter table household_mailboxes enable row level security;
create policy mailbox_read on household_mailboxes for select to hh_app
  using (household_id=app_household_id() and app_can_write());
create policy mailbox_insert on household_mailboxes for insert to hh_app
  with check (household_id=app_household_id() and current_setting('app.role',true)='owner' and connected_by=app_user_id());
create policy mailbox_update on household_mailboxes for update to hh_app
  using (household_id=app_household_id() and current_setting('app.role',true)='owner')
  with check (household_id=app_household_id() and current_setting('app.role',true)='owner' and connected_by=app_user_id());
create policy mailbox_delete on household_mailboxes for delete to hh_app
  using (household_id=app_household_id() and current_setting('app.role',true)='owner');
grant select,insert,update,delete on household_mailboxes to hh_app;

create table gmail_oauth_transactions (
  token_hash text primary key, state text not null, nonce text not null, verifier text not null,
  household_id uuid not null references households(id), user_id uuid not null references users(id),
  expires_at timestamptz not null
);
grant select,insert,delete on gmail_oauth_transactions to hh_app;

create table email_deliveries (
  id uuid primary key default gen_random_uuid(), household_id uuid not null references households(id),
  operation_id uuid not null, kind text not null check (kind in ('household_invitation','calendar_invitation')),
  resource_id uuid not null, recipient text not null,
  status text not null default 'sending' check (status in ('sending','sent','failed','unknown')),
  provider_id text, created_at timestamptz not null default now(),
  unique(household_id,operation_id,recipient)
);
alter table email_deliveries enable row level security;
create policy delivery_access on email_deliveries for all to hh_app
  using (household_id=app_household_id() and app_can_write())
  with check (household_id=app_household_id() and app_can_write());
grant select,insert,update on email_deliveries to hh_app;
create index email_deliveries_rate on email_deliveries(household_id,created_at);

-- Addresses are returned only to someone who actually belongs to this household.
create function household_people()
returns table(id uuid,email text,name text,role text)
language sql stable security definer set search_path=public as $$
  select u.id,u.email,u.display_name,hu.role from household_users hu join users u on u.id=hu.user_id
  where hu.household_id=app_household_id() and exists (
    select 1 from household_users actor where actor.household_id=app_household_id() and actor.user_id=app_user_id()
  )
$$;

create function accept_household_invitation(p_session_hash text,p_invite_hash text,p_request uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare u uuid; account_email text; invitation household_invitations;
begin
  select s.user_id,users.email into u,account_email from auth_sessions s join users on users.id=s.user_id
    where s.token_hash=p_session_hash and s.expires_at>now() and users.google_subject is not null;
  if u is null then raise exception 'Sign in with Google first' using errcode='28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,44));
  select * into invitation from household_invitations where token_hash=p_invite_hash for update;
  if invitation.id is null or invitation.status<>'pending' or invitation.expires_at<=now()
    or lower(account_email)<>invitation.email then
    raise exception 'Invitation is unavailable or belongs to another account' using errcode='22023';
  end if;
  if not exists(select 1 from household_users where household_id=invitation.household_id and user_id=invitation.invited_by and role='owner') then
    raise exception 'Invitation is unavailable' using errcode='22023';
  end if;
  insert into household_users(household_id,user_id,role) values(invitation.household_id,u,invitation.role) on conflict do nothing;
  update household_invitations set status='accepted' where id=invitation.id;
  insert into audit_log(household_id,actor_user_id,action,entity,entity_id,details,request_id)
    values(invitation.household_id,u,'invitation_accepted','household_invitations',invitation.id,jsonb_build_object('role',invitation.role),p_request);
  return invitation.household_id;
end $$;

create function change_household_access(p_user uuid,p_role text)
returns void language plpgsql security definer set search_path=public as $$
declare old_role text;
begin
  -- Serialize owner changes within a household; ownership itself cannot be changed here.
  perform pg_advisory_xact_lock(hashtextextended(app_household_id()::text,46));
  if not exists(select 1 from household_users where household_id=app_household_id() and user_id=app_user_id() and role='owner') then
    raise exception 'Only the household owner can change access' using errcode='42501';
  end if;
  select role into old_role from household_users where household_id=app_household_id() and user_id=p_user for update;
  if old_role is null or old_role='owner' or (p_role is not null and p_role not in ('editor','viewer')) then
    raise exception 'This account cannot be changed here' using errcode='22023';
  end if;
  if p_role is null then delete from household_users where household_id=app_household_id() and user_id=p_user;
  else update household_users set role=p_role where household_id=app_household_id() and user_id=p_user; end if;
end $$;
revoke all on function household_people(),accept_household_invitation(text,text,uuid),change_household_access(uuid,text) from public;
grant execute on function household_people(),accept_household_invitation(text,text,uuid),change_household_access(uuid,text) to hh_app;

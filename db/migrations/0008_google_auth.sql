alter table users add column google_subject text unique;
create table auth_sessions (
  token_hash text primary key,
  user_id uuid not null references users(id),
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index auth_sessions_expiry on auth_sessions(expires_at);
create table oauth_transactions (
  token_hash text primary key, state text not null, nonce text not null,
  verifier text not null, expires_at timestamptz not null
);
grant select,insert,delete on oauth_transactions to hh_app;

create function google_login(p_subject text,p_email text,p_name text,p_authoritative boolean,p_hash text,p_csrf text)
returns uuid language plpgsql security definer set search_path=public as $$
declare u uuid; linked text;
begin
  perform pg_advisory_xact_lock(hashtextextended(lower(p_email),43));
  select id into u from users where google_subject=p_subject;
  if u is null then
    if (select count(*) from users where lower(email)=lower(p_email))>1 then
      raise exception 'Ambiguous account' using errcode='28000';
    end if;
    select id,google_subject into u,linked from users where lower(email)=lower(p_email) for update;
    if u is not null then
      if linked is not null or not p_authoritative then
        raise exception 'Account linking required' using errcode='28000';
      end if;
      update users set google_subject=p_subject where id=u;
    else
      insert into users(email,display_name,google_subject) values(lower(p_email),p_name,p_subject) returning id into u;
    end if;
  end if;
  delete from auth_sessions where expires_at<=now();
  insert into auth_sessions(token_hash,user_id,csrf_token,expires_at) values(p_hash,u,p_csrf,now()+interval '7 days');
  return u;
end $$;
create function login_session(p_hash text)
returns table(user_id uuid,email text,display_name text,csrf_token text)
language sql stable security definer set search_path=public as $$
  select u.id,u.email,u.display_name,s.csrf_token from auth_sessions s join users u on u.id=s.user_id where s.token_hash=p_hash and s.expires_at>now()
$$;
create function logout_session(p_hash text) returns void
language sql security definer set search_path=public as $$ delete from auth_sessions where token_hash=p_hash $$;
create function auth_memberships_by_user(p_user uuid)
returns table(user_id uuid,display_name text,household_id uuid,household_name text,role text)
language sql stable security definer set search_path=public as $$
  select u.id,u.display_name,h.id,h.name,hu.role from users u join household_users hu on hu.user_id=u.id join households h on h.id=hu.household_id where u.id=p_user
$$;
create function create_authenticated_household(p_hash text,p_name text,p_timezone text,p_units text)
returns uuid language plpgsql security definer set search_path=public as $$
declare u uuid; h uuid;
begin
  select user_id into u from auth_sessions where token_hash=p_hash and expires_at>now();
  if u is null then raise exception 'Sign in required' using errcode='28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,44));
  if exists(select 1 from household_users where user_id=u) then raise exception 'Account already has a household' using errcode='23505'; end if;
  if length(trim(p_name))=0 or p_units not in ('us','metric') then raise exception 'Invalid household' using errcode='22023'; end if;
  insert into households(name,timezone,unit_system) values(p_name,p_timezone,p_units) returning id into h;
  insert into household_users(household_id,user_id,role) values(h,u,'owner');return h;
end $$;
revoke all on function google_login(text,text,text,boolean,text,text),login_session(text),logout_session(text),auth_memberships_by_user(uuid),create_authenticated_household(text,text,text,text) from public;
grant execute on function google_login(text,text,text,boolean,text,text),login_session(text),logout_session(text),auth_memberships_by_user(uuid),create_authenticated_household(text,text,text,text) to hh_app;

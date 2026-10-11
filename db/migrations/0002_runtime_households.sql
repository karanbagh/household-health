-- Development-mode onboarding. The app role never needs an owner connection.
-- A new email can create its own household; existing users cannot claim another household.
create or replace function create_household(p_email text, p_display_name text, p_name text, p_timezone text, p_units text)
returns uuid language plpgsql security definer set search_path = public as $$
declare h uuid; u uuid;
begin
  if length(trim(p_email)) = 0 or length(trim(p_display_name)) = 0 or length(trim(p_name)) = 0 then
    raise exception 'Email, your name, and household name are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_email)), 43));
  if exists (select 1 from users where lower(email) = lower(trim(p_email))) then
    raise exception 'This email already has an account. Sign in instead.' using errcode = '23505';
  end if;
  insert into users(email, display_name) values(lower(trim(p_email)), trim(p_display_name)) returning id into u;
  insert into households(name, timezone, unit_system) values(trim(p_name), p_timezone, p_units) returning id into h;
  insert into household_users(household_id, user_id, role) values(h, u, 'owner');
  return h;
end $$;
revoke all on function create_household(text, text, text, text, text) from public;
grant execute on function create_household(text, text, text, text, text) to hh_app;

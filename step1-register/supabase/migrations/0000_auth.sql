-- The `auth` schema the policies use, on plain Postgres (Azure, local, PGlite). Idempotent, so it also runs on Supabase.
-- The API sets request.jwt.claim.sub to the signed-in user's id for each request.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    begin
      create role service_role nologin bypassrls;
    exception when insufficient_privilege then
      -- Azure's admin cannot grant BYPASSRLS. Workers then use the owner connection, which RLS does not restrict.
      create role service_role nologin;
    end;
  end if;
end $$;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;

-- The API's login switches to `authenticated` per request (set local role), so it must be a member of that role.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
    execute format('grant authenticated to %I', current_user);
  end if;
end $$;

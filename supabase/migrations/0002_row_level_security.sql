-- Project isolation at the database: a signed-in Supabase user (role "authenticated") only sees rows of the projects
-- they are a member of. The API server connects with the database owner / service role, which bypasses RLS and
-- applies the same membership rule itself. Writes are made only through the API (AI proposes, deterministic code
-- validates and writes), so "authenticated" gets read access only.

-- Outside Supabase (local Postgres, tests) provide the pieces Supabase normally has.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    create schema auth;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $f$
      create function auth.uid() returns uuid language sql stable as
      $b$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $b$
    $f$;
  end if;
end $$;

create function app_member_project_ids() returns setof uuid
  language sql stable security definer set search_path = public as
$$ select project_id from project_members where user_id = auth.uid() $$;

create function app_member_organization_ids() returns setof uuid
  language sql stable security definer set search_path = public as
$$ select distinct p.organization_id from project_members m join projects p on p.project_id = m.project_id where m.user_id = auth.uid() $$;

grant usage on schema public to authenticated;
grant execute on function app_member_project_ids(), app_member_organization_ids() to authenticated;

alter table organizations enable row level security;
alter table projects enable row level security;
alter table project_members enable row level security;
alter table work_packages enable row level security;
alter table cost_assignments enable row level security;
alter table units_of_measure enable row level security;
alter table item_definitions enable row level security;
alter table item_aliases enable row level security;
alter table boq_document_revisions enable row level security;
alter table boq_lines enable row level security;
alter table inventory_requirements enable row level security;
alter table requirement_boq_allocations enable row level security;
alter table audit_events enable row level security;

grant select on organizations, projects, project_members, work_packages, cost_assignments, units_of_measure,
  item_definitions, item_aliases, boq_document_revisions, boq_lines, inventory_requirements,
  requirement_boq_allocations, audit_events to authenticated;

create policy member_read on organizations for select to authenticated
  using (organization_id in (select app_member_organization_ids()));
create policy member_read on projects for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on project_members for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on work_packages for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on cost_assignments for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy any_read on units_of_measure for select to authenticated using (true);
create policy member_read on item_definitions for select to authenticated
  using (organization_id in (select app_member_organization_ids()));
create policy member_read on item_aliases for select to authenticated
  using (item_id in (select item_id from item_definitions));
create policy member_read on boq_document_revisions for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on boq_lines for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on inventory_requirements for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on requirement_boq_allocations for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on audit_events for select to authenticated
  using (project_id in (select app_member_project_ids()));

-- The register view runs with the caller's rights so the policies above apply through it.
alter view inventory_register set (security_invoker = true);
grant select on inventory_register to authenticated;

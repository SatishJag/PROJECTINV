-- =====================================================================
-- 0001_core_reference.sql
-- Organizations, memberships, projects, units of measure, UOM conversions.
--
-- Conventions (apply to every table in this project, created here or later):
--   * Immutable UUID primary keys (gen_random_uuid()).
--   * Shared audit fields: organization_id (where applicable), created_at,
--     updated_at, created_by, record_version.
--   * Serials, part numbers, supplier codes and Procore IDs are ADDITIONAL
--     identifiers - never substitutes for our primary keys.
--   * Procore IDs are stored as opaque text.
--   * Money/quantities use exact numerics: quantities numeric(19,6).
-- =====================================================================

create table public.organizations (
    organization_id   uuid primary key default gen_random_uuid(),
    name              text not null unique,
    status            text not null default 'active'
                      check (status in ('active','archived')),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    created_by        text,
    record_version    bigint not null default 1
);

comment on table public.organizations is
  'Top-level tenant. Every business row is org-scoped.';

------------------------------------------------------------------
-- Projects
------------------------------------------------------------------

create table public.projects (
    project_id          uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references public.organizations (organization_id),
    procore_company_id  text,
    procore_project_id  text,
    project_code        text,
    project_name        text not null,
    status              text not null default 'active'
                        check (status in ('active','closed','archived')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    created_by          text,
    record_version      bigint not null default 1,
    unique (organization_id, procore_company_id, procore_project_id)
);

comment on table public.projects is
  'Internal project identity mapped to Procore company/project IDs. '
  'Example: Bangkok Central 1. Procore IDs are opaque text; they never '
  'replace project_id as the key.';

------------------------------------------------------------------
-- Memberships: the basis of all RLS policies.
-- organization_memberships  -> visibility of org-level data
-- project_memberships       -> visibility of project-scoped data
-- Deletes are denied by policy (no members table rebuilds / no history wipe).
------------------------------------------------------------------

create table public.organization_memberships (
    organization_membership_id uuid primary key default gen_random_uuid(),
    organization_id            uuid not null references public.organizations (organization_id),
    user_id                    uuid not null references auth.users (id),
    role                       text not null default 'member'
                               check (role in ('owner','admin','member','viewer')),
    is_active                  boolean not null default true,
    created_at                 timestamptz not null default now(),
    updated_at                 timestamptz not null default now(),
    created_by                 text,
    record_version             bigint not null default 1,
    unique (organization_id, user_id)
);

create table public.project_memberships (
    project_membership_id uuid primary key default gen_random_uuid(),
    project_id            uuid not null references public.projects (project_id),
    user_id               uuid not null references auth.users (id),
    role                  text not null default 'member'
                          check (role in ('admin','engineer','procurement','finance','viewer')),
    is_active             boolean not null default true,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    created_by            text,
    record_version        bigint not null default 1,
    unique (project_id, user_id)
);

------------------------------------------------------------------
-- Units of measure and controlled conversions.
-- Source UOM is always preserved; conversions are evidence-based,
-- dimension-checked, and never inferred (mm2 is never a quantity unit;
-- one lot is never converted to an invented item count).
------------------------------------------------------------------

create table public.units_of_measure (
    uom_id                uuid primary key default gen_random_uuid(),
    organization_id       uuid not null references public.organizations (organization_id),
    code                  text not null,
    name                  text not null,
    measurement_dimension text not null,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    created_by            text,
    record_version        bigint not null default 1,
    unique (organization_id, code)
);

create table public.uom_conversions (
    conversion_id      uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    from_uom_id        uuid not null references public.units_of_measure (uom_id),
    to_uom_id          uuid not null references public.units_of_measure (uom_id),
    factor             numeric(28,12) not null check (factor > 0),
    evidence_reference text,
    approval_reference text,
    valid_from         timestamptz not null default now(),
    valid_until        timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    unique (organization_id, from_uom_id, to_uom_id)
);

comment on table public.uom_conversions is
  'Controlled UOM conversion table. A conversion is only valid within one '
  'measurement dimension (enforced by trigger). Factor multiplies the '
  'from-quantity to obtain the to-quantity.';

-- Enforce same measurement dimension for both sides of a conversion.
create or replace function public.enforce_uom_dimension()
returns trigger language plpgsql as $$
declare
    v_from text;
    v_to   text;
begin
    select measurement_dimension into v_from
      from public.units_of_measure where uom_id = new.from_uom_id;
    select measurement_dimension into v_to
      from public.units_of_measure where uom_id = new.to_uom_id;
    if v_from is distinct from v_to then
        raise exception 'UOM conversion must stay within one measurement dimension (%) vs (%)',
            v_from, v_to;
    end if;
    return new;
end $$;

create trigger uom_conversions_dimension
    before insert or update on public.uom_conversions
    for each row execute function public.enforce_uom_dimension();

------------------------------------------------------------------
-- Shared audit trigger: updated_at + record_version bump on update.
------------------------------------------------------------------

create or replace function public.maintain_audit()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    if tg_op = 'UPDATE' then
        new.record_version := old.record_version + 1;
    end if;
    return new;
end $$;

do $$
declare t text;
begin
    foreach t in array array[
        'organizations',
        'organization_memberships',
        'project_memberships',
        'projects',
        'units_of_measure',
        'uom_conversions'
    ] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

------------------------------------------------------------------
-- RLS helpers and policies.
--
-- Every business table is exposed to authenticated users only through
-- their org or project membership. DELETE is denied by default on all
-- business tables (history is never silently removed); use status
-- transitions instead. The Supabase service_role (workers/adapters)
-- bypasses RLS by design and is granted explicitly in adapters.
--
-- Security-definer helper functions avoid per-table recursive checks.
------------------------------------------------------------------

create or replace function public.current_org_ids()
returns setof uuid
language sql stable security definer
set search_path = public, auth
as $$
    select organization_id
      from public.organization_memberships
     where user_id = auth.uid() and is_active
$$;

create or replace function public.current_project_ids()
returns setof uuid
language sql stable security definer
set search_path = public, auth
as $$
    select project_id
      from public.project_memberships
     where user_id = auth.uid() and is_active
$$;

revoke execute on function public.current_org_ids() from anon;
revoke execute on function public.current_project_ids() from anon;

-- --- organizations -------------------------------------------------
alter table public.organizations enable row level security;
create policy organizations_select on public.organizations
    for select using (organization_id in (select current_org_ids()));
create policy organizations_insert on public.organizations
    for insert with check (created_by = auth.uid()::text);

-- --- members of an org manage their own membership rows ------------
alter table public.organization_memberships enable row level security;
create policy organization_memberships_select on public.organization_memberships
    for select using (organization_id in (select current_org_ids()));
create policy organization_memberships_admin on public.organization_memberships
    for all using (
        user_id = auth.uid()
        or organization_id in (
            select organization_id from public.organization_memberships
             where user_id = auth.uid() and role = 'owner' and is_active
        )
    ) with check (
        organization_id in (
            select organization_id from public.organization_memberships
             where user_id = auth.uid() and role = 'owner' and is_active
        )
    );

-- --- project memberships -------------------------------------------
alter table public.project_memberships enable row level security;
create policy project_memberships_select on public.project_memberships
    for select using (
        user_id = auth.uid()
        or project_id in (select current_project_ids())
    );
create policy project_memberships_admin on public.project_memberships
    for all using (
        project_id in (
            select pm.project_id from public.project_memberships pm
            join public.organization_memberships om on om.organization_id =
                (select p.organization_id from public.projects p
                  where p.project_id = pm.project_id)
             where om.user_id = auth.uid() and om.role in ('owner','admin') and om.is_active
        )
    ) with check (
        project_id in (
            select pm.project_id from public.project_memberships pm
            join public.organization_memberships om on om.organization_id =
                (select p.organization_id from public.projects p
                  where p.project_id = pm.project_id)
             where om.user_id = auth.uid() and om.role in ('owner','admin') and om.is_active
        )
    );

-- --- projects --------------------------------------------------------
alter table public.projects enable row level security;
create policy projects_select on public.projects
    for select using (organization_id in (select current_org_ids()));
create policy projects_insert on public.projects
    for insert with check (organization_id in (select current_org_ids()));
create policy projects_update on public.projects
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

-- --- units_of_measure / uom_conversions ------------------------------
alter table public.units_of_measure enable row level security;
create policy uom_select on public.units_of_measure
    for select using (organization_id in (select current_org_ids()));
create policy uom_insert on public.units_of_measure
    for insert with check (organization_id in (select current_org_ids()));
create policy uom_update on public.units_of_measure
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.uom_conversions enable row level security;
create policy uom_conv_select on public.uom_conversions
    for select using (organization_id in (select current_org_ids()));
create policy uom_conv_insert on public.uom_conversions
    for insert with check (organization_id in (select current_org_ids()));
create policy uom_conv_update on public.uom_conversions
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

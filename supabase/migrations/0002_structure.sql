-- =====================================================================
-- 0002_structure.sql
-- Project WBS work packages and Procore cost assignments.
--
-- The defining relationship of Step 1:
--   project -> work package -> approved cost assignment -> BOQ line -> item
--
-- PROJECT-CONSISTENCY RULE
-- Every project-scoped row carries project_id. Child rows use composite
-- foreign keys of the form (project_id, <parent_key>) where the parent
-- table declares a matching unique constraint. This makes it impossible
-- for a Bangkok Central 1 record to reference a Bangkok Central 2 parent -
-- the database rejects it, not the screen filter.
-- =====================================================================

------------------------------------------------------------------
-- Work packages: project-specific WBS hierarchy / equipment packages.
-- NOT a mapping to Procore's timekeeping "Task Code".
------------------------------------------------------------------

create table public.work_packages (
    work_package_id       uuid primary key default gen_random_uuid(),
    project_id            uuid not null references public.projects (project_id),
    parent_work_package_id uuid references public.work_packages (work_package_id),
    source_wbs_reference  text,
    code                  text not null,
    name                  text not null,
    status                text not null default 'active'
                          check (status in ('draft','active','inactive','archived')),
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    created_by            text,
    record_version        bigint not null default 1,
    unique (project_id, code),
    unique (project_id, work_package_id)   -- enables composite FKs from children
);

comment on table public.work_packages is
  'Project-level WBS equipment work packages (e.g. Chiller, UPS, '
  'Transformer, Generator). source_wbs_reference retains the Procore/'
  'source-system reference where one exists.';

-- Prevent a child package from pointing at a parent in another project,
-- and prevent self-parenting.
create or replace function public.enforce_work_package_scope()
returns trigger language plpgsql as $$
declare
    v_parent_project uuid;
begin
    if new.parent_work_package_id is null then
        return new;
    end if;
    if new.parent_work_package_id = new.work_package_id then
        raise exception 'work package cannot be its own parent';
    end if;
    select project_id into v_parent_project
      from public.work_packages
     where work_package_id = new.parent_work_package_id;
    if v_parent_project is distinct from new.project_id then
        raise exception 'parent work package belongs to a different project';
    end if;
    return new;
end $$;

create trigger work_packages_scope
    before insert or update on public.work_packages
    for each row execute function public.enforce_work_package_scope();

------------------------------------------------------------------
-- Cost assignments: APPROVED mapping between a work package and the
-- full Procore budget-code context (cost code + cost type + other
-- configured segments). Cost code alone does not identify the package.
------------------------------------------------------------------

create table public.cost_assignments (
    cost_assignment_id     uuid primary key default gen_random_uuid(),
    project_id             uuid not null references public.projects (project_id),
    work_package_id        uuid not null,
    procore_budget_code_id text,
    cost_code              text not null,
    cost_type              text,
    status                 text not null default 'approved'
                           check (status in ('draft','approved','superseded','cancelled')),
    valid_from             timestamptz not null default now(),
    valid_until            timestamptz,
    -- full configured budget-code segment context retained verbatim
    segment_context        jsonb,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    created_by             text,
    record_version         bigint not null default 1,
    -- composite FK: the work package must belong to the same project
    constraint cost_assignment_work_package_same_project
        foreign key (project_id, work_package_id)
        references public.work_packages (project_id, work_package_id),
    unique (project_id, work_package_id)   -- enables composite FKs from children
);

comment on table public.cost_assignments is
  'Approved work-package to Procore budget-code mapping. segment_context '
  'keeps all configured fiscal-period segments verbatim. A new approval '
  'supersedes the prior row (supersede, never overwrite).';

-- Normalized segments for the configured budget-code structure.
create table public.cost_code_segments (
    cost_code_segment_id uuid primary key default gen_random_uuid(),
    organization_id      uuid not null references public.organizations (organization_id),
    project_id           uuid not null references public.projects (project_id),
    cost_assignment_id   uuid not null,
    segment_name         text not null,
    segment_value        text not null,
    segment_position     integer not null default 0,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    created_by           text,
    record_version       bigint not null default 1,
    constraint cost_segment_same_project
        foreign key (project_id, cost_assignment_id)
        references public.cost_assignments (project_id, cost_assignment_id),
    unique (project_id, cost_assignment_id, segment_name)
);

comment on table public.cost_code_segments is
  'Normalized segments of the Procore budget code (cost code, cost type, '
  'and tenant-configured segments). segment_context (JSONB) on the parent '
  'holds unconfigured extras verbatim.';

do $$
declare t text;
begin
    foreach t in array array['work_packages','cost_assignments','cost_code_segments'] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

------------------------------------------------------------------
-- RLS: all three tables are project-scoped.
------------------------------------------------------------------

alter table public.work_packages enable row level security;
create policy work_packages_select on public.work_packages
    for select using (project_id in (select current_project_ids()));
create policy work_packages_insert on public.work_packages
    for insert with check (project_id in (select current_project_ids()));
create policy work_packages_update on public.work_packages
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.cost_assignments enable row level security;
create policy cost_assignments_select on public.cost_assignments
    for select using (project_id in (select current_project_ids()));
create policy cost_assignments_insert on public.cost_assignments
    for insert with check (project_id in (select current_project_ids()));
create policy cost_assignments_update on public.cost_assignments
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.cost_code_segments enable row level security;
create policy cost_code_segments_select on public.cost_code_segments
    for select using (project_id in (select current_project_ids()));
create policy cost_code_segments_insert on public.cost_code_segments
    for insert with check (project_id in (select current_project_ids()));
create policy cost_code_segments_update on public.cost_code_segments
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

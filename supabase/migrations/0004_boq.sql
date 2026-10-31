-- =====================================================================
-- 0004_boq.sql
-- BOQ document revisions, extracted lines, the project inventory
-- register, and BOQ-line allocations.
--
-- KEY DISTINCTION: BOQ quantity is the REQUIRED quantity. Ordered
-- quantity is a separate matter (0005) and stays unknown until purchase
-- evidence exists. Reading a BOQ never implies purchase or receipt.
--
-- IDEMPOTENCY: reprocessing the same document revision must not
-- duplicate quantities (unique revision key + file hash + line locator).
-- A revised BOQ preserves previous revisions; current quantities derive
-- ONLY from the accepted revision's allocations.
--
-- ALLOCATIONS: one BOQ line may serve several work packages and several
-- source lines may contribute to one requirement. Allocation quantities
-- must reconcile to the source line - the full quantity is NEVER copied
-- into each package.
-- =====================================================================

------------------------------------------------------------------
-- BOQ document revisions
------------------------------------------------------------------

create table public.boq_document_revisions (
    boq_revision_id     uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references public.organizations (organization_id),
    project_id          uuid not null,
    source_tool         text not null default 'procore'
                        check (source_tool in ('procore','upload','other')),
    procore_document_id text,
    source_revision     text,
    file_hash           text not null,
    source_file_name    text,
    document_status     text not null default 'received'
                        check (document_status in ('received','duplicate','accepted','superseded','cancelled')),
    processing_status   text not null default 'pending'
                        check (processing_status in ('pending','processing','processed','failed')),
    submitted_by        text,
    submitted_at        timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    created_by          text,
    record_version      bigint not null default 1,
    constraint boq_rev_same_project
        foreign key (project_id) references public.projects (project_id),
    -- idempotent reprocessing: one accepted record per document revision
    unique (project_id, source_tool, procore_document_id, source_revision)
);

comment on table public.boq_document_revisions is
  'Source BOQ document revision. A re-import with the same revision key '
  'resolves here (duplicate) and never duplicates quantities. If the '
  'project context conflicts with the file content, flag it - never '
  'silently re-attribute. Source file (in evidence storage) is immutable.';

------------------------------------------------------------------
-- Extracted BOQ lines (raw source rows; normalized identities live in
-- inventory_requirements and allocations).
------------------------------------------------------------------

create table public.boq_lines (
    boq_line_id            uuid primary key default gen_random_uuid(),
    organization_id        uuid not null references public.organizations (organization_id),
    project_id             uuid not null,
    boq_revision_id        uuid not null,
    parent_source_line_id  uuid references public.boq_lines (boq_line_id),
    line_no                integer,
    source_locator         text not null,       -- sheet/row reference or PDF page
    line_type              text not null default 'item'
                           check (line_type in ('item','heading','subtotal','note')),
    raw_description        text,
    raw_item_code          text,
    raw_quantity           numeric(19,6),
    raw_uom                text,
    -- normalized values (validated, not yet attributed)
    normalized_uom_id      uuid references public.units_of_measure (uom_id),
    normalized_quantity    numeric(19,6),
    stated_wbs_reference   text,
    stated_cost_code       text,
    validation_status      text not null default 'pending'
                           check (validation_status in ('pending','valid','ambiguous','rejected')),
    validation_notes       text,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    created_by             text,
    record_version         bigint not null default 1,
    constraint boq_line_same_project
        foreign key (project_id, boq_revision_id)
        references public.boq_document_revisions (project_id, boq_revision_id),
    -- headings/subtotals are NOT inventory items (A6)
    constraint boq_line_item_has_checks
        check (line_type <> 'item' or raw_description is not null),
    unique (boq_revision_id, source_locator)
);

comment on table public.boq_lines is
  'Extracted source line with document location for full traceability '
  '(every accepted record opens back to sheet/row or PDF page). Heading '
  'and subtotal rows are retained for reconciliation but excluded from '
  'the register by line_type.';

-- unique pair needed for composite FKs from the register layer
alter table public.boq_lines
    add constraint boq_lines_project_line_unique unique (project_id, boq_line_id);

------------------------------------------------------------------
-- Project inventory requirement (the register row): project,
-- work package, approved cost assignment, item, UOM.
-- Quantities are NEVER stored on this row - they derive from its
-- allocations in the accepted revision.
------------------------------------------------------------------

create table public.inventory_requirements (
    inventory_record_id   uuid primary key default gen_random_uuid(),
    organization_id       uuid not null references public.organizations (organization_id),
    project_id            uuid not null,
    work_package_id       uuid not null,
    cost_assignment_id    uuid not null,
    item_id               uuid not null,
    uom_id                uuid not null references public.units_of_measure (uom_id),
    status                text not null default 'active'
                          check (status in ('draft','active','superseded','cancelled')),
    -- retained source snapshots (per the register spec)
    item_description      text,
    specification         text,
    original_uom          text,
    normalized_uom        text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    created_by            text,
    record_version        bigint not null default 1,
    -- the database must prevent cross-project references (A7):
    constraint req_same_project_work_package
        foreign key (project_id, work_package_id)
        references public.work_packages (project_id, work_package_id),
    constraint req_same_project_cost_assignment
        foreign key (project_id, cost_assignment_id)
        references public.cost_assignments (project_id, cost_assignment_id),
    unique (project_id, work_package_id, cost_assignment_id, item_id, uom_id, status)
);

comment on table public.inventory_requirements is
  'The accepted relationship: project x work package x cost assignment x '
  'item x UOM. Item ID identifies the definition; inventory record ID '
  'identifies this specific project/package/BOQ-line relationship. A '
  'shared item definition never combines project quantities (A8). '
  'boq_quantity is derived via allocations, never stored here; '
  'ordered_quantity is separately unknown until purchase evidence (0005).';

------------------------------------------------------------------
-- Requirement <-> BOQ line allocations (both directions preserved).
------------------------------------------------------------------

create table public.requirement_boq_allocations (
    allocation_id      uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    project_id         uuid not null,
    inventory_record_id uuid not null,
    boq_line_id        uuid not null,
    allocated_quantity numeric(19,6) not null check (allocated_quantity <> 0),
    uom_id             uuid not null references public.units_of_measure (uom_id),
    approval_status    text not null default 'proposed'
                       check (approval_status in ('proposed','approved','rejected')),
    approval_reference text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    constraint alloc_same_project_req
        foreign key (project_id, inventory_record_id)
        references public.inventory_requirements (project_id, inventory_record_id),
    constraint alloc_same_project_line
        foreign key (project_id, boq_line_id)
        references public.boq_lines (project_id, boq_line_id),
    unique (inventory_record_id, boq_line_id)
);

comment on table public.requirement_boq_allocations is
  'Explicit allocation of a source BOQ line quantity to a project '
  'requirement. Multi-package lines create several allocations whose sum '
  'reconciles to the source line - full quantity is never duplicated '
  'into each work package (A4).';

-- Requirement <-> BOQ line allocations (both directions preserved),
-- versioned rather than duplicated on re-import.
------------------------------------------------------------------

------------------------------------------------------------------
-- Derived quantities: ONLY from the accepted revision (A3).
------------------------------------------------------------------

create view public.current_boq_quantities as
select
    ar.inventory_record_id,
    sum(ar.allocated_quantity) as accepted_boq_quantity,
    min(r.source_revision)     as source_revision
from public.requirement_boq_allocations ar
join public.boq_lines bl on bl.boq_line_id = ar.boq_line_id
join public.boq_document_revisions r on r.boq_revision_id = bl.boq_revision_id
where r.document_status = 'accepted'
  and r.processing_status = 'processed'
  and bl.validation_status = 'valid'
  and bl.line_type = 'item'
  and ar.approval_status = 'approved'
group by ar.inventory_record_id;

comment on view public.current_boq_quantities is
  'Current required quantity per requirement, derived from allocations '
  'in the accepted BOQ revision. Summing across revisions is prohibited: '
  'new revisions supersede - they are never added (A3).';

do $$
declare t text;
begin
    foreach t in array array[
        'boq_document_revisions','boq_lines',
        'inventory_requirements','requirement_boq_allocations'
    ] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

------------------------------------------------------------------
-- Useful indexes
------------------------------------------------------------------

create index idx_boq_lines_revision        on public.boq_lines (boq_revision_id);
create index idx_boq_lines_validation      on public.boq_lines (boq_revision_id, validation_status);
create index idx_alloc_requirement         on public.requirement_boq_allocations (inventory_record_id);
create index idx_alloc_line                on public.requirement_boq_allocations (boq_line_id);
create index idx_req_project               on public.inventory_requirements (project_id, work_package_id);

------------------------------------------------------------------
-- RLS (project-scoped)
------------------------------------------------------------------

alter table public.boq_document_revisions enable row level security;
create policy boq_rev_select on public.boq_document_revisions
    for select using (project_id in (select current_project_ids()));
create policy boq_rev_insert on public.boq_document_revisions
    for insert with check (project_id in (select current_project_ids()));
create policy boq_rev_update on public.boq_document_revisions
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.boq_lines enable row level security;
create policy boq_lines_select on public.boq_lines
    for select using (project_id in (select current_project_ids()));
create policy boq_lines_insert on public.boq_lines
    for insert with check (project_id in (select current_project_ids()));
create policy boq_lines_update on public.boq_lines
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));
create policy boq_lines_delete on public.boq_lines
    for delete using (
        validation_status in ('pending','rejected')   -- raw extraction rows may be cleared; validated lines are not deleted
    );

alter table public.inventory_requirements enable row level security;
create policy req_select on public.inventory_requirements
    for select using (project_id in (select current_project_ids()));
create policy req_insert on public.inventory_requirements
    for insert with check (project_id in (select current_project_ids()));
create policy req_update on public.inventory_requirements
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.requirement_boq_allocations enable row level security;
create policy alloc_select on public.requirement_boq_allocations
    for select using (project_id in (select current_project_ids()));
create policy alloc_insert on public.requirement_boq_allocations
    for insert with check (project_id in (select current_project_ids()));
create policy alloc_update on public.requirement_boq_allocations
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

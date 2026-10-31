-- =====================================================================
-- 0005_commitments.sql
-- Suppliers and purchase commitments (ordered quantity evidence).
-- Created now, ACTIVE in Step 2.
--
-- RULES ENCODED:
--   * ordered_quantity is populated ONLY from purchase evidence.
--   * Lump-sum commitments with no reliable item quantity leave
--     ordered_quantity NULL - it is never calculated from the amount.
--   * The LDC submitting a BOQ is not automatically the equipment
--     supplier; supplier attribution comes from purchase evidence.
--   * Split purchasing both ways: one requirement via several
--     commitments; one commitment line covering several requirements.
--   * Procore commitment/line resource fields must be validated against
--     the tenant BEFORE implementing the adapter (discovery dependency).
-- =====================================================================

create table public.suppliers (
    supplier_id        uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    procore_vendor_id  text,
    supplier_code      text,
    legal_name         text not null,
    status             text not null default 'active'
                       check (status in ('active','inactive','blocked')),
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    unique (organization_id, supplier_code)
);

comment on table public.suppliers is
  'Commercial supplier identity. Procore vendor ID is an additional '
  'identifier, never the key. Supplier attribution is set by purchase '
  'evidence only - never inferred from a BOQ submission.';

create table public.commitments (
    commitment_id         uuid primary key default gen_random_uuid(),
    organization_id       uuid not null references public.organizations (organization_id),
    project_id            uuid not null,
    procore_commitment_id text,
    commitment_type       text not null
                          check (commitment_type in
                            ('purchase_order','subcontract','other')),
    commitment_number     text not null,
    supplier_id           uuid references public.suppliers (supplier_id),
    status                text not null default 'active'
                          check (status in ('draft','active','closed','superseded','cancelled')),
    source_revision       text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    created_by            text,
    record_version        bigint not null default 1,
    constraint commitment_same_project
        foreign key (project_id) references public.projects (project_id),
    unique (project_id, procore_commitment_id)
);

comment on table public.commitments is
  'Authoritative purchase evidence source. Revisions append with '
  'source_revision; commitment history is preserved.';

create table public.commitment_lines (
    commitment_line_id  uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references public.organizations (organization_id),
    project_id          uuid not null,
    commitment_id       uuid not null,
    procore_line_id     text,
    description         text,
    item_id             uuid references public.item_definitions (item_id),  -- NULL where unresolved
    ordered_quantity    numeric(19,6),                                      -- NULL => unknown, never invented
    uom_id              uuid references public.units_of_measure (uom_id),
    line_type           text not null default 'material'
                        check (line_type in ('material','lump_sum','service','other')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    created_by          text,
    record_version      bigint not null default 1,
    constraint line_same_project_commitment
        foreign key (project_id, commitment_id)
        references public.commitments (project_id, commitment_id),
    -- rule: lump-sum lines carry no invented item quantity (A10)
    constraint lump_sum_no_quantity
        check (line_type <> 'lump_sum' or ordered_quantity is null),
    -- a quantity, when present, must be defined in a UOM
    constraint quantity_needs_uom
        check (ordered_quantity is null or uom_id is not null),
    unique (project_id, commitment_id, procore_line_id)
);

comment on table public.commitment_lines is
  'Commitment line item. ordered_quantity is the ordered-quantity field '
  'of the project register: unknown until supported by purchase evidence.';

create table public.requirement_commitment_allocations (
    allocation_id       uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references public.organizations (organization_id),
    project_id          uuid not null,
    inventory_record_id uuid not null,
    commitment_line_id  uuid not null,
    allocated_quantity  numeric(19,6) not null check (allocated_quantity <> 0),
    uom_id              uuid not null references public.units_of_measure (uom_id),
    status              text not null default 'active'
                        check (status in ('draft','active','superseded','cancelled')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    created_by          text,
    record_version      bigint not null default 1,
    constraint alloc_same_project_req
        foreign key (project_id, inventory_record_id)
        references public.inventory_requirements (project_id, inventory_record_id),
    constraint alloc_same_project_line
        foreign key (project_id, commitment_line_id)
        references public.commitment_lines (project_id, commitment_line_id),
    unique (inventory_record_id, commitment_line_id)
);

comment on table public.requirement_commitment_allocations is
  'Requirement-to-purchase allocation: the engagement between BOQ-derived '
  'need and ordered evidence. Quantities reconcile; nothing is implied.';

create view public.current_ordered_quantities as
select
    a.inventory_record_id,
    sum(a.allocated_quantity) as ordered_quantity
from public.requirement_commitment_allocations a
join public.commitment_lines cl on cl.commitment_line_id = a.commitment_line_id
join public.commitments cm on cm.commitment_id = cl.commitment_id
where cm.status = 'active'
  and a.status = 'active'
group by a.inventory_record_id;

comment on view public.current_ordered_quantities is
  'Ordered quantity per requirement, derived only from active '
  'commitment allocations in active commitments. NULL/absent = unknown, '
  'not zero.';

do $$
declare t text;
begin
    foreach t in array array[
        'suppliers','commitments','commitment_lines',
        'requirement_commitment_allocations'
    ] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

create index idx_commitments_project   on public.commitments (project_id);
create index idx_commit_lines_commit   on public.commitment_lines (commitment_id);
create index idx_alloc_commit_req      on public.requirement_commitment_allocations (inventory_record_id);

------------------------------------------------------------------
-- RLS
------------------------------------------------------------------

alter table public.suppliers enable row level security;
create policy suppliers_select on public.suppliers
    for select using (organization_id in (select current_org_ids()));
create policy suppliers_insert on public.suppliers
    for insert with check (organization_id in (select current_org_ids()));
create policy suppliers_update on public.suppliers
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.commitments enable row level security;
create policy commitments_select on public.commitments
    for select using (project_id in (select current_project_ids()));
create policy commitments_insert on public.commitments
    for insert with check (project_id in (select current_project_ids()));
create policy commitments_update on public.commitments
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.commitment_lines enable row level security;
create policy commitment_lines_select on public.commitment_lines
    for select using (project_id in (select current_project_ids()));
create policy commitment_lines_insert on public.commitment_lines
    for insert with check (project_id in (select current_project_ids()));
create policy commitment_lines_update on public.commitment_lines
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.requirement_commitment_allocations enable row level security;
create policy rc_alloc_select on public.requirement_commitment_allocations
    for select using (project_id in (select current_project_ids()));
create policy rc_alloc_insert on public.requirement_commitment_allocations
    for insert with check (project_id in (select current_project_ids()));
create policy rc_alloc_update on public.requirement_commitment_allocations
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

-- =====================================================================
-- 0006_physical.sql
-- Physical identity layer: asset units, expected assembly, actual
-- installation history, supply provenance.
-- Created now, ACTIVE in later steps.
--
-- IDENTITY RULES:
--   * Physical unit = one particular serialized instance (GS-9841),
--     set apart from the item definition (G100) and from the project
--     requirement (why it was bought).
--   * Same repaired serial KEEPS its unit ID; a replaced unit gets a
--     NEW unit ID; unit IDs are never recycled.
--   * Serial uniqueness is enforced only within a verified
--     manufacturer/model namespace, not globally.
--   * tracking_mode-aware: batch/lot items (e.g. oil) do not receive
--     fabricated serial children; bulk materials stay lot/quantity-based.
--
-- STRUCTURE RULES:
--   * Expected assembly (assembly_definitions) is separate from what
--     was actually installed (installation_history).
--   * BOQ indentation does not prove physical assembly membership.
--   * At most one physical parent per component at any instant and no
--     conflict per (parent, slot) at any instant - enforced with
--     temporal exclusion constraints over FULL intervals.
-- =====================================================================

------------------------------------------------------------------
-- Asset units: individual physical instances.
------------------------------------------------------------------

create table public.asset_units (
    asset_unit_id            uuid primary key default gen_random_uuid(),
    organization_id          uuid not null references public.organizations (organization_id),
    item_id                  uuid not null references public.item_definitions (item_id),
    origin_inventory_record_id uuid references public.inventory_requirements (inventory_record_id),
    serial_number            text,
    lifecycle_status         text not null default 'planned'
                             check (lifecycle_status in
                               ('planned','ordered','received','installed','in_service',
                                'under_repair','spare','transferred','retired','scrapped')),
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),
    created_by               text,
    record_version           bigint not null default 1,
    unique (organization_id, asset_unit_id)   -- enables composite org-consistent FKs
);

comment on table public.asset_units is
  'One physical unit with persistent identity through receipt, '
  'installation, repair, transfer and retirement. Serial is an '
  'additional identifier.';

-- Serial uniqueness only within a verified manufacturer/model namespace.
-- Implemented as a namespace ref (company + brand + model + spec revision)
-- extracted from the item definition; empty namespace = no constraint.
create table public.item_definitions_serial_namespaces (
    namespace_id            uuid primary key default gen_random_uuid(),
    organization_id         uuid not null references public.organizations (organization_id),
    item_id                 uuid not null,
    namespace_key           text not null,     -- verified manufacturer/model/spec realm
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    created_by              text,
    record_version          bigint not null default 1,
    constraint ns_same_item
        foreign key (organization_id, item_id)
        references public.item_definitions (organization_id, item_id),
    unique (organization_id, item_id, namespace_key)
);

comment on table public.item_definitions_serial_namespaces is
  'The verified realm within which serials are unique. Populated only '
  'after verification, never from raw extraction.';

create table public.asset_unit_serial_bindings (
    binding_id        uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references public.organizations (organization_id),
    asset_unit_id     uuid not null,
    namespace_id      uuid not null,
    serial_number     text not null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    created_by        text,
    record_version    bigint not null default 1,
    constraint binding_same_unit
        foreign key (asset_unit_id) references public.asset_units (asset_unit_id),
    constraint binding_same_namespace
        foreign key (namespace_id)
        references public.item_definitions_serial_namespaces (namespace_id),
    constraint binding_org_match
        foreign key (organization_id, namespace_id)
        references public.item_definitions_serial_namespaces
            (organization_id, namespace_id),
    unique (namespace_id, serial_number)
);

comment on table public.asset_unit_serial_bindings is
  'A serial becomes unique ONLY within its verified namespace '
  '(unique(namespace_id, serial_number)) - the doc rule enforced.';

------------------------------------------------------------------
-- Expected assembly (per item definition): what SHOULD be inside.
------------------------------------------------------------------

create table public.assembly_definitions (
    assembly_line_id    uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references public.organizations (organization_id),
    parent_item_id      uuid not null,
    child_item_id       uuid not null,
    slot_code           text not null,
    quantity_per_parent numeric(19,6) not null check (quantity_per_parent > 0),
    uom_id              uuid not null references public.units_of_measure (uom_id),
    revision            integer not null default 1,
    relationship_type   text not null default 'component'
                        check (relationship_type in ('component','accessory','consumable','work')),
    valid_from          timestamptz not null default now(),
    valid_until         timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    created_by          text,
    record_version      bigint not null default 1,
    constraint parent_item_same_org
        foreign key (organization_id, parent_item_id)
        references public.item_definitions (organization_id, item_id),
    constraint child_item_same_org
        foreign key (organization_id, child_item_id)
        references public.item_definitions (organization_id, item_id),
    unique (organization_id, parent_item_id, slot_code, revision)
    -- BOQ indentation is NOT input here; mapping requires approval evidence
);

comment on table public.assembly_definitions is
  'Expected structure of an item (e.g. generator G100 contains one '
  'breaker BR in slot CTRL-1). Created/edited only with approved '
  'engineering evidence - never derived from BOQ indentation.';

------------------------------------------------------------------
-- Actual installation history: what IS installed, when.
------------------------------------------------------------------

create table public.installation_history (
    installation_id      uuid primary key default gen_random_uuid(),
    organization_id      uuid not null references public.organizations (organization_id),
    parent_asset_unit_id uuid not null,
    child_asset_unit_id  uuid not null,
    slot_code            text not null,
    installed_at         timestamptz not null,
    removed_at           timestamptz,
    reason               text check (reason in ('initial','replacement','maintenance','transfer','other')),
    evidence_reference   text,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    created_by           text,
    record_version       bigint not null default 1,
    constraint install_units_same_org
        foreign key (organization_id, parent_asset_unit_id)
        references public.asset_units (organization_id, asset_unit_id),
    constraint install_units_same_org_child
        foreign key (organization_id, child_asset_unit_id)
        references public.asset_units (organization_id, asset_unit_id)
);

-- Full-interval overlap prevention (not open-rows-only):
-- a child can have at most ONE installed parent at any instant,
-- and a (parent, slot) pair is occupied by at most one child at any time.
alter table public.installation_history
    add constraint ih_child_unique_parent
    exclude using gist (
        child_asset_unit_id with =,
        tstzrange(installed_at, coalesce(removed_at, 'infinity'), '[)') with &&
    );

alter table public.installation_history
    add constraint ih_slot_occupied
    exclude using gist (
        parent_asset_unit_id with =,
        slot_code with =,
        tstzrange(installed_at, coalesce(removed_at, 'infinity'), '[)') with &&
    );

comment on table public.installation_history is
  'Actual structure over time. Breaker BR-2107 removed => its row gets '
  'removed_at; replacement BR-3820 gets its own unit and row; original '
  'history remains intact. Cycles prevented by the two exclusion rules '
  'plus app-level graph checks.';

------------------------------------------------------------------
-- Supply provenance: where a unit came from (commitment/supplier).
------------------------------------------------------------------

create table public.asset_supply_links (
    supply_link_id       uuid primary key default gen_random_uuid(),
    organization_id      uuid not null references public.organizations (organization_id),
    asset_unit_id        uuid not null,
    commitment_line_id   uuid,
    supplier_id          uuid references public.suppliers (supplier_id),
    manufacturer_id      uuid references public.suppliers (supplier_id),
    supply_role          text not null default 'seller'
                         check (supply_role in ('seller','manufacturer','installer','maintainer','other')),
    supplied_with_asset_id uuid references public.asset_units (asset_unit_id),
    evidence_reference   text,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    created_by           text,
    record_version       bigint not null default 1,
    constraint link_same_unit
        foreign key (asset_unit_id) references public.asset_units (asset_unit_id),
    constraint link_same_commitment_line
        foreign key (commitment_line_id)
        references public.commitment_lines (commitment_line_id)
);

comment on table public.asset_supply_links is
  'Commercial supplier, component manufacturer, installer and maintainer '
  'are preserved SEPARATELY (they may be different organizations). One '
  'row per supply role. Traced chain for Step 3: failed component -> '
  'installation -> project -> supply evidence -> commitment -> supplier.';

do $$
declare t text;
begin
    foreach t in array array[
        'asset_units','item_definitions_serial_namespaces',
        'asset_unit_serial_bindings','assembly_definitions',
        'installation_history','asset_supply_links'
    ] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

create index idx_units_item        on public.asset_units (item_id);
create index idx_units_serial      on public.asset_units (serial_number);
create index idx_install_parent    on public.installation_history (parent_asset_unit_id);
create index idx_install_child     on public.installation_history (child_asset_unit_id);

------------------------------------------------------------------
-- RLS: physical identity is org-scoped (identity persists across
-- project transfers per the PRD); provenance links likewise.
------------------------------------------------------------------

alter table public.asset_units enable row level security;
create policy asset_units_select on public.asset_units
    for select using (organization_id in (select current_org_ids()));
create policy asset_units_insert on public.asset_units
    for insert with check (organization_id in (select current_org_ids()));
create policy asset_units_update on public.asset_units
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.item_definitions_serial_namespaces enable row level security;
create policy sn_select on public.item_definitions_serial_namespaces
    for select using (organization_id in (select current_org_ids()));
create policy sn_insert on public.item_definitions_serial_namespaces
    for insert with check (organization_id in (select current_org_ids()));
create policy sn_update on public.item_definitions_serial_namespaces
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.asset_unit_serial_bindings enable row level security;
create policy sb_select on public.asset_unit_serial_bindings
    for select using (organization_id in (select current_org_ids()));
create policy sb_insert on public.asset_unit_serial_bindings
    for insert with check (organization_id in (select current_org_ids()));
create policy sb_update on public.asset_unit_serial_bindings
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.assembly_definitions enable row level security;
create policy ad_select on public.assembly_definitions
    for select using (organization_id in (select current_org_ids()));
create policy ad_insert on public.assembly_definitions
    for insert with check (organization_id in (select current_org_ids()));
create policy ad_update on public.assembly_definitions
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.installation_history enable row level security;
create policy ih_select on public.installation_history
    for select using (organization_id in (select current_org_ids()));
create policy ih_insert on public.installation_history
    for insert with check (organization_id in (select current_org_ids()));
create policy ih_update on public.installation_history
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.asset_supply_links enable row level security;
create policy sl_select on public.asset_supply_links
    for select using (organization_id in (select current_org_ids()));
create policy sl_insert on public.asset_supply_links
    for insert with check (organization_id in (select current_org_ids()));
create policy sl_update on public.asset_supply_links
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

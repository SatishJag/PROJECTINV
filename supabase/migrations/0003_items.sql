-- =====================================================================
-- 0003_items.sql
-- Item definitions (material/equipment identity) and controlled aliases.
--
-- DISTINCT FROM: a project inventory requirement (0004) and a physical
-- unit (0006). One shared item definition does NOT combine project
-- quantities.
--
-- Matching rule: AI proposes matches; it never establishes identity.
-- Identical descriptions do not prove identical specifications - cable
-- gauge, voltage, insulation, rating and configuration must be considered.
-- An unknown item in a new project is still recorded: it gets a new
-- definition or stays provisionally classified.
-- =====================================================================

create table public.item_definitions (
    item_id                   uuid primary key default gen_random_uuid(),
    organization_id           uuid not null references public.organizations (organization_id),
    internal_item_code        text,
    name                      text not null,
    category                  text,
    manufacturer_part_number  text,
    specification             jsonb,          -- typed technical attributes; never a substitute for FKs
    base_uom_id               uuid not null references public.units_of_measure (uom_id),
    tracking_mode             text not null default 'not_tracked'
                              check (tracking_mode in ('serialized','batch','bulk','not_tracked')),
    verification_status       text not null default 'unverified'
                              check (verification_status in ('unverified','provisional','verified','rejected')),
    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now(),
    created_by                text,
    record_version            bigint not null default 1,
    unique (organization_id, internal_item_code),
    unique (organization_id, item_id)   -- enables composite org-consistent FKs
);

comment on table public.item_definitions is
  'Material/equipment identity shared across projects (e.g. "Copper cable, '
  'specification A", "Generator model G100"). tracking_mode governs whether '
  'physical units receive serial children (0006) or lot/consumption records.';

create table public.item_aliases (
    alias_id          uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references public.organizations (organization_id),
    item_id           uuid not null references public.item_definitions (item_id),
    issuer            text not null,
    alias_type        text not null,
    alias_value       text not null,
    source_reference  text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    created_by        text,
    record_version    bigint not null default 1,
    unique (organization_id, issuer, alias_type, alias_value)
);

comment on table public.item_aliases is
  'External identifiers (manufacturer codes, supplier codes, BOQ item '
  'codes) that RESOLVE to an item definition. Alias uniqueness is scoped '
  'by issuer + type + value; similarity alone is never a match.';

do $$
declare t text;
begin
    foreach t in array array['item_definitions','item_aliases'] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

------------------------------------------------------------------
-- RLS: org-level catalogue, visible to org members.
------------------------------------------------------------------

alter table public.item_definitions enable row level security;
create policy item_definitions_select on public.item_definitions
    for select using (organization_id in (select current_org_ids()));
create policy item_definitions_insert on public.item_definitions
    for insert with check (organization_id in (select current_org_ids()));
create policy item_definitions_update on public.item_definitions
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

alter table public.item_aliases enable row level security;
create policy item_aliases_select on public.item_aliases
    for select using (organization_id in (select current_org_ids()));
create policy item_aliases_insert on public.item_aliases
    for insert with check (organization_id in (select current_org_ids()));
create policy item_aliases_update on public.item_aliases
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

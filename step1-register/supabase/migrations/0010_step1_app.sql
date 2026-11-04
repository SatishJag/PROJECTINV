-- =====================================================================
-- 0010_step1_app.sql
-- Columns and tables the Step 1 register app needs on top of the
-- canonical schema (0001-0009): BOQ extraction detail, mapping state,
-- file-store references, unit aliases, the audit trail and the
-- register view. Nothing here changes a canonical key or relationship.
-- =====================================================================

-- Units: the aliases a BOQ may use for each unit ("nos", "lm", "sqm"...).
alter table public.units_of_measure add column aliases text[] not null default '{}';

-- Standard units for an organization (called when the organization is created).
create or replace function public.seed_units_of_measure(org uuid) returns void
language sql as $$
    insert into public.units_of_measure (organization_id, code, name, measurement_dimension, aliases) values
      (org, 'each',  'Each',            'count',  array['ea', 'no', 'nos', 'no.', 'nos.', 'nr', 'number', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'set', 'sets']),
      (org, 'm',     'Metre',           'length', array['m', 'lm', 'l.m', 'rm', 'r.m', 'mtr', 'mtrs', 'metre', 'metres', 'meter', 'meters', 'lin.m']),
      (org, 'km',    'Kilometre',       'length', array['km']),
      (org, 'm2',    'Square metre',    'area',   array['m2', 'm²', 'sqm', 'sq.m', 'sq m']),
      (org, 'm3',    'Cubic metre',     'volume', array['m3', 'm³', 'cum', 'cu.m', 'cu m']),
      (org, 'l',     'Litre',           'volume', array['l', 'ltr', 'litre', 'litres', 'liter', 'liters']),
      (org, 'kg',    'Kilogram',        'mass',   array['kg', 'kgs']),
      (org, 't',     'Tonne',           'mass',   array['t', 'ton', 'tons', 'tonne', 'tonnes', 'mt']),
      (org, 'lot',   'Lot / lump sum',  'lot',    array['lot', 'lots', 'ls', 'l.s', 'l.s.', 'lump sum', 'item', 'job']),
      (org, 'day',   'Day',             'time',   array['day', 'days']),
      (org, 'month', 'Month',           'time',   array['month', 'months', 'mth'])
    on conflict (organization_id, code) do nothing
$$;

-- Work packages: extra BOQ heading / sheet terms that identify the package.
alter table public.work_packages add column match_terms text[] not null default '{}';

-- Cost assignments: the full budget-code string and description from Procore; one row per Procore budget code.
alter table public.cost_assignments add column budget_code text;
alter table public.cost_assignments add column description text;
alter table public.cost_assignments add constraint cost_assignments_procore_budget_code unique (project_id, procore_budget_code_id);
alter table public.cost_assignments add constraint cost_assignments_wp_key unique (cost_assignment_id, work_package_id, project_id);

-- Items: the BOQ's specification text, and the key used to propose a catalogue match.
create sequence public.item_code_seq;
alter table public.item_definitions alter column internal_item_code set default ('ITM-' || lpad(nextval('public.item_code_seq')::text, 5, '0'));
alter table public.item_definitions add column specification_text text;
alter table public.item_definitions add column match_key text;
create index item_definitions_match_key on public.item_definitions (organization_id, match_key);

-- BOQ revisions: document identity across revisions, Procore context, file-store reference, project cross-check.
-- The original file is never stored in Postgres: it lives in the file store under storage_key.
alter table public.boq_document_revisions
    add column document_key text,
    add column procore_company_id text,
    add column procore_project_id text,
    add column mime_type text,
    add column file_size integer,
    add column storage_kind text,
    add column storage_key text,
    add column declared_project_name text,
    add column project_conflict boolean not null default false,
    add column processing_messages jsonb not null default '[]',
    add column supersedes_revision_id uuid,
    add constraint boq_rev_supersedes_same_project
        foreign key (project_id, supersedes_revision_id)
        references public.boq_document_revisions (project_id, boq_revision_id);
alter table public.boq_document_revisions alter column submitted_at set default now();
alter table public.boq_document_revisions add constraint boq_revision_original_kept
    check ((storage_kind is null) = (storage_key is null));
create unique index boq_rev_one_accepted_per_document_key
    on public.boq_document_revisions (project_id, document_key)
    where document_status = 'accepted';

-- BOQ lines: where the line sits in the source, its headings, and the mapping decision.
alter table public.boq_lines
    add column sheet_name text,
    add column row_number integer,
    add column page_number integer,
    add column section_path text[] not null default '{}',
    add column raw_specification text,
    add column item_id uuid references public.item_definitions (item_id),
    add column validation_messages jsonb not null default '[]',
    -- proposed: mapped automatically but held (e.g. project conflict); mapped / split: published as allocations.
    add column mapping_status text not null default 'unmapped'
        check (mapping_status in ('unmapped', 'proposed', 'mapped', 'split', 'unresolved', 'rejected', 'not_applicable')),
    add column mapping_basis text,
    add column proposed_work_package_id uuid,
    add column proposed_cost_assignment_id uuid,
    add column resolution_note text,
    add column resolved_by text,
    add column resolved_at timestamptz,
    add constraint boq_line_proposed_wp_same_project
        foreign key (project_id, proposed_work_package_id) references public.work_packages (project_id, work_package_id),
    add constraint boq_line_proposed_ca_same_project
        foreign key (project_id, proposed_cost_assignment_id) references public.cost_assignments (project_id, cost_assignment_id);

-- Requirements: a readable record number, and the cost assignment must belong to the requirement's work package.
create sequence public.inventory_record_number_seq;
alter table public.inventory_requirements
    add column record_number text not null unique default ('INV-' || lpad(nextval('public.inventory_record_number_seq')::text, 5, '0')),
    add constraint req_cost_assignment_of_work_package
        foreign key (cost_assignment_id, work_package_id, project_id)
        references public.cost_assignments (cost_assignment_id, work_package_id, project_id);

-- Allocations: why the line was attributed, and who approved it.
alter table public.requirement_boq_allocations
    add column basis text,
    add column approved_by text,
    add column approved_at timestamptz;

------------------------------------------------------------------
-- Audit trail: every mutation writes one row in the same transaction.
------------------------------------------------------------------

create table public.audit_events (
    audit_id        bigserial primary key,
    organization_id uuid references public.organizations (organization_id),
    project_id      uuid references public.projects (project_id),
    actor           text not null,
    action          text not null,
    entity          text not null,
    entity_id       text,
    detail          jsonb not null default '{}',
    created_at      timestamptz not null default now()
);
create index audit_events_project on public.audit_events (project_id, created_at desc);

alter table public.audit_events enable row level security;
create policy audit_select on public.audit_events
    for select using (project_id in (select current_project_ids()));
create policy audit_insert on public.audit_events
    for insert with check (project_id in (select current_project_ids()));

------------------------------------------------------------------
-- The register: project + work package + cost assignment + item, with
-- the BOQ quantity from the accepted revision only. ordered_quantity
-- stays NULL (unknown) in Step 1: it needs purchase evidence.
------------------------------------------------------------------

create view public.inventory_register
with (security_invoker = true) as
select
  r.inventory_record_id,
  r.record_number,
  r.organization_id,
  r.project_id,
  p.project_name,
  p.procore_company_id,
  p.procore_project_id,
  r.work_package_id,
  wp.code as work_package_code,
  wp.name as work_package_name,
  r.cost_assignment_id,
  ca.budget_code,
  ca.cost_code,
  ca.cost_type,
  ca.procore_budget_code_id,
  r.item_id,
  i.internal_item_code,
  i.verification_status as item_verification_status,
  r.item_description,
  r.specification,
  u.code as normalized_uom,
  coalesce(q.original_uoms, '{}') as original_uoms,
  coalesce(q.boq_quantity, 0) as boq_quantity,
  null::numeric as ordered_quantity,
  coalesce(q.source_line_count, 0) as source_line_count,
  case when coalesce(q.source_line_count, 0) = 0 then 'no_current_source' else 'validated' end as validation_status,
  r.status,
  r.created_at
from public.inventory_requirements r
join public.projects p on p.project_id = r.project_id
join public.work_packages wp on wp.work_package_id = r.work_package_id
join public.cost_assignments ca on ca.cost_assignment_id = r.cost_assignment_id
join public.item_definitions i on i.item_id = r.item_id
join public.units_of_measure u on u.uom_id = r.uom_id
left join lateral (
  select sum(a.allocated_quantity) as boq_quantity,
         count(*) as source_line_count,
         array_agg(distinct l.raw_uom) filter (where l.raw_uom is not null) as original_uoms
  from public.requirement_boq_allocations a
  join public.boq_lines l on l.boq_line_id = a.boq_line_id
  join public.boq_document_revisions d on d.boq_revision_id = l.boq_revision_id
  where a.inventory_record_id = r.inventory_record_id
    and a.approval_status = 'approved'
    and d.document_status = 'accepted'
) q on true;

grant select, insert, update on all tables in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage on all sequences in schema public to authenticated, service_role;

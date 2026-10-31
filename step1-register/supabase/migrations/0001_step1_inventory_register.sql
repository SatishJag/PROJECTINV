-- Step 1: Project Inventory Register.
-- Relationship between a Procore project, its WBS work package and cost assignment, and every item taken from a BOQ.
-- Rules enforced here (not just in the application):
--   * every project-scoped row carries project_id, and references to other project-scoped rows use composite
--     (id, project_id) foreign keys, so a Bangkok Central 1 record cannot point at a Bangkok Central 2 work package,
--     cost assignment, BOQ revision or BOQ line;
--   * a requirement's cost assignment must belong to the requirement's own work package;
--   * importing the same file (or the same Procore document revision) twice does not create a second revision;
--   * one source line is extracted once per revision (revision + source locator);
--   * approved allocations of a BOQ line never exceed the line's quantity (no copying the full quantity into each
--     work package);
--   * BOQ quantity is never "ordered quantity": ordered quantity is not stored in Step 1 and the register reports it
--     as unknown until purchase evidence exists.


create table organizations (
  organization_id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table projects (
  project_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  procore_company_id bigint,
  procore_project_id bigint,
  project_code text,
  project_name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  record_version integer not null default 1,
  unique (organization_id, procore_company_id, procore_project_id),
  unique (project_id, organization_id)
);

-- Access per project (used by the row-level security policies in 0002).
create table project_members (
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null,
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- The project's WBS hierarchy and equipment work packages (Chiller, UPS, Transformer, Generator, ...).
-- "Work package" is our equipment task; it is NOT Procore's timekeeping Task Code.
create table work_packages (
  work_package_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  project_id uuid not null references projects,
  parent_work_package_id uuid,
  source_wbs_reference text,              -- e.g. Procore cost-code segment item id
  code text not null,
  name text not null,
  match_terms text[] not null default '{}', -- extra BOQ heading / sheet terms that identify this package
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  record_version integer not null default 1,
  unique (project_id, code),
  unique (work_package_id, project_id),
  foreign key (parent_work_package_id, project_id) references work_packages (work_package_id, project_id),
  check (parent_work_package_id is null or parent_work_package_id <> work_package_id)
);

-- Approved mapping between a work package and its full Procore budget-code context (cost code + cost type + other
-- segments). A cost code alone is not assumed to identify the work package.
create table cost_assignments (
  cost_assignment_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  project_id uuid not null references projects,
  work_package_id uuid not null,
  procore_budget_code_id text,           -- Procore WBS code id
  budget_code text,                      -- full budget code string, e.g. 26-100.M
  cost_code text not null,
  cost_type text,
  segment_references jsonb not null default '[]',
  description text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  record_version integer not null default 1,
  foreign key (work_package_id, project_id) references work_packages (work_package_id, project_id),
  unique (cost_assignment_id, project_id),
  unique (cost_assignment_id, work_package_id, project_id),
  unique (project_id, procore_budget_code_id)
);

create table units_of_measure (
  uom_id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  measurement_dimension text not null check (measurement_dimension in ('count', 'length', 'area', 'volume', 'mass', 'lot', 'time', 'other')),
  aliases text[] not null default '{}'
);

insert into units_of_measure (code, name, measurement_dimension, aliases) values
  ('each', 'Each', 'count', array['ea', 'no', 'nos', 'no.', 'nos.', 'nr', 'number', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'set', 'sets']),
  ('m', 'Metre', 'length', array['m', 'lm', 'l.m', 'rm', 'r.m', 'mtr', 'mtrs', 'metre', 'metres', 'meter', 'meters', 'lin.m']),
  ('km', 'Kilometre', 'length', array['km']),
  ('m2', 'Square metre', 'area', array['m2', 'm²', 'sqm', 'sq.m', 'sq m']),
  ('m3', 'Cubic metre', 'volume', array['m3', 'm³', 'cum', 'cu.m', 'cu m']),
  ('l', 'Litre', 'volume', array['l', 'ltr', 'litre', 'litres', 'liter', 'liters']),
  ('kg', 'Kilogram', 'mass', array['kg', 'kgs']),
  ('t', 'Tonne', 'mass', array['t', 'ton', 'tons', 'tonne', 'tonnes', 'mt']),
  ('lot', 'Lot / lump sum', 'lot', array['lot', 'lots', 'ls', 'l.s', 'l.s.', 'lump sum', 'item', 'job']),
  ('day', 'Day', 'time', array['day', 'days']),
  ('month', 'Month', 'time', array['month', 'months', 'mth']);

-- Equipment / material identity (type or specification), shared across projects. Never holds project quantities.
create sequence item_code_seq;
create table item_definitions (
  item_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  internal_item_code text not null default ('ITM-' || lpad(nextval('item_code_seq')::text, 5, '0')),
  name text not null,
  category text,
  manufacturer_part_number text,
  specification text,
  match_key text not null,               -- normalised description + specification + unit dimension
  base_uom_id uuid not null references units_of_measure,
  tracking_mode text not null default 'quantity' check (tracking_mode in ('quantity', 'lot', 'serialized')),
  verification_status text not null default 'provisional' check (verification_status in ('provisional', 'verified', 'rejected')),
  attributes jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  record_version integer not null default 1,
  unique (organization_id, internal_item_code)
);
create index item_definitions_match_key on item_definitions (organization_id, match_key);

create table item_aliases (
  alias_id uuid primary key default gen_random_uuid(),
  item_id uuid not null references item_definitions on delete cascade,
  issuer text not null,                  -- who issued the identifier (LDC, manufacturer, supplier, project)
  alias_type text not null,              -- boq_item_code, manufacturer_part_number, description, ...
  alias_value text not null,
  source_reference text,
  created_at timestamptz not null default now(),
  unique (issuer, alias_type, alias_value)
);

-- One submitted BOQ file (one revision of a BOQ document) with its Procore source context.
create table boq_document_revisions (
  boq_revision_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  project_id uuid not null references projects,
  document_key text not null,            -- stable identity of the BOQ document across revisions
  source_tool text not null check (source_tool in ('procore_documents', 'procore_attachment', 'upload')),
  procore_company_id bigint,
  procore_project_id bigint,
  procore_document_id text,
  source_revision text,
  file_name text not null,
  mime_type text,
  file_hash text not null,               -- sha256 of the file
  file_size integer,
  file_content bytea,                    -- original file, kept for traceability
  declared_project_name text,            -- project name read from the file (a cross-check only)
  project_conflict boolean not null default false,
  submitted_by text,
  submitted_at timestamptz not null default now(),
  document_status text not null default 'current' check (document_status in ('current', 'superseded', 'withdrawn')),
  processing_status text not null default 'received' check (processing_status in ('received', 'extracted', 'failed')),
  processing_messages jsonb not null default '[]',
  supersedes_revision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  record_version integer not null default 1,
  unique (boq_revision_id, project_id),
  unique (project_id, file_hash),
  foreign key (supersedes_revision_id, project_id) references boq_document_revisions (boq_revision_id, project_id)
);
create unique index boq_revision_procore_source on boq_document_revisions (project_id, procore_document_id, source_revision)
  where procore_document_id is not null and source_revision is not null;
create unique index boq_one_current_revision on boq_document_revisions (project_id, document_key)
  where document_status = 'current';

-- Every extracted source line (items, headings, subtotals, notes) with its original values and location.
create table boq_lines (
  boq_line_id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  boq_revision_id uuid not null,
  parent_source_line_id uuid,
  line_kind text not null check (line_kind in ('item', 'heading', 'subtotal', 'note')),
  source_locator text not null,          -- e.g. "Electrical!R14" or "p3:L22"
  sheet_name text,
  row_number integer,
  page_number integer,
  section_path text[] not null default '{}',
  raw_item_code text,
  raw_description text,
  raw_specification text,
  raw_quantity text,
  raw_uom text,
  raw_wbs_reference text,
  raw_cost_code text,
  quantity numeric(20, 6),
  uom_id uuid references units_of_measure,
  item_id uuid references item_definitions,
  validation_status text not null default 'pending' check (validation_status in ('pending', 'valid', 'invalid', 'not_applicable')),
  validation_messages jsonb not null default '[]',
  -- proposed: mapped automatically but held (e.g. project conflict); mapped / split: published as allocations.
  mapping_status text not null default 'unmapped' check (mapping_status in ('unmapped', 'proposed', 'mapped', 'split', 'unresolved', 'rejected', 'not_applicable')),
  mapping_basis text,
  proposed_work_package_id uuid,
  proposed_cost_assignment_id uuid,
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  record_version integer not null default 1,
  foreign key (boq_revision_id, project_id) references boq_document_revisions (boq_revision_id, project_id) on delete cascade,
  foreign key (proposed_work_package_id, project_id) references work_packages (work_package_id, project_id),
  foreign key (proposed_cost_assignment_id, project_id) references cost_assignments (cost_assignment_id, project_id),
  unique (boq_revision_id, source_locator),
  unique (boq_line_id, project_id)
);
create index boq_lines_revision on boq_lines (boq_revision_id);

-- The register: project + work package + cost assignment + item. inventory_record_id is the primary key.
create sequence inventory_record_number_seq;
create table inventory_requirements (
  inventory_record_id uuid primary key default gen_random_uuid(),
  record_number text not null unique default ('INV-' || lpad(nextval('inventory_record_number_seq')::text, 5, '0')),
  organization_id uuid not null references organizations,
  project_id uuid not null references projects,
  work_package_id uuid not null,
  cost_assignment_id uuid not null,
  item_id uuid not null references item_definitions,
  uom_id uuid not null references units_of_measure,
  item_description text not null,
  specification text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  record_version integer not null default 1,
  foreign key (work_package_id, project_id) references work_packages (work_package_id, project_id),
  foreign key (cost_assignment_id, work_package_id, project_id) references cost_assignments (cost_assignment_id, work_package_id, project_id),
  unique (inventory_record_id, project_id),
  unique (project_id, work_package_id, cost_assignment_id, item_id, uom_id)
);

-- Which BOQ line(s) a requirement's quantity comes from, and how much of each line.
create table requirement_boq_allocations (
  allocation_id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  inventory_record_id uuid not null,
  boq_line_id uuid not null,
  allocated_quantity numeric(20, 6) not null check (allocated_quantity > 0),
  uom_id uuid not null references units_of_measure,
  approval_status text not null default 'approved' check (approval_status in ('proposed', 'approved', 'rejected')),
  basis text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (inventory_record_id, project_id) references inventory_requirements (inventory_record_id, project_id),
  foreign key (boq_line_id, project_id) references boq_lines (boq_line_id, project_id) on delete cascade,
  unique (inventory_record_id, boq_line_id)
);
create index allocations_line on requirement_boq_allocations (boq_line_id);

-- Allocations of one line never exceed the line, and use the line's own unit (no silent conversion).
create function check_allocation_within_line() returns trigger language plpgsql as $$
declare
  line_qty numeric;
  line_uom uuid;
  line_kind_v text;
  line_project uuid;
  total numeric;
begin
  select quantity, uom_id, line_kind, project_id into line_qty, line_uom, line_kind_v, line_project from boq_lines where boq_line_id = new.boq_line_id;
  if line_project is distinct from new.project_id then
    raise exception 'BOQ line % belongs to another project', new.boq_line_id using errcode = '23503';
  end if;
  if line_kind_v <> 'item' then
    raise exception 'BOQ line % is a %, not an item; it cannot be allocated', new.boq_line_id, line_kind_v;
  end if;
  if line_qty is null or line_uom is null then
    raise exception 'BOQ line % has no valid quantity/unit; it cannot be allocated', new.boq_line_id;
  end if;
  if new.uom_id <> line_uom then
    raise exception 'Allocation unit differs from the BOQ line unit';
  end if;
  select coalesce(sum(allocated_quantity), 0) into total from requirement_boq_allocations
    where boq_line_id = new.boq_line_id and approval_status <> 'rejected' and allocation_id <> new.allocation_id;
  if new.approval_status <> 'rejected' and total + new.allocated_quantity > line_qty then
    raise exception 'Allocations (%) exceed the BOQ line quantity (%)', total + new.allocated_quantity, line_qty;
  end if;
  return new;
end $$;
create trigger allocation_within_line before insert or update on requirement_boq_allocations
  for each row execute function check_allocation_within_line();

-- A requirement's unit must match its allocations' unit.
create function check_allocation_requirement_uom() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from inventory_requirements r where r.inventory_record_id = new.inventory_record_id and r.uom_id = new.uom_id) then
    raise exception 'Allocation unit differs from the requirement unit';
  end if;
  return new;
end $$;
create trigger allocation_requirement_uom before insert or update on requirement_boq_allocations
  for each row execute function check_allocation_requirement_uom();

create table audit_events (
  audit_id bigserial primary key,
  organization_id uuid,
  project_id uuid,
  actor text not null,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Current register: quantities come only from current (not superseded) BOQ revisions; old and new revisions are never
-- summed. ordered_quantity stays NULL (unknown) in Step 1: it needs purchase evidence.
create view inventory_register as
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
from inventory_requirements r
join projects p on p.project_id = r.project_id
join work_packages wp on wp.work_package_id = r.work_package_id
join cost_assignments ca on ca.cost_assignment_id = r.cost_assignment_id
join item_definitions i on i.item_id = r.item_id
join units_of_measure u on u.uom_id = r.uom_id
left join lateral (
  select sum(a.allocated_quantity) as boq_quantity,
         count(*) as source_line_count,
         array_agg(distinct l.raw_uom) filter (where l.raw_uom is not null) as original_uoms
  from requirement_boq_allocations a
  join boq_lines l on l.boq_line_id = a.boq_line_id
  join boq_document_revisions d on d.boq_revision_id = l.boq_revision_id
  where a.inventory_record_id = r.inventory_record_id
    and a.approval_status = 'approved'
    and d.document_status = 'current'
) q on true;

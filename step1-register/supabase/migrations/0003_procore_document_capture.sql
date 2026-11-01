-- Automatic capture of BOQ files stored in a project's Procore Documents tool.
--
-- The LDC stores a BOQ in the project's watched Procore folder. A webhook (or the periodic scan that catches missed
-- webhooks) finds each new file or new file version, downloads it, and runs it through the normal BOQ intake. Every
-- file version is captured once: (project, Procore file id, file version) is unique, so repeated webhooks and
-- overlapping scans never import the same file twice.

-- Which Procore Documents folder is watched for each project.
create table procore_document_watches (
  project_id uuid primary key references projects,
  organization_id uuid not null references organizations,
  enabled boolean not null default true,
  folder_id text,                        -- Procore folder id; null = use a top-level folder named like "BOQ"
  folder_path text,                      -- resolved folder path, for display
  include_subfolders boolean not null default true,
  last_scan_at timestamptz,
  last_scan_status text check (last_scan_status in ('ok', 'no_folder', 'error')),
  last_scan_message text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  record_version integer not null default 1
);

-- One row per Procore file version seen in a watched folder, with what happened to it.
create table procore_document_captures (
  capture_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  project_id uuid not null references projects,
  procore_file_id text not null,
  procore_file_version text not null,
  file_name text not null,
  folder_path text,
  detected_via text not null check (detected_via in ('webhook', 'scan', 'manual')),
  -- captured: a new BOQ revision was created; duplicate: identical content already imported;
  -- failed: the file cannot be read as a BOQ (not retried until a new version); retry: a temporary error, retried.
  status text not null default 'pending' check (status in ('pending', 'captured', 'duplicate', 'failed', 'retry')),
  attempts integer not null default 0,
  message text,
  boq_revision_id uuid,
  document_key text,
  detected_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  record_version integer not null default 1,
  unique (project_id, procore_file_id, procore_file_version),
  foreign key (boq_revision_id, project_id) references boq_document_revisions (boq_revision_id, project_id)
);
create index procore_captures_project on procore_document_captures (project_id, detected_at desc);
create index procore_captures_file on procore_document_captures (project_id, procore_file_id);

-- Every webhook delivery, stored before it is acknowledged. Procore delivers at least once, so the delivery id
-- (ulid, else id) is unique per organization.
create table procore_webhook_events (
  event_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  delivery_id text not null,
  procore_company_id text,
  procore_project_id text,
  project_id uuid references projects,
  resource_name text,
  event_type text,
  resource_id text,
  payload jsonb not null,
  payload_hash text not null,
  state text not null default 'received' check (state in ('received', 'processed', 'ignored', 'failed')),
  message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (organization_id, delivery_id)
);
create index procore_webhook_events_state on procore_webhook_events (state, received_at);

alter table procore_document_watches enable row level security;
alter table procore_document_captures enable row level security;
alter table procore_webhook_events enable row level security;

grant select on procore_document_watches, procore_document_captures, procore_webhook_events to authenticated;

create policy member_read on procore_document_watches for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on procore_document_captures for select to authenticated
  using (project_id in (select app_member_project_ids()));
create policy member_read on procore_webhook_events for select to authenticated
  using (project_id in (select app_member_project_ids()));

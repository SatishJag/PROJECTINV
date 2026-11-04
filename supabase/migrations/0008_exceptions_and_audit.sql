-- =====================================================================
-- 0008_exceptions_and_audit.sql
-- Mapping exception queue and ingestion-run audit.
--
-- The processing flow stores extraction results FIRST; only validated
-- lines become project inventory records. Ambiguous lines remain
-- visible in the exception queue with owner, due date and resolution -
-- nothing is silently attributed.
--
-- RECONCILIATION CONTROL: extracted item lines, rejected lines and
-- unresolved mappings are accounted for per ingestion run.
-- =====================================================================

create table public.mapping_exceptions (
    mapping_exception_id uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    project_id         uuid not null,
    boq_line_id        uuid not null,
    exception_type     text not null
                       check (exception_type in
                         ('unattributed_work_package','ambiguous_item_match',
                          'uom_unresolvable','quantity_invalid','duplicate_conflict',
                          'spec_conflict','other')),
    exception_detail   text,
    proposed_mapping   jsonb,               -- AI/analyst proposal; never auto-applied
    state              text not null default 'open'
                       check (state in ('open','in_review','resolved','dismissed')),
    owner              text,
    due_at             timestamptz,
    resolution         text,
    resolved_by        text,
    resolved_at        timestamptz,
    resolution_evidence text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    constraint exc_same_project
        foreign key (project_id) references public.projects (project_id),
    constraint exc_line_same_project
        foreign key (project_id, boq_line_id)
        references public.boq_lines (project_id, boq_line_id),
    constraint resolved_needs_evidence
        check (state not in ('resolved','dismissed') or resolution is not null)
);

comment on table public.mapping_exceptions is
  'Exception queue. "Copper cable" with no package attribution lands '
  'here (unattributed_work_package) - attribution stays unresolved '
  'until a human resolves it with evidence.';

create table public.ingestion_runs (
    ingestion_run_id   uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    project_id         uuid not null,
    boq_revision_id    uuid not null,
    started_at         timestamptz not null default now(),
    completed_at       timestamptz,
    run_status         text not null default 'running'
                       check (run_status in ('running','completed','failed')),
    extracted_count    integer not null default 0,
    item_count         integer not null default 0,     -- line_type = 'item'
    validated_count    integer not null default 0,
    exception_count    integer not null default 0,
    rejected_count     integer not null default 0,
    non_item_count     integer not null default 0,     -- headings/subtotals excluded
    run_notes          text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    constraint run_same_project
        foreign key (project_id) references public.projects (project_id),
    constraint run_same_project_revision
        foreign key (project_id, boq_revision_id)
        references public.boq_document_revisions (project_id, boq_revision_id)
);

comment on table public.ingestion_runs is
  'One processing run per document attempt. Reconciliation check: '
  'item_count = validated + exception + rejected, with non_item_count '
  'excluded from the register. This makes the extraction auditable.';

do $$
declare t text;
begin
    foreach t in array array['mapping_exceptions','ingestion_runs'] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

create index idx_exc_state  on public.mapping_exceptions (project_id, state);
create index idx_exc_owner  on public.mapping_exceptions (owner) where state in ('open','in_review');
create index idx_runs_rev   on public.ingestion_runs (boq_revision_id);

------------------------------------------------------------------
-- RLS (project-scoped)
------------------------------------------------------------------

alter table public.mapping_exceptions enable row level security;
create policy exc_select on public.mapping_exceptions
    for select using (project_id in (select current_project_ids()));
create policy exc_insert on public.mapping_exceptions
    for insert with check (project_id in (select current_project_ids()));
create policy exc_update on public.mapping_exceptions
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.ingestion_runs enable row level security;
create policy run_select on public.ingestion_runs
    for select using (project_id in (select current_project_ids()));
create policy run_insert on public.ingestion_runs
    for insert with check (project_id in (select current_project_ids()));
create policy run_update on public.ingestion_runs
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

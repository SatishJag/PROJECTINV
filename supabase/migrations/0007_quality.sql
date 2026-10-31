-- =====================================================================
-- 0007_quality.sql
-- Test results, failure cases, recovery actions.
-- Created now, ACTIVE in later steps.
--
-- RULES ENCODED:
--   * A failure does not automatically establish supplier fault. The
--     record preserves affected product, exposure, cause and
--     responsibility so a FAIR supplier assessment is possible later.
--   * Incident discipline: repeated tests or returns tied to ONE
--     incident must not count as several independent failures
--     (failure_case is the unit of counting, not test rows).
--   * Commercial supplier, manufacturer, installer, maintainer remain
--     separate attributions.
--   * history is append-oriented; corrections supersede, cases are
--     never silently rewritten.
-- =====================================================================

create table public.test_results (
    test_result_id     uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    project_id         uuid not null,
    affected_asset_unit_id uuid references public.asset_units (asset_unit_id),
    affected_lot_reference text,             -- for batch/lot-tracked items
    test_type          text not null,        -- FAT / SAT / commissioning / spot / retest
    test_date          timestamptz not null,
    outcome            text not null
                       check (outcome in ('pass','fail','pass_with_deviations','inconclusive')),
    related_failure_case_id uuid,
    evidence_reference text,
    performed_by       text,                 -- organization performing the test
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    constraint test_same_project
        foreign key (project_id) references public.projects (project_id),
    constraint test_unit_org_match
        foreign key (organization_id, affected_asset_unit_id)
        references public.asset_units (organization_id, asset_unit_id),
    constraint affected_is_something
        check (affected_asset_unit_id is not null or affected_lot_reference is not null)
);

comment on table public.test_results is
  'Test evidence rows. Multiple rows may describe one incident; '
  'counting happens on failure_cases, not here.';

create table public.failure_cases (
    failure_case_id    uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    project_id         uuid not null,
    affected_asset_unit_id uuid references public.asset_units (asset_unit_id),
    affected_lot_reference text,
    related_test_result_id uuid references public.test_results (test_result_id),
    symptom            text,
    suspected_cause    text,
    confirmed_cause    text,
    responsibility_status text not null default 'under_investigation'
                       check (responsibility_status in
                         ('under_investigation','supplier','manufacturer','installer',
                          'maintainer','client','site_conditions','undetermined')),
    opened_at          timestamptz not null default now(),
    closed_at          timestamptz,
    evidence_reference text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    constraint failure_same_project
        foreign key (project_id) references public.projects (project_id),
    constraint failure_unit_org_match
        foreign key (organization_id, affected_asset_unit_id)
        references public.asset_units (organization_id, asset_unit_id),
    constraint affected_is_something
        check (affected_asset_unit_id is not null or affected_lot_reference is not null)
);

comment on table public.failure_cases is
  'The unit of failure counting. One physical incident = one case; '
  'retests and returns link back to it via test_results.related_'
  'failure_case_id or recovery_actions.failure_case_id.';

create table public.recovery_actions (
    action_id          uuid primary key default gen_random_uuid(),
    organization_id    uuid not null references public.organizations (organization_id),
    failure_case_id    uuid not null,
    action_type        text not null
                       check (action_type in ('rma','return','repair','replacement','retest','warranty_claim','other')),
    return_reference   text,
    repair_outcome     text,
    replacement_asset_unit_id uuid references public.asset_units (asset_unit_id),  -- NEW unit => new UUID with lineage to this case
    replacement_lot_reference text,
    started_at         timestamptz,
    completed_at       timestamptz,
    evidence_reference text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    created_by         text,
    record_version     bigint not null default 1,
    constraint action_same_org_case
        foreign key (organization_id, failure_case_id)
        references public.failure_cases (organization_id, failure_case_id),
    constraint replacement_unit_org_match
        foreign key (organization_id, replacement_asset_unit_id)
        references public.asset_units (organization_id, asset_unit_id)
);

comment on table public.recovery_actions is
  'Recovery trace: return, repair outcome, replacement unit identity '
  '(a replacement is a NEW asset unit; the repaired same serial keeps '
  'its unit), retest and warranty evidence.';

do $$
declare t text;
begin
    foreach t in array array['test_results','failure_cases','recovery_actions'] loop
        execute format(
            'create trigger %s_audit before insert or update on public.%I '
            'for each row execute function public.maintain_audit()', t, t);
    end loop;
end $$;

create index idx_tests_unit   on public.test_results (affected_asset_unit_id);
create index idx_failures_unit on public.failure_cases (affected_asset_unit_id);
create index idx_actions_case on public.recovery_actions (failure_case_id);

------------------------------------------------------------------
-- RLS (project-scoped)
------------------------------------------------------------------

alter table public.test_results enable row level security;
create policy test_select on public.test_results
    for select using (project_id in (select current_project_ids()));
create policy test_insert on public.test_results
    for insert with check (project_id in (select current_project_ids()));
create policy test_update on public.test_results
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.failure_cases enable row level security;
create policy failure_select on public.failure_cases
    for select using (project_id in (select current_project_ids()));
create policy failure_insert on public.failure_cases
    for insert with check (project_id in (select current_project_ids()));
create policy failure_update on public.failure_cases
    for update using (project_id in (select current_project_ids()))
    with check (project_id in (select current_project_ids()));

alter table public.recovery_actions enable row level security;
create policy action_select on public.recovery_actions
    for select using (organization_id in (select current_org_ids()));
create policy action_insert on public.recovery_actions
    for insert with check (organization_id in (select current_org_ids()));
create policy action_update on public.recovery_actions
    for update using (organization_id in (select current_org_ids()))
    with check (organization_id in (select current_org_ids()));

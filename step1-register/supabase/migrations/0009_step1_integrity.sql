-- =====================================================================
-- 0009_step1_integrity.sql
-- Database rules the Step 1 acceptance checks rely on, plus the grants
-- for the API role. Plain Postgres 16+ (Azure Database for PostgreSQL).
-- =====================================================================

------------------------------------------------------------------
-- A3: one accepted revision per document. A new accepted revision
-- must supersede the previous one first; quantities never sum.
------------------------------------------------------------------

create unique index boq_rev_one_accepted_per_document
    on public.boq_document_revisions (project_id, source_tool, procore_document_id)
    where document_status = 'accepted';

-- A2: the same file is captured once per project.
create unique index boq_rev_file_once_per_project
    on public.boq_document_revisions (project_id, file_hash)
    where document_status <> 'cancelled';

------------------------------------------------------------------
-- A4/A5/A6: allocation rules.
--   * only valid item lines can be allocated (headings, subtotals,
--     notes and rejected lines never reach the register);
--   * the allocation is in the line's own normalized unit;
--   * approved + proposed allocations never exceed the line quantity
--     (the full quantity is never copied into each package);
--   * a line with an open exception cannot have an approved allocation;
--   * the requirement's unit matches the allocation's unit.
------------------------------------------------------------------

create or replace function public.enforce_boq_allocation()
returns trigger language plpgsql as $$
declare
    v_line   public.boq_lines%rowtype;
    v_req_uom uuid;
    v_total  numeric;
begin
    if new.approval_status = 'rejected' then
        return new;
    end if;

    select * into v_line from public.boq_lines where boq_line_id = new.boq_line_id for update;
    if v_line.project_id is distinct from new.project_id then
        raise exception 'BOQ line % belongs to another project', new.boq_line_id using errcode = '23503';
    end if;
    if v_line.line_type <> 'item' then
        raise exception 'BOQ line % is a %, not an item', v_line.source_locator, v_line.line_type
            using errcode = '23514';
    end if;
    if v_line.validation_status <> 'valid' then
        raise exception 'BOQ line % is %, only valid lines can be allocated',
            v_line.source_locator, v_line.validation_status using errcode = '23514';
    end if;
    if v_line.normalized_quantity is null or v_line.normalized_uom_id is null then
        raise exception 'BOQ line % has no normalized quantity and unit', v_line.source_locator
            using errcode = '23514';
    end if;
    if new.uom_id <> v_line.normalized_uom_id then
        raise exception 'Allocation unit differs from the unit of BOQ line %', v_line.source_locator
            using errcode = '23514';
    end if;

    select uom_id into v_req_uom from public.inventory_requirements
     where inventory_record_id = new.inventory_record_id and project_id = new.project_id;
    if not found then
        raise exception 'Requirement % belongs to another project', new.inventory_record_id using errcode = '23503';
    end if;
    if v_req_uom <> new.uom_id then
        raise exception 'Allocation unit differs from the requirement unit' using errcode = '23514';
    end if;

    select coalesce(sum(allocated_quantity), 0) into v_total
      from public.requirement_boq_allocations
     where boq_line_id = new.boq_line_id
       and approval_status <> 'rejected'
       and allocation_id <> new.allocation_id;
    if v_total + new.allocated_quantity > v_line.normalized_quantity then
        raise exception 'Allocations for BOQ line % total % but the line quantity is %',
            v_line.source_locator, v_total + new.allocated_quantity, v_line.normalized_quantity
            using errcode = '23514';
    end if;

    if new.approval_status = 'approved' and exists (
        select 1 from public.mapping_exceptions
         where boq_line_id = new.boq_line_id and state in ('open', 'in_review')
    ) then
        raise exception 'BOQ line % has an open mapping exception', v_line.source_locator
            using errcode = '23514';
    end if;
    return new;
end $$;

create trigger requirement_boq_allocations_rules
    before insert or update on public.requirement_boq_allocations
    for each row execute function public.enforce_boq_allocation();

-- Exact reconciliation per line, for acceptance and reporting (A4).
create view public.boq_line_reconciliation
with (security_invoker = true) as
select
    bl.boq_line_id,
    bl.project_id,
    bl.boq_revision_id,
    bl.source_locator,
    bl.normalized_quantity,
    coalesce(sum(a.allocated_quantity) filter (where a.approval_status = 'approved'), 0) as approved_quantity,
    bl.normalized_quantity
      - coalesce(sum(a.allocated_quantity) filter (where a.approval_status = 'approved'), 0) as unallocated_quantity
from public.boq_lines bl
left join public.requirement_boq_allocations a on a.boq_line_id = bl.boq_line_id
where bl.line_type = 'item'
group by bl.boq_line_id;

alter view public.current_boq_quantities set (security_invoker = true);
alter view public.current_ordered_quantities set (security_invoker = true);

------------------------------------------------------------------
-- API role. Signed-in users run as `authenticated` with
-- request.jwt.claim.sub set per request; RLS decides what they see.
-- No DELETE anywhere: history is superseded or cancelled, not removed.
------------------------------------------------------------------

grant usage on schema public to authenticated, service_role;
grant select, insert, update on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
revoke delete on all tables in schema public from authenticated;
grant execute on function public.current_project_ids() to authenticated;
grant execute on function public.current_org_ids() to authenticated;
grant execute on function public.current_admin_org_ids(text[]) to authenticated;

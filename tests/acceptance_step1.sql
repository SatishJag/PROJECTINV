-- =====================================================================
-- tests/acceptance_step1.sql
-- Executable Step 1 acceptance checks A1-A10. Run after all migrations
-- (tests/check_migrations.sh). Everything happens in one transaction that
-- is rolled back, so it can run against any database. Any failed check
-- raises an error; psql -v ON_ERROR_STOP=1 then exits non-zero.
-- =====================================================================

begin;

-- expect_error(label, statement, sqlstate): the statement must fail with that SQLSTATE.
create function pg_temp.expect_error(label text, stmt text, code text) returns void
language plpgsql as $$
begin
    execute stmt;
    raise exception using errcode = 'P0001', message = format('%s FAILED: statement succeeded, expected SQLSTATE %s', label, code);
exception when others then
    if sqlstate = code then
        raise notice '% ok (rejected: %)', label, sqlerrm;
    else
        raise exception '% FAILED: expected SQLSTATE %, got %: %', label, code, sqlstate, sqlerrm;
    end if;
end $$;

create function pg_temp.check(label text, ok boolean) returns void
language plpgsql as $$
begin
    if ok is not true then
        raise exception '% FAILED', label;
    end if;
    raise notice '% ok', label;
end $$;

create function pg_temp.rows_affected(stmt text) returns bigint
language plpgsql as $$
declare n bigint;
begin
    execute stmt;
    get diagnostics n = row_count;
    return n;
end $$;

-- ---------------------------------------------------------------------
-- Scenario data (as the database owner, which bypasses RLS)
-- ---------------------------------------------------------------------
-- ids: org 1.., users 2.., projects 3.., uom 4.., work packages 5..,
-- cost assignments 6.., items 7.., revisions 8.., lines 9.., requirements a..

insert into auth.users (id) values
    ('20000000-0000-0000-0000-000000000001'),   -- BC1 member
    ('20000000-0000-0000-0000-000000000002');   -- BC2 member

insert into public.organizations (organization_id, name)
values ('10000000-0000-0000-0000-000000000001', 'Acceptance Org');

insert into public.organization_memberships (organization_id, user_id, role) values
    ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'member'),
    ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'member');

insert into public.projects (project_id, organization_id, procore_company_id, procore_project_id, project_code, project_name) values
    ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '4283715', '900101', 'BC1', 'Bangkok Central 1'),
    ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '4283715', '900102', 'BC2', 'Bangkok Central 2');

insert into public.project_memberships (project_id, user_id, role) values
    ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'engineer'),
    ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'engineer');

insert into public.units_of_measure (uom_id, organization_id, code, name, measurement_dimension) values
    ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'm',  'metre', 'length'),
    ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'ea', 'each',  'count');

insert into public.work_packages (work_package_id, project_id, code, name, status) values
    ('50000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000001', 'UPS',     'UPS',     'active'),
    ('50000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000001', 'CHILLER', 'Chiller', 'active'),
    ('50000000-0000-0000-0000-000000000021', '30000000-0000-0000-0000-000000000002', 'UPS',     'UPS',     'active');

insert into public.cost_assignments (cost_assignment_id, project_id, work_package_id, procore_budget_code_id, cost_code, cost_type, status) values
    ('60000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000011', 'BC-200', '26-200', 'M', 'approved'),
    ('60000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000012', 'BC-100', '26-100', 'M', 'approved'),
    ('60000000-0000-0000-0000-000000000021', '30000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000021', 'BC-200', '26-200', 'M', 'approved');

insert into public.cost_code_segments (organization_id, project_id, cost_assignment_id, segment_name, segment_value, segment_position) values
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000011', 'cost_code', '26-200', 1),
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000011', 'cost_type', 'M', 2);

insert into public.item_definitions (item_id, organization_id, internal_item_code, name, category, specification, base_uom_id, verification_status) values
    ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'CBL-CU-95', 'Copper cable', 'cable', '{"conductor": "95mm2", "cores": 4}', '40000000-0000-0000-0000-000000000001', 'verified'),
    ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'UPS-500',   'UPS module',   'ups',   '{"rating_kva": 500}',               '40000000-0000-0000-0000-000000000002', 'verified');

-- BC1 BOQ, document DOC-1 revision A (accepted)
insert into public.boq_document_revisions (boq_revision_id, organization_id, project_id, source_tool, procore_document_id, source_revision, file_hash, source_file_name, document_status, processing_status) values
    ('80000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'procore', 'DOC-1', 'A', 'sha256-bc1-a', 'BC1_MEP_BOQ_RevA.xlsx', 'accepted', 'processed');

insert into public.boq_lines (boq_line_id, organization_id, project_id, boq_revision_id, line_no, source_locator, line_type, raw_description, raw_item_code, raw_quantity, raw_uom, normalized_uom_id, normalized_quantity, validation_status) values
    ('90000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 1, 'Electrical!R5',  'heading',  'UPS SYSTEM',                  '2',   null,   null, null, null, 'valid'),
    ('90000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 2, 'Electrical!R6',  'item',     'UPS module 500 kVA',          '2.1', '2',    'nos', '40000000-0000-0000-0000-000000000002', 2, 'valid'),
    ('90000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 3, 'Electrical!R7',  'item',     'Copper cable 4C x 95mm2',     '2.2', '1200', 'm',   '40000000-0000-0000-0000-000000000001', 1200, 'valid'),
    ('90000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 4, 'Electrical!R8',  'subtotal', 'Sub-total UPS',               null,  null,   null, null, null, 'valid'),
    ('90000000-0000-0000-0000-000000000015', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 5, 'General!R3',     'item',     'Copper cable',                'G.1', '300',  'm',   '40000000-0000-0000-0000-000000000001', 300, 'valid');

insert into public.inventory_requirements (inventory_record_id, organization_id, project_id, work_package_id, cost_assignment_id, item_id, uom_id, status, item_description, specification, original_uom, normalized_uom) values
    ('a0000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000011', '60000000-0000-0000-0000-000000000011', '70000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'active', 'UPS module 500 kVA', '500 kVA', 'nos', 'ea'),
    ('a0000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000011', '60000000-0000-0000-0000-000000000011', '70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'active', 'Copper cable 4C x 95mm2', '4C x 95mm2', 'm', 'm'),
    ('a0000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000012', '60000000-0000-0000-0000-000000000012', '70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'active', 'Copper cable 4C x 95mm2', '4C x 95mm2', 'm', 'm');

insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id, approval_status) values
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000011', '90000000-0000-0000-0000-000000000012',    2, '40000000-0000-0000-0000-000000000002', 'approved'),
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000012', '90000000-0000-0000-0000-000000000013',  400, '40000000-0000-0000-0000-000000000001', 'approved'),
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000013', '90000000-0000-0000-0000-000000000013',  800, '40000000-0000-0000-0000-000000000001', 'approved');

insert into public.mapping_exceptions (organization_id, project_id, boq_line_id, exception_type, exception_detail) values
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000015', 'unattributed_work_package', 'Copper cable under GENERAL: no work package in the document');

insert into public.ingestion_runs (organization_id, project_id, boq_revision_id, run_status, extracted_count, item_count, validated_count, exception_count, rejected_count, non_item_count) values
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 'completed', 5, 3, 2, 1, 0, 2);

-- BC2 BOQ: same cable item, plus an item the catalogue has never seen
insert into public.boq_document_revisions (boq_revision_id, organization_id, project_id, source_tool, procore_document_id, source_revision, file_hash, source_file_name, document_status, processing_status) values
    ('80000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'procore', 'DOC-9', 'A', 'sha256-bc2-a', 'BC2_BOQ.pdf', 'accepted', 'processed');

insert into public.boq_lines (boq_line_id, organization_id, project_id, boq_revision_id, line_no, source_locator, line_type, raw_description, raw_item_code, raw_quantity, raw_uom, normalized_uom_id, normalized_quantity, validation_status) values
    ('90000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000021', 1, 'page 3', 'item', 'Copper cable 4C x 95mm2',    '1.1', '500', 'm',   '40000000-0000-0000-0000-000000000001', 500, 'valid'),
    ('90000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000021', 2, 'page 4', 'item', 'Hydrogen fuel-cell UPS skid', '1.2', '1',   'set', '40000000-0000-0000-0000-000000000002',   1, 'valid');

-- A9: the unfamiliar item is recorded as a provisional definition, no catalogue match needed
insert into public.item_definitions (item_id, organization_id, internal_item_code, name, base_uom_id, verification_status)
values ('70000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', null, 'Hydrogen fuel-cell UPS skid', '40000000-0000-0000-0000-000000000002', 'provisional');

insert into public.inventory_requirements (inventory_record_id, organization_id, project_id, work_package_id, cost_assignment_id, item_id, uom_id, status, item_description, original_uom, normalized_uom) values
    ('a0000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000021', '60000000-0000-0000-0000-000000000021', '70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'active', 'Copper cable 4C x 95mm2', 'm', 'm'),
    ('a0000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000021', '60000000-0000-0000-0000-000000000021', '70000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000002', 'active', 'Hydrogen fuel-cell UPS skid', 'set', 'ea');

insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id, approval_status) values
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000021', '90000000-0000-0000-0000-000000000021', 500, '40000000-0000-0000-0000-000000000001', 'approved'),
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000022', '90000000-0000-0000-0000-000000000022',   1, '40000000-0000-0000-0000-000000000002', 'approved');

-- The register query used by A1 (one row per requirement x source line)
create temp view register with (security_invoker = true) as
select ir.project_id, wp.name as work_package, id.name as item, ir.specification, u.code as uom,
       a.allocated_quantity as boq_quantity, cq.accepted_boq_quantity, ca.cost_code, ca.cost_type,
       bl.source_locator, r.procore_document_id, r.source_revision, oq.ordered_quantity
  from public.inventory_requirements ir
  join public.work_packages wp on wp.work_package_id = ir.work_package_id
  join public.item_definitions id on id.item_id = ir.item_id
  join public.units_of_measure u on u.uom_id = ir.uom_id
  join public.cost_assignments ca on ca.cost_assignment_id = ir.cost_assignment_id
  join public.requirement_boq_allocations a on a.inventory_record_id = ir.inventory_record_id and a.approval_status = 'approved'
  join public.boq_lines bl on bl.boq_line_id = a.boq_line_id
  join public.boq_document_revisions r on r.boq_revision_id = bl.boq_revision_id and r.document_status = 'accepted'
  left join public.current_boq_quantities cq on cq.inventory_record_id = ir.inventory_record_id
  left join public.current_ordered_quantities oq on oq.inventory_record_id = ir.inventory_record_id;
grant select on register to authenticated;

-- ---------------------------------------------------------------------
-- A1: BC1 -> UPS shows every BOQ item with full attribution; a BC1 reader sees no BC2 rows
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-0000-0000-000000000001';

select pg_temp.check('A1 BC1 -> UPS lists both UPS items',
    (select count(*) = 2 from register where project_id = '30000000-0000-0000-0000-000000000001' and work_package = 'UPS'));
select pg_temp.check('A1 every UPS row has spec, UOM, quantity, cost assignment and source locator',
    (select bool_and(specification is not null and uom is not null and boq_quantity is not null
                     and cost_code = '26-200' and cost_type = 'M' and source_locator is not null)
       from register where work_package = 'UPS'));
select pg_temp.check('A1 BC1 reader sees no BC2 rows',
    (select count(*) = 0 from register where project_id = '30000000-0000-0000-0000-000000000002')
    and (select count(*) = 0 from public.boq_lines where project_id = '30000000-0000-0000-0000-000000000002')
    and (select count(*) = 0 from public.work_packages where project_id = '30000000-0000-0000-0000-000000000002')
    and (select count(*) = 0 from public.projects where project_id = '30000000-0000-0000-0000-000000000002'));
select pg_temp.check('A1 BC1 reader sees BC1 only',
    (select count(distinct project_id) = 1 from register));

-- A7 (RLS half): a BC1 member cannot write into BC2 or delete anything
select pg_temp.expect_error('A7 BC1 member cannot add a BC2 work package',
    $$insert into public.work_packages (project_id, code, name) values ('30000000-0000-0000-0000-000000000002', 'GEN', 'Generator')$$, '42501');
select pg_temp.check('A7 BC1 member cannot update BC2 rows',
    pg_temp.rows_affected($$update public.boq_lines set raw_description = 'x' where project_id = '30000000-0000-0000-0000-000000000002'$$) = 0);
select pg_temp.expect_error('A7 no DELETE for signed-in users',
    $$delete from public.boq_lines where project_id = '30000000-0000-0000-0000-000000000001'$$, '42501');

reset role;
reset request.jwt.claim.sub;

-- ---------------------------------------------------------------------
-- A2: re-importing the same document revision changes nothing
-- ---------------------------------------------------------------------
select pg_temp.expect_error('A2 same document revision cannot be imported twice',
    $$insert into public.boq_document_revisions (organization_id, project_id, source_tool, procore_document_id, source_revision, file_hash, document_status)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'procore', 'DOC-1', 'A', 'sha256-other', 'received')$$, '23505');
select pg_temp.expect_error('A2 same file cannot be imported twice under another name',
    $$insert into public.boq_document_revisions (organization_id, project_id, source_tool, procore_document_id, source_revision, file_hash, document_status)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'upload', 'copy', 'A', 'sha256-bc1-a', 'received')$$, '23505');
select pg_temp.expect_error('A2 same source line cannot be extracted twice',
    $$insert into public.boq_lines (organization_id, project_id, boq_revision_id, source_locator, line_type, raw_description)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 'Electrical!R7', 'item', 'Copper cable 4C x 95mm2')$$, '23505');
select pg_temp.check('A2 quantities unchanged',
    (select accepted_boq_quantity = 400 from public.current_boq_quantities where inventory_record_id = 'a0000000-0000-0000-0000-000000000012'));

-- ---------------------------------------------------------------------
-- A4: a line split across two work packages reconciles exactly
-- ---------------------------------------------------------------------
select pg_temp.check('A4 split allocations equal the source quantity (800 + 400 = 1200)',
    (select approved_quantity = 1200 and unallocated_quantity = 0
       from public.boq_line_reconciliation where boq_line_id = '90000000-0000-0000-0000-000000000013'));
select pg_temp.expect_error('A4 allocating beyond the source quantity fails',
    $$update public.requirement_boq_allocations set allocated_quantity = 1200
       where inventory_record_id = 'a0000000-0000-0000-0000-000000000012'$$, '23514');
select pg_temp.expect_error('A4 allocation in a different unit fails',
    $$insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000011', '90000000-0000-0000-0000-000000000013', 1, '40000000-0000-0000-0000-000000000002')$$, '23514');

-- ---------------------------------------------------------------------
-- A5: an unattributable line goes to mapping_exceptions, never silently mapped
-- ---------------------------------------------------------------------
select pg_temp.check('A5 GENERAL copper cable has an open exception and no allocation',
    (select count(*) = 1 from public.mapping_exceptions
      where boq_line_id = '90000000-0000-0000-0000-000000000015' and state = 'open' and exception_type = 'unattributed_work_package')
    and (select count(*) = 0 from public.requirement_boq_allocations where boq_line_id = '90000000-0000-0000-0000-000000000015'));
select pg_temp.expect_error('A5 approving an allocation while the exception is open fails',
    $$insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id, approval_status)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000012', '90000000-0000-0000-0000-000000000015', 300, '40000000-0000-0000-0000-000000000001', 'approved')$$, '23514');
select pg_temp.expect_error('A5 resolving an exception needs a resolution',
    $$update public.mapping_exceptions set state = 'resolved' where boq_line_id = '90000000-0000-0000-0000-000000000015'$$, '23514');
select pg_temp.check('A5 ingestion run accounts for every extracted line',
    (select item_count = validated_count + exception_count + rejected_count and extracted_count = item_count + non_item_count
       from public.ingestion_runs where boq_revision_id = '80000000-0000-0000-0000-000000000011'));

-- ---------------------------------------------------------------------
-- A6: headings and subtotals are excluded from the register
-- ---------------------------------------------------------------------
select pg_temp.expect_error('A6 a heading cannot be allocated',
    $$insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000011', '90000000-0000-0000-0000-000000000011', 1, '40000000-0000-0000-0000-000000000002')$$, '23514');
select pg_temp.expect_error('A6 a subtotal cannot be allocated',
    $$insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000011', '90000000-0000-0000-0000-000000000014', 1, '40000000-0000-0000-0000-000000000002')$$, '23514');
select pg_temp.check('A6 no non-item line reaches the register',
    (select count(*) = 0 from public.requirement_boq_allocations a join public.boq_lines bl using (boq_line_id) where bl.line_type <> 'item'));

-- ---------------------------------------------------------------------
-- A7: cross-project references fail at the database (composite FKs)
-- ---------------------------------------------------------------------
select pg_temp.expect_error('A7 BC1 requirement cannot use a BC2 work package',
    $$insert into public.inventory_requirements (organization_id, project_id, work_package_id, cost_assignment_id, item_id, uom_id)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000021', '60000000-0000-0000-0000-000000000011', '70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001')$$, '23503');
select pg_temp.expect_error('A7 BC1 requirement cannot use a BC2 cost assignment',
    $$insert into public.inventory_requirements (organization_id, project_id, work_package_id, cost_assignment_id, item_id, uom_id)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000011', '60000000-0000-0000-0000-000000000021', '70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001')$$, '23503');
select pg_temp.expect_error('A7 BC1 requirement cannot take a BC2 BOQ line',
    $$insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000012', '90000000-0000-0000-0000-000000000021', 1, '40000000-0000-0000-0000-000000000001')$$, '23503');
select pg_temp.expect_error('A7 a BC1 cost assignment cannot point at a BC2 work package',
    $$insert into public.cost_assignments (project_id, work_package_id, cost_code)
      values ('30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000021', '26-900')$$, '23503');

-- ---------------------------------------------------------------------
-- A8: one item definition shared across projects; quantities stay separate
-- ---------------------------------------------------------------------
select pg_temp.check('A8 copper cable is one definition used by three requirements in two projects',
    (select count(*) = 3 and count(distinct project_id) = 2 from public.inventory_requirements where item_id = '70000000-0000-0000-0000-000000000001'));
select pg_temp.check('A8 per-project cable quantities stay separate (BC1 1200, BC2 500)',
    (select array_agg(q order by p) = array[1200, 500]::numeric[]
       from (select ir.project_code p, sum(cq.accepted_boq_quantity) q
               from public.current_boq_quantities cq
               join (select r.inventory_record_id, pr.project_code from public.inventory_requirements r join public.projects pr using (project_id)
                      where r.item_id = '70000000-0000-0000-0000-000000000001') ir using (inventory_record_id)
              group by ir.project_code) t));
select pg_temp.check('A8 the item definition carries no quantity',
    (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'item_definitions' and column_name like '%quantity%'));

-- ---------------------------------------------------------------------
-- A9: an unfamiliar item is recorded anyway
-- ---------------------------------------------------------------------
select pg_temp.check('A9 unfamiliar BC2 item is in the register as provisional',
    (select count(*) = 1 from register rg join public.item_definitions id on id.name = rg.item
      where rg.item = 'Hydrogen fuel-cell UPS skid' and id.verification_status = 'provisional' and rg.accepted_boq_quantity = 1));

-- ---------------------------------------------------------------------
-- A10: ordered_quantity is NULL for BOQ-only data and lump-sum commitments
-- ---------------------------------------------------------------------
select pg_temp.check('A10 BOQ-only data has no ordered quantity',
    (select bool_and(ordered_quantity is null) from register));

insert into public.commitments (commitment_id, organization_id, project_id, procore_commitment_id, commitment_type, commitment_number, status)
values ('b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'PO-1', 'purchase_order', 'BC1-PO-001', 'active');
select pg_temp.expect_error('A10 a lump-sum line cannot carry an ordered quantity',
    $$insert into public.commitment_lines (organization_id, project_id, commitment_id, procore_line_id, description, ordered_quantity, uom_id, line_type)
      values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'L1', 'UPS supply, lump sum', 2, '40000000-0000-0000-0000-000000000002', 'lump_sum')$$, '23514');
insert into public.commitment_lines (organization_id, project_id, commitment_id, procore_line_id, description, line_type)
values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'L1', 'UPS supply, lump sum', 'lump_sum');
select pg_temp.check('A10 the lump-sum commitment leaves ordered quantity NULL',
    (select ordered_quantity is null from register where item = 'UPS module'));

-- ---------------------------------------------------------------------
-- A3: a revised BOQ keeps the old revision; current quantity comes from the accepted revision only
-- ---------------------------------------------------------------------
insert into public.boq_document_revisions (boq_revision_id, organization_id, project_id, source_tool, procore_document_id, source_revision, file_hash, source_file_name, document_status, processing_status)
values ('80000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'procore', 'DOC-1', 'B', 'sha256-bc1-b', 'BC1_MEP_BOQ_RevB.xlsx', 'received', 'processed');
insert into public.boq_lines (boq_line_id, organization_id, project_id, boq_revision_id, line_no, source_locator, line_type, raw_description, raw_item_code, raw_quantity, raw_uom, normalized_uom_id, normalized_quantity, validation_status)
values ('90000000-0000-0000-0000-000000000016', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000012', 3, 'Electrical!R7', 'item', 'Copper cable 4C x 95mm2', '2.2', '1500', 'm', '40000000-0000-0000-0000-000000000001', 1500, 'valid');
insert into public.requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id, approval_status) values
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000012', '90000000-0000-0000-0000-000000000016',  500, '40000000-0000-0000-0000-000000000001', 'approved'),
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000013', '90000000-0000-0000-0000-000000000016', 1000, '40000000-0000-0000-0000-000000000001', 'approved');

select pg_temp.check('A3 before acceptance the current quantity is still revision A (400)',
    (select accepted_boq_quantity = 400 from public.current_boq_quantities where inventory_record_id = 'a0000000-0000-0000-0000-000000000012'));
select pg_temp.expect_error('A3 two accepted revisions of one document are refused',
    $$update public.boq_document_revisions set document_status = 'accepted' where boq_revision_id = '80000000-0000-0000-0000-000000000012'$$, '23505');

update public.boq_document_revisions set document_status = 'superseded' where boq_revision_id = '80000000-0000-0000-0000-000000000011';
update public.boq_document_revisions set document_status = 'accepted'   where boq_revision_id = '80000000-0000-0000-0000-000000000012';

select pg_temp.check('A3 current quantity is revision B (500), not A + B (900)',
    (select accepted_boq_quantity = 500 and source_revision = 'B' from public.current_boq_quantities where inventory_record_id = 'a0000000-0000-0000-0000-000000000012'));
select pg_temp.check('A3 revision A and its lines are kept as superseded',
    (select document_status = 'superseded' from public.boq_document_revisions where boq_revision_id = '80000000-0000-0000-0000-000000000011')
    and (select count(*) = 5 from public.boq_lines where boq_revision_id = '80000000-0000-0000-0000-000000000011'));

select 'A1-A10 acceptance checks passed' as result;

rollback;

-- =====================================================================
-- tests/acceptance_step1.sql
-- Step 1 acceptance checks (A1-A10) from the approved foundation plan.
--
-- These are scenario templates: apply against a test Supabase project
-- with two projects (Bangkok Central 1/2) and two users (BC1 member,
-- BC2 member). Each check states the expectation and the SQL to prove
-- or disprove it. Run as postgres (service role) to set up scenario
-- data, then re-run the RLS-specific checks with JWT claims set.
-- =====================================================================

------------------------------------------------------------------
-- A1 - Project/work-package visibility with full attribution
------------------------------------------------------------------
-- Given: accepted BOQ revision for BC1 with UPS package items.
-- Then: selecting BC1 -> UPS shows every BOQ-derived item with
-- specification, UOM, quantity, cost assignment and source locator,
-- and BC2 records are INVISIBLE to a BC1 reader.

-- As a BC1 member (row-level security active):
-- SELECT ir.inventory_record_id, ip.name AS item, id.specification,
--        u.code AS uom, cq.accepted_boq_quantity, ca.cost_code,
--        bl.source_locator
--   FROM inventory_requirements ir
--   JOIN work_packages wp USING (work_package_id)
--   JOIN item_definitions id USING (item_id)
--   JOIN units_of_measure u USING (uom_id)
--   JOIN current_boq_quantities cq USING (inventory_record_id)
--   JOIN cost_assignments ca USING (cost_assignment_id)
--   LEFT JOIN requirement_boq_allocations ar USING (inventory_record_id)
--   LEFT JOIN boq_lines bl USING (boq_line_id)
--  WHERE wp.project_id = '<bc1-project-uuid>' AND wp.name = 'UPS';
-- PASS: rows returned, every row has source_locator, zero BC2 rows.
-- FAIL: any BC2 row appears.

------------------------------------------------------------------
-- A2 - Reprocessing idempotence
------------------------------------------------------------------
-- Re-import of the same document revision changes nothing.

-- A second INSERT into boq_document_revisions with identical
-- (project_id, source_tool, procore_document_id, source_revision)
-- must fail with a unique violation (23505).
-- PASS: insert rejected; ingestion run marks processing_status='processed'
-- with a duplicate document_status; quantity totals unchanged:
-- SELECT accepted_boq_quantity FROM current_boq_quantities; (same as before)

------------------------------------------------------------------
-- A3 - Revision supersession, no double counting
------------------------------------------------------------------
-- Given: BOQ rev 1 accepted (qty 10), then rev 2 accepted (qty 12).
-- Then: current quantity is 12, not 22.

-- SELECT accepted_boq_quantity FROM current_boq_quantities
--  WHERE inventory_record_id = '<req-uuid>';
-- PASS: 12. rev 1's document_status becomes 'superseded'.
-- FAIL: 22.

------------------------------------------------------------------
-- A4 - Line split across work packages reconciles exactly
------------------------------------------------------------------
-- Given: BOQ line "Copper cable spec A, 1200 m" attributed to both
-- Chiller (800 m) and UPS (400 m).
-- Then: allocations sum to exactly 1200 and no requirement row
-- contains the full 1200 for both packages.

-- SELECT SUM(allocated_quantity) FROM requirement_boq_allocations
--  WHERE boq_line_id = '<line-uuid>';
-- PASS: 1200.000000 exactly.
-- FAIL: 1600 (full quantity copied into each package).

------------------------------------------------------------------
-- A5 - Unattributable line lands in the exception queue
------------------------------------------------------------------
-- Given: a cable line with no package attribution in the document.
-- Then: a mapping_exceptions row exists and NO inventory requirement
-- was silently created from it.

-- SELECT * FROM mapping_exceptions WHERE boq_line_id = '<line-uuid>';
-- PASS: one open row with exception_type='unattributed_work_package'.
-- PASS: no approved allocation referencing that line.

------------------------------------------------------------------
-- A6 - Headings and subtotals excluded by construction
------------------------------------------------------------------
-- SELECT COUNT(*) FROM boq_lines WHERE line_type <> 'item'
--   AND boq_line_id IN (SELECT boq_line_id
--                         FROM requirement_boq_allocations);
-- PASS: 0.

------------------------------------------------------------------
-- A7 - Cross-project reference impossible
------------------------------------------------------------------
-- Attempt: insert a BC1 inventory requirement referencing a BC2
-- work package / cost assignment / BOQ line.
-- PASS: composite FK violation; the insert fails.
-- attempt: as BC1 member, SELECT from BC2 work packages.
-- PASS: zero rows (RLS).

------------------------------------------------------------------
-- A8 - Shared item, separate project quantities
------------------------------------------------------------------
-- Given: "Copper cable spec A" exists in BC1/Chiller, BC1/UPS and
-- BC2/UPS referencing one item_definition.
-- Then: three inventory_requirements rows; per-project totals remain
-- separate; the item definition itself carries no quantity.
-- PASS: SELECT project_id, SUM(accepted_boq_quantity)
--         FROM current_boq_quantities cq
--         JOIN inventory_requirements ir USING (inventory_record_id)
--        GROUP BY project_id; returns per-project sums.

------------------------------------------------------------------
-- A9 - Unfamiliar item still recorded
------------------------------------------------------------------
-- Given: BC2 has an item unknown to the catalogue.
-- Then: extraction records it - new item_definitions.row with
-- verification_status='provisional' (or 'unverified') - and the BOQ
-- line is retained. Catalogue match is NOT a prerequisite.
-- PASS: item row + valid line + allocation exist with provisional status.

------------------------------------------------------------------
-- A10 - Lump-sum commitment never invents quantity
------------------------------------------------------------------
-- Given: a lump-sum commitment line for BC1 generator package.
-- Then: ordered_quantity is NULL; current_ordered_quantities shows
-- nothing derived from the amount.
-- PASS: inserting a lump-sum line WITH ordered_quantity violates
-- lump_sum_no_quantity constraint; without it, the view omits/keeps
-- NULL for that requirement.

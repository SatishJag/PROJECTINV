# Step 1 Foundation Plan — Project Inventory Register (Supabase PostgreSQL)

**Status:** Approved plan, ready for implementation
**Source basis:** "Step 1 of Inventory Intelligence" design dialogue + PCX PRD 001 (Equipment Procurement and Asset Lifecycle Intelligence) for context
**Key decisions locked:**
- **Platform: Supabase PostgreSQL** (supersedes PCX PRD 001 §26/§28 Azure SQL proposal; PRD store choice is recorded as revised by later planning)
- **Full schema up front** — all ~17+ tables created in the first build, including dormant procurement/component/quality tables, so FK targets exist from day one and later steps never fork identities
- **First deliverable: SQL migration files** (ordered, each independently applicable)
- Names from the Step 1 document (`work_packages`, `inventory_requirements`, `commitments`, ...) are **canonical**; the PRD's `alm`/`pcx` names map to them in the reconciliation note

---

## Design principles (from the Step 1 document, treated as requirements)

1. **Three different records, always separate:** item definition (a type/model) vs. project inventory requirement (a project/work-package need) vs. physical unit (one serial) vs. physical component (one serial child). Immutable UUID PKs; serials, MPNs, supplier codes, Procore IDs are *additional identifiers, never substitutes*.
2. **BOQ quantity ≠ ordered quantity.** `ordered_quantity` stays unknown until supported by purchase evidence. Reading a BOQ never implies purchase or receipt.
3. **Full Procore WBS/budget context retained** (cost code + cost type + other configured segments). "Work package" is our equipment package — never auto-mapped to Procore's timekeeping "Task Code."
4. **AI proposes, never decides.** Item matching and work-package attribution proposals always land in an exception queue; identical descriptions do not prove identical specifications.
5. **Allocation tables in both directions:** BOQ line → requirement AND requirement → commitment line. Allocation quantities reconcile to source; the full quantity is never copied into each package.
6. **Units preserved:** source UOM kept; conversions only via controlled, dimension-checked conversion evidence; mm² conductor size never becomes a quantity unit; "one lot" never becomes an invented item count.
7. **Expected assembly vs. installed structure** are separate (`assembly_definitions` vs `installation_history`); BOQ indentation does not prove physical membership.
8. **No silent duplication:** stable source keys + file hashes + line locators make reprocessing idempotent; revised BOQs preserve history; current quantity derives only from the accepted revision.
9. **Project isolation enforced in the database** (RLS), not just screen filters.
10. **Supplier attribution ≠ BOQ submitter.** The LDC submitting a BOQ is not the equipment supplier; suppliers come from purchase evidence.
11. **Failure evidence ≠ supplier fault.** Failure records capture product, exposure, cause and responsibility; one incident's repeated tests/returns must not count as independent failures.

---

## Migration series

### `0001_core_reference.sql` — organization & reference data
- `projects`: internal UUID PK, `procore_company_id`, `procore_project_id`, `project_code`, `project_name`, `status`.
  - **Unique:** (`organization_id`, `procore_company_id`, `procore_project_id`)
- `units_of_measure`: `uom_id` PK, `code` (unique), `name`, `measurement_dimension`
- `uom_conversions` *(new table — closes UOM-conversion gap)*:
  - `from_uom_id`, `to_uom_id`, `factor numeric(28,12)`, evidence/approval references, validity period
  - **Unique:** (`from_uom_id`, `to_uom_id`); CHECK: both UOMs share the same `measurement_dimension`
- **Shared audit fields on every business table:** `organization_id`, `created_at timestamptz`, `updated_at`, `created_by`, `record_version` (e.g. `generated always as` row version / `xid8`)

### `0002_structure.sql` — WBS & cost context
- `work_packages`: project-scoped, self-referencing `parent_work_package_id`, `source_wbs_reference`, `code`, `name`, `status`
- `cost_assignments`: approved work-package ↔ Procore budget-code context; `procore_budget_code_id`, `cost_code`, `cost_type`, `status`, validity period
- `cost_code_segments`: normalized child table for configured Procore segments (`cost_assignment_id`, segment name, value, position) + JSONB on the parent for unconfigured extras
- **Composite project-consistent FKs:** every project-scoped child carries `project_id` with an FK `(project_id, parent_key)` to the parent, so a Bangkok Central 2 row can never reference a Bangkok Central 1 parent by construction

### `0003_items.sql` — catalogue identity
- `item_definitions`: `internal_item_code` (unique per org), `name`, `category`, `manufacturer_part_number`, `specification` (JSONB, typed attributes), `base_uom_id` FK, `tracking_mode` (`serialized | batch | bulk | not_tracked`), `verification_status`
- `item_aliases`: `item_id` FK, `issuer`, `alias_type`, `alias_value`, `source_reference`
  - **Unique:** (`issuer`, `alias_type`, `alias_value`) — matching *proposes*, never establishes identity

### `0004_boq.sql` — documents, lines, register
- `boq_document_revisions`: `project_id` FK, `source_tool`, `procore_document_id`, `source_revision`, `file_hash`
  - **Unique:** (`project_id`, `procore_document_id`, `source_revision`) → re-import is idempotent
  - `document_status`, `processing_status`
- `boq_lines`: `boq_revision_id` FK, `parent_source_line_id` (self, for section headings), `source_locator` (sheet/row or PDF page), `raw_description`, `raw_item_code`, `raw_quantity`, `raw_uom`, **`line_type` (`item | heading | subtotal | note`)**, `validation_status`
  - **Unique:** (`boq_revision_id`, `source_locator`)
  - Headings/subtotals excluded from register by construction
- `inventory_requirements` (the project inventory register's central row): `project_id`, `work_package_id`, `cost_assignment_id`, `item_id`, `uom_id` FKs, `status`; optional retained `item_description`/`specification`/`original_uom`/`normalized_uom` snapshots
- `requirement_boq_allocations`: `inventory_record_id` FK, `boq_line_id` FK, `allocated_quantity`, `uom_id` FK, `approval_status`
  - Validation: allocation quantities reconcile to the source line quantity (sum of allocations ≤ line quantity, exactness enforced at acceptance)
  - **Current BOQ quantity = derived from the accepted revision's allocations only** (view or computed rule) — old revisions never summed in

### `0005_commitments.sql` — procurement (created now, dormant until Step 2)
- `suppliers`: `supplier_id`, `procore_vendor_id`, `supplier_code`, `legal_name`, `status`
- `commitments`: `project_id` FK, `procore_commitment_id`, `commitment_type`, `commitment_number`, `supplier_id` FK, `status`, `source_revision`
- `commitment_lines`: `commitment_id` FK, `procore_line_id`, `description`, `item_id` FK *where resolved* (nullable), `ordered_quantity` (nullable), `uom_id`, `line_type`
  - **Unique:** project/source namespace + commitment + source line ID
  - **Lump-sum rule:** no reliable item quantity ⇒ `ordered_quantity` remains NULL; never derived from amount
- `requirement_commitment_allocations`: `inventory_record_id` FK, `commitment_line_id` FK, `allocated_quantity`, `uom_idFK`, `status`
  - Splits supported both ways: one requirement via several commitments; one commitment line covering several requirements
  - Adapter fields must be validated against the actual Procore environment before implementation (discovery, per PRD §3)

### `0006_physical.sql` — units, components, provenance (created now, dormant)
- `assembly_definitions` (expected structure): `parent_item_id`, `child_item_id`, `slot_code`, `quantity_per_parent`, `uom_id`, `revision`, `relationship_type`
- `asset_units` (individual units): `item_id`, `origin_inventory_record_id`, `serial_number`, `lifecycle_status`
  - **Serial uniqueness enforced only within a verified manufacturer/model namespace** (not globally)
- `installation_history` (actual structure): `parent_asset_unit_id`, `child_asset_unit_id`, `slot_code`, `installed_at`, `removed_at`, `reason`, `evidence_reference`
  - Integrity: at most one physical parent per component at any instant (temporal overlap checks on full intervals, not just open rows); occupied-slot and circular-relationship prevention
- `asset_supply_links` (provenance): `asset_unit_id`, `commitment_line_id`, `supplier_id`, `manufacturer_id`, `supply_role`, `supplied_with_asset_id`, `evidence_reference`
- `tracking_mode`-aware: batch/lot items (e.g. oil) are consumption/lot records, never fabricated serial children; pads/installation work classified per engineering policy

### `0007_quality.sql` — failure & recovery evidence (created now, dormant)
- `test_results`: affected unit/lot, project, test type, test date, outcome, evidence
- `failure_cases`: affected unit/lot, related test, symptom, suspected/confirmed cause, responsibility status
  - Incident discipline: repeated tests/returns tied to one incident do **not** become independent failures
- `recovery_actions`: failure case FK, action type, return reference, repair outcome, replacement unit, dates, evidence
- Trace chain implemented via joins: failed component → installation → project/work package → supply evidence → commitment → supplier (commercial supplier / manufacturer / installer / maintainer kept separate)

### `0008_exceptions_and_audit.sql` *(new — closes exception-queue gap)*
- `mapping_exceptions`: `boq_line_id` FK, `project_id` FK, `exception_type`, `proposed_mapping` JSONB, `state` (`open | in_review | resolved | dismissed`), `owner`, `due_at`, `resolution`, `resolved_by`, `resolved_at`
  - "Copper cable" with no package attribution lands here, never silently attributed
- `ingestion_runs`: document revision FK, started/completed timestamps, counts: lines extracted / validated / rejected / unmapped (the document's reconciliation control made auditable)

---

## Row-Level Security — project isolation in the database

- `project_memberships` mapping: Supabase auth user → organization → project (plus role)
- RLS enabled on **all** business tables; each carries `project_id` directly or via one-hop FK
- Policy essence: `project_id in (select project_id from project_memberships where user_id = auth.uid())`
- Result: a Bangkok Central 1 principal cannot `SELECT`, update or even see Bangkok Central 2 rows — enforced at the database, independent of UI
- Dormant tables get RLS policies **now**, so Step 2 does not retrofit security
- Worker/service role paths (ingestion pipeline) run with explicit, least-privilege role grants, not unrestricted client access

---

## Acceptance checks (encoded as test SQL / scenarios)

| # | Scenario |
|---|----------|
| A1 | Select Bangkok Central 1 → UPS: every BOQ-derived item visible with specification, UOM, quantity, cost assignment, source locator. Bangkok Central 2 records invisible to a BC1 reader |
| A2 | Re-import of the same document revision changes nothing (idempotent by project+document+revision+file hash+line locator) |
| A3 | Revised BOQ preserves the prior revision; current quantities derive only from the accepted revision's allocations; old revisions never summed |
| A4 | One BOQ line split across two work packages reconciles exactly to the source quantity — full quantity never copied into each |
| A5 | Unattributable line ("copper cable" with no package context) lands in `mapping_exceptions`, not silently mapped |
| A6 | Headings and subtotal rows are excluded from the register by construction |
| A7 | A BC1 record cannot reference a BC2 work package/cost assignment/BOQ line — FK-composite + RLS fail the write |
| A8 | Same cable item ID shared across projects/work packages; project and package quantities remain separate |
| A9 | Unfamiliar item in BC2 recorded anyway (new item definition or provisional classification); catalogue match not a prerequisite |
| A10 | `ordered_quantity` stays NULL for lump-sum commitments and BOQ-only data |

---

## Explicitly deferred (later steps; FK targets already exist)

- Ingestion pipeline implementation (parse Excel/PDF, extract, line classification, publish) — schema and ingestion-run table exist now
- Procore adapter (document API, commitment/line resources, budget-code segments) — validate actual fields/permissions against tenant first
- Reservation, transfers, availability, arrival forecasting, handbook, FM cost feedback, benchmarking — later steps per PRD roadmap
- Reconciliation note (one page): maps these tables to PRD `alm`/`pcx` entity names and records the Supabase-over-Azure-SQL platform decision so Step 2 / PRD readers never fork identities

## Migration discipline (per Step 1 document §6)

Versioned migrations only: add column/table → update behaviour → backfill where evidence supports → validate → add stronger constraints when appropriate. Typed columns (`numeric` scales) for money/quantities/UOM factors; JSONB for category-specific specifications — never as a substitute for foreign keys.

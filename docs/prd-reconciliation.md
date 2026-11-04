# PRD Reconciliation — PCX PRD 001 ↔ Step 1 Foundation

**Purpose:** prevent identity forks between the Step 1 Supabase foundation and the earlier product specification PCX PRD 001 "Equipment Procurement and Asset Lifecycle Intelligence" v1.0 (30 Oct 2026). Read together with `docs/step1-foundation-plan.md`.

## 1. Platform decision

| Decision | Status |
|---|---|
| PRD §26/§28 proposed **Azure SQL** (`alm` + `pcx` schemas) | **Superseded** — implementation foundation is **PostgreSQL on Supabase** (approved 31 Oct 2026 session) |
| PRD's proposed `pcx` entities for planning/evaluation/handbooks | **Not rejected** — deferred to later steps; their FK *targets* already exist as Step 1 identities |

## 2. Entity name mapping

| PCX PRD 001 (proposed) | Step 1 Supabase foundation | Notes |
|---|---|---|
| `alm.requirement` (functional need) | `inventory_requirements` | Same concept: stable functional/project need, quantities derived via allocations, never stored on the row |
| `pcx.requirement_revision` | `boq_document_revisions` + allocation filtering by accepted revision | Step 1 revises at document level; per-line revision semantics can be added later without re-keying |
| `alm/pcx` project scoping | `projects` (+ `procore_company_id`, `procore_project_id` as opaque identifiers) | Procore IDs are additional identifiers, never keys |
| Work package / task | `work_packages` | Explicit: NOT Procore's timekeeping "Task Code" |
| Budget code context incl. segments | `cost_assignments` + `cost_code_segments` + `segment_context` JSONB | Full configured segment context retained |
| Catalogue / item | `item_definitions` + `item_aliases` | Identical descriptions never imply identical specification |
| Physical unit (`alm` unit UUID) | `asset_units` (+ serial bindings under verified namespaces) | PRD's permanent unit UUID survives transfer |
| Parent/slot temporal structure | `assembly_definitions` (expected) ↔ `installation_history` (actual) + two exclusion constraints | Matches PRD §19 slot/cycle/overlap rules |
| Commitments / PO allocation | `commitments` / `commitment_lines` / `requirement_commitment_allocations` | Lump-sum rule: ordered quantity stays unknown |
| Exception queue | `mapping_exceptions` + `ingestion_runs` | PRD §34 quality/freshness controls land here in Step 1 |

## 3. Rules carried forward unchanged

1. Three-record separation: item definition / project requirement / physical unit / physical component — immutable UUIDs.
2. BOQ quantity ≠ ordered quantity; ordered appears only with purchase evidence.
3. Allocation reconciliation both directions (BOQ line ↔ requirement ↔ commitment line).
4. History is never silois rewritten: supersede instead of overwrite; RLS deletes denied by default.
5. Project isolation enforced in the database (RLS via memberships).

## 4. What Step 2 inheritors must NOT do

- Re-key any entity to a Procore ID, serial or supplier code.
- Sum quantities across BOQ revisions.
- Let an item match or work-package attribution ship without going through `mapping_exceptions` for approval.
- Create physical unit children for `tracking_mode <> 'serialized'` items.
- Bypass `ingestion_runs` accounting when extraction behaviour changes.

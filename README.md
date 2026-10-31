# PROJECTINV — Inventory Intelligence, Step 1: Project Inventory Register

The foundation of the equipment/material intelligence product: a **reliable
relationship between the Procore project, its WBS work package and cost code,
and every item extracted from the BOQ** — with full source evidence.

Status: **schema baseline implemented as Supabase SQL migrations.** The live
Supabase database and the BOQ ingestion pipeline are future work.

## Design basis

- `docs/step1-foundation-plan.md` — approved foundation plan (identities, rules, migrations, acceptance checks)
- `docs/prd-reconciliation.md` — how this maps back to PCX PRD 001 and what later steps must not re-key

## Core rules (short list)

1. **Three different records:** item definition / project requirement / physical unit / physical component. Immutable UUIDs; serials, part numbers, and Procore IDs are additional identifiers, never keys.
2. **BOQ quantity ≠ ordered quantity.** Ordered stays unknown until purchase evidence exists.
3. **Explicit allocations both ways** (BOQ line → requirement, requirement → commitment line); quantities reconcile, never copied in full.
4. **Project isolation in the database** (RLS), not screen filters.
5. **AI proposes, never decides.** Ambiguity lands in `mapping_exceptions`.
6. **Idempotent reprocessing** (revision key + file hash + line locator); revisions supersede, never sum.
7. Full Procore budget-code segment context is retained ("task" here = equipment work package, never Procore's timekeeping Task Code).

## Repository layout

```
supabase/migrations/
  0001_core_reference.sql          organizations, memberships, projects, UOM + conversions
  0002_structure.sql               work packages, cost assignments, cost-code segments
  0003_items.sql                   item definitions, aliases
  0004_boq.sql                     BOQ revisions/lines, inventory register, allocations, derived views
  0005_commitments.sql             suppliers, commitments, ordered-quantity evidence   (dormant until Step 2)
  0006_physical.sql                asset units, assembly, installation history, supply links (dormant)
  0007_quality.sql                 test results, failure cases, recovery actions         (dormant)
  0008_exceptions_and_audit.sql    mapping exceptions, ingestion-run audit
tests/acceptance_step1.sql         A1-A10 acceptance scenario templates
```

## Applying the migrations to a Supabase project

```bash
# Option A - Supabase CLI
supabase link --project-ref <ref>
supabase db push

# Option B - plain psql against the Supabase session pooler
psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_core_reference.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/0002_structure.sql
# ... in order, 0001 through 0008
```

Migrate strictly in order; later files depend on earlier ones.

## Security model

- RLS is enabled on **every** business table.
- `organization_memberships` / `project_memberships` (referencing `auth.users`) drive
  security-definer helper functions `current_org_ids()` / `current_project_ids()`.
- DELETE is denied by default on business tables — supersede status instead.
- The Supabase `service_role` (used by ingestion workers / Procore adapters) bypasses
  RLS by design; grant it explicitly only to service code.
- Seed an org, projects and memberships before testing the RLS behaviour.

## Definition of done for Step 1

Selecting *Bangkok Central 1 → UPS* shows every BOQ-derived item, its specification,
UOM, quantity, cost assignment and source evidence — with Bangkok Central 2's records
separately attributable. Acceptance scenarios A1–A10 in `tests/` encode the checks.

## Next steps (not in this repo's Step 1 scope)

- Supabase project provisioning + first tenant seed
- BOQ ingestion pipeline (parse → extract → classify → validate → publish/exception)
- Procore adapter (documents, commitment line items, budget codes) — validate actual
  tenant fields/permissions first
- Then: reservations, transfers, failure/supplier analysis, arrival forecasting

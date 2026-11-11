# Step 1 → PCX feed — design

**Status:** draft for review · **Date:** 2026-11-11
**Part of:** Phase 1, piece 1 of 3 (1 Step 1 feed → 2 approval correctness → 3 benchmark & reuse correctness).
**Governing spec:** `docs/spec/PCX-PRD-001-product-specification.md` (FR01, FR02, B01.2, B01.3.3).

## 1. Purpose

PCX creates requirements from a hand-built JSON BOQ import. Step 1 (`step1-register/`) already reads real BOQ
files (xlsx/csv/text PDF), maps every line to a Procore WBS work package and cost code, and keeps an exceptions
queue. This change makes Step 1 the source of PCX's BOQ intake: PCX pulls Step 1's register and turns long-lead
items into requirements and **draft** revisions.

Fixes two gaps from the B01 audit:
- **Gap 1:** a changed BOQ quantity must produce a new revision, and a removed line must be flagged. Today neither happens.
- **Gap 4:** the requirement's WBS link (`Requirement.wbs_id`) is set from the cost code. Today it is never set.

### Success criteria
1. A BOQ change in Step 1 becomes a new PCX draft revision, with `predecessor_id` and `changed_fields` correct.
2. An approved baseline is never modified by a sync.
3. Items that are not long-lead equipment never become requirements.
4. Nothing is guessed: unclassified items, odd units and unmatched WBS codes surface as visible queue items or exceptions.
5. Running sync twice in a row changes nothing the second time.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Relationship | Step 1 **feeds** PCX. Step 1 is unchanged and unaware of PCX. |
| Which items become requirements | A **crosswalk kept in PCX**: Step 1 item → equipment class, or "not long-lead". A person confirms each one; unlinked items wait in a queue. |
| Direction | **PCX pulls** from Step 1 when a person presses *Sync now*. No push, no schedule in this piece. |
| Output | Sync creates **drafts only**. It never approves, and never cancels a requirement. |
| Change arrives during review | The in-review (or draft) revision is **cancelled and replaced** by a new draft. |
| Non-count units | A long-lead item in a unit other than `each` (lot, m, kg…) is **blocked as an exception**. |
| Who classifies | ESTIMATOR, ENGINEERING and ADMIN. |

## 3. Non-goals

A scheduled sync · writing anything back to Step 1 · retiring `POST /api/planning/boq-imports` (stays; marked legacy
in docs) · live Procore testing · changing Step 1's code.

## 4. Flow

```
Step 1  GET /api/projects                                    (project list, includes Procore ids)
        GET /api/projects/:id/register?includeSuperseded=true (rows incl. those with source_line_count = 0)
   │
   ▼
PCX  Step1 sync service  (one DB transaction per project; HTTP fetch happens BEFORE the transaction)
   1. Match project:  Step 1 procore_project_id (and company id, when both sides have it) == PCX Project; no match → skipped, reported
   2. For each register row:
        item gate      step1_item_class: PENDING → queue, nothing created · NOT_LLE → ignore · LLE → continue
        validate       unit, quantity, WBS (see §6)
        link           ExternalObjectLink(platform=STEP1, object_type=inventory_record, object_key=<inventory_record_id>)
        create/change  see §6
   3. For each STEP1 link whose record is missing or has source_line_count = 0 → "dropped" exception
   4. Write step1_sync_run (counts, state) and an audit entry
```

## 5. Data model

### 5.1 New table `step1_item_class` (the crosswalk)

| Column | Notes |
|---|---|
| `id`, `tenant_id`, `created_at`, `created_by`, `version` | standard (`TenantScoped`, `Versioned`) |
| `step1_item_id` | Step 1 `item_id` (opaque string). **Unique per tenant.** |
| `internal_item_code` | e.g. `ITM-00012`, as last seen |
| `description` | as last seen (refreshed every sync) |
| `suggested_class_id` | nullable FK → `equipment_class`; see §5.3 |
| `decision` | `PENDING` (default) · `LLE` · `NOT_LLE` |
| `equipment_class_id` | nullable FK; required when `decision = LLE`, null otherwise |
| `decision_reason` | text; required for `NOT_LLE` |
| `decided_by`, `decided_at` | set on classify |
| `last_seen_at` | set on every sync that sees the item |

Step 1 items are shared across projects, so one decision covers the item in every project.

### 5.2 New table `step1_sync_run`

`id`, `tenant_id`, `started_at`, `finished_at`, `actor`, `state` (`RUNNING|SUCCEEDED|PARTIAL|FAILED`),
`projects_json` (per-project result), `counts_json` (`created`, `revised`, `unchanged`, `queued`, `ignored`,
`exceptions`, `skipped_projects`), `error` (text, for FAILED).

### 5.3 Reused tables, with the changes noted

- **`ExternalObjectLink`** gets the new `platform` value `STEP1` (update the comment on the column).
  `company_key = ''`, `project_key` = Step 1 `project_id`, `object_type = inventory_record`,
  `object_key` = Step 1 `inventory_record_id`, `domain_type = requirement`, `domain_id` = PCX requirement id,
  `source_revision` = the change hash (§6), `sync_state = LINKED`.
- **`IntegrationException`** gets the new `source` value `STEP1`. Kinds used: `MAPPING`, `VALIDATION`, `RECONCILIATION`.
  Owner role `ESTIMATOR`. Reuse the existing `open_exception` / `auto_resolve` helpers; the plan decides whether to
  import them from `integrations/procore/links.py` or lift them into a shared module (preferred, they are generic).
- **`Requirement`**: `source_boq_key = "STEP1"`, `source_line_key` = Step 1 `record_number` (e.g. `INV-00012`).
  The existing `(project, source_boq_key, source_line_key)` de-duplication in `create_requirement` then makes
  creation replay-safe.

### 5.4 Class suggestion

When an item is first seen, suggest a class by comparing the register row's `work_package_name` and
`item_description` with `EquipmentClass.name` and `category` (case-folded token overlap). Store it only if there is
exactly one best match; otherwise leave it null. A suggestion never classifies anything.

## 6. Mapping and change rules

### 6.1 Field mapping

| Step 1 register field | PCX field | Notes |
|---|---|---|
| `boq_quantity` | `RequirementRevision.quantity` | Parse as `Decimal`, never float. Must be > 0. A **serialized** class needs a whole number. |
| `normalized_uom` | `uom` | `each` → `EA`. Any other code → exception, no requirement (§2). |
| `item_description`, `specification`, `work_package_code`, `budget_code`, `record_number` | `specification_json["boq"]` | Sync replaces only the `boq` key; PCX-entered keys are preserved. |
| `cost_code` | `RequirementRevision.cost_code` | |
| `cost_code` + project | `Requirement.wbs_id` | The one `WbsElement` in the same project whose `cost_code` matches. None or several → `wbs_id` stays null and a `MAPPING` exception opens; the requirement is still created. |
| `item_description` | `Requirement.title` | Set on creation only; later revisions do not rename the requirement. |
| class from crosswalk | `Requirement.equipment_class_id` | |

Fields Step 1 knows nothing about (duty, capacity, redundancy, install location, dates, budget amount) are never
written by sync. They stay null on a new requirement and are carried forward on later revisions.

### 6.2 Change hash

`sha256` of the canonical JSON of `{quantity, uom, cost_code, work_package_code, budget_code, item_description, specification}`.
Stored in `ExternalObjectLink.source_revision`. A record whose hash equals the stored one is a no-op.

### 6.3 Per-record rules

| Situation | Action |
|---|---|
| New record, item `LLE` | `create_requirement(...)` with revision 1 as `DRAFT`. Create the link. |
| Hash changed, latest revision is `APPROVED` or `SUPERSEDED` | `add_revision(...)` with `changes` = Step 1 fields. `change_reason` = "Step 1 BOQ change: INV-00012 quantity 6 → 7". |
| Hash changed, latest revision is `DRAFT` or `IN_REVIEW` | **Replace:** cancel that revision (`change_reason`/audit "Replaced by Step 1 sync"), then `add_revision(...)`. `add_revision` refuses while a draft is open and copies from the *approved* revision, so sync builds `changes` as: the cancelled draft's non-Step-1 fields, then the Step 1 fields on top. `changed_fields` is then computed against the approved baseline as usual. |
| Hash unchanged | No-op. |
| Record missing from the register, or `source_line_count = 0` | `RECONCILIATION` exception "Source BOQ no longer contains INV-00012". The requirement is **never** cancelled. The exception auto-resolves if the record returns. |
| Item later set to `NOT_LLE` | Existing requirements untouched; one exception per requirement asks a person to cancel it. |
| Unit not `each`, quantity ≤ 0, fractional quantity on a serialized class | `VALIDATION` exception, nothing created or changed. |
| Requirement is `CANCELLED` | Record is skipped; a `RECONCILIATION` exception notes that Step 1 still lists it. |

### 6.4 Constraints on the crosswalk

- Changing an item's class while requirements already link to it is refused (`409 CLASS_IN_USE`): `Requirement.equipment_class_id` is fixed at creation. Setting `NOT_LLE` is allowed and raises the exceptions in §6.3.
- Classifying does not create requirements by itself. The next sync does.

## 7. API

New router `app/api/step1.py`, mounted at `/api/integrations/step1`. Conventions as elsewhere: problem+json errors,
audit on every mutation, `Idempotency-Key` on `POST` commands.

| Route | Purpose | Roles |
|---|---|---|
| `GET /status` | configured?, last run, pending-item count, open Step 1 exceptions | any internal |
| `POST /sync` | body `{project_ids?: []}`; returns the run report | INTEGRATION, ADMIN |
| `GET /runs?limit=` | run history | any internal |
| `GET /items?decision=` | crosswalk queue, with suggestion | any internal |
| `POST /items/{id}/classify` | `{decision: LLE\|NOT_LLE, equipment_class_id?, reason?}`; `If-Match` honoured | ESTIMATOR, ENGINEERING, ADMIN |

Suppliers are blocked as with every `require_internal` route. `docs/api-contract.md` gets a new section.

## 8. Configuration

`PCX_STEP1_BASE_URL` and `PCX_STEP1_APP_PASSWORD` in `backend/.env` (`app/config.py`). The password is never stored in
the database, logged, or returned by any route. PCX sends `Authorization: Bearer <password>` and
`x-user-name: pcx-sync`. If either is unset, `GET /status` reports "not configured" and `POST /sync` returns 409
`STEP1_NOT_CONFIGURED`.

A small `Step1Client` interface has two implementations: an HTTP one (`httpx`, timeouts, no retries beyond one) and an
in-memory fake for tests, the same pattern as the Procore simulator.

## 9. UI (`web/src`)

- **Planning & BOQ → "Step 1 items" tab:** the classification queue (item, code, description, suggested class,
  Confirm / choose another class / "Not long-lead"). Shows how many requirements each decision covers.
- **Administration → "Step 1" page:** connection status, *Sync now*, last run counts, run history, link to the
  exceptions screen filtered to `STEP1`.
- **Requirement detail:** a "Source: Step 1 · INV-00012" badge, linking to the register record in Step 1.
- The nav and capability map (`auth/permissions.ts`) get the two new entries. Tables and forms use the existing
  primitives, semantic tables and labelled inputs.

## 10. Errors

| Case | Behaviour |
|---|---|
| Step 1 unreachable, timeout, 401, non-JSON | run `FAILED`, nothing written, UI shows the age of the last good run |
| One bad record | exception for that record; the rest of the project still syncs; run `PARTIAL` |
| No matching PCX project | skipped, listed in the run report |
| WBS missing or ambiguous | requirement created with `wbs_id` null + `MAPPING` exception |
| Double click / replay | safe: unchanged records are no-ops, creation is de-duplicated |

## 11. Security

Tenant scoping on every query. The only outbound call is to the configured Step 1 URL; the URL must be `http(s)`
and is set by the operator, never by a request. Step 1 data is treated as untrusted text: stored and rendered
escaped, never interpreted. No commercial data crosses this boundary (Step 1 holds quantities, not prices).

## 12. Tests

New file `backend/tests/test_acceptance_step1_feed.py`, using the fake `Step1Client` (no network):

1. Unclassified item → nothing created; appears in the queue with a suggestion.
2. `LLE` item → requirement + draft revision 1; `wbs_id` set; `source_*` fields set.
3. Second sync with no change → no new rows (idempotent).
4. Quantity change → new draft; `predecessor_id` correct; PCX-entered fields carried; `changed_fields` correct.
5. Change during review → in-review revision `CANCELLED`, one new draft, non-Step-1 edits kept.
6. **Approved baseline untouched** by any sync.
7. Dropped record → exception; requirement still `ACTIVE`; exception auto-resolves when the record returns.
8. Non-`each` unit → exception, no requirement.
9. Fractional quantity on a serialized class → exception.
10. WBS none/ambiguous → `wbs_id` null + exception; requirement still created.
11. Step 1 down → run `FAILED`, no partial writes.
12. Roles: Finance cannot classify; only INTEGRATION/ADMIN can sync; supplier blocked; cross-tenant ids return 404.
13. `CLASS_IN_USE` refused; `NOT_LLE` after use raises the cancel-request exceptions.

All 35 existing tests must still pass; T01 and the seed keep using the legacy import.

## 13. Documentation to update with the code

`CLAUDE.md` (coverage rows for FR01–02 / B01.3.3, backlog item 4, status log), `docs/api-contract.md`, `README.md`
(config + the new workspace page), and a "legacy" note on `POST /boq-imports`.

## 14. Impact check (from the code graph)

`ExternalObjectLink` has other readers besides Procore code. Each was checked:
`delivery.unit_passport` filters by the *unit's* id, so a requirement-keyed link never matches ·
`procore/service.status()` filters `platform == "PROCORE"` · `GET /links` lists all platforms and has a `platform`
filter, so `STEP1` links appear there by design. `Requirement` is read by 32 places, but sync only creates
requirements and revisions through the existing `create_requirement` and `add_revision` functions, so their
invariants (codes, audit, `changed_fields`) are not bypassed.

## 15. Risks and open points

- Class suggestion is a heuristic on names; it only ever pre-fills a choice.
- Step 1's register is unpaginated. Fine at current volumes; revisit if a project exceeds a few thousand records.
- Step 1 has not been run against live Procore, so real WBS and cost-code data may expose mapping cases the demo data does not.
- Replacing an in-review revision cancels a reviewer's work in progress. This is a deliberate choice; the cancelled revision stays in the history with its reason.

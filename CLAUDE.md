# CLAUDE.md — PROJECTINV

This is the working memory for this repository. **Keep it current:** when you finish a piece of work, update
the *Spec coverage*, *Open gaps* and *Status log* sections in the same commit.

## What this repo is

Equipment and inventory intelligence for data-centre construction, built to run inside Procore. The governing
spec is **PCX PRD 001 v1.0 (30 Oct 2026)**, saved at
[`docs/spec/PCX-PRD-001-product-specification.md`](docs/spec/PCX-PRD-001-product-specification.md). It defines
8 L1 domains (B01–B08), 24 L2 capabilities, 72 L3 capabilities, requirements FR01–FR19 and acceptance tests T01–T28.

The repo contains **two independent apps**. They share no code and no database.

| App | Folder | Stack | Purpose |
|---|---|---|---|
| **PCX** (full product) | `backend/`, `web/` | Python 3.13+ · FastAPI · SQLAlchemy 2 · SQLite; React 19 · Vite 7 · TS strict · Tailwind 4 · TanStack Query | Implements PRD 001 end to end, against simulated Procore/Oracle/Planon |
| **Step 1 register** | `step1-register/` | Node 22 · Fastify · `pg` · Postgres/Supabase (tests on PGlite); React/Vite | Procore project → WBS work package → cost assignment → every BOQ item, with source evidence. Deploys to Railway (Root Directory `step1-register`) |

**Decision (2026-11-11):** Step 1 **feeds** PCX. PCX pulls Step 1's register on demand (`POST /api/integrations/step1/sync`;
no schedule yet). The item → equipment-class crosswalk lives in PCX (`step1_item_class`, decided by an estimator or
engineer), and a sync creates **draft** requirements and revisions only, never an approval. Step 1 itself is unchanged.
The two apps still share no code and no database, so don't merge them or duplicate features between them. Design:
`docs/superpowers/specs/2026-11-11-step1-feed-design.md`; plan: `docs/superpowers/plans/2026-11-11-step1-feed.md`.

## Commands

PCX backend (run from `backend/`):
```bash
python -m pip install -r requirements.txt
python -m app.seed            # rebuilds data/pcx.db with the BKK demo; --reference-only for master data only
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
python -m pytest -q           # expect 85 passed
```
Step 1 feed config (backend env): `PCX_STEP1_BASE_URL` and `PCX_STEP1_APP_PASSWORD`; unset means `/status` reports `configured: false` and `/sync` returns 409 `STEP1_NOT_CONFIGURED`.
PCX web (from `web/`): `npm ci` · `npm run typecheck` · `npm run build` (served by the backend from `web/dist`) ·
`npm run dev` (:5173, proxies `/api`).

Step 1 (from `step1-register/`): `npm ci` · `npm test` (expect 18 passed) · `npm run typecheck` · `npm run build` ·
`PROCORE_MODE=demo npm start` (:4100, in-memory DB) · `npm run samples` (regenerates `samples/`).

There is no CI. Run the relevant suite yourself before you push.

## Conventions (both apps; see `docs/api-contract.md` for PCX detail)

- Unknown is `null`, shown as *Unknown*. Never coerce it to 0. This covers prices, probabilities, ordered quantities and unpriced scope.
- Money and quantities are exact decimals, sent over the API as **strings**. Rounding is half-up and explicit.
- Every mutation does audit row + outbox row + state in **one transaction**. External calls run asynchronously through the outbox and never inside a transaction.
- Versioned resources carry an ETag. Approve and publish commands require `If-Match` (428 when missing, 412 when stale).
- Commands accept an `Idempotency-Key`. The same key with the same body replays the stored response; a different body returns 409.
- Errors use RFC 7807 problem+json, with a stable code in `title`. A cross-tenant or out-of-scope id returns 404.
- Approved and published records (requirement revisions, awards, handbook packages) are frozen. A change creates a new version.
- Commercial fields are hidden unless `can_see_commercial`. Suppliers see only their own offers and `/sourcing/*`.
- Step 1: project isolation is enforced **in the database** (composite `(id, project_id)` FKs, an allocation trigger, RLS). A BOQ line is never mapped from its description alone.

## How BOQ lines link to WBS

- **Step 1:** `boq_lines` → `requirement_boq_allocations` (quantity) → `inventory_requirements` → `work_packages` (Procore WBS segment items) + `cost_assignments` (Procore budget codes). The matcher in `step1-register/server/src/boq/ingest.ts` tries, in order: budget code, cost code, WBS reference, enclosing heading, sheet name, else *unresolved*. Conflicts are held for a person to decide.
- **PCX, Step 1 feed (current path):** `services/step1_sync.py` pulls the register, and each classified-LLE record becomes a `Requirement` (`source_boq_key="STEP1"`, `source_line_key` = Step 1 `record_number`, `step1_item_id` set) with a DRAFT revision. It **sets `Requirement.wbs_id`** when exactly one `WbsElement` in the project has the record's cost code. With none or several, `wbs_id` stays null and a `MAPPING` exception is raised. Links are `ExternalObjectLink(platform="STEP1")`.
- **PCX, legacy JSON import:** `POST /api/planning/boq-imports` still works (T01 and the seed use it): `BoqLine` → `RequirementRevision`, whose `cost_code` is plain text. It does **not** set `wbs_id` (`backend/app/services/planning.py`). Known gap.

## Spec coverage — PCX vs PRD 001 (audited 2026-11-06)

All 28 acceptance tests T01–T28 have a matching pytest in `backend/tests/test_acceptance_*.py`, and all pass.
The table below covers spec features the tests don't fully exercise.

| Area | Spec ref | Status | Notes |
|---|---|---|---|
| Requirement identity, revisions, impact actions | FR01–02, B01 | ✅ Done | B01.3.3 (requirement → project cost code / WBS position): done for the Step 1 feed, which sets `wbs_id` from the cost code. The legacy JSON BOQ import still leaves `wbs_id` null |
| Catalogue: class / model / option / BOM / spares | FR03 | ✅ Done | No post-award **substitution assessment** flow |
| Benchmarks with sample/coverage, insufficient evidence | FR04, B02.1 | 🟡 Partial | No **inflation/location** normalization; no **outlier policy** |
| Reuse search, reservation lock, sunk-cost exclusion | FR05, B02.2–3 | ✅ Done | |
| Packages, offers, adjustments, deviations | FR06–07, B03.1 | 🟡 Partial | `fx_rate_to_package` only. No **tax** (recoverable/non-recoverable) and no price-date FX basis. No `POST offers/import` from GEP |
| Mandatory gate, weighted evaluation, staleness | FR08–09, B03.2 | ✅ Done | |
| Award freeze, split awards, PO reconciliation | FR10–11, B03.3, B04.1 | ✅ Done | |
| Long-lead schedule / **backward procurement plan** | FR12 | ❌ Missing | No latest-feasible order/approval dates calculated from the operational date |
| Shipment tracking | FR12, B04.2 | 🟡 Partial | Milestones are entered by hand or simulated. No licensed tracking provider and no **daily tracking job**. No packing-list/BOL/AWB mapping |
| Arrival probability | FR12, B04.3 | 🟡 Partial | `services/delivery.py:_arrival_for` uses a heuristic ETA ± fixed window, and P(on/by date) are step values (0/0.1/0.5/1). This is **not** F(d) / F(d)−F(d−1) as the spec defines. As-known-at snapshots work |
| Receiving readiness | B04.3.2 | 🟡 Partial | Blocker list only. No access/crane/crew/storage/inspection resources |
| Component structure, slots, cycles, transfers, recovery | FR13–14, B05 | ✅ Done | |
| **Logical groups & group readiness** | FR13 | ❌ Missing | No group entity and no redundancy rules |
| Costs: provisional→final, allocation, rollup, FM attribution | FR17, B06.1 | ✅ Done | Open commitments aren't shown separately in costs. No credits/warranty-recovery cost events |
| TCO / PV | §22, B06.2 | ✅ Done | |
| Outcome → benchmark feedback | FR18, B06.3 | ✅ Done | `POST /outcomes/publish` |
| Handbook templates, validation, waivers, publish, accept, export | FR15–16, B07 | 🟡 Partial | Evidence is metadata plus `storage_ref`. No file upload/storage and no malware/type/size checks (§34). Export is JSON, not an agreed FM/EAM schema |
| Integrations: Procore OAuth/sync/webhooks/outbox/inbox | B08.1 | 🟡 Partial | Simulated only, never run against a live tenant. ERP/FM are simulators |
| Security, tenant/supplier isolation, audit | B08.2, §34 | ✅ Done | No delegated-authority thresholds or segregation of duties (discovery item) |
| Timeline UI | FR19 | 🟡 Partial | Date and as-known-at inputs only. No day/week/month **zoom** and no keyboard timeline. No WCAG 2.2 AA audit done |
| Async jobs (202 for benchmark/validate) | §33 | ❌ Missing | These run synchronously. The only background worker is the outbox thread |
| Platform | §26 | ⚠️ Deviation | Uses SQLite, not the proposed Azure SQL. Routes are under `/api`, not `/extension/v1`. No evidence blob store |
| `decision_evidence` table | §31 | ❌ Missing | Audit log covers some of it |
| Analytics facts, p95 targets, restore drills | §35 | ❌ Not started | |
| Procore discovery matrix (U/N/C/P/I/E/D) | §3–4, §38 | ❌ Not started | This is business/admin work, not code. It needs tenant access |

## Open gaps / backlog (priority order)

1. Test Procore live against sandbox company `4283715`, especially Step 1 Documents download `GET /rest/v1.0/files/{id}`.
2. ~~Decide how Step 1 and PCX fit together.~~ Decided 2026-11-11: Step 1 feeds PCX (see *Decision* above). Phase 1 continues with approval correctness, then benchmark/reuse correctness.
3. Deploy Step 1 (Railway + Supabase).
4. PCX: set `Requirement.wbs_id` on BOQ import by matching the cost code to a `WbsElement`. **Done for the Step 1 feed path; the legacy `POST /boq-imports` path is still open.**
5. PCX: implement a real arrival distribution (F(d)), the backward procurement plan, and a daily tracking job behind a provider interface.
6. PCX: logical groups + group readiness. Tax/inflation normalization. Benchmark outlier policy.
7. PCX: evidence file storage with hash, type and size checks. An FM/EAM export schema.
8. Add CI (GitHub Actions running pytest, the web typecheck and Step 1's `npm test`).
9. Housekeeping:
   - README says Python 3.14 (3.13 works) and lists a nonexistent `backend/app/domain/`.
   - The `httpx` test client is deprecated; replace it.
   - OCR for scanned BOQ PDFs (Step 1 refuses them today).
10. Step 1 feed follow-ups:
   - `GET /api/integrations/step1/status` should expose the age of the last **good** run (spec §10). It returns only the latest run, so after a FAILED run the page cannot say how stale the data is.
   - Small deferred items from review (no test or minor hardening): the client catches only `httpx.HTTPError` (not `InvalidURL` or `UnicodeError`); a non-string `item_description` or `normalized_uom` from Step 1 would abort the whole run; `project_ids: []` is accepted as a no-op run; replacing an unapproved DRAFT revision 1 and the MAPPING-stays-open branch have no test. The full list is in the (uncommitted) SDD ledger `.superpowers/sdd/2026-11-11-step1-feed/progress.md`.
   - Nothing here has run against a live Procore tenant or a deployed Step 1; only the local demo server (see the status log).

## Status log

Newest first. Add one line per meaningful change.

- **2026-11-11** — Step 1 → PCX feed built and verified (tasks 1–9 of the plan). New: settings `PCX_STEP1_BASE_URL` / `PCX_STEP1_APP_PASSWORD`, tables `step1_item_class` and `step1_sync_run`, `Requirement.step1_item_id`, services `step1_items.py` and `step1_sync.py`, routes under `/api/integrations/step1`, shared `integrations/exceptions.py`, web pages `/admin/step1` and `/planning/step1-items`. Docs: `docs/api-contract.md` "Step 1 feed", README. Verified: PCX 85 pytest (35 original + 50 new), web typecheck and build clean, Step 1 18/18. End to end against a real local Step 1 demo server (`PROCORE_MODE=demo`, `BC1_MEP_BOQ_RevA.xlsx` uploaded to Bangkok Central 1, 8 register rows): first sync `queued 8, created 0`; after classifying, `created 3` (2 MAPPING exceptions, no WBS element for 26-200 / 26-400; the chiller got `wbs_id` from a hand-added 26-100 element); third sync `unchanged 3, created 0`. A FAILED run (Step 1 down) returned HTTP 200 with `state: "FAILED"` and the page showed it. Not covered live: a `revised` run (RevB only changes a non-LLE item) and any real Procore tenant.
- **2026-11-11** — Spec approved; wrote the implementation plan for piece 1 in `docs/superpowers/plans/2026-11-11-step1-feed.md` (9 tasks, tests first; awaiting review and an execution-method choice; no code yet). The plan amends the spec in five places (e.g. `Requirement.step1_item_id`, one transaction per run).
- **2026-11-11** — Phase 1 agreed (Step 1 feed → approval correctness → benchmark/reuse correctness; substitution, FX/inflation and scheduled sync are Phase 2). Wrote the design for piece 1 in `docs/superpowers/specs/2026-11-11-step1-feed-design.md` (awaiting review; no code yet). Built a code graph of the repo with graphify (2,150 nodes, 83 communities) to check the blast radius; the output is generated, not committed.
- **2026-11-06** — Audited PCX against PRD 001. Saved the spec to `docs/spec/`. Created this file. Verified: PCX 35/35 pytest, web typecheck clean; Step 1 18/18 tests, typecheck and build clean.
- **2026-11-06** — PR #1 merged: Step 1 register added in `step1-register/`.
- **2026-10-31** — PCX app built (`backend/`, `web/`) covering T01–T28.

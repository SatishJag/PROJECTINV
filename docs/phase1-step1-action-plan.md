# Phase 1 · Step 1 — Repo Review and Plan of Action

Date: 1 Nov 2026. Goal of Step 1 (from `feature/step1-foundation/docs/step1-foundation-plan.md`):
select **Bangkok Central 1 → UPS** and see every BOQ-derived item with specification, UOM, quantity,
cost assignment and source evidence, with Bangkok Central 2 kept separate. Platform: **Supabase Postgres**.

---

## 1. What exists today

There are three separate efforts. None of them builds on another.

| Where | What it is | Stack | State (checked 1 Nov) |
|---|---|---|---|
| `main` (`backend/`, `web/`) | **PCX** — the whole lifecycle: requirements, sourcing, POs, units, FAT/recovery, handbooks, TCO, Procore write-back | Python/FastAPI + **SQLite**, React | 35/35 tests pass. ~14k lines Python, ~10k lines TSX. Built to PRD 001, on a database the approved plan has since replaced |
| PR #1 (`step1-register/`, Devin) | **Step 1 app** — Procore sync → work packages / cost assignments, BOQ upload (xlsx/csv/text-PDF), mapping, exception queue, revisions, register UI | Node/Fastify + **Postgres** (Supabase migrations), React | 18/18 tests pass. Open, not merged |
| `feature/step1-foundation` | **Approved plan + full schema** (migrations 0001–0008, 30 tables incl. dormant Step 2+ tables), PRD reconciliation note, A1–A10 acceptance templates | SQL only | **Migrations fail on Postgres 16** (see §2). Acceptance file has no executable checks. Branch is cut from the initial commit, so merging it would delete PCX |

Supabase: the account has one project, `SiteSelection` (inactive, unrelated). No PROJECTINV database exists yet.

## 2. Findings

**Foundation schema (`feature/step1-foundation`)**
- `0002_structure.sql:121` — `cost_code_segments` references `cost_assignments(project_id, cost_assignment_id)`, but
  that unique key is missing. `cost_assignments` instead has `unique (project_id, work_package_id)`, which wrongly
  allows only **one** cost assignment per work package and blocks supersession.
- The same missing-composite-key pattern breaks `0004` (`boq_document_revisions`) and `0005` (`commitments`); 0006–0008
  then cascade-fail. Only 13 of the 30 planned tables are created.
- `tests/acceptance_step1.sql` is entirely comments; A1–A10 have never been run.

**PR #1 (`step1-register/`)** — the closest thing to a working Step 1, but it does not yet match the approved plan:
- Missing tables from the plan: `uom_conversions`, `cost_code_segments`, `mapping_exceptions`, `ingestion_runs`,
  `organization_memberships`, and the dormant `0005–0007` tables (commitments, units, quality). Exceptions are held as
  BOQ-line statuses instead of a `mapping_exceptions` queue.
- RLS has read policies only: no write policies, and DELETE is not denied. The API connects as the DB owner with one
  shared password (`APP_PASSWORD`), so per-user project isolation is never applied to app traffic. It is enforced by
  code and composite FKs only.
- Live Procore is unproven: there were no credentials, and the Documents download endpoint is untested. Scanned PDFs are
  refused (no OCR).

**PCX (`main`)** — good reference for patterns (audit, idempotency, outbox, Procore OAuth/webhooks/embed, decimal rules)
but it is on SQLite and spans all phases. It should not be the Step 1 base.

## 3. Recommendation

Build Step 1 on **PR #1's app**, using the **foundation plan's schema as the canonical data model** (fixed). Keep PCX
on `main` as a reference prototype. Don't delete it now; decide later whether to move it to `legacy/` or a branch.

Reasons: PR #1 is the only Postgres code that works end-to-end and has tests. The foundation schema is the approved
contract that Step 2+ depends on ("full schema up front, never re-key"). Merging the two avoids a third fork.

## 4. Plan of action

| # | Work | Done when |
|---|---|---|
| 0 | **Decide the repo layout** (see §5) and close or retarget the stale branches | One Step 1 branch; PR #1 and the foundation branch are superseded by it |
| 1 | **Fix the foundation migrations**: add the composite unique keys (`(project_id, <pk>)`) to every parent table; drop `unique(project_id, work_package_id)` on `cost_assignments`; add a Supabase `auth` shim for local tests | 0001–0008 apply cleanly to plain Postgres 16/17 and to a Supabase branch |
| 2 | **Make A1–A10 executable**: seed BC1/BC2, two users, set JWT claims, assert with `DO` blocks or pgTAP; run in CI | `psql -f tests/acceptance_step1.sql` fails loudly on any broken rule |
| 3 | **Port PR #1's server to the canonical schema**: write exceptions to `mapping_exceptions`, reconciliation counts to `ingestion_runs`, segments to `cost_code_segments`; keep the parse → classify → validate → map → publish pipeline | PR #1's 18 tests pass against migrations 0001–0008 |
| 4 | **Apply RLS to app traffic**: replace the shared password with Supabase Auth. The API forwards the user's JWT (`set local role authenticated` + claims); only ingestion workers use `service_role`. Add write policies and deny DELETE | The RLS test runs through the HTTP API, not just raw SQL |
| 5 | **Provision Supabase**: new project (e.g. `projectinv-dev`, Singapore/Sydney region), apply migrations, seed org + Bangkok Central 1–4 + memberships | Hosted DB matches `supabase db diff` = empty |
| 6 | **Procore sandbox discovery**: with real sandbox credentials, verify WBS segments, budget codes, the Documents download, and permissions; record the actual field names | Live sync runs twice with no duplicates; one BOQ imported from Procore Documents |
| 7 | **UAT on the definition of done**: real LDC BOQs (Excel + PDF) for BC1/BC2, the exception queue worked through by an estimator | BC1 → UPS demo signed off; A1–A10 green on hosted DB |
| 8 | **Deploy** (Railway per PR #1, or Supabase + Vercel) with env/secrets documented | Shareable URL behind Supabase Auth |

Out of scope for Step 1 (dormant tables exist, no behaviour): commitments / ordered quantity, physical units,
assemblies, test/failure, reservations, arrival, handbooks. `ordered_quantity` stays NULL.

Suggested order: 1 → 2 → 3 → 4 can run on local Postgres now. 5 needs a go-ahead to create a Supabase project (it may
be billable). 6 needs Procore sandbox credentials. 7 needs real BOQ files.

## 4a. Progress

| Date | Done |
|---|---|
| 1 Nov 2026 | PR #1 merged into the working branch (`step1-register/`, alongside PCX) |
| 1 Nov 2026 | **Automatic BOQ capture from Procore Documents.** A BOQ stored in the project's "BOQ" folder (or a chosen folder) is captured into the register via a webhook plus a periodic catch-up scan. Covers new versions, Rev B files beside Rev A, duplicates, unreadable files and temporary errors. 15 new tests (33 total); verified in the browser on demo data. Still needs Procore sandbox confirmation (step 6) |

## 5. Decisions needed from the owner

1. **Repo layout** — (a) make the Step 1 app the repo root and move PCX to `legacy/pcx/` *(recommended)*, or (b) keep
   `step1-register/` next to PCX as PR #1 does.
2. **Supabase** — OK to create a new project for PROJECTINV? Which region?
3. **Procore** — sandbox client id/secret and company id for discovery (step 6).
4. **Auth** — Supabase Auth email magic-link is enough for Step 1, or is Procore SSO / embedded-app launch needed now?
5. **Sample data** — real LDC BOQ files for BC1/BC2 to replace the generated samples.

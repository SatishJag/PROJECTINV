# AGENTS.md — PROJECTINV (Inventory Intelligence)

Instructions for AI coding agents and new contributors. Read this before you change anything.
`CLAUDE.md` imports this file, so keep the rules here.

## 1. What we are building

An equipment and material intelligence product for data-centre construction. It is embedded in Procore and serves the
Bangkok Central (BC1–BC4) programme.

**Current focus: Phase 1 · Step 1 — Project Inventory Register.** We need a reliable link from the Procore project to
its WBS work package and cost assignment, and on to every item extracted from the BOQ, with full source evidence.

**Definition of done:** select *Bangkok Central 1 → UPS* and see every BOQ-derived item with its specification, UOM,
quantity, cost assignment and source evidence. Bangkok Central 2's records must stay separately attributable.

Plan and status: `docs/phase1-step1-action-plan.md`. Approved design: `docs/step1-foundation-plan.md` and
`docs/prd-reconciliation.md` (on `feature/step1-foundation` until merged).

## 2. Where things live (as of 1 Nov 2026)

There are three separate efforts. Know which one you are touching.

| Location | What | Status | Rule for agents |
|---|---|---|---|
| `main`: `backend/`, `web/` | **PCX**: full lifecycle prototype (Python/FastAPI + SQLite, React) | 35 tests pass | **Reference only.** Don't extend it for Step 1 or delete it without owner approval |
| `step1-register/` (PR #1 merged into this branch, plus BOQ auto-capture) | **Step 1 app** (Node/Fastify + Postgres, React/Vite) | 33 tests pass | **Base for Step 1 code** |
| `feature/step1-foundation`: `supabase/migrations/0001–0008` | **Canonical schema** (30 tables, including dormant Step 2+ tables) | Broken: 0002/0004/0005 lack composite unique keys | **Canonical data model.** Fix it, then port the Step 1 app onto it |

- `feature/step1-foundation` was cut from the initial commit. **Never merge it into `main` as is**, because that would
  delete PCX. Cherry-pick or copy its files instead.
- Still open (see the plan, §5): final repo layout (recommended: Step 1 at root, PCX to `legacy/pcx/`), Procore sandbox credentials and real BOQ samples. Don't decide these yourself. Ask.

### Platform (decided 1 Nov 2026): cloud-portable, Azure first

Each client runs the product in **their own cloud account**. We build for Azure first; AWS follows behind the same
interfaces. **Supabase is no longer the target platform.** It, or plain local Postgres, is only a development option.

| Part | Azure (first) | AWS (later) |
|---|---|---|
| Database + vectors | Azure Database for PostgreSQL Flexible Server + `pgvector` | RDS / Aurora Postgres + `pgvector` |
| Original BOQ files | Azure Blob Storage (`AzureBlobFileStore`), with lifecycle tiers | S3 (to add behind `FileStore`) |
| App + extraction worker | Linux VM or container, managed identity | EC2 / container |
| Sign-in | Microsoft Entra ID (OIDC) | Cognito / client SSO |
| OCR | Azure AI Document Intelligence | Amazon Textract |

- Code must stay plain Postgres + interfaces: no Supabase SDK or Supabase-only features in app code.
- **Never store file bytes in Postgres.** Originals go through `FileStore` (`server/src/filestore.ts`). The database
  keeps `storage_kind`, `storage_key` (`boq/<org>/<project>/<sha256>`), size and sha256.
- On Azure, authenticate to Blob with managed identity (`AZURE_STORAGE_ACCOUNT_URL`). Connection strings are for
  Azurite and local development only.
- The migrations folder is still called `supabase/migrations`, but the SQL must run on plain Postgres (Azure). The
  `auth.uid()` shim in 0002 reads the user id the API sets per request, whatever the identity provider.

### Current feature: automatic BOQ capture from Procore Documents

When the LDC stores a BOQ in a project's watched Procore Documents folder, it is captured into the register without a
manual upload. The code is `step1-register/server/src/capture.ts`, migration `0003_procore_document_capture.sql`, the UI
card is `web/src/pages/ProcoreCapture.tsx`, and the tests are `server/test/capture.test.ts`.

- A webhook, the periodic scan and "Check Procore now" all run the **same idempotent folder scan**. Never build a path
  that imports directly from a webhook payload.
- Each (project, Procore file id, file version) is captured once. Keep it that way.
- Folder listing, the Documents webhook resource name and version-upload webhooks are unverified against live
  Procore, so the periodic scan must stay on in live mode.

## 3. Domain rules (non-negotiable)

These rules are requirements. A change that breaks one is a bug, even if the tests pass.

1. **Separate records.** Item definition (a type or model), project inventory requirement (a project or work-package
   need), physical unit (one serial) and physical component (one serial child) are different rows. Primary keys are
   immutable UUIDs. Serials, MPNs, supplier codes and Procore IDs are *extra identifiers, never keys*.
2. **BOQ quantity ≠ ordered quantity.** `ordered_quantity` stays `NULL` ("Unknown") until there is purchase evidence.
   Lump-sum commitments never get a derived quantity.
3. **Explicit allocations, both ways.** Use BOQ line → requirement and requirement → commitment line. Split quantities
   must reconcile exactly to the source line. Never copy the full quantity into each package.
4. **Project isolation lives in the database**: composite `(project_id, id)` FKs plus RLS. Don't rely only on UI or API
   filters. A BC1 row can never reference a BC2 parent.
5. **AI proposes, never decides.** Item matches and work-package attributions go to `mapping_exceptions` for a human.
   Identical descriptions do not prove identical specifications. Never map a line from its description alone.
6. **Idempotent reprocessing.** Every run is keyed by project + document + revision + file hash + line locator.
   Re-importing the same file changes nothing.
7. **Revisions supersede, never sum.** Current quantity comes only from the accepted revision. Never DELETE
   history: set a superseded/cancelled status.
8. **Units are preserved.** Keep the source UOM. Convert only through `uom_conversions` with the same dimension.
   `mm²` is a conductor size, not a quantity unit. "1 lot" never becomes an invented item count.
9. **Headings, subtotals and notes are never register items.** `line_type` decides this, by construction.
10. **Full Procore budget-code context is kept**: cost code, cost type and all configured segments. "Work package" means
    our equipment package. It is **never** Procore's timekeeping *Task Code*.
11. **The BOQ submitter (the LDC) is not the supplier.** Suppliers come only from purchase evidence.
12. **Failure evidence ≠ supplier fault.** Repeated tests or returns from one incident are not independent failures.
    (Dormant in Step 1.)

**Step 1 scope:** projects, work packages, cost assignments, UOM, items, BOQ revisions and lines, the register,
allocations, exceptions and ingestion runs. Commitments, physical units, assemblies, quality, reservations, arrival
and handbooks have **tables only, with no behaviour**.

## 4. Data and code conventions

- Money and quantities: Postgres `numeric` (quantities `numeric(19,6)`, factors `numeric(28,12)`). In JSON they are
  **decimal strings**, never floats. Never do float maths on them.
- Unknown is `NULL` and renders as "Unknown". Never coerce it to `0`.
- Every business table has `organization_id` (or a one-hop route to it), `project_id` where project-scoped,
  `created_at`, `updated_at`, `created_by` and `record_version`.
- RLS is enabled on **every** business table, including dormant ones, with deny-by-default DELETE. Only server-side
  workers use `service_role`.
- JSONB is for category-specific specifications. Never use it in place of a foreign key.
- Procore IDs are stored as opaque `text`.
- Every mutation writes an audit record in the same transaction.

## 5. Migrations

- They live in `supabase/migrations/NNNN_name.sql`. They apply strictly in order, and each must apply cleanly on plain
  Postgres 16+ (with the local `auth` shim) and on Azure Database for PostgreSQL.
- **Before the first hosted deploy:** fix the baseline files (0001–0008) in place.
  **After the first hosted deploy:** never edit an applied migration. Add a new one.
- Evolve in this order: add the column or table → update behaviour → backfill from evidence → validate → tighten the
  constraints.
- Every composite FK `(project_id, x_id)` needs a matching `unique (project_id, x_id)` on the parent.

Local check against Postgres (needs a stand-in for the Supabase `auth` schema):

```bash
psql "$DB" -c "create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
  \$\$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid \$\$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;"
for f in supabase/migrations/*.sql; do psql "$DB" -v ON_ERROR_STOP=1 -f "$f" || break; done
psql "$DB" -v ON_ERROR_STOP=1 -f tests/acceptance_step1.sql
```

## 6. Commands

**Step 1 app** (`step1-register/`, Node 22+). Run from that folder:

```bash
npm ci
npm test               # vitest + PGlite (in-process Postgres)
npm run typecheck
npm run build
PROCORE_MODE=demo npm start          # http://localhost:4100, demo Bangkok Central company
npm run dev:server / npm run dev:web # API :4100, Vite :5173
npm run samples                      # regenerate sample BOQs in samples/
npm run files:migrate                # move originals still stored in Postgres into the file store
```

Configuration lives in `.env.example`. Without `PROCORE_CLIENT_ID`/`SECRET`, the demo Procore adapter is used.

**PCX reference** (repo root, Python 3.13+):

```bash
cd backend && pip install -r requirements.txt && python -m pytest -q   # 35 tests
python -m app.seed && python -m uvicorn app.main:app --port 8000
cd web && npm install && npm run typecheck
```

## 7. Acceptance checks A1–A10

Each Step 1 change must keep these true. Encode them as executable tests, not comments.

| # | Check |
|---|---|
| A1 | BC1 → UPS shows every BOQ item with spec, UOM, quantity, cost assignment and source locator. A BC1 reader cannot see BC2 rows |
| A2 | Re-importing the same document revision changes nothing |
| A3 | A revised BOQ keeps the old revision. Current quantity comes from the accepted revision only |
| A4 | A line split across two work packages reconciles exactly to the source quantity |
| A5 | An unattributable line (e.g. "Copper cable" under GENERAL) goes to `mapping_exceptions` |
| A6 | Headings and subtotals are excluded from the register |
| A7 | Cross-project references fail at the database (composite FK + RLS) |
| A8 | One item definition is shared across projects; quantities stay separate |
| A9 | An unfamiliar item is recorded anyway. A catalogue match is not a prerequisite |
| A10 | `ordered_quantity` is `NULL` for BOQ-only data and lump-sum commitments |

## 8. Procore

- Treat every Procore field and endpoint as **unverified** until it has been run against the sandbox. Validate the
  real tenant's fields and permissions before you build on them. The Documents download
  (`GET /rest/v1.0/files/{id}`) has not been proven yet.
- Live calls use client-credentials OAuth, the `Procore-Company-Id` header, pagination, and retries on 429/5xx.
- Never commit credentials. `.env*`, `*.key` and `*.pem` are git-ignored.

## 9. Working rules for agents

- Work on the branch you were given. Don't push to `main` or open PRs unless asked.
- Before you commit: run the tests and typecheck for every codebase you touched, and the migration check if you
  changed SQL. Report failures; never skip or disable a test to get green.
- Keep changes scoped to Step 1. Don't build behaviour on dormant tables.
- Don't re-key any entity to a Procore ID, serial or supplier code. Don't sum quantities across revisions.
- Ask the owner before you delete code, change the repo layout, create cloud resources (Azure, AWS, Supabase, Railway) or call a
  live Procore tenant.
- Write plainly in docs and comments. Keep `docs/phase1-step1-action-plan.md` current when a step's status changes.

## 10. Glossary

- **BOQ**: bill of quantities, submitted by the **LDC** (lead design consultant / contractor).
- **Work package**: an equipment package within a project's WBS (Chiller, UPS, Transformer, Generator).
- **Cost assignment**: an approved link between a work package and a Procore budget code (all segments).
- **Inventory requirement / record**: a register row (project + work package + cost assignment + item + UOM). Its
  quantity is derived from allocations.
- **BC1–BC4**: the Bangkok Central 1–4 projects (demo and target programme).

# Step 1 — Project Inventory Register (Inventory Intelligence)

A standalone Node app in `step1-register/`, separate from the PCX app at the repo root (`backend/`, `web/`). Run every command below from this folder.

Step 1 only: a reliable relationship between the **Procore project**, its **WBS work package** and **cost assignment**,
and **every item extracted from the BOQ** the LDC submits. Done when you can select *Bangkok Central 1 → UPS* and see every
BOQ-derived item with its specification, UOM, quantity, cost assignment and source evidence, with Bangkok Central 2's
records kept separately attributable.

Out of scope here (later steps): commitments/ordered quantities, suppliers, physical units, assemblies, installation
history, failures. `ordered_quantity` is reported as **Unknown** — a BOQ establishes required quantity only.

## What it does

1. **Procore sync** — projects; the WBS cost-code segment items become *work packages* (Chiller, UPS, Transformer,
   Generator…); WBS / budget codes (cost code + cost type + other segments, kept in full) become *cost assignments*.
2. **BOQ intake** — upload (Excel `.xlsx`, CSV, text PDF) or import a file from the project's Procore Documents tool.
   The project comes from the submission location; the project name inside the file is only a cross-check — a mismatch
   is flagged and nothing is published until someone confirms the project.
3. **Extraction** — every source row is stored with its original values and locator (`Sheet!R12`, `p3:L22`),
   classified as item / heading / subtotal / note. Headings and subtotals are never items.
4. **Validation** — quantity must be a number, unit must be a recognised unit; the source unit is kept (`Nr` → `each`,
   `LS` → `lot`; a lot is never turned into a count; `95mm²` in a description is a size, not a unit).
5. **Mapping (per line)** — explicit budget/cost code or WBS column, else the BOQ heading the line sits under, else the
   sheet name. Never from the description alone: “Copper cable” under *GENERAL* stays unresolved. A heading naming two
   packages is ambiguous. Explicit code vs heading conflicts are flagged.
6. **Publish** — attributable valid lines become **inventory records** (`INV-00001`, primary key
   `inventory_record_id`) through explicit **allocations** to the BOQ line. A line serving several work packages is
   split with quantities that must reconcile to the line.
7. **Exception queue** — unresolved / invalid / held lines: assign, split, correct the extraction, or reject with a reason.
8. **Revisions** — re-importing the same file (same hash) or the same Procore document revision never duplicates
   quantities. A new revision supersedes the previous one; the register uses the current revision only (never sums
   revisions); manual resolutions carry forward when the line is unchanged.
9. **Reconciliation** per revision — every extracted line is accounted for (published / split / held / unresolved /
   rejected, plus headings / subtotals / notes) and allocated quantities equal line quantities.

## Data model (`supabase/migrations`)

| Table | Purpose |
| --- | --- |
| `projects` | Internal UUID, Procore company/project IDs, name |
| `work_packages` | Project WBS hierarchy / equipment work packages (+ BOQ match terms) |
| `cost_assignments` | Approved work package ↔ Procore budget-code context (cost code, cost type, segments) |
| `units_of_measure` | Controlled units + source aliases |
| `item_definitions`, `item_aliases` | Equipment/material identity shared across projects (`ITM-00001`); never holds quantities |
| `boq_document_revisions` | Source file, Procore document/revision, sha256, original bytes, status |
| `boq_lines` | Every extracted line, raw values, locator, validation + mapping status |
| `inventory_requirements` | **The register**: project + work package + cost assignment + item + UOM |
| `requirement_boq_allocations` | How much of which BOQ line each record holds |
| `inventory_register` (view) | Current quantities from current revisions only; `ordered_quantity` = NULL |

Enforced by the database, not only the UI:

- composite `(id, project_id)` foreign keys — a Bangkok Central 1 record cannot reference a Bangkok Central 2 work
  package, cost assignment, BOQ revision or BOQ line; a record's cost assignment must belong to its own work package;
- unique `(project, file hash)`, `(project, Procore document, revision)`, `(revision, source locator)`, one current
  revision per document;
- a trigger refuses allocations above the line quantity, in a different unit, or on headings/subtotals;
- row-level security (`0002`): Supabase users (`authenticated`) read only projects they are members of
  (`project_members`). The API connects as the database owner and writes through validated code.

## Run locally

Node 22+.

```bash
npm install
npm run build
# demo Procore company (Bangkok Central 1-4), in-memory database:
PROCORE_MODE=demo npm start            # http://localhost:4100
# or with Postgres / Supabase:
DATABASE_URL=postgres://... PROCORE_MODE=demo npm start
```

Dev with hot reload: `npm run dev:server` (API :4100) and `npm run dev:web` (Vite :5173, proxies `/api`).
Migrations run on start; `npm run migrate` applies them alone. Sample BOQs: `npm run samples` → `samples/`.

Tests (in-process Postgres via PGlite): `npm test`. Type check: `npm run typecheck`.

## Configuration

See `.env.example`. Live Procore needs `PROCORE_CLIENT_ID` / `PROCORE_CLIENT_SECRET` (the same DMSA app as AdvaPay,
sandbox company `4283715`); without them the built-in demo company is used.

## Deploy (Railway + Supabase)

1. Supabase: create a project; copy the Postgres connection string (session pooler URI).
2. Railway: new service from this repo with **Root Directory `step1-register`**; `railway.json` sets build `npm ci && npm run build`, start
   `npm start`, health check `/api/health`.
3. Variables: `DATABASE_URL`, `APP_PASSWORD`, and either `PROCORE_MODE=demo` or the Procore variables
   (`PROCORE_BASE_URL`, `PROCORE_COMPANY_ID`, `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`).
4. Open the app → *WBS & cost codes* → **Sync all from Procore**.

## Not yet verified against live Procore

The WBS calls (`work_breakdown_structure/segments/{id}/segment_items`, `wbs_codes`) are the ones proven in AdvaPay;
the Documents download (`GET /rest/v1.0/files/{id}` → latest `file_versions[].url`) has not been run against the
sandbox yet. OCR for scanned PDFs is not included: such files are refused with a message.

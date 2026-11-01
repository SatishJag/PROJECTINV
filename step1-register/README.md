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

## Automatic capture of BOQs stored in Procore

When the LDC stores a BOQ in a project's Procore **Documents** tool, it is captured without anyone uploading it here.

- **What is watched:** a top-level Documents folder named "BOQ" (or "Bill of Quantities") and its subfolders. To use
  another folder, open *BOQ submissions → Automatic capture → Change folder*. Capture can be switched off per project.
- **How files are found:**
  1. A Procore webhook for a Documents event triggers an immediate check of that project's folder.
  2. A periodic scan (`PROCORE_SCAN_MINUTES`, default 15 with live Procore) catches anything a webhook missed.
  3. *Check Procore now* runs the same check by hand.
- **What happens to each file:** every new file, and every new version of a file, in a supported format (Excel, CSV,
  text PDF) is downloaded and goes through the normal intake: extraction, mapping, exceptions and the register. The
  project is the Procore project the file was stored in.
- **Revisions:**
  - A new version of the same Procore file supersedes the previous revision.
  - So does a revised file stored next to the old one ("… Rev B.xlsx" beside "… Rev A.xlsx"). Quantities are never
    summed across revisions.
- **Never twice:** each (project, Procore file, version) is captured once. Redelivered webhooks are recognised by their
  `ulid`, and identical content is recognised by its file hash.
- **Errors:**
  - Temporary Procore errors (timeouts, 429, 5xx) are retried on later checks, up to 5 attempts.
  - A file that cannot be read as a BOQ (e.g. a scanned PDF) is marked *could not read* and is left alone until a new
    version is stored.
  - Files in other formats (e.g. `.docx`) and files outside the watched folder are ignored.
- **Record:** *BOQ submissions* lists every captured file version with how it was found and the result. Deliveries are
  in `procore_webhook_events`, captures in `procore_document_captures` (migration `0003`).
- **Demo:** with the demo company, *Store in Procore* on the BOQ page acts as the LDC. It stores a file in the simulated
  Documents tool and delivers the webhook Procore would send.

### Setting up the Procore webhook (live)

1. Set `PROCORE_WEBHOOK_SECRET` to a long random value and deploy.
2. In Procore, open *Project → Admin → Webhooks*, or create the hook through the Webhooks API at company level. Set:
   - destination URL `https://<your-host>/api/procore/webhooks`;
   - custom header `Authorization: Bearer <PROCORE_WEBHOOK_SECRET>`;
   - triggers for the Documents resource (create and update).
3. Procore does not sign deliveries, so the header is the only check. Requests without it get 401.

Any event whose resource name mentions files, folders or documents triggers a check, and every other event is stored
and ignored. The check is safe to repeat, so an over-broad trigger only costs API calls.

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

Not yet proven against the sandbox:
- the Documents folder listing (`GET /rest/v1.0/folders` and `/folders/{id}` with `project_id`);
- the exact webhook resource name for Documents events;
- whether Procore sends a webhook when a new file version is uploaded.

The periodic scan covers the last two until they are confirmed.

The WBS calls (`work_breakdown_structure/segments/{id}/segment_items`, `wbs_codes`) are the ones proven in AdvaPay;
the Documents download (`GET /rest/v1.0/files/{id}` → latest `file_versions[].url`) has not been run against the
sandbox yet. OCR for scanned PDFs is not included: such files are refused with a message.

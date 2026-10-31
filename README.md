# Procore Equipment Intelligence (PCX)

A programme-scale equipment intelligence product for data-centre construction and operations, built to be
embedded inside Procore (Full Screen and Side Panel apps) or run standalone.

It carries one asset from engineering need to a published handbook: requirement revisions and BOQ imports,
sourcing packages and frozen awards, purchase orders and serialized unit passports, custody and allocation,
FAT/recovery, arrival evidence, evidence-backed handbooks, cost attribution/TCO, and a reconciled Procore
write-back path. Unknown values stay unknown — never zero.

- Backend: Python 3.14 · FastAPI · SQLAlchemy 2 · SQLite (WAL, foreign keys)
- Frontend: React 19 · Vite 7 · TypeScript (strict) · Tailwind 4 · TanStack Query 5 · Radix UI
- Tests: 35 pytest cases, covering acceptance criteria T01–T28

---

## Quick start

```bash
# 1. Backend dependencies
cd backend
py -m pip install -r requirements.txt

# 2. Seed the deterministic BKK demo scenario (drops and recreates data/pcx.db)
py -m app.seed

# 3. Run the API + built UI on one origin
py -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Build the UI once (the backend serves `web/dist` with an SPA fallback):

```bash
cd web
npm install
npm run build     # tsc --noEmit && vite build
```

Open <http://127.0.0.1:8000>.

### Frontend dev mode

```bash
cd web
npm run dev       # http://localhost:5173, proxies /api → http://127.0.0.1:8000
```

### Tests

```bash
cd backend
py -m pytest -q
```

---

## Demo accounts

Password for every demo account: `Demo!2026` · tenant: `DEMO`.

| Email | Role | Purpose |
| --- | --- | --- |
| `admin@demo.pcx` | ADMIN | Full access; passes every internal capability check |
| `owner@demo.pcx` | OWNER | Approvals: evaluation, award, handbook publish |
| `estimator@demo.pcx` | ESTIMATOR | Requirements, BOQ, benchmarks, TCO |
| `engineering@demo.pcx` | ENGINEERING | Revision approval, tests, recovery release, handbook approval |
| `procurement@demo.pcx` | PROCUREMENT | Packages, offers, evaluation, award, PO import |
| `inventory@demo.pcx` | INVENTORY | Allocation, stock, transfers, handbook validation |
| `bkk2.site@demo.pcx` | INVENTORY | Project-scoped inventory (BKK2 only) |
| `finance@demo.pcx` | FINANCE | Cost events, TCO creation, FM import |
| `fm@demo.pcx` | FM | Handbook acceptance, FM work orders |
| `integration@demo.pcx` | INTEGRATION | Procore connection, sync, outbox/inbox resolution |
| `supplier.meridian@demo.pcx` | SUPPLIER | Supplier bid desk (Meridian) — sourcing workspace only |
| `supplier.northwind@demo.pcx` | SUPPLIER | Supplier bid desk (Northwind) |
| `supplier.polar@demo.pcx` | SUPPLIER | Supplier bid desk (Polar) |

Suppliers may only reach `/sourcing/*`; the UI redirects and the API enforces the same scope.

---

## Workspaces

| Workspace | What lives there |
| --- | --- |
| Dashboard | Cross-domain summary, attention queue, unit position, recent audit |
| Planning & BOQ | Requirements + revisions, BOQ imports, impact actions, benchmark evidence |
| Sourcing & Award | Packages, immutable offer revisions, normalization, evaluation, frozen award, PO release |
| Delivery & Assets | PO register and identities, serialized unit passports, stock, allocation, arrival, shipments, transfers, FAT & recovery |
| Handbook & Operations | Handbook assembly, validation, waivers, approval, hashed publish, FM work orders |
| Cost Intelligence | Cost events (actual/provisional/superseded), unit summaries, structure rollup, TCO scenarios |
| Administration | Procore connection, outbox, webhook inbox, exceptions, external links, simulators, audit log |

Commercial values (prices, totals, TCO) are only rendered for roles with commercial visibility; the API
withholds them for supplier sessions.

---

## Repository layout

```
backend/
  app/
    api/             HTTP routers (auth, planning, sourcing, procurement, inventory, assets,
                     quality, logistics, handbook, costs, integrations, dashboard)
    services/        Domain services: state machines, invariants, projections
    domain/          Numbering, rounding and identity rules (exact decimals)
    core/            Auth, RBAC, audit, idempotency, outbox, errors, ETag helpers
    integrations/    Procore connector, Oracle/Planon simulators, embedded app manifest
    seed/            Deterministic BKK reference + planning/delivery/Procore scenarios
    models.py        SQLAlchemy schema
  tests/             Core + acceptance suites (T01–T28)
  data/pcx.db        SQLite database (created by seed)
docs/api-contract.md API contract, conventions, outbox catalogue, demo scenario
web/
  src/api/           Typed endpoint catalogue, fetch client, query/mutation hooks, types
  src/pages/         One folder per workspace
  src/components/    Accessible table/form/dialog primitives, shared display components
  src/auth/          Session provider and UI capability map
  src/layout/        Workspace rail, context bar, navigation
  src/embed/         Procore launch-context parsing and side-panel handshake
```

---

## API conventions

- **Auth** — `POST /api/auth/login` `{email, password, tenant_code}` returns a bearer token; send
  `Authorization: Bearer <token>`. Sessions expire per `PCX_SESSION_TTL_MINUTES`.
- **Errors** — RFC 7807 `application/problem+json` with a stable `title` code (e.g. `STALE_WRITE`,
  `IDEMPOTENCY_CONFLICT`) and field `errors`.
- **Concurrency** — versioned writes return `ETag`; guarded commands require `If-Match` and answer
  `412` when the record moved. The UI surfaces conflicts inline.
- **Idempotency** — creates and external commands accept `Idempotency-Key`; a replay returns the original
  result, a payload mismatch raises `409`.
- **Numbers** — monetary and quantity values are decimal strings, never floats. Division uses explicit
  rounding (half-up) and totals are summed exactly.
- **Unknowns** — absent evidence is `null`, rendered as *Unknown*. Nothing is coerced to `0`.
- **Audit** — every command appends an immutable audit entry with actor, subject, action, reason,
  correlation id and before/after state. `GET /api/audit` exposes it.

The full endpoint list lives in [docs/api-contract.md](docs/api-contract.md).

---

## Procore integration

Configuration lives in `backend/.env` (prefix `PCX_`):

```ini
PCX_PROCORE_MODE=SIMULATED            # SIMULATED | SANDBOX | PRODUCTION
PCX_PROCORE_CLIENT_ID=...
PCX_PROCORE_CLIENT_SECRET=...
PCX_PROCORE_REDIRECT_URI=http://localhost:8000/api/integrations/procore/oauth/callback
PCX_PROCORE_WEBHOOK_SECRET=...
PCX_PUBLIC_BASE_URL=https://your-host.example
PCX_FRAME_ANCESTORS='self' https://app.procore.com https://us02.procore.com https://uk01.procore.com https://sandbox.procore.com
```

- **SIMULATED** needs no credentials: an OAuth connection, sync, write-backs and webhooks run against the
  in-process simulator. Switch simulator behaviour per target (ACK / REJECT / TIMEOUT / TRANSIENT) in
  *Administration → Simulators*.
- **Writes never block the request.** Commands append outbox messages; a worker delivers them with retry
  and backoff. `TIMEOUT` outcomes become `TIMEOUT_UNKNOWN` and must be reconciled explicitly — the UI
  never silently retries an unconfirmed external write.
- **Inbound webhooks** are persisted before acknowledgement, deduplicated on event id + payload hash, then
  processed once. Handler failures open integration exceptions.
- **Sync** pulls projects, vendors, cost codes and commitments and maintains the external link register
  (`/api/integrations/links`).
- **Embedded launch** — Full Screen apps pass `?procore_company_id=&procore_project_id=`; Side Panel apps
  exchange `{type:'initialize'}` / `{type:'setup'}` messages, accepted only from `*.procore.com` over
  HTTPS. The launch context maps the Procore company/project to a PCX programme/project in the context bar.
- **CSP** — every response sets `frame-ancestors` from `PCX_FRAME_ANCESTORS` and `nosniff`.
- **App manifest** — `GET /api/integrations/procore/app-manifest` returns the URLs, scopes and webhook
  description to register in the Procore developer portal; the UI displays it on the Procore connection page.
- **SIMULATED demo company** — the seed connects a simulated company (`562949953421312`), syncs resources
  and replays outbox write-backs so Administration shows a realistic connection on first launch.

---

## Acceptance coverage

The suite in `backend/tests` maps to specification criteria:

| Tests | Theme |
| --- | --- |
| T01–T06 | Requirement revisions, BOQ idempotency, benchmark normalization, reuse, approval impacts |
| T07–T12 | Packages, offer immutability, normalization, evaluation staleness, award freeze, PO identity |
| T13–T18 | Arrival as-known-at snapshots, structure history, FAT/recovery, transfer hashes, cost exactness |
| T19–T25 | Cost attribution/supersession, TCO, rollup, handbook validation/waiver/publish, FM resolution |
| T26–T28 | Tenant + supplier isolation, replay safety, restore/reconnect |

Run `py -m pytest -q` for the current result.

---

## Development notes

- The database is disposable: `py -m app.seed` rebuilds it deterministically. Use `--reference-only` to
  seed master data without business scenarios.
- The outbox worker starts with the app (`PCX_RUN_OUTBOX_WORKER=false` disables it in tests).
- Type-check the frontend with `cd web && npm run typecheck`.
- Hard-refresh after `npm run build` when the backend is already serving `web/dist` — the SPA fallback
  serves the newest `index.html`, but hashed bundles are cached by the browser.

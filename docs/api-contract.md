# PCX API contract (v1)

Backend: FastAPI in `backend/app`. Base path `/api`. All workstreams build to this contract. The
schema in `backend/app/models.py` is authoritative for field names.

## Conventions

- **Auth:** send `Authorization: Bearer <token>`. Get the token from `POST /api/auth/login` with `{email, password, tenant_code:"DEMO"}`, which returns `{token, user}`. `GET /api/auth/me` returns `{user, roles, can_see_commercial}`.
- **JSON shape:**
  - Keys are snake_case and match model column names. Records are serialized with `app.api.common.row()`.
  - Decimals are always **strings** (`"1050"`, `"0.08"`); never send JSON floats for money or quantities.
  - Dates are `YYYY-MM-DD`. Datetimes are UTC ISO strings ending in `Z`.
  - An unknown value is `null`, never `0`.
- **Versioned resources** carry `version` and `etag` (`W/"3"`). Mutating commands on them accept an `If-Match` header; approve and publish commands **require** it, returning 428 when it is missing and 412 when it is stale.
- **Commands** accept an optional `Idempotency-Key` header. The same key with the same body returns the stored response; the same key with a different body returns 409. Use `app.core.commands.replay` / `remember`.
- **Errors** are `application/problem+json` with `{type, title, status, detail, errors}`, where `title` is a stable machine code such as `MANDATORY_DEVIATION_OPEN`.
  - 404 also covers cross-tenant and out-of-scope ids. Never reveal that such a record exists.
  - 403 covers role failures.
  - 409 covers state and concurrency conflicts.
  - 422 covers business-rule failures.
- **Every mutation** must, in one transaction: write an audit row (`app.core.audit.record`), write outbox rows where an external system must learn of the change (`app.core.outbox.enqueue` / `publish_event`), and commit once.
- **Roles:** OWNER, ESTIMATOR, ENGINEERING, PROCUREMENT, SUPPLIER, INVENTORY, FINANCE, FM, INTEGRATION, ADMIN. ADMIN passes every internal role check.
  - Suppliers see only their own offers and packages that have been issued to them.
  - Commercial fields (prices, costs, purchase price annexes) are visible only when `p.can_see_commercial` is true. For other roles they are omitted or nulled.

## Reference (core, done)

`GET /api/programmes` · `/api/projects` · `/api/projects/{id}/wbs` · `/api/locations` · `/api/suppliers` ·
`/api/equipment-classes?include_components=` · `/api/item-models?equipment_class_id=` · `/api/item-models/{id}` (adds `bom` tree with `children`, `compatible_spares`, `options`) · `/api/options` · `/api/dashboard/summary` · `/api/audit?subject_type=&subject_id=` · `/api/health`

## Planning — `/api/planning` (workstream A)

| Method and path | Body / query | Returns |
|---|---|---|
| GET `/requirements` | `project_id?` | list of requirement rows + `current_revision` (approved) + `latest_revision` + `project_code` + `equipment_class_name` |
| POST `/requirements` | `{title, project_id, wbs_id?, equipment_class_id, code?, source_boq_key?, source_line_key?, revision:{quantity, uom, duty, capacity, capacity_unit, redundancy, install_location, specification_json, cost_code, budget_amount, currency, required_site_date, required_install_date, required_operational_date}}` | 201 `{requirement, revision}`. A duplicate `(source_boq_key, source_line_key)` returns the existing need with 200 (T01) |
| GET `/requirements/{id}` | | `{requirement, revisions[], impact_actions[], benchmark_runs[], reuse_assessments[], reservations[]}` |
| POST `/requirements/{id}/revisions` | `{changes:{...revision fields}, change_reason}` | new DRAFT revision; `changed_fields` computed against its predecessor |
| POST `/revisions/{id}/submit` · `/approve` · `/cancel` | approve requires If-Match on the revision's requirement | Approve promotes `current_revision_id`, supersedes the prior approved revision, opens ImpactActions for affected evaluations, awards, POs and reservations, and publishes `RequirementRevisionApproved` (T02) |
| GET `/impact-actions?state=` · POST `/impact-actions/{id}/resolve` `{resolution}` | | |
| POST `/boq-imports` | `{project_id, source_key, lines:[{source_line_key, title, equipment_class_code, quantity, uom, budget_amount, currency, duty?, capacity?, capacity_unit?, cost_code?, required_site_date?}]}` | BoqRevision. Same `source_hash` → same revision (idempotent); a different hash → next revision |
| GET `/boq-revisions?project_id=` | | |
| GET `/benchmark-observations?equipment_class_id=` | | |
| POST `/benchmark-runs` | `{requirement_revision_id, evidence_cutoff?}` | run with `results[]`, `excluded[]` (with reasons), `quality_json` (`sample_count`, `coverage`, `missing_scope`, `basis`). State is `INSUFFICIENT_EVIDENCE` when n < `benchmark_min_sample` (T03, T04) |
| GET `/benchmark-runs/{id}` | | |
| GET `/reuse-candidates?requirement_revision_id=` | | existing compatible units in any authorized project: `{unit, project_code, custody, condition, available_from, active_reservation}` |
| POST `/reuse-assessments` | `{requirement_revision_id, unit_id, currency, transfer_cost, refurbishment_cost, retest_cost, forward_new_cost, available_from}` | assessment; `forward_reuse_cost` excludes sunk purchase cost, which is recorded in `sunk_cost_excluded` (T06) |
| POST `/reuse-assessments/{id}/approve` · `/reject` | | approve creates an ACTIVE Reservation (unique per unit, T05 → 409 `UNIT_ALREADY_RESERVED`) |
| POST `/reservations` `{unit_id, project_id, requirement_id?}` · POST `/reservations/{id}/release` · GET `/reservations?unit_id=` | | |

## Sourcing — `/api/sourcing` (workstream A)

| Method and path | Body | Notes |
|---|---|---|
| GET/POST `/packages` | `{code, title, programme_id, currency, bid_due_at?, evaluation_policy_json?, lines:[{line_key, requirement_revision_id, quantity, uom, scope_json:{required:[...]}}]}` | a package spans projects of one programme |
| GET `/packages/{id}` | | `{package, lines[], offers[] (latest revisions; supplier sees own only), evaluations[], awards[]}` |
| POST `/packages/{id}/issue` | | |
| POST `/packages/{id}/offers` | `{supplier_id?, source_offer_key, currency, fx_rate_to_package?, valid_until, incoterms, lines:[{line_key, option_code, quantity, unit_price, promised_delivery_date?, lead_time_days?, scope_json:{included:[], excluded:[]}, annual_om_estimate?, warranty_months?}]}` | A supplier always submits as its own `supplier_id`. Same key with changed content → new revision, prior marked SUPERSEDED (T07); same content → same revision |
| GET `/offers/{id}` | | `{offer, lines[] each with adjustments[] and deviations[]}` |
| POST `/offer-lines/{id}/adjustments` | `{category, amount: string\|null, currency, rationale, evidence_ref?}` | null amount = unpriced unknown. Rejected if the category is already included in the offer scope |
| POST `/adjustments/{id}/approve` · `/reject` | | |
| POST `/offer-lines/{id}/deviations` | `{criterion_ref, mandatory, severity, description, proposed_alternative?}` | |
| POST `/deviations/{id}/disposition` | `{disposition: ACCEPTED\|REJECTED, evidence_ref?}` | ENGINEERING only |
| POST `/packages/{id}/evaluations` | `{criteria_policy_json:{weights:{INSTALLED_COST, TCO, DELIVERY, TECHNICAL}, horizon_years, discount_rate}}` | CALCULATED evaluation: `results_json.lines[]` with `normalized_installed_cost` (null if any unpriced exclusion), `tco_pv`, `eligible`, `ineligible_reasons`, `weighted_score`, `rank`, `unknowns[]`; `input_fingerprint` |
| GET `/evaluations/{id}` | | includes live `is_stale` + `stale_reason` (T09) |
| POST `/evaluations/{id}/submit` · `/approve` | If-Match | approve blocked when stale |
| POST `/evaluations/{id}/awards` | `{rationale, input_fingerprint, lines:[{package_line_id, offer_line_id, selected_quantity}]}` | DRAFT award; ordinary award blocked by any open or rejected mandatory deviation (T08). Split quantities cannot exceed the package line quantity (T10) |
| POST `/awards/{id}/submit` · `/approve` | approve: If-Match + `{input_fingerprint}` | freezes `frozen_json`; publishes `AwardApproved` |
| GET `/awards/{id}` | | award + lines + PO reconciliation |

## Procurement and identity — `/api/procurement` (workstream A)

| Method and path | Body | Notes |
|---|---|---|
| POST `/purchase-orders/import` | `{source_system: GEP\|ORACLE\|PROCORE, source_number, canonical_number?, award_id?, supplier_id, programme_id, currency, incoterms?, lines:[{line_no, item_code, option_code?, quantity, unit_price, need_by?, award_line_id?, distributions:[{project_id\|null, wbs_id?, requirement_id?, quantity}]}]}` | Alias dedupe: an existing alias, or an explicit `canonical_number` match, yields the same canonical PO with no new units (T11). A new PO creates one PLANNED PhysicalUnit per serialized quantity (`asset_code` from `app.services.identity`, `requirement_id` from the distribution, `assigned_project_id` NULL = programme stock). With `award_line_id` it creates RequirementPoAllocation, conserving quantities. Enqueues `PROCORE purchase_order.upsert` |
| GET `/purchase-orders` · `/purchase-orders/{id}` | | `{po, aliases[], lines[] with distributions[] and unit counts, units[]}` |
| POST `/purchase-orders/{id}/cancel-quantity` | `{po_line_id, quantity}` | the latest PLANNED units become CANCELLED; codes are never reused (T12) |

## Inventory — `/api/inventory` (workstream B)

| Method and path | Body | Notes |
|---|---|---|
| POST `/receipts` | `{receipt_ref, po_id, location_id, received_at, lines:[{unit_id, serial_number, condition, components:[{slot_code, serial_number, asset_code?}]}]}` | Unit → RECEIVED, custody = location. Supplied components are created as child units and fitted via UnitComponent. A unit cannot be received twice (409 `UNIT_ALREADY_RECEIVED`, T12). Enqueues `ORACLE receipt.create`. Records a provisional PURCHASE cost per unit |
| GET `/stock?programme_id=&location_id=&project_id=` | | `{by_location:[{location, total, unallocated, allocated, reserved, issued}], units:[...]}` |
| POST `/allocations` | `{unit_ids[], kind: PLANNING_INTENT\|ORACLE_RESERVATION\|PROJECT_TRANSFER, to_project_id, to_wbs_id?, reason}` | sets `assigned_project_id` and `allocation_status` (ALLOCATED / RESERVED / ISSUED path). Reallocation records `from_project_id`. ORACLE_* and PROJECT_TRANSFER enqueue ORACLE messages; PROJECT_TRANSFER sets `generates_project_charge` |
| POST `/allocations/{id}/release` · GET `/allocations?unit_id=` | | |
| POST `/issues` | `{unit_id, to_location_id, installed_position?}` | requires an assigned project; ISSUE stock transaction; `allocation_status` ISSUED |
| GET/POST `/transfers` | `{code, from_location_id, to_location_id, to_project_id?, unit_ids[]}` | descendants included and deduplicated; `structure_hash` frozen |
| POST `/transfers/{id}/approve` · `/dispatch` · `/receive` `{unit_ids[]}` | | a changed structure invalidates approval; partial receipt (T17) |
| GET `/stock-transactions?unit_id=` | | |

## Assets — `/api/assets` (workstream B)

| Method and path | Notes |
|---|---|
| GET `/units?programme_id=&project_id=&state=&allocation_status=&q=&include_components=false` | rows + `item_code`, `project_code`, `custody_code` |
| GET `/units/{id}` | passport: `{unit, item_model, equipment_class, requirement, po:{canonical_number, line_no}, assigned_project, custody_location, parent:{unit, slot_code}\|null, structure (current tree), tests[], recovery_cases[], allocations[], latest_arrival, handbook:{package_id, state}\|null, cost_summary\|null (commercial only), external_links[]}` |
| GET `/units/{id}/structure?at=` | temporal tree at a datetime |
| GET `/units/{id}/history` | component fit and removal events, allocations, stock transactions, audit |
| POST `/units` | register a loose spare `{item_code, serial_number, programme_id, custody_location_id, is_spare:true}` |
| POST `/units/{id}/components` | `{child_unit_id, slot_code, valid_from, install_reason}`. Rejects an occupied slot, a child already fitted elsewhere, cycles and historical overlaps (T15) |
| POST `/units/{id}/components/{link_id}/remove` | `{valid_to, removal_reason}` |

## Quality and recovery — `/api/quality` (workstream B)

`POST /tests` `{unit_id, component_unit_id?, test_type, test_ref, result, stage, performed_at, measurement?, evidence_ref?}`. A FAIL sets `quality_status` FAILED; a PASS never releases a unit that has an open recovery case.

`POST /recovery-cases` `{ncr_number, parent_unit_id, failed_component_id, slot_code, failed_test_id?, failure_stage, description}`

Commands on a recovery case:
- `POST /recovery-cases/{id}/disposition` `{route: REPAIR_AND_WAIT|REPLACE_FROM_SPARE|TAKE_FROM_DONOR, donor_unit_id?, replacement_unit_id?, responsible_party, expected_completion?, replacement_eta?}`. Computes `impacts_json`; the donor route lists both projects.
- `/remove-component` `{removed_at, supplier_return_ref?}` leaves the parent slot vacant (T16).
- `/fit-replacement` `{fitted_at}`. Repair refits the same UUID; a spare or donor unit is a different UUID with `replaces_unit_id`. The state becomes RETEST_REQUIRED.
- `/release` `{retest_id}`. ENGINEERING only; needs a PASS retest recorded after the fit.
- `/close` `{recovery_cost?, currency?}`.

`GET /recovery-cases?state=` and `/recovery-cases/{id}`.

## Logistics and arrival — `/api/logistics` (workstream B)

`POST /shipments` `{code, po_id, carrier, mode, container_ref?, bol_awb?, origin, destination_location_id, unit_ids[]}`. A unit can sit on only one active shipment (T12).

`POST /shipments/{id}/milestones` `{code, planned_at?, estimated_at?, actual_at?, source, source_event_id?, recorded_at?}`. Deduplicated on `source_event_id`.

`POST /shipments/{id}/tracking-failure` `{message}`.

`GET /shipments`, `/shipments/{id}`.

`GET /arrival?project_id=&selected_date=&as_known_at=` returns per unit `{unit_id, asset_code, eta_p50, earliest, latest, p_on_date, p_by_date (strings or null), quality GOOD|SPARSE|UNKNOWN|STALE, unknown_reason, receiving_readiness:{ready, blockers[]}}`. Only milestones with `recorded_at <= as_known_at` are used (T13, T14).

`POST /arrival/snapshots` `{project_id?}` creates ArrivalSnapshot rows.

## Handbooks — `/api/handbooks` (workstream B)

`GET /templates` (with criteria) · `POST /evidence` `{unit_id, doc_type, title, revision, model_ref?, serial_ref?, expires_at?, storage_ref?, commercial}` · `POST /evidence/{id}/approve` · `GET /evidence?unit_id=`

`POST /handbooks` `{unit_id, template_id?}` · `GET /handbooks?unit_id=&state=` · `GET /handbooks/{id}` returns `{package, unit, entries[] (with criterion), blockers[]}`. Commercial criteria are hidden without `can_see_commercial`.

Commands on a package:
- `POST /handbooks/{id}/validate` sets each entry to PASS, FAIL, MISSING or WAIVED (T22). A critical failure or missing item → BLOCKED.
- `/entries/{entry_id}/waive` `{reason, expires_at}`. OWNER or ENGINEERING only; a critical criterion cannot be waived without ENGINEERING.
- `/approve` and `/publish` require If-Match. Publish computes `package_hash` over the manifest, freezes it (T24), and enqueues `PROCORE handbook.publish` and `PLANON asset.handover`.
- `/acceptance` `{decision, notes}`. FM only.
- `/new-version`.
- `GET /handbooks/{id}/export` returns the recipient structured fields with no commercial annex (T25).

## Costs, TCO and FM — `/api/costs` (workstream B)

`POST /events` `{economic_key, unit_id?, po_line_id?, posting_project_id?, category, status, amount, currency, source_system, source_ref, occurred_on, service_from?, service_to?}`. A repeated `economic_key` supersedes the prior revision; recognized cost = the latest ACTUAL (T18).

`GET /events?unit_id=` · `POST /events/{id}/allocate` `{basis, targets:[{unit_id?, attributed_project_id?, weight}]}` (exact sum, T19) · `GET /units/{unit_id}/summary` returns `{recognized_total, provisional_total, by_category, by_project, unallocated_total, sources[]}` · `GET /rollup?parent_unit_id=` (each distinct leaf once)

`POST /tco-scenarios` `{name, subject_type, subject_id?, currency, horizon_years, discount_rate, timing, lines:[{year, category, amount, kind}], is_illustrative}` computes `undiscounted_total` and `present_value` (T21: 2090 / about 1953.9 at 8%). Also `GET /tco-scenarios`.

`POST /fm-work-orders/import` `{work_orders:[{work_order_ref, invoice_ref, planon_asset_id?, parent_unit_id?, slot_code?, service_from, service_to, description, amount, currency, posting_project_id?}]}`. Resolves the fitted unit at the service date and the attributed project at the service date; unresolved → state UNRESOLVED (T20). Also `GET /fm-work-orders`.

`POST /outcomes/publish` `{unit_id}` turns observed asset life into a BenchmarkObservation (B06.3). `GET /outcomes?equipment_class_id=`.

## Integrations — `/api/integrations` (workstream C)

**Procore connection:**
- `GET /procore/status`
- `GET /procore/oauth/authorize-url`
- `GET /procore/oauth/callback?code&state`
- `POST /procore/connect` (SIMULATED or CLIENT_CREDENTIALS)
- `POST /procore/disconnect`
- `POST /procore/sync` `{resources:[projects, vendors, cost_codes, commitments]}`
- `POST /procore/webhooks` (public; verified by the shared Authorization header; inbox dedupe on `ulid` or `id`)
- `GET /procore/embedded/context?company_id=&project_id=` maps to a pcx project
- `GET /procore/app-manifest`

**Platform operations:**
- `GET /links?domain_type=&domain_id=`
- `GET /outbox?state=`
- `POST /outbox/{id}/retry` (409 if the message is UNKNOWN)
- `POST /outbox/{id}/reconcile` `{outcome: APPLIED|NOT_APPLIED, external_ref?}` (T27)
- `POST /outbox/process`
- `GET /inbox`
- `GET /exceptions?state=` · `POST /exceptions/{id}/resolve` `{resolution}`
- `GET /simulators` · `POST /simulators/{ORACLE|PLANON|PROCORE}/mode` `{mode: ACK|REJECT|TIMEOUT|TRANSIENT}`

## Outbox event catalogue

| Target | event_type | payload | Handler owner |
|---|---|---|---|
| ORACLE | `receipt.create` | `{receipt_id}` | B (`integrations/oracle_sim.py`) |
| ORACLE | `reservation.create` / `reservation.release` | `{allocation_id}` | B |
| ORACLE | `project_transfer.create` | `{allocation_id}` | B |
| ORACLE | `stock_txn.post` | `{stock_transaction_id}` | B |
| PLANON | `asset.handover` | `{unit_id, package_id}` | B (`integrations/planon_sim.py`) |
| PROCORE | `purchase_order.upsert` | `{po_id}` | C |
| PROCORE | `equipment.upsert` | `{unit_id}` | C |
| PROCORE | `handbook.publish` | `{package_id}` | C |
| INTERNAL | `RequirementRevisionApproved`, `BenchmarkPublished`, `EvaluationInvalidated`, `AwardApproved`, `AwardPoReconciled`, `HandbookValidated`, `HandbookPublished`, `AssetOutcomeObserved` | aggregate ids | acknowledged automatically |

Simulators read their mode from `app/integrations/sim_state.py` (`get_mode(target)` / `set_mode(target, mode)`, default ACK), which workstream C provides.

## Seeded demo scenario (BKK)

- **Reference data** (`app/seed/reference.py`): tenant DEMO; users `<role>@demo.pcx` plus `bkk2.site@`, `supplier.meridian@`, `supplier.northwind@` and `supplier.polar@`, all with password `Demo!2026`; programme BKK (BKK1, BKK2) and closed SGP1; locations and suppliers; 55 LLE classes plus 14 component classes; gensets GEN-MER-2500S and GEN-NWP-2500X and chiller CH-POL-1500A with nested BOMs; options OPT-GEN-A, OPT-GEN-B and OPT-CHL-A; handbook templates HB-GEN and HB-CHL; benchmark observations.
- **A** (`scenario_planning.py`):
  - Requirements REQ-BKK1-GEN (6 × 2500 kVA standby) and REQ-BKK2-GEN (4), both approved. REQ-BKK1-GEN also has a later DRAFT revision 2 with quantity 7, showing T02.
  - Requirements REQ-BKK1-CHL (2) and REQ-BKK2-CHL (2).
  - A published benchmark run for REQ-BKK1-GEN.
  - Package PKG-BKK-GEN with offer A from Meridian (all scope, OPT-GEN-A) and offer B from Northwind (cheaper, freight excluded with an unpriced adjustment, plus a mandatory OPEN deviation on 46 C derating).
  - An approved evaluation and an approved award of 10 to Meridian.
  - PO PO-BKK-GEN-0001 with aliases GEP-PO-55120 and ORA-PO-880120 → GEN-001..GEN-010 (requirement lineage 6 to BKK1, 4 to BKK2).
  - Chiller PO PO-BKK-CHL-0001 (Polar, 4 units) → CH-001..CH-004.
- **B** (`scenario_delivery.py`):
  - Shipments with milestones.
  - Receipt of GEN-001..010 into BKK-CW, recording components ENG/ALT/CTL/RAD/BAT/BRK plus TUR/FIP under the engine.
  - Allocations: GEN-001..006 PLANNING_INTENT → BKK1; GEN-007..009 ORACLE_RESERVATION → BKK2; GEN-010 left unallocated.
  - Receipt of CH-001..004 with compressors CMP-101.. (COMPRESSOR_1 / COMPRESSOR_2).
  - FAT FAIL on CH-001 compressor CMP-101 → NCR recovery case dispositioned REPLACE_FROM_SPARE and awaiting retest.
  - A spare ALT and a spare CMP held in stock.
  - GEN-001 issued to BKK1-GY and handbook validated → BLOCKED (commissioning missing).
  - Cost events, including provisional 1000 → final 1050 on a spare.
  - A TCO scenario (illustrative 2090 / PV about 1953.9).
  - FM work orders, one resolved and one unresolved.
- **C** (`scenario_procore.py`): a SIMULATED Procore connection for company 562949953421312 with BKK1/BKK2 project links, vendor links and the commitment link for PO-BKK-GEN-0001.

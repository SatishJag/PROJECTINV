/**
 * Hand-written TS mirrors of backend/app/models.py. JSON keys = column names.
 * Decimals are strings (D), dates 'YYYY-MM-DD' (ISODate), datetimes UTC ISO 'Z' (ISODateTime).
 * Composite response shapes follow docs/api-contract.md; keys marked "assumed" are guesses
 * where the contract does not spell out the shape.
 */
export type D = string
export type ISODate = string
export type ISODateTime = string
export type Json = Record<string, unknown>

export interface Base {
  id: string
  created_at?: ISODateTime
  created_by?: string | null
}
export interface Versioned {
  version: number
  updated_at?: ISODateTime
  etag: string
}

export type Role = 'OWNER' | 'ESTIMATOR' | 'ENGINEERING' | 'PROCUREMENT' | 'SUPPLIER' | 'INVENTORY' | 'FINANCE' | 'FM' | 'INTEGRATION' | 'ADMIN'

// ---------------------------------------------------------------- auth
export interface User extends Base {
  email: string
  name: string
  roles: string
  role_list: Role[]
  supplier_id: string | null
  procore_user_id: string | null
  active: boolean
}
export interface LoginResponse {
  token: string
  user: User
}
export interface MeResponse {
  user: User
  roles: Role[]
  can_see_commercial: boolean
}
export interface DemoAccounts {
  demo_mode: boolean
  password_hint?: string
  accounts: { email: string; name: string; roles: Role[] }[]
  role_catalogue?: Record<string, string>
}

// ---------------------------------------------------------------- reference
export interface Programme extends Base {
  code: string
  name: string
  region: string | null
  currency: string
}
export interface Project extends Base {
  programme_id: string
  code: string
  name: string
  site_timezone: string
  status: string
  procore_company_id: string | null
  procore_project_id: string | null
}
export interface WbsElement extends Base {
  project_id: string
  code: string
  name: string
  cost_code: string | null
  procore_cost_code_id: string | null
}
export type LocationKind = 'SUPPLIER' | 'IN_TRANSIT' | 'CENTRAL_WAREHOUSE' | 'SITE_STORE' | 'INSTALLED'
export interface Location extends Base {
  code: string
  name: string
  kind: LocationKind | string
  programme_id: string | null
  project_id: string | null
  oracle_subinventory: string | null
}
export interface Supplier extends Base {
  key: string
  name: string
  country: string | null
  procore_vendor_id: string | null
  oracle_supplier_id: string | null
}
export interface EquipmentClass extends Base {
  code: string
  category: string
  name: string
  lle_status: string
  tracking: 'SERIALIZED' | 'BULK' | string
  typical_lead_time_days: number | null
  is_component_class: boolean
}
export interface ItemModel extends Base {
  item_code: string
  equipment_class_id: string
  equipment_class_code?: string
  manufacturer: string | null
  model: string | null
  description: string
  rated_capacity: D | null
  capacity_unit: string | null
  rating_standard: string | null
  duty_modes: string | null
  serial_controlled: boolean
  specs_json: Json
  state: string
  oracle_item_id: string | null
}
export interface BomNode extends Base {
  parent_model_id: string
  child_model_id: string | null
  slot_code: string
  description: string
  quantity: D
  individually_tracked: boolean
  parent_slot_code: string | null
  child_item_code: string | null
  child_description: string | null
  children: BomNode[]
}
export interface EquipmentOption extends Base {
  item_model_id: string
  option_code: string
  revision_no: number
  name: string
  configuration_json: Json
  technical_basis: string | null
  state: string
  item_code?: string
  equipment_class_id?: string
}
export interface ItemModelDetail extends ItemModel {
  bom: BomNode[]
  compatible_spares: { id: string; spare_model_id: string; parent_model_id: string; slot_code: string; spare_item_code: string }[]
  options: EquipmentOption[]
}

// ---------------------------------------------------------------- planning
export type RevisionState = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SUPERSEDED' | 'CANCELLED'
export interface RequirementRevision extends Base {
  requirement_id: string
  revision_no: number
  state: RevisionState | string
  quantity: D
  uom: string
  duty: string | null
  capacity: D | null
  capacity_unit: string | null
  redundancy: string | null
  install_location: string | null
  specification_json: Json
  cost_code: string | null
  budget_amount: D | null
  currency: string | null
  required_site_date: ISODate | null
  required_install_date: ISODate | null
  required_operational_date: ISODate | null
  predecessor_id: string | null
  changed_fields: string[]
  change_reason: string | null
  submitted_at: ISODateTime | null
  approved_at: ISODateTime | null
  approved_by: string | null
}
export interface Requirement extends Base, Versioned {
  code: string
  title: string
  project_id: string
  wbs_id: string | null
  equipment_class_id: string
  current_revision_id: string | null
  sourcing_route: string | null
  state: string
  source_boq_key: string | null
  source_line_key: string | null
}
export interface RequirementListRow extends Requirement {
  current_revision: RequirementRevision | null
  latest_revision: RequirementRevision | null
  project_code?: string
  equipment_class_code?: string
  equipment_class_name?: string
}
export interface ImpactAction extends Base, Versioned {
  requirement_id: string
  revision_id: string | null
  subject_type: string
  subject_id: string
  reason: string
  owner_role: string
  state: string
  resolution: string | null
}
export interface BenchmarkResult extends Base {
  benchmark_run_id: string
  metric_code: string
  basis: string
  value_min: D | null
  value_median: D | null
  value_max: D | null
  unit: string | null
  sample_count: number
  coverage_note: string | null
}
export interface BenchmarkExclusion {
  observation_id?: string
  source_project_code?: string
  source_ref?: string
  reason?: string
  reasons?: string[]
  [k: string]: unknown
}
export interface BenchmarkRun extends Base {
  requirement_revision_id: string
  cohort_json: Json
  normalization_version: string
  evidence_cutoff: ISODateTime
  input_manifest_hash: string
  observation_ids: string[]
  excluded_json: BenchmarkExclusion[]
  quality_json: { sample_count?: number; coverage?: string | number | null; missing_scope?: string[]; basis?: string; [k: string]: unknown }
  sample_count: number
  state: 'CALCULATED' | 'PUBLISHED' | 'INSUFFICIENT_EVIDENCE' | string
  results?: BenchmarkResult[]
  excluded?: BenchmarkExclusion[]
}
export interface BenchmarkRunResponse {
  run: BenchmarkRun
  results: BenchmarkResult[]
  excluded: BenchmarkExclusion[]
  quality: Json
}
export interface Reservation extends Base, Versioned {
  unit_id: string
  requirement_id: string | null
  project_id: string
  state: string
  authority: string
  oracle_reservation_ref: string | null
  expires_at: ISODateTime | null
  approved_by: string | null
}
export interface ReuseAssessment extends Base, Versioned {
  requirement_revision_id: string
  unit_id: string
  state: string
  suitability_json: Json
  available_from: ISODate | null
  currency: string
  transfer_cost: D | null
  refurbishment_cost: D | null
  retest_cost: D | null
  forward_reuse_cost: D | null
  forward_new_cost: D | null
  sunk_cost_excluded: D | null
  reservation_id: string | null
  decision_reason: string | null
  approved_by: string | null
}
export interface ReuseCandidate {
  unit: PhysicalUnit
  project_code: string | null
  custody_code: string | null
  condition: string | null
  available_from: ISODate | null
  active_reservation: Reservation | null
  purchase_cost?: D | null
}
export interface RequirementDetail extends Requirement {
  project_code?: string
  project_name?: string
  equipment_class_code?: string
  equipment_class_name?: string
  current_revision: RequirementRevision | null
  latest_revision: RequirementRevision | null
  revisions: RequirementRevision[]
  impact_actions: ImpactAction[]
  benchmark_runs: BenchmarkRun[]
  reuse_assessments: ReuseAssessment[]
  reservations: Reservation[]
}
export interface BoqRevision extends Base {
  project_id: string
  project_code?: string
  source_key: string
  revision_no: number
  state: string
  source_hash: string
  approved_at: ISODateTime | null
  lines?: unknown[]
}
export interface BenchmarkObservation extends Base {
  equipment_class_id: string
  item_model_id: string | null
  source_project_code: string
  duty: string | null
  capacity: D | null
  capacity_unit: string | null
  region: string | null
  currency: string
  purchase_cost: D | null
  installed_cost: D | null
  operating_years_observed: number
  scope_included: string[]
  commissioning_failures: number
  delivery_delay_days: number | null
  observed_at: ISODate
  source_ref: string
}

// ---------------------------------------------------------------- sourcing
export interface SourcingPackage extends Base, Versioned {
  code: string
  title: string
  programme_id: string
  revision_no: number
  state: string
  source_system: string
  source_key: string | null
  currency: string
  bid_due_at: ISODateTime | null
  evaluation_policy_json: Json
  /** Present on the list projection. */
  lines?: PackageLine[]
  offers?: SupplierOffer[]
  evaluations?: Evaluation[]
  awards?: AwardDecision[]
}
export interface PackageLine extends Base {
  package_id: string
  line_key: string
  requirement_revision_id: string
  quantity: D
  uom: string
  scope_json: { required?: string[]; [k: string]: unknown }
  requirement_code?: string
  project_code?: string
}
export interface SupplierOffer extends Base {
  package_id: string
  supplier_id: string
  source_offer_key: string
  revision_no: number
  predecessor_id: string | null
  currency: string
  fx_rate_to_package: D | null
  valid_until: ISODate | null
  incoterms: string | null
  state: string
  content_hash: string | null
  supplier_key?: string
  supplier_name?: string
}
export interface NormalizationAdjustment extends Base, Versioned {
  offer_line_id: string
  category: string
  amount: D | null
  currency: string
  rationale: string
  evidence_ref: string | null
  state: 'PROPOSED' | 'APPROVED' | 'REJECTED' | string
  approved_by: string | null
}
export interface TechnicalDeviation extends Base, Versioned {
  offer_line_id: string
  criterion_ref: string
  mandatory: boolean
  severity: string
  description: string
  proposed_alternative: string | null
  disposition: 'OPEN' | 'ACCEPTED' | 'REJECTED' | string
  approver: string | null
  evidence_ref: string | null
}
export interface OfferLine extends Base {
  offer_id: string
  package_line_id: string
  option_id: string
  quantity: D
  unit_price: D | null
  base_amount: D | null
  promised_delivery_date: ISODate | null
  lead_time_days: number | null
  scope_json: { included?: string[]; excluded?: string[] }
  annual_om_estimate: D | null
  warranty_months: number | null
  option_code?: string
  line_key?: string
  adjustments?: NormalizationAdjustment[]
  deviations?: TechnicalDeviation[]
}
export interface OfferDetail {
  offer: SupplierOffer
  lines: OfferLine[]
}
export interface EvaluationResultLine {
  offer_line_id?: string
  offer_line_ids?: string[]
  offer_lines?: Record<string, string>
  offer_id?: string
  offer_revision_no?: number
  supplier_id?: string
  supplier_key?: string
  supplier_name?: string
  package_line_id?: string
  line_key?: string
  option_code?: string
  base_amount?: D | null
  normalized_installed_cost: D | null
  tco_pv: D | null
  annual_om?: D | null
  lead_time_days?: number | null
  promised_delivery_date?: ISODate | null
  eligible: boolean
  ineligible_reasons?: string[]
  weighted_score: D | null
  rank: number | null
  recommended?: boolean
  basis_complete?: boolean
  unknowns?: string[]
  scores?: Record<string, D | null>
  [k: string]: unknown
}
export interface Evaluation extends Base, Versioned {
  package_id: string
  revision_no: number
  state: string
  criteria_policy_json: { weights?: Record<string, D>; horizon_years?: number; discount_rate?: D; [k: string]: unknown }
  input_fingerprint: string | null
  input_manifest_json: Json
  evidence_cutoff: ISODateTime | null
  results_json: { lines?: EvaluationResultLine[]; currency?: string; [k: string]: unknown }
  stale_reason: string | null
  is_stale?: boolean
}
export interface EvaluationDetail {
  evaluation: Evaluation
  package_code: string | null
  results: Evaluation['results_json']
  scores: { criterion_code: string; score: D | null; weight: D | null; eligible: boolean; note: string | null }[]
  is_stale: boolean
  stale_reason: string | null
  current_fingerprint: string
}
export interface AwardLine extends Base {
  award_id: string
  package_line_id: string
  offer_line_id: string
  option_id: string
  supplier_id: string
  selected_quantity: D
  supplier_name?: string
  option_code?: string
  unit_price?: D | null
  line_key?: string
}
export interface AwardDecision extends Base, Versioned {
  evaluation_id: string
  decision_version: number
  state: string
  rationale: string | null
  input_fingerprint: string
  frozen_json: Json
  approved_by: string | null
  approved_at: ISODateTime | null
  source_award_ref: string | null
  lines?: AwardLine[]
}
export interface AwardDetail {
  award: AwardDecision
  evaluation_id?: string
  lines: AwardLine[]
  purchase_orders?: PurchaseOrder[]
  reconciliation?: string
  po_reconciliation?: unknown
}
export interface PackageDetail extends SourcingPackage {
  lines: PackageLine[]
  offers: SupplierOffer[]
  evaluations: Evaluation[]
  awards: AwardDecision[]
}

// ---------------------------------------------------------------- procurement
export interface PurchaseOrder extends Base, Versioned {
  canonical_number: string
  supplier_id: string
  programme_id: string
  award_id: string | null
  currency: string
  state: string
  issued_at: ISODateTime
  incoterms: string | null
  supplier_name?: string
  aliases?: PoAlias[]
  unit_count?: number
}
export interface PoAlias extends Base {
  po_id: string
  source_system: string
  source_number: string
}
export interface PoDistribution extends Base {
  po_line_id: string
  project_id: string | null
  wbs_id: string | null
  requirement_id: string | null
  quantity: D
  project_code?: string | null
  requirement_code?: string | null
}
export interface PoLine extends Base {
  po_id: string
  line_no: number
  item_model_id: string
  option_id: string | null
  quantity: D
  cancelled_quantity: D
  uom: string
  unit_price: D | null
  need_by: ISODate | null
  item_code?: string
  distributions?: PoDistribution[]
  unit_counts?: Record<string, number>
  unit_count?: number
}
export interface PoDetail {
  po: PurchaseOrder
  aliases: PoAlias[]
  lines: PoLine[]
  units: PhysicalUnit[]
}

// ---------------------------------------------------------------- assets & inventory
export type UnitState = 'PLANNED' | 'IN_TRANSIT' | 'RECEIVED' | 'ISSUED' | 'INSTALLED' | 'IN_REPAIR' | 'RETURNED' | 'SCRAPPED' | 'CANCELLED' | 'RETIRED'
export type AllocationStatus = 'UNALLOCATED' | 'ALLOCATED' | 'RESERVED' | 'ISSUED'
export interface PhysicalUnit extends Base, Versioned {
  asset_code: string
  item_model_id: string
  programme_id: string | null
  po_line_id: string | null
  requirement_id: string | null
  serial_number: string | null
  barcode: string | null
  state: UnitState | string
  custody_location_id: string | null
  assigned_project_id: string | null
  assigned_wbs_id: string | null
  allocation_status: AllocationStatus | string
  installed_position: string | null
  condition: string
  quality_status: string
  replaces_unit_id: string | null
  is_spare: boolean
  warranty_start: ISODate | null
  warranty_end: ISODate | null
  in_service_date: ISODate | null
  oracle_serial_ref: string | null
  planon_asset_id: string | null
  procore_equipment_id: string | null
  item_code?: string
  item_description?: string
  project_code?: string | null
  custody_code?: string | null
  custody_name?: string | null
}
export interface AllocationRecord extends Base, Versioned {
  unit_id: string
  kind: 'PLANNING_INTENT' | 'ORACLE_RESERVATION' | 'PROJECT_TRANSFER' | string
  from_project_id: string | null
  to_project_id: string | null
  to_wbs_id: string | null
  state: string
  reason: string | null
  requested_by: string | null
  approved_by: string | null
  effective_from: ISODateTime | null
  effective_to: ISODateTime | null
  oracle_ref: string | null
  generates_project_charge: boolean
}
export interface StockByLocation {
  location: Location
  code: string
  name: string
  total: number
  unallocated: number
  allocated: number
  reserved: number
  issued: number
}
export interface AllocationResponse {
  kind: string
  to_project: Project
  allocations: AllocationRecord[]
}
export interface StockResponse {
  by_location: StockByLocation[]
  units: PhysicalUnit[]
}
export interface StockTransaction extends Base {
  request_ref: string
  unit_id: string
  txn_type: string
  from_location_id: string | null
  to_location_id: string | null
  from_project_id: string | null
  to_project_id: string | null
  quantity: D
  state: string
  oracle_txn_id: string | null
  message: string | null
  confirmed_at: ISODateTime | null
}
export interface TransferManifest extends Base, Versioned {
  code: string
  from_location_id: string
  to_location_id: string
  to_project_id: string | null
  state: string
  unit_ids: string[]
  structure_hash: string | null
  received_unit_ids: string[]
  approved_by: string | null
}
export interface UnitComponent extends Base {
  parent_unit_id: string
  child_unit_id: string
  slot_code: string
  valid_from: ISODateTime
  valid_to: ISODateTime | null
  install_reason: string | null
  removal_reason: string | null
  work_order_ref: string | null
  recovery_case_id: string | null
}
/** Structure tree node (assumed): either {unit, slot_code, link, children} or a unit row with children. */
export interface StructureNode extends Partial<PhysicalUnit> {
  unit?: PhysicalUnit
  slot_code?: string | null
  link?: UnitComponent | null
  link_id?: string | null
  valid_from?: ISODateTime | null
  vacant?: boolean
  children?: StructureNode[]
}
export interface TestRecord extends Base {
  unit_id: string
  component_unit_id: string | null
  test_type: string
  test_ref: string
  procedure_ref: string | null
  result: 'PASS' | 'FAIL' | string
  measurement: string | null
  stage: string
  performed_at: ISODateTime
  witnessed_by: string | null
  approved_by: string | null
  evidence_ref: string | null
  recovery_case_id: string | null
}
export interface RecoveryImpact {
  project_id?: string
  project_code?: string
  unit_id?: string
  asset_code?: string
  impact?: string
  eta?: ISODate | null
}
export interface RecoveryCase extends Base, Versioned {
  ncr_number: string
  parent_unit_id: string
  failed_component_id: string | null
  slot_code: string | null
  failed_test_id: string | null
  failure_stage: string
  description: string
  state: string
  route: string | null
  donor_unit_id: string | null
  replacement_unit_id: string | null
  supplier_return_ref: string | null
  responsible_party: string | null
  expected_completion: ISODate | null
  replacement_eta: ISODate | null
  impacts_json: RecoveryImpact[]
  recovery_cost: D | null
  currency: string | null
  disposition_by: string | null
  released_by: string | null
  released_at: ISODateTime | null
  parent_asset_code?: string
  failed_component_code?: string
}
export interface RecoveryCaseDetail extends RecoveryCase {
  case?: RecoveryCase
  tests?: TestRecord[]
  links?: (UnitComponent & { child_asset_code?: string })[]
}
export interface ArrivalRow {
  unit_id: string
  asset_code: string
  item_code?: string
  project_id?: string | null
  shipment_id?: string | null
  eta_p50: ISODate | null
  earliest: ISODate | null
  latest: ISODate | null
  p_on_date: string | null
  p_by_date: string | null
  quality: 'GOOD' | 'SPARSE' | 'UNKNOWN' | 'STALE' | string
  unknown_reason: string | null
  receiving_readiness: { ready: boolean; blockers: (string | { code?: string; message?: string })[]; site_store?: string | null } | null
  shipment_code?: string | null
  required_site_date?: ISODate | null
}
export interface Shipment extends Base, Versioned {
  code: string
  po_id: string
  carrier: string | null
  mode: string
  container_ref: string | null
  bol_awb: string | null
  origin: string | null
  destination_location_id: string | null
  unit_ids: string[]
  state: string
  last_tracked_at: ISODateTime | null
  milestones?: ShipmentMilestone[]
}
export interface ShipmentMilestone extends Base {
  shipment_id: string
  code: string
  planned_at: ISODateTime | null
  estimated_at: ISODateTime | null
  actual_at: ISODateTime | null
  recorded_at: ISODateTime
  source: string
  source_event_id: string | null
}
export interface ExternalObjectLink extends Base, Versioned {
  platform: string
  company_key: string
  project_key: string | null
  object_type: string
  object_key: string
  domain_type: string
  domain_id: string
  link_role: string
  source_revision: string | null
  sync_state: string
  last_synced_at: ISODateTime | null
}
export interface CostSummary {
  unit_id?: string
  asset_code?: string
  currency: string | null
  recognized_total: D | null
  provisional_total: D | null
  by_category: { category: string; recognized: D | null; provisional: D | null }[]
  by_project: { project_id?: string | null; project_code?: string | null; amount: D | null }[]
  unallocated_total: D | null
  sources: {
    source_system?: string
    source_ref?: string
    cost_event_id?: string
    economic_key?: string
    category?: string
    amount?: D | null
    currency?: string
    status?: string
    occurred_on?: ISODate
    [k: string]: unknown
  }[]
}
export interface UnitPassport {
  unit: PhysicalUnit
  item_model: ItemModel | null
  equipment_class: EquipmentClass | null
  requirement: Requirement | null
  po: { canonical_number: string; line_no: number; id?: string; po_id?: string } | null
  assigned_project: Project | null
  custody_location: Location | null
  parent: { unit: PhysicalUnit; slot_code: string } | null
  structure: StructureNode | StructureNode[] | null
  tests: TestRecord[]
  recovery_cases: RecoveryCase[]
  allocations: AllocationRecord[]
  latest_arrival: (Partial<ArrivalRow> & { recorded_at?: ISODateTime; model_version?: string; evidence_cutoff?: ISODateTime }) | null
  handbook: { package_id: string; state: string } | null
  cost_summary: CostSummary | null
  external_links: ExternalObjectLink[]
}
export interface UnitHistory {
  components?: (UnitComponent & { child_asset_code?: string })[]
  component_events?: (UnitComponent & { child_asset_code?: string })[]
  allocations?: AllocationRecord[]
  stock_transactions?: StockTransaction[]
  audit?: AuditEvent[]
  [k: string]: unknown
}

// ---------------------------------------------------------------- handbook
export interface HandbookCriterion extends Base {
  template_id: string
  criterion_code: string
  title: string
  section: string
  kind: string
  mandatory: boolean
  critical: boolean
  rule_json: Json
  responsible_role: string
  commercial: boolean
}
export interface HandbookTemplate extends Base {
  equipment_class_id: string
  template_code: string
  revision_no: number
  name: string
  recipient_role: string
  state: string
  criteria?: HandbookCriterion[]
}
export interface HandbookPackage extends Base, Versioned {
  unit_id: string
  template_id: string
  version_no: number
  state: 'DRAFT' | 'VALIDATING' | 'READY' | 'BLOCKED' | 'APPROVED' | 'PUBLISHED' | string
  evidence_cutoff: ISODateTime | null
  manifest_json: Json
  package_hash: string | null
  approved_by: string | null
  published_at: ISODateTime | null
  acceptance_state: string
  acceptance_notes: string | null
  accepted_by: string | null
  asset_code?: string
  template_code?: string
}
export interface HandbookEntry extends Base, Versioned {
  package_id: string
  criterion_id: string
  source_ref: string | null
  source_revision: string | null
  content_hash: string | null
  validation: 'PASS' | 'FAIL' | 'MISSING' | 'WAIVED' | 'PENDING' | string
  message: string | null
  owner_role: string | null
  due_date: ISODate | null
  waiver_reason: string | null
  waiver_by: string | null
  waiver_expires_at: ISODate | null
  criterion?: HandbookCriterion
}
export type Blocker = string | { criterion_code?: string; entry_id?: string; title?: string; message?: string; reason?: string; critical?: boolean }
export interface HandbookDetail extends HandbookPackage {
  unit: PhysicalUnit | null
  entries: HandbookEntry[]
  blockers: Blocker[]
  template: HandbookTemplate | null
}
export interface EvidenceDocument extends Base {
  unit_id: string
  doc_type: string
  title: string
  revision: string
  model_ref: string | null
  serial_ref: string | null
  approved: boolean
  approved_by: string | null
  expires_at: ISODate | null
  content_hash: string
  storage_ref: string | null
  procore_document_id: string | null
  commercial: boolean
}

// ---------------------------------------------------------------- costs
export interface CostEvent extends Base {
  economic_key: string
  revision_no: number
  supersedes_id: string | null
  unit_id: string | null
  po_line_id: string | null
  posting_project_id: string | null
  category: string
  status: 'PROVISIONAL' | 'ACTUAL' | 'SUPERSEDED' | 'REVERSED' | string
  amount: D | null
  currency: string
  source_system: string
  source_ref: string
  occurred_on: ISODate
  service_from: ISODate | null
  service_to: ISODate | null
  asset_code?: string | null
  allocations?: { unit_id: string; attributed_project_id: string | null; amount: D | null; [k: string]: unknown }[]
}
export interface RollupResponse {
  parent_unit_id?: string
  asset_code?: string
  currency?: string
  total?: D | null
  recognized_total?: D | null
  provisional_total?: D | null
  leaves?: { unit_id: string; asset_code?: string; item_code?: string; slot_code?: string | null; total?: D | null; recognized_total?: D | null; provisional_total?: D | null; [k: string]: unknown }[]
  [k: string]: unknown
}
export interface TcoLine {
  year: number
  category: string
  amount: D
  kind: 'ACTUAL' | 'FORECAST' | 'ASSUMPTION' | string
}
export interface TcoScenario extends Base {
  name: string
  subject_type: string
  subject_id: string | null
  currency: string
  horizon_years: number
  discount_rate: D
  timing: string
  lines: TcoLine[]
  undiscounted_total: D | null
  present_value: D | null
  is_illustrative: boolean
}
export interface FmWorkOrder extends Base {
  source_system: string
  work_order_ref: string
  invoice_ref: string
  planon_asset_id: string | null
  parent_unit_id: string | null
  slot_code: string | null
  service_from: ISODate
  service_to: ISODate
  description: string
  amount: D | null
  currency: string
  posting_project_id: string | null
  resolved_unit_id: string | null
  cost_event_id: string | null
  state: 'RESOLVED' | 'UNRESOLVED' | string
  resolution_note: string | null
  resolved_asset_code?: string | null
  resolved_serial?: string | null
  attributed_project_id?: string | null
  unallocated_amount?: D | null
}

// ---------------------------------------------------------------- integrations
export interface ProcoreConnection extends Base, Versioned {
  environment: 'SIMULATED' | 'SANDBOX' | 'PRODUCTION' | string
  company_id: string
  company_name: string | null
  auth_mode: string
  token_expires_at: ISODateTime | null
  state: 'CONNECTED' | 'DISCONNECTED' | 'REVOKED' | 'ERROR' | string
  last_sync_at: ISODateTime | null
  last_error: string | null
  webhook_hook_id: string | null
}
export interface ProcoreStatus {
  mode: string
  environment: string
  oauth_configured: boolean
  redirect_uri: string
  webhook_destination_url: string
  writeback_enabled: boolean
  connected: boolean
  connection: ProcoreConnection | null
  token_present?: boolean
  has_refresh_token?: boolean
  environment_mismatch?: boolean
  link_counts?: Record<string, number>
  outbox?: Record<string, number>
  open_exceptions?: number
  resources?: string[]
  [k: string]: unknown
}
export interface EmbeddedContext {
  company_id?: string | null
  project_id?: string | null
  mapped?: boolean
  project?: Project | null
  programme?: Programme | null
  pcx_project_id?: string | null
  connection?: ProcoreConnection | null
  message?: string
}
export interface OutboxMessage extends Base {
  target: string
  event_type: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number | null
  dedup_key: string
  payload: Json
  state: 'PENDING' | 'ACKNOWLEDGED' | 'REJECTED' | 'UNKNOWN' | 'TIMEOUT_UNKNOWN' | 'DEAD' | string
  attempts: number
  next_attempt_at: ISODateTime
  last_error: string | null
  external_ref: string | null
  correlation_id: string | null
  processed_at: ISODateTime | null
}
export interface InboxMessage extends Base {
  source: string
  source_event_id: string
  event_type: string
  payload_hash: string
  payload: Json
  state: string
  error: string | null
  processed_at: ISODateTime | null
}
export interface IntegrationException extends Base, Versioned {
  source: string
  kind: string
  subject_type: string | null
  subject_id: string | null
  message: string
  owner_role: string
  state: string
  resolution: string | null
}
export interface AuditEvent {
  id: string
  at: ISODateTime
  actor: string
  actor_roles: string | null
  action: string
  subject_type: string
  subject_id: string
  before: Json | null
  after: Json | null
  reason: string | null
  correlation_id: string | null
}
export interface DashboardSummary {
  requirements: number
  open_impact_actions: number
  units_by_state: Record<string, number>
  units_by_allocation: Record<string, number>
  open_recovery_cases: number
  handbooks_blocked: number
  handbooks_published: number
  open_integration_exceptions: number
  outbox_pending: number
  outbox_unknown: number
}
export interface Health {
  status: string
  procore_mode?: string
}

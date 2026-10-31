/**
 * Endpoint catalogue (docs/api-contract.md). UI components use these through
 * TanStack Query hooks; they never call fetch directly.
 */
import { api, request, type Query } from './client'
import type * as T from './types'

type Sig = AbortSignal | undefined
const g = <R>(path: string, q?: Query) => (signal?: Sig) => api.get<R>(path, q, signal)

export interface Cmd {
  ifMatch?: string | null
  idempotencyKey?: string | true
}
const post = <R>(path: string, body?: unknown, opts: Cmd = {}) => api.post<R>(path, body, opts)

// ---------------------------------------------------------------- auth / reference / dashboard
export const auth = {
  login: (body: { email: string; password: string; tenant_code: string }) =>
    request<T.LoginResponse>('/auth/login', { method: 'POST', body, anonymous: true }),
  me: g<T.MeResponse>('/auth/me'),
  demoAccounts: g<T.DemoAccounts>('/auth/demo-accounts'),
}

export const reference = {
  health: g<T.Health>('/health'),
  programmes: g<T.Programme[]>('/programmes'),
  projects: g<T.Project[]>('/projects'),
  wbs: (projectId: string) => g<T.WbsElement[]>(`/projects/${projectId}/wbs`),
  locations: g<T.Location[]>('/locations'),
  suppliers: g<T.Supplier[]>('/suppliers'),
  equipmentClasses: (includeComponents = false) => g<T.EquipmentClass[]>('/equipment-classes', { include_components: includeComponents }),
  itemModels: (equipmentClassId?: string) => g<T.ItemModel[]>('/item-models', { equipment_class_id: equipmentClassId }),
  itemModel: (id: string) => g<T.ItemModelDetail>(`/item-models/${id}`),
  options: g<T.EquipmentOption[]>('/options'),
}

export const dashboard = {
  summary: g<T.DashboardSummary>('/dashboard/summary'),
  audit: (q: { subject_type?: string; subject_id?: string; limit?: number; offset?: number }) => g<T.AuditEvent[]>('/audit', q),
}

// ---------------------------------------------------------------- planning
const P = '/planning'
export interface RevisionFields {
  quantity: string
  uom: string
  duty?: string | null
  capacity?: string | null
  capacity_unit?: string | null
  redundancy?: string | null
  install_location?: string | null
  specification_json?: Record<string, unknown>
  cost_code?: string | null
  budget_amount?: string | null
  currency?: string | null
  required_site_date?: string | null
  required_install_date?: string | null
  required_operational_date?: string | null
}
export const planning = {
  requirements: (projectId?: string | null) => g<T.RequirementListRow[]>(`${P}/requirements`, { project_id: projectId }),
  requirement: (id: string) => g<T.RequirementDetail>(`${P}/requirements/${id}`),
  createRequirement: (body: { title: string; project_id: string; wbs_id?: string | null; equipment_class_id: string; code?: string; revision: RevisionFields }) =>
    post<{ requirement: T.Requirement; revision: T.RequirementRevision }>(`${P}/requirements`, body, { idempotencyKey: true }),
  revise: (id: string, body: { changes: Partial<RevisionFields>; change_reason: string }, opts: Cmd) =>
    post<T.RequirementRevision>(`${P}/requirements/${id}/revisions`, body, { idempotencyKey: true, ...opts }),
  submitRevision: (id: string, opts: Cmd = {}) => post(`${P}/revisions/${id}/submit`, {}, opts),
  approveRevision: (id: string, opts: Cmd) => post(`${P}/revisions/${id}/approve`, {}, opts),
  cancelRevision: (id: string, opts: Cmd = {}) => post(`${P}/revisions/${id}/cancel`, {}, opts),
  impactActions: (state?: string) => g<T.ImpactAction[]>(`${P}/impact-actions`, { state }),
  resolveImpact: (id: string, resolution: string, opts: Cmd = {}) => post(`${P}/impact-actions/${id}/resolve`, { resolution }, opts),
  boqImport: (body: { project_id: string; source_key: string; lines: Record<string, unknown>[] }) =>
    post<T.BoqRevision>(`${P}/boq-imports`, body, { idempotencyKey: true }),
  boqRevisions: (projectId?: string | null) => g<T.BoqRevision[]>(`${P}/boq-revisions`, { project_id: projectId }),
  benchmarkObservations: (equipmentClassId?: string) => g<T.BenchmarkObservation[]>(`${P}/benchmark-observations`, { equipment_class_id: equipmentClassId }),
  runBenchmark: (body: { requirement_revision_id: string; evidence_cutoff?: string | null }) =>
    post<T.BenchmarkRunResponse>(`${P}/benchmark-runs`, body, { idempotencyKey: true }),
  benchmarkRun: (id: string) => g<T.BenchmarkRunResponse>(`${P}/benchmark-runs/${id}`),
  reuseCandidates: (revisionId: string) => g<T.ReuseCandidate[]>(`${P}/reuse-candidates`, { requirement_revision_id: revisionId }),
  createReuseAssessment: (body: Record<string, unknown>) => post<T.ReuseAssessment>(`${P}/reuse-assessments`, body, { idempotencyKey: true }),
  createReservation: (body: { unit_id: string; project_id: string; requirement_id?: string | null }) => post<T.Reservation>(`${P}/reservations`, body, { idempotencyKey: true }),
  approveReuse: (id: string, opts: Cmd = {}) => post(`${P}/reuse-assessments/${id}/approve`, {}, opts),
  rejectReuse: (id: string, opts: Cmd = {}) => post(`${P}/reuse-assessments/${id}/reject`, {}, opts),
  reservations: (unitId?: string) => g<T.Reservation[]>(`${P}/reservations`, { unit_id: unitId }),
  releaseReservation: (id: string, opts: Cmd = {}) => post(`${P}/reservations/${id}/release`, {}, opts),
}

// ---------------------------------------------------------------- sourcing
const S = '/sourcing'
export const sourcing = {
  packages: g<T.SourcingPackage[]>(`${S}/packages`),
  package: (id: string) => g<T.PackageDetail>(`${S}/packages/${id}`),
  createPackage: (body: { code: string; title: string; programme_id: string; currency: string; bid_due_at?: string | null; lines?: Record<string, unknown>[] }) =>
    post<T.PackageDetail>(`${S}/packages`, body, { idempotencyKey: true }),
  issuePackage: (id: string, opts: Cmd = {}) => post(`${S}/packages/${id}/issue`, {}, opts),
  submitOffer: (packageId: string, body: Record<string, unknown>) => post<T.OfferDetail>(`${S}/packages/${packageId}/offers`, body, { idempotencyKey: true }),
  offer: (id: string) => g<T.OfferDetail>(`${S}/offers/${id}`),
  addAdjustment: (offerLineId: string, body: { category: string; amount: string | null; currency: string; rationale: string; evidence_ref?: string | null }) =>
    post<T.NormalizationAdjustment>(`${S}/offer-lines/${offerLineId}/adjustments`, body, { idempotencyKey: true }),
  approveAdjustment: (id: string, opts: Cmd = {}) => post(`${S}/adjustments/${id}/approve`, {}, opts),
  rejectAdjustment: (id: string, opts: Cmd = {}) => post(`${S}/adjustments/${id}/reject`, {}, opts),
  addDeviation: (offerLineId: string, body: { criterion_ref: string; mandatory: boolean; severity: string; description: string; proposed_alternative?: string | null }) =>
    post<T.TechnicalDeviation>(`${S}/offer-lines/${offerLineId}/deviations`, body, { idempotencyKey: true }),
  dispositionDeviation: (id: string, body: { disposition: 'ACCEPTED' | 'REJECTED'; evidence_ref?: string | null }, opts: Cmd = {}) =>
    post(`${S}/deviations/${id}/disposition`, body, opts),
  calculateEvaluation: (packageId: string, body: { criteria_policy_json: Record<string, unknown> }) =>
    post<T.EvaluationDetail>(`${S}/packages/${packageId}/evaluations`, body, { idempotencyKey: true }),
  evaluation: (id: string) => g<T.EvaluationDetail>(`${S}/evaluations/${id}`),
  submitEvaluation: (id: string, opts: Cmd) => post(`${S}/evaluations/${id}/submit`, {}, opts),
  approveEvaluation: (id: string, opts: Cmd) => post(`${S}/evaluations/${id}/approve`, {}, opts),
  createAward: (evaluationId: string, body: { rationale: string; input_fingerprint: string; lines: { package_line_id: string; offer_line_id: string; selected_quantity: string }[] }) =>
    post<T.AwardDetail>(`${S}/evaluations/${evaluationId}/awards`, body, { idempotencyKey: true }),
  submitAward: (id: string, opts: Cmd = {}) => post(`${S}/awards/${id}/submit`, {}, opts),
  approveAward: (id: string, inputFingerprint: string, opts: Cmd) => post(`${S}/awards/${id}/approve`, { input_fingerprint: inputFingerprint }, opts),
  award: (id: string) => g<T.AwardDetail>(`${S}/awards/${id}`),
}

// ---------------------------------------------------------------- procurement
const PR = '/procurement'
export const procurement = {
  purchaseOrders: g<T.PurchaseOrder[]>(`${PR}/purchase-orders`),
  purchaseOrder: (id: string) => g<T.PoDetail>(`${PR}/purchase-orders/${id}`),
  importPo: (body: Record<string, unknown>) => post<T.PoDetail>(`${PR}/purchase-orders/import`, body, { idempotencyKey: true }),
  cancelQuantity: (id: string, body: { po_line_id: string; quantity: string }, opts: Cmd = {}) =>
    post(`${PR}/purchase-orders/${id}/cancel-quantity`, body, { idempotencyKey: true, ...opts }),
}

// ---------------------------------------------------------------- inventory
const I = '/inventory'
export const inventory = {
  stock: (q: { programme_id?: string | null; location_id?: string | null; project_id?: string | null }) => g<T.StockResponse>(`${I}/stock`, q),
  allocate: (body: { unit_ids: string[]; kind: string; to_project_id: string; to_wbs_id?: string | null; reason: string }) =>
    post<T.AllocationResponse>(`${I}/allocations`, body, { idempotencyKey: true }),
  releaseAllocation: (id: string, opts: Cmd = {}) => post(`${I}/allocations/${id}/release`, {}, opts),
  allocations: (unitId?: string) => g<T.AllocationRecord[]>(`${I}/allocations`, { unit_id: unitId }),
  issue: (body: { unit_id: string; to_location_id: string; installed_position?: string | null }) => post(`${I}/issues`, body, { idempotencyKey: true }),
  transfers: g<T.TransferManifest[]>(`${I}/transfers`),
  createTransfer: (body: { code: string; from_location_id: string; to_location_id: string; to_project_id?: string | null; unit_ids: string[] }) =>
    post<T.TransferManifest>(`${I}/transfers`, body, { idempotencyKey: true }),
  approveTransfer: (id: string, opts: Cmd = {}) => post(`${I}/transfers/${id}/approve`, {}, opts),
  dispatchTransfer: (id: string, opts: Cmd = {}) => post(`${I}/transfers/${id}/dispatch`, {}, opts),
  receiveTransfer: (id: string, unitIds: string[], opts: Cmd = {}) => post(`${I}/transfers/${id}/receive`, { unit_ids: unitIds }, opts),
  stockTransactions: (unitId?: string) => g<T.StockTransaction[]>(`${I}/stock-transactions`, { unit_id: unitId }),
}

// ---------------------------------------------------------------- assets
const A = '/assets'
export const assets = {
  units: (q: { programme_id?: string | null; project_id?: string | null; state?: string; allocation_status?: string; q?: string; include_components?: boolean }) =>
    g<T.PhysicalUnit[]>(`${A}/units`, q),
  unit: (id: string) => g<T.UnitPassport>(`${A}/units/${id}`),
  structure: (id: string, at?: string | null) => g<T.StructureNode | T.StructureNode[]>(`${A}/units/${id}/structure`, { at }),
  history: (id: string) => g<T.UnitHistory>(`${A}/units/${id}/history`),
}

// ---------------------------------------------------------------- quality
const Q = '/quality'
export const quality = {
  recordTest: (body: Record<string, unknown>) => post<T.TestRecord>(`${Q}/tests`, body, { idempotencyKey: true }),
  recoveryCases: (state?: string) => g<T.RecoveryCase[]>(`${Q}/recovery-cases`, { state }),
  recoveryCase: (id: string) => g<T.RecoveryCaseDetail>(`${Q}/recovery-cases/${id}`),
  createRecoveryCase: (body: {
    ncr_number: string
    parent_unit_id: string
    failed_component_id?: string | null
    failed_test_id?: string | null
    slot_code?: string | null
    failure_stage?: string
    description: string
  }) => post<T.RecoveryCase>(`${Q}/recovery-cases`, body, { idempotencyKey: true }),
  command: (id: string, action: 'disposition' | 'remove-component' | 'fit-replacement' | 'release' | 'close', body: Record<string, unknown>, opts: Cmd = {}) =>
    post<T.RecoveryCase>(`${Q}/recovery-cases/${id}/${action}`, body, opts),
}

// ---------------------------------------------------------------- logistics
const L = '/logistics'
export const logistics = {
  shipments: g<T.Shipment[]>(`${L}/shipments`),
  shipment: (id: string) => g<T.Shipment & { milestones?: T.ShipmentMilestone[] }>(`${L}/shipments/${id}`),
  arrival: (q: { project_id?: string | null; selected_date: string; as_known_at?: string | null }) => g<T.ArrivalRow[]>(`${L}/arrival`, q),
  snapshot: (projectId?: string | null) => post(`${L}/arrival/snapshots`, { project_id: projectId ?? null }, { idempotencyKey: true }),
  addMilestone: (id: string, body: Record<string, unknown>) => post(`${L}/shipments/${id}/milestones`, body, { idempotencyKey: true }),
  trackingFailure: (id: string, body: { reason?: string }) => post(`${L}/shipments/${id}/tracking-failure`, body, { idempotencyKey: true }),
}

// ---------------------------------------------------------------- handbooks
const H = '/handbooks'
export const handbooks = {
  templates: g<T.HandbookTemplate[]>(`${H}/templates`),
  list: (q: { unit_id?: string; state?: string }) => g<T.HandbookPackage[]>(`${H}`, q),
  detail: (id: string) => g<T.HandbookDetail>(`${H}/${id}`),
  evidence: (unitId?: string) => g<T.EvidenceDocument[]>(`${H}/evidence`, { unit_id: unitId }),
  approveEvidence: (id: string) => post(`${H}/evidence/${id}/approve`, {}),
  create: (body: { unit_id: string; template_id?: string | null }) => post<T.HandbookPackage>(`${H}`, body, { idempotencyKey: true }),
  validate: (id: string, opts: Cmd = {}) => post<T.HandbookDetail>(`${H}/${id}/validate`, {}, opts),
  waive: (id: string, entryId: string, body: { reason: string; expires_at: string }, opts: Cmd = {}) => post(`${H}/${id}/entries/${entryId}/waive`, body, opts),
  approve: (id: string, opts: Cmd) => post(`${H}/${id}/approve`, {}, opts),
  publish: (id: string, opts: Cmd) => post<T.HandbookPackage>(`${H}/${id}/publish`, {}, opts),
  acceptance: (id: string, body: { decision: string; notes: string }, opts: Cmd = {}) => post(`${H}/${id}/acceptance`, body, opts),
  newVersion: (id: string, opts: Cmd = {}) => post<T.HandbookPackage>(`${H}/${id}/new-version`, {}, opts),
  exportPackage: (id: string) => api.get<Record<string, unknown>>(`${H}/${id}/export`),
}

// ---------------------------------------------------------------- costs
const C = '/costs'
export const costs = {
  events: (unitId?: string) => g<T.CostEvent[]>(`${C}/events`, { unit_id: unitId }),
  recordEvent: (body: Record<string, unknown>) => post<T.CostEvent>(`${C}/events`, body, { idempotencyKey: true }),
  unitSummary: (unitId: string) => g<T.CostSummary>(`${C}/units/${unitId}/summary`),
  rollup: (parentUnitId: string) => g<T.RollupResponse>(`${C}/rollup`, { parent_unit_id: parentUnitId }),
  tcoScenarios: g<T.TcoScenario[]>(`${C}/tco-scenarios`),
  createTco: (body: Record<string, unknown>) => post<T.TcoScenario>(`${C}/tco-scenarios`, body, { idempotencyKey: true }),
  fmWorkOrders: g<T.FmWorkOrder[]>(`${C}/fm-work-orders`),
  importFm: (body: { work_orders: Record<string, unknown>[] }) => post(`${C}/fm-work-orders/import`, body, { idempotencyKey: true }),
}

// ---------------------------------------------------------------- integrations
const X = '/integrations'
export const integrations = {
  procoreStatus: g<T.ProcoreStatus>(`${X}/procore/status`),
  authorizeUrl: g<{ url?: string; authorize_url?: string }>(`${X}/procore/oauth/authorize-url`),
  connect: (body: Record<string, unknown>) => post(`${X}/procore/connect`, body, { idempotencyKey: true }),
  disconnect: () => post(`${X}/procore/disconnect`, {}),
  sync: (resources: string[]) => post(`${X}/procore/sync`, { resources }, { idempotencyKey: true }),
  /** The brief names `embedded-context`; the contract table names `embedded/context`. Try both. */
  embeddedContext: async (q: { company_id?: string | null; project_id?: string | null }, signal?: AbortSignal): Promise<T.EmbeddedContext> => {
    try {
      return await api.get<T.EmbeddedContext>(`${X}/procore/embedded-context`, q, signal)
    } catch (e) {
      if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
        return api.get<T.EmbeddedContext>(`${X}/procore/embedded/context`, q, signal)
      }
      throw e
    }
  },
  appManifest: g<Record<string, unknown>>(`${X}/procore/app-manifest`),
  links: (q: { domain_type?: string; domain_id?: string; platform?: string }) => g<T.ExternalObjectLink[]>(`${X}/links`, q),
  outbox: (state?: string) => g<T.OutboxMessage[]>(`${X}/outbox`, { state }),
  retryOutbox: (id: string) => post(`${X}/outbox/${id}/retry`, {}),
  reconcileOutbox: (id: string, body: { outcome: 'APPLIED' | 'NOT_APPLIED'; external_ref?: string | null; note?: string | null }) => post(`${X}/outbox/${id}/reconcile`, body),
  processOutbox: () => post(`${X}/outbox/process`, {}),
  inbox: g<T.InboxMessage[]>(`${X}/inbox`),
  processInbox: (limit = 50) => post<{ processed: number; messages: T.InboxMessage[] }>(`${X}/inbox/process`, { limit }),
  exceptions: (state?: string) => g<T.IntegrationException[]>(`${X}/exceptions`, { state }),
  resolveException: (id: string, resolution: string, opts: Cmd = {}) => post(`${X}/exceptions/${id}/resolve`, { resolution }, opts),
  simulators: g<unknown>(`${X}/simulators`),
  setSimulatorMode: (target: string, mode: string) => post(`${X}/simulators/${target}/mode`, { mode }),
}

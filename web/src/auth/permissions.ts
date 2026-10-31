import type { Role } from '@/api/types'

/**
 * UI capability map: hides/disables actions the user's roles cannot perform.
 * The backend remains the authority (403); this only avoids offering dead ends.
 * ADMIN passes every internal check (contract §Roles). Where the contract does not name
 * the role for a command, the mapping below is an assumption aligned with spec §5.
 */
export const CAPABILITIES = {
  'requirement.edit': ['OWNER', 'ESTIMATOR', 'ENGINEERING'],
  'requirement.approve': ['OWNER', 'ENGINEERING'],
  'impact.resolve': ['OWNER', 'ESTIMATOR', 'ENGINEERING', 'PROCUREMENT', 'INVENTORY'],
  'boq.import': ['OWNER', 'ESTIMATOR'],
  'benchmark.run': ['OWNER', 'ESTIMATOR', 'ENGINEERING', 'PROCUREMENT'],
  'reuse.assess': ['OWNER', 'ESTIMATOR', 'ENGINEERING', 'INVENTORY'],
  'reuse.approve': ['OWNER', 'ENGINEERING'],
  'reservation.manage': ['OWNER', 'INVENTORY'],
  'package.manage': ['PROCUREMENT'],
  'offer.submit': ['SUPPLIER', 'PROCUREMENT'],
  'adjustment.propose': ['PROCUREMENT', 'ESTIMATOR'],
  'adjustment.approve': ['OWNER', 'PROCUREMENT'],
  'deviation.record': ['ENGINEERING', 'PROCUREMENT'],
  'deviation.disposition': ['ENGINEERING'],
  'evaluation.calculate': ['PROCUREMENT', 'ESTIMATOR'],
  'evaluation.submit': ['PROCUREMENT', 'ESTIMATOR'],
  'evaluation.approve': ['OWNER'],
  'award.create': ['PROCUREMENT'],
  'award.approve': ['OWNER'],
  'po.import': ['PROCUREMENT', 'INTEGRATION'],
  'po.cancel': ['PROCUREMENT'],
  'allocation.manage': ['INVENTORY', 'OWNER'],
  'issue.create': ['INVENTORY'],
  'transfer.manage': ['INVENTORY'],
  'transfer.approve': ['OWNER', 'INVENTORY'],
  'test.record': ['ENGINEERING'],
  'recovery.manage': ['ENGINEERING', 'PROCUREMENT', 'INVENTORY'],
  'recovery.release': ['ENGINEERING'],
  'handbook.validate': ['OWNER', 'ENGINEERING', 'FM', 'INVENTORY'],
  'handbook.waive': ['OWNER', 'ENGINEERING'],
  'handbook.approve': ['OWNER', 'ENGINEERING'],
  'evidence.approve': ['ENGINEERING', 'PROCUREMENT', 'OWNER'],
  'handbook.publish': ['OWNER'],
  'handbook.accept': ['FM'],
  'cost.record': ['FINANCE'],
  'tco.create': ['FINANCE', 'ESTIMATOR', 'OWNER', 'PROCUREMENT'],
  'fm.import': ['FM', 'FINANCE'],
  'integration.manage': ['INTEGRATION'],
} satisfies Record<string, Role[]>

export type Capability = keyof typeof CAPABILITIES

export function hasCapability(roles: readonly Role[], cap: Capability): boolean {
  const allowed = CAPABILITIES[cap] as readonly Role[]
  if (roles.includes('ADMIN') && !(allowed.length === 1 && allowed[0] === 'SUPPLIER')) return true
  return roles.some((r) => allowed.includes(r))
}

export function isSupplierOnly(roles: readonly Role[]): boolean {
  return roles.includes('SUPPLIER') && !roles.includes('ADMIN')
}

export const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  ESTIMATOR: 'Estimator',
  ENGINEERING: 'Engineering',
  PROCUREMENT: 'Procurement',
  SUPPLIER: 'Supplier',
  INVENTORY: 'Inventory',
  FINANCE: 'Finance',
  FM: 'FM',
  INTEGRATION: 'Integration',
  ADMIN: 'Admin',
}

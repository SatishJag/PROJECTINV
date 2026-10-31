import { BookCheck, CircleDollarSign, ClipboardList, LayoutDashboard, Scale, Settings2, Truck, type LucideIcon } from 'lucide-react'
import type { Role } from '@/api/types'

export interface NavItem {
  to: string
  label: string
}
export interface Workspace {
  key: string
  label: string
  short: string
  icon: LucideIcon
  to: string
  items: NavItem[]
  /** Requires commercial visibility. */
  commercial?: boolean
  roles?: Role[]
}

export const WORKSPACES: Workspace[] = [
  { key: 'dashboard', label: 'Dashboard', short: 'Home', icon: LayoutDashboard, to: '/', items: [] },
  {
    key: 'planning',
    label: 'Planning & BOQ',
    short: 'Planning',
    icon: ClipboardList,
    to: '/planning/requirements',
    items: [
      { to: '/planning/requirements', label: 'Requirements' },
      { to: '/planning/boq', label: 'BOQ imports' },
      { to: '/planning/impact-actions', label: 'Impact actions' },
      { to: '/planning/benchmarks', label: 'Benchmark evidence' },
    ],
  },
  {
    key: 'sourcing',
    label: 'Sourcing & Award',
    short: 'Sourcing',
    icon: Scale,
    to: '/sourcing/packages',
    items: [{ to: '/sourcing/packages', label: 'Sourcing packages' }],
  },
  {
    key: 'delivery',
    label: 'Delivery & Assets',
    short: 'Delivery',
    icon: Truck,
    to: '/delivery/purchase-orders',
    items: [
      { to: '/delivery/purchase-orders', label: 'PO register' },
      { to: '/delivery/units', label: 'Asset register' },
      { to: '/delivery/stock', label: 'Stock by location' },
      { to: '/delivery/allocation', label: 'Allocation board' },
      { to: '/delivery/arrival', label: 'Arrival timeline' },
      { to: '/delivery/shipments', label: 'Shipments' },
      { to: '/delivery/transfers', label: 'Transfers' },
      { to: '/delivery/recovery', label: 'FAT & recovery' },
    ],
  },
  {
    key: 'handbook',
    label: 'Handbook & Operations',
    short: 'Handbook',
    icon: BookCheck,
    to: '/handbook/packages',
    items: [
      { to: '/handbook/packages', label: 'Handbook workbench' },
      { to: '/handbook/fm-work-orders', label: 'FM work orders' },
    ],
  },
  {
    key: 'costs',
    label: 'Cost Intelligence',
    short: 'Costs',
    icon: CircleDollarSign,
    to: '/costs/events',
    commercial: true,
    items: [
      { to: '/costs/events', label: 'Cost events' },
      { to: '/costs/units', label: 'Unit cost summary' },
      { to: '/costs/rollup', label: 'Structure rollup' },
      { to: '/costs/tco', label: 'TCO scenarios' },
    ],
  },
  {
    key: 'admin',
    label: 'Administration',
    short: 'Admin',
    icon: Settings2,
    to: '/admin/procore',
    roles: ['ADMIN', 'INTEGRATION', 'OWNER'],
    items: [
      { to: '/admin/procore', label: 'Procore connection' },
      { to: '/admin/outbox', label: 'Outbox' },
      { to: '/admin/inbox', label: 'Webhook inbox' },
      { to: '/admin/exceptions', label: 'Exceptions' },
      { to: '/admin/links', label: 'External links' },
      { to: '/admin/simulators', label: 'Simulators' },
      { to: '/admin/audit', label: 'Audit log' },
    ],
  },
]

export function workspaceFor(pathname: string): Workspace {
  return WORKSPACES.find((w) => w.key !== 'dashboard' && pathname.startsWith(`/${w.key}`)) ?? WORKSPACES[0]
}

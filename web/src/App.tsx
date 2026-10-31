import { Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { AppShell } from '@/layout/AppShell'
import { SignIn } from '@/pages/SignIn'
import { Dashboard } from '@/pages/Dashboard'
import { Requirements } from '@/pages/planning/Requirements'
import { RequirementDetail } from '@/pages/planning/RequirementDetail'
import { BoqImports } from '@/pages/planning/BoqImports'
import { ImpactActions } from '@/pages/planning/ImpactActions'
import { Benchmarks } from '@/pages/planning/Benchmarks'
import { Packages } from '@/pages/sourcing/Packages'
import { PackageDetail } from '@/pages/sourcing/PackageDetail'
import { PurchaseOrders } from '@/pages/delivery/PurchaseOrders'
import { PurchaseOrderDetail } from '@/pages/delivery/PurchaseOrderDetail'
import { Units } from '@/pages/delivery/Units'
import { UnitDetail } from '@/pages/delivery/UnitDetail'
import { Stock } from '@/pages/delivery/Stock'
import { AllocationBoard } from '@/pages/delivery/AllocationBoard'
import { Arrival } from '@/pages/delivery/Arrival'
import { Shipments } from '@/pages/delivery/Shipments'
import { Transfers } from '@/pages/delivery/Transfers'
import { Recovery } from '@/pages/delivery/Recovery'
import { RecoveryDetail } from '@/pages/delivery/RecoveryDetail'
import { HandbookWorkbench } from '@/pages/handbook/HandbookWorkbench'
import { HandbookDetail } from '@/pages/handbook/HandbookDetail'
import { FmWorkOrders } from '@/pages/handbook/FmWorkOrders'
import { CostEvents } from '@/pages/costs/CostEvents'
import { UnitCosts } from '@/pages/costs/UnitCosts'
import { Rollup } from '@/pages/costs/Rollup'
import { TcoScenarios } from '@/pages/costs/TcoScenarios'
import { ProcoreAdmin } from '@/pages/admin/ProcoreAdmin'
import { Outbox } from '@/pages/admin/Outbox'
import { Inbox } from '@/pages/admin/Inbox'
import { Exceptions } from '@/pages/admin/Exceptions'
import { ExternalLinks } from '@/pages/admin/ExternalLinks'
import { Simulators } from '@/pages/admin/Simulators'
import { AuditLog } from '@/pages/admin/AuditLog'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [pathname])
  return null
}

function Boot() {
  return (
    <div className="grid min-h-svh place-items-center bg-background">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading your workspace…
      </div>
    </div>
  )
}

function Expired({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="grid min-h-svh place-items-center px-6">
      <div className="max-w-md rounded-lg border bg-card p-6 text-center">
        <TriangleAlert className="mx-auto size-6 text-warning" aria-hidden />
        <h1 className="mt-2 text-lg font-semibold">Cannot open your workspace</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{message}</p>
        <Button className="mt-4" variant="primary" onClick={retry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

function NotFound() {
  return (
    <div className="py-16 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">404</p>
      <h1 className="mt-1 text-xl font-semibold">Page not found</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">The workspace or record does not exist.</p>
      <Button className="mt-4" variant="primary" onClick={() => window.history.back()}>
        Go back
      </Button>
      <p className="mt-3 text-xs">
        or <Link className="text-accent underline-offset-2 hover:underline" to="/">return to the dashboard</Link>
      </p>
    </div>
  )
}

/** Suppliers may only reach the sourcing workspace; the backend enforces the same scope. */
function SupplierGate({ children }: { children: ReactNode }) {
  const s = useSession()
  const { pathname } = useLocation()
  if (s.isSupplier && !pathname.startsWith('/sourcing')) return <Navigate replace to="/sourcing/packages" />
  return <>{children}</>
}

export default function App() {
  const s = useSession()
  if (s.loading) return <Boot />
  if (!s.signedIn) {
    if (s.error && s.error.status !== 401) return <Expired message={s.error.detail} retry={s.retry} />
    return <SignIn />
  }
  return (
    <>
      <ScrollToTop />
      <AppShell>
        <SupplierGate>
          <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/planning" element={<Navigate replace to="/planning/requirements" />} />
          <Route path="/planning/requirements" element={<Requirements />} />
          <Route path="/planning/requirements/:requirementId" element={<RequirementDetail />} />
          <Route path="/planning/boq" element={<BoqImports />} />
          <Route path="/planning/impact-actions" element={<ImpactActions />} />
          <Route path="/planning/benchmarks" element={<Benchmarks />} />
          <Route path="/sourcing" element={<Navigate replace to="/sourcing/packages" />} />
          <Route path="/sourcing/packages" element={<Packages />} />
          <Route path="/sourcing/packages/:packageId" element={<PackageDetail />} />
          <Route path="/delivery" element={<Navigate replace to="/delivery/purchase-orders" />} />
          <Route path="/delivery/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/delivery/purchase-orders/:poId" element={<PurchaseOrderDetail />} />
          <Route path="/delivery/units" element={<Units />} />
          <Route path="/delivery/units/:unitId" element={<UnitDetail />} />
          <Route path="/delivery/stock" element={<Stock />} />
          <Route path="/delivery/allocation" element={<AllocationBoard />} />
          <Route path="/delivery/arrival" element={<Arrival />} />
          <Route path="/delivery/shipments" element={<Shipments />} />
          <Route path="/delivery/transfers" element={<Transfers />} />
          <Route path="/delivery/recovery" element={<Recovery />} />
          <Route path="/delivery/recovery/:caseId" element={<RecoveryDetail />} />
          <Route path="/handbook" element={<Navigate replace to="/handbook/packages" />} />
          <Route path="/handbook/packages" element={<HandbookWorkbench />} />
          <Route path="/handbook/packages/:packageId" element={<HandbookDetail />} />
          <Route path="/handbook/fm-work-orders" element={<FmWorkOrders />} />
          <Route path="/costs" element={<Navigate replace to="/costs/events" />} />
          <Route path="/costs/events" element={<CostEvents />} />
          <Route path="/costs/units" element={<UnitCosts />} />
          <Route path="/costs/units/:unitId" element={<UnitCosts />} />
          <Route path="/costs/rollup" element={<Rollup />} />
          <Route path="/costs/tco" element={<TcoScenarios />} />
          <Route path="/admin" element={<Navigate replace to="/admin/procore" />} />
          <Route path="/admin/procore" element={<ProcoreAdmin />} />
          <Route path="/admin/outbox" element={<Outbox />} />
          <Route path="/admin/inbox" element={<Inbox />} />
          <Route path="/admin/exceptions" element={<Exceptions />} />
          <Route path="/admin/links" element={<ExternalLinks />} />
          <Route path="/admin/simulators" element={<Simulators />} />
          <Route path="/admin/audit" element={<AuditLog />} />
          <Route path="*" element={<NotFound />} />
          </Routes>
        </SupplierGate>
      </AppShell>
    </>
  )
}

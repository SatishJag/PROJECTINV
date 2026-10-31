import { AlertTriangle, ArrowRight, Boxes, CircleDollarSign, ClipboardList, LockKeyhole, RefreshCw, Scale, ShieldCheck, Truck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useApi } from '@/api/hooks'
import { auth } from '@/api/endpoints'
import { describeError } from '@/api/client'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/form'
import { ROLE_LABELS } from '@/auth/permissions'
import { humanize } from '@/lib/utils'

const FEATURES = [
  { icon: ClipboardList, title: 'Plan with evidence', text: 'Requirements, BOQ change, benchmarks and reuse decisions.' },
  { icon: Scale, title: 'Source and award', text: 'Normalised offers, deviations, TCO and frozen award evidence.' },
  { icon: Truck, title: 'Deliver and track', text: 'PO identity, custody, allocation, arrival and FAT recovery.' },
  { icon: Boxes, title: 'Hand over', text: 'Validated handbooks, FM work orders and installed structure.' },
  { icon: CircleDollarSign, title: 'Know the cost', text: 'Attributed lifecycle cost from purchase to service.' },
  { icon: ShieldCheck, title: 'Prove it', text: 'Audit trail, idempotent commands and Procore write-back.' },
]

export function SignIn() {
  const s = useSession()
  const demo = useApi(['auth', 'demo-accounts'], auth.demoAccounts, { staleTime: 10 * 60_000 })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tenant, setTenant] = useState(s.tenantCode || 'DEMO')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const demoMode = demo.data?.demo_mode === true
  const accounts = demo.data?.accounts ?? []

  useEffect(() => {
    if (!email && accounts.length) setEmail(accounts[0].email)
    if (!password && demoMode && demo.data?.password_hint) setPassword('Demo!2026')
    // Seed the form once demo metadata arrives; later edits are preserved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length, demoMode])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await s.signIn(email.trim(), password, tenant.trim().toUpperCase())
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-ink px-10 py-10 text-ink-foreground lg:flex">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-32 size-[420px] rounded-full border border-white/10" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 -left-24 size-[420px] rounded-full border border-white/10" />
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-md bg-accent text-[13px] font-bold tracking-tight text-accent-foreground">PCX</span>
            <div>
              <p className="text-[13px] font-semibold leading-tight">Equipment Intelligence</p>
              <p className="text-[11px] text-ink-muted">Programme operations for long-lead equipment</p>
            </div>
          </div>
          <p className="mt-12 max-w-lg text-[30px] font-semibold leading-[1.12] tracking-tight">
            One operational spine from engineering need to handover.
          </p>
          <p className="mt-3 max-w-md text-[13px] leading-relaxed text-ink-muted">
            Built for data-centre programmes where generators, chillers and switchgear cross projects, warehouses and contracts — and every decision has to be
            evidenced.
          </p>
          <ul className="mt-8 grid max-w-xl grid-cols-2 gap-x-6 gap-y-5">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-2.5">
                <f.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                <div>
                  <p className="text-[12px] font-semibold">{f.title}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{f.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-10 max-w-lg rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-muted">
            <ShieldCheck className="size-3.5 text-accent" aria-hidden />
            Integration boundaries
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
            Procore owns projects, commitments and equipment records. Oracle remains the stock authority; Planon remains the FM system of record. PCX keeps the
            evidence, identity and allocation history that connects them.
          </p>
        </div>
      </section>

      <section className="flex flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <span className="grid size-8 place-items-center rounded-md bg-ink text-[12px] font-bold text-ink-foreground">PCX</span>
            <p className="text-[14px] font-semibold">Equipment Intelligence</p>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Use your organization account. Access follows your roles.</p>

          {s.error && !error ? (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px]" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{describeError(s.error).title}</p>
                <p className="text-foreground/80">{describeError(s.error).message}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={s.retry}>
                <RefreshCw aria-hidden /> Retry
              </Button>
            </div>
          ) : null}

          <form className="mt-5 space-y-3.5" onSubmit={submit} noValidate>
            <Field label="Email" required>
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@organization.com" />
            </Field>
            <Field label="Password" required>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Field label="Tenant" hint="Your organization code, for example DEMO." required>
              <Input value={tenant} onChange={(e) => setTenant(e.target.value)} required autoCapitalize="characters" />
            </Field>
            {error ? (
              <p className="flex items-start gap-1.5 text-[12px] font-medium text-danger" role="alert">
                <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email || !password || !tenant}>
              Sign in <ArrowRight aria-hidden />
            </Button>
          </form>

          {demoMode ? (
            <div className="mt-6 rounded-lg border bg-card">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <div>
                  <p className="text-[12px] font-semibold">Demo accounts</p>
                  <p className="text-[11px] text-muted-foreground">
                    Password <span className="code">Demo!2026</span> · tenant <span className="code">DEMO</span>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPassword('Demo!2026')
                    setTenant('DEMO')
                  }}
                >
                  Use demo password
                </Button>
              </div>
              <div className="max-h-56 overflow-y-auto p-1.5">
                <label className="sr-only" htmlFor="demo-account-select">
                  Demo account
                </label>
                <Select
                  id="demo-account-select"
                  className="mb-1.5"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setPassword('Demo!2026')
                    setTenant('DEMO')
                  }}
                >
                  {accounts.map((a) => (
                    <option key={a.email} value={a.email}>
                      {a.name} · {a.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}
                    </option>
                  ))}
                </Select>
                <ul className="grid gap-1">
                  {accounts.slice(0, 5).map((a) => (
                    <li key={a.email}>
                      <button
                        type="button"
                        onClick={() => {
                          setEmail(a.email)
                          setPassword('Demo!2026')
                          setTenant('DEMO')
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-medium">{a.name}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{a.email}</span>
                        </span>
                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{a.roles.map((r) => humanize(r)).join(', ')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground">
            This application is an embedded Procore app. Opening it from Procore carries the company and project context into the header; the same URL works
            standalone.
          </p>
        </div>
      </section>
    </div>
  )
}

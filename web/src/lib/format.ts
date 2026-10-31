/** Display formatting. All inputs may be null: callers render <Unknown/> for null, never 0. */

function groupInt(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Format a decimal string without float conversion. */
export function formatDecimal(v: string | number | null | undefined, maxFraction = 2, minFraction = 0): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return s
  const [, neg, int, fracRaw = ''] = m
  let frac = fracRaw.slice(0, maxFraction)
  // round half-up on the dropped digit
  let intPart = int
  if (fracRaw.length > maxFraction && Number(fracRaw[maxFraction]) >= 5) {
    const scaled = BigInt(intPart + frac.padEnd(maxFraction, '0')) + 1n
    const str = scaled.toString().padStart(maxFraction + 1, '0')
    intPart = maxFraction > 0 ? str.slice(0, -maxFraction) : str
    frac = maxFraction > 0 ? str.slice(-maxFraction) : ''
  }
  frac = frac.replace(/0+$/, '')
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, '0')
  return `${neg ? '-' : ''}${groupInt(intPart)}${frac ? `.${frac}` : ''}`
}

export function formatMoney(v: string | null | undefined, currency?: string | null): string | null {
  const n = formatDecimal(v, 2, 0)
  if (n === null) return null
  return currency ? `${currency} ${n}` : n
}

export function formatQty(v: string | number | null | undefined, uom?: string | null): string | null {
  const n = formatDecimal(v, 3)
  if (n === null) return null
  return uom ? `${n} ${uom}` : n
}

export function formatPercent(v: string | number | null | undefined, digits = 0): string | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return `${(n * 100).toFixed(digits)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** YYYY-MM-DD → "15 Nov 2026" (no timezone shift: the date is a calendar date). */
export function formatDate(v: string | null | undefined): string | null {
  if (!v) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (!m) return v
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

/** ISO UTC datetime → local display with explicit UTC fallback in the title. */
export function formatDateTime(v: string | null | undefined): string | null {
  if (!v) return null
  const d = new Date(v.endsWith('Z') || /[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** <input type="datetime-local"> value (local) → UTC ISO with Z. */
export function localInputToISO(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function isoToLocalInput(v: string | null | undefined): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function parseISODate(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso)
  if (!d) return iso
  d.setUTCDate(d.getUTCDate() + days)
  return toISODate(d)
}

export function diffDays(a: string, b: string): number {
  const da = parseISODate(a.slice(0, 10))
  const db = parseISODate(b.slice(0, 10))
  if (!da || !db) return 0
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

export function relativeAge(v: string | null | undefined): string | null {
  if (!v) return null
  const t = new Date(v).getTime()
  if (Number.isNaN(t)) return null
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs} h ago`
  return `${Math.round(hrs / 24)} d ago`
}

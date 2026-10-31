/**
 * Exact decimal helpers. The API sends money and quantities as strings; we never
 * route them through JS floats. Values are scaled BigInts with SCALE fractional digits.
 */
const SCALE = 6
const FACTOR = 10n ** BigInt(SCALE)

export type Dec = bigint

export function parseDec(v: string | number | null | undefined): Dec | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  const m = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  if (m[4]) {
    // Exponent notation is rare; fall back to a careful string expansion.
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    return parseDec(n.toFixed(SCALE))
  }
  const sign = m[1] === '-' ? -1n : 1n
  const intPart = BigInt(m[2] || '0')
  const fracRaw = (m[3] ?? '').padEnd(SCALE + 1, '0')
  let frac = BigInt(fracRaw.slice(0, SCALE))
  if (Number(fracRaw[SCALE]) >= 5) frac += 1n
  return sign * (intPart * FACTOR + frac)
}

export function addDec(...vals: (Dec | null)[]): Dec | null {
  let acc = 0n
  for (const v of vals) {
    if (v === null) return null
    acc += v
  }
  return acc
}

export function mulDec(a: Dec | null, b: Dec | null): Dec | null {
  if (a === null || b === null) return null
  const p = a * b
  const half = FACTOR / 2n
  return p >= 0n ? (p + half) / FACTOR : (p - half) / FACTOR
}

export function cmpDec(a: Dec, b: Dec): number {
  return a === b ? 0 : a < b ? -1 : 1
}

export function decToString(v: Dec | null, fractionDigits?: number): string | null {
  if (v === null) return null
  const neg = v < 0n
  const abs = neg ? -v : v
  const int = abs / FACTOR
  let frac = (abs % FACTOR).toString().padStart(SCALE, '0')
  if (fractionDigits !== undefined) frac = frac.slice(0, fractionDigits)
  else frac = frac.replace(/0+$/, '')
  return `${neg ? '-' : ''}${int.toString()}${frac ? `.${frac}` : ''}`
}

/** Sum a list of decimal strings; returns null if any is null (unknown stays unknown). */
export function sumStrings(vals: (string | null | undefined)[]): string | null {
  return decToString(addDec(...vals.map((v) => parseDec(v ?? null))))
}

export function mulStrings(a: string | null | undefined, b: string | null | undefined): string | null {
  return decToString(mulDec(parseDec(a ?? null), parseDec(b ?? null)))
}

export function isValidDecimal(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s.trim())
}

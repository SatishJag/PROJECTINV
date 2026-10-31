import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Stable random key for Idempotency-Key headers. */
export function newKey(prefix = 'web'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${rnd}`
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Lists may arrive as plain arrays or as paginated envelopes ({items}, {results}, {data}). */
export function asList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (isRecord(data)) {
    for (const k of ['items', 'results', 'data', 'rows']) {
      const v = data[k]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

export function byId<T extends { id: string }>(list: T[] | undefined): Map<string, T> {
  return new Map((list ?? []).map((x) => [x.id, x]))
}

export function humanize(code: string | null | undefined): string {
  if (!code) return ''
  return code
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : ''
}

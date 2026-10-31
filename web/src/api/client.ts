/**
 * Typed fetch wrapper for the PCX API.
 * - Bearer token held in memory and mirrored to sessionStorage (per-tab, cleared on sign-out).
 * - problem+json → ApiError with stable `code` (the problem `title`) and `detail`.
 * - If-Match / Idempotency-Key helpers for guarded commands and creates.
 * - AbortSignal pass-through so superseded requests never overwrite newer state.
 */
import { isRecord, newKey } from '@/lib/utils'

const TOKEN_KEY = 'pcx.token'
let memoryToken: string | null = null

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function getToken(): string | null {
  if (memoryToken === null) memoryToken = readStoredToken()
  return memoryToken
}

export function setToken(token: string | null): void {
  memoryToken = token
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage may be partitioned/blocked inside third-party iframes; memory still works */
  }
}

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn)
  return () => unauthorizedListeners.delete(fn)
}

export interface ProblemFieldError {
  loc?: (string | number)[]
  msg?: string
  type?: string
  field?: string
  message?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string
  readonly errors: ProblemFieldError[]
  readonly type?: string
  readonly path: string

  constructor(init: { status: number; code: string; detail: string; errors?: ProblemFieldError[]; type?: string; path: string }) {
    super(init.detail || init.code)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.detail = init.detail
    this.errors = init.errors ?? []
    this.type = init.type
    this.path = init.path
  }

  /** The route itself does not exist yet (backend workstream still building it). */
  get isEndpointMissing(): boolean {
    return this.status === 404 && (this.code === 'Not Found' || this.code === 'ROUTE_NOT_FOUND' || /^No API route/i.test(this.detail) || this.detail === 'Not Found')
  }
  get isNotFound(): boolean {
    return this.status === 404
  }
  get isStale(): boolean {
    return this.status === 412
  }
  get isPreconditionRequired(): boolean {
    return this.status === 428
  }
  get isNetwork(): boolean {
    return this.status === 0
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

export type Query = Record<string, string | number | boolean | null | undefined>

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Query
  body?: unknown
  /** Optimistic concurrency: the row's `etag` (e.g. W/"3"). */
  ifMatch?: string | null
  /** Idempotency key; pass `true` to generate one. */
  idempotencyKey?: string | true
  signal?: AbortSignal
  /** Do not treat 401 as session expiry (used by the sign-in call). */
  anonymous?: boolean
}

export function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`
  if (!query) return url
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `${url}?${s}` : url
}

function normalizeProblem(status: number, body: unknown, path: string, fallback: string): ApiError {
  if (isRecord(body)) {
    const rawDetail = body.detail
    // FastAPI validation errors: {detail:[{loc,msg,type}]}
    if (Array.isArray(rawDetail)) {
      const errs = rawDetail as ProblemFieldError[]
      return new ApiError({
        status,
        code: 'VALIDATION_ERROR',
        detail: errs.map((e) => `${(e.loc ?? []).slice(1).join('.') || 'request'}: ${e.msg ?? e.message ?? 'invalid'}`).join('; '),
        errors: errs,
        path,
      })
    }
    const code = (typeof body.code === 'string' && body.code) || (typeof body.title === 'string' && body.title) || fallback
    const detail = typeof rawDetail === 'string' ? rawDetail : typeof body.message === 'string' ? body.message : fallback
    return new ApiError({
      status,
      code,
      detail,
      errors: Array.isArray(body.errors) ? (body.errors as ProblemFieldError[]) : [],
      type: typeof body.type === 'string' ? body.type : undefined,
      path,
    })
  }
  return new ApiError({ status, code: fallback, detail: typeof body === 'string' && body ? body.slice(0, 300) : fallback, path })
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query)
  const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey === true ? newKey() : opts.idempotencyKey

  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: 'same-origin',
    })
  } catch (e) {
    if (isAbort(e)) throw e
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', detail: 'The server could not be reached. Check your connection and try again.', path: url })
  }

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!res.ok) {
    const err = normalizeProblem(res.status, body, url, res.statusText || `HTTP_${res.status}`)
    if (res.status === 401 && !opts.anonymous) unauthorizedListeners.forEach((fn) => fn())
    // Technical detail for support; the UI shows the friendly message.
    console.warn(`[pcx-api] ${opts.method ?? 'GET'} ${url} → ${res.status} ${err.code}: ${err.detail}`)
    throw err
  }
  return body as T
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body' | 'method'> = {}) =>
    request<T>(path, { ...opts, method: 'POST', body: body ?? {} }),
}

/** Friendly sentence for an error, tuned per status. */
export function describeError(e: unknown): { title: string; message: string; code?: string } {
  if (isApiError(e)) {
    if (e.isNetwork) return { title: 'Server unreachable', message: e.detail, code: e.code }
    if (e.isEndpointMissing) return { title: 'Not available yet', message: 'This capability is not yet available on the server. It will appear once the backend service is deployed.', code: 'ENDPOINT_UNAVAILABLE' }
    if (e.status === 404) return { title: 'Not found', message: 'The record does not exist or is outside your authorized scope.', code: e.code }
    if (e.status === 403) return { title: 'Not permitted', message: e.detail || 'Your roles do not allow this action.', code: e.code }
    if (e.status === 412) return { title: 'Record changed', message: 'Someone else changed this record since you loaded it. Reload to review the latest values before trying again.', code: e.code }
    if (e.status === 428) return { title: 'Version required', message: 'This command needs the current record version. Reload the record and retry.', code: e.code }
    if (e.status === 409) return { title: 'Conflict', message: e.detail, code: e.code }
    if (e.status === 422) return { title: 'Business rule', message: e.detail, code: e.code }
    if (e.status === 401) return { title: 'Session expired', message: 'Sign in again to continue.', code: e.code }
    return { title: 'Request failed', message: e.detail || `HTTP ${e.status}`, code: e.code }
  }
  if (e instanceof Error) return { title: 'Unexpected error', message: e.message }
  return { title: 'Unexpected error', message: String(e) }
}

/**
 * Procore embedding support.
 * - Full Screen apps receive context in the launch URL (?procore_company_id=&procore_project_id=,
 *   also accepted: company_id / project_id).
 * - Side Panel apps run in an iframe: we post {type:'initialize'} to the parent and accept a
 *   {type:'setup', context:{company_id, project_id}} reply, but only from *.procore.com origins.
 */
export interface ProcoreLaunchContext {
  companyId: string | null
  projectId: string | null
  source: 'url' | 'handshake' | 'stored' | null
}

const STORE_KEY = 'pcx.procore-launch'

export function isInIframe(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true // cross-origin access to window.top throws → we are framed
  }
}

export function isTrustedProcoreOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    if (u.protocol !== 'https:') return false
    return u.hostname === 'procore.com' || u.hostname.endsWith('.procore.com')
  } catch {
    return false
  }
}

export function readLaunchContext(): ProcoreLaunchContext {
  const qs = new URLSearchParams(window.location.search)
  const companyId = qs.get('procore_company_id') ?? qs.get('company_id')
  const projectId = qs.get('procore_project_id') ?? qs.get('project_id')
  if (companyId || projectId) {
    const ctx: ProcoreLaunchContext = { companyId, projectId, source: 'url' }
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(ctx))
    } catch {
      /* ignore */
    }
    return ctx
  }
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ProcoreLaunchContext
      return { ...parsed, source: 'stored' }
    }
  } catch {
    /* ignore */
  }
  return { companyId: null, projectId: null, source: null }
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v) return v
  if (typeof v === 'number') return String(v)
  return null
}

/** Starts the side-panel handshake. Returns a cleanup function. */
export function startSidePanelHandshake(onContext: (ctx: ProcoreLaunchContext) => void): () => void {
  if (!isInIframe()) return () => undefined
  const handler = (event: MessageEvent) => {
    if (!isTrustedProcoreOrigin(event.origin)) return
    const data = event.data as { type?: string; context?: Record<string, unknown> } | null
    if (!data || typeof data !== 'object' || data.type !== 'setup') return
    const c = data.context ?? {}
    const ctx: ProcoreLaunchContext = { companyId: str(c.company_id), projectId: str(c.project_id), source: 'handshake' }
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(ctx))
    } catch {
      /* ignore */
    }
    onContext(ctx)
  }
  window.addEventListener('message', handler)
  try {
    // Procore's documented side-panel handshake uses a wildcard target; the reply is origin-checked above.
    window.parent.postMessage({ type: 'initialize' }, '*')
  } catch {
    /* parent unavailable */
  }
  return () => window.removeEventListener('message', handler)
}

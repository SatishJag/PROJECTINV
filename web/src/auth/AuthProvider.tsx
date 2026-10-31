import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getToken, onUnauthorized, setToken, type ApiError } from '@/api/client'
import { auth } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { MeResponse, Role, User } from '@/api/types'
import { hasCapability, isSupplierOnly, type Capability } from './permissions'

export interface Session {
  signedIn: boolean
  loading: boolean
  error: ApiError | null
  retry: () => void
  user: User | null
  roles: Role[]
  canSeeCommercial: boolean
  isSupplier: boolean
  can: (cap: Capability) => boolean
  signIn: (email: string, password: string, tenantCode: string) => Promise<void>
  signOut: () => void
  tenantCode: string
}

const Ctx = createContext<Session | null>(null)

export function useSession(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession outside AuthProvider')
  return s
}

const TENANT_KEY = 'pcx.tenant'

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [token, setTok] = useState<string | null>(() => getToken())
  const [tenantCode, setTenantCode] = useState<string>(() => {
    try {
      return sessionStorage.getItem(TENANT_KEY) ?? 'DEMO'
    } catch {
      return 'DEMO'
    }
  })

  const me = useApi<MeResponse>(['auth', 'me', token], auth.me, { enabled: !!token, staleTime: 5 * 60_000 })

  const signOut = useCallback(() => {
    setToken(null)
    setTok(null)
    qc.clear()
  }, [qc])

  useEffect(() => onUnauthorized(signOut), [signOut])

  const signIn = useCallback(
    async (email: string, password: string, tenant: string) => {
      const res = await auth.login({ email, password, tenant_code: tenant })
      setToken(res.token)
      try {
        sessionStorage.setItem(TENANT_KEY, tenant)
      } catch {
        /* ignore */
      }
      setTenantCode(tenant)
      qc.clear()
      setTok(res.token)
    },
    [qc],
  )

  const value = useMemo<Session>(() => {
    const roles = (me.data?.roles ?? me.data?.user.role_list ?? []) as Role[]
    return {
      signedIn: !!token && !!me.data,
      loading: !!token && me.isPending,
      error: token ? (me.error ?? null) : null,
      retry: () => void me.refetch(),
      user: me.data?.user ?? null,
      roles,
      canSeeCommercial: !!me.data?.can_see_commercial,
      isSupplier: isSupplierOnly(roles),
      can: (cap) => hasCapability(roles, cap),
      signIn,
      signOut,
      tenantCode,
    }
  }, [token, me, signIn, signOut, tenantCode])

  // A token that no longer validates (e.g. server restarted with a new key) → sign out.
  useEffect(() => {
    if (token && me.isError && me.error.status === 401) signOut()
  }, [token, me.isError, me.error, signOut])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function Can({ cap, children, fallback = null }: { cap: Capability; children: ReactNode; fallback?: ReactNode }) {
  const s = useSession()
  return <>{s.can(cap) ? children : fallback}</>
}

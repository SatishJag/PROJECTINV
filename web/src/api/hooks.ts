import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query'
import { useState } from 'react'
import { useToast } from '@/components/ui/toast'
import { ApiError, describeError, isApiError } from './client'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      // Never retry client errors (404 for not-yet-built endpoints, 403, 412...). Back off on network/5xx.
      retry: (count, err) => {
        if (isApiError(err) && err.status >= 400 && err.status < 500) return false
        return count < 2
      },
      retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 6000),
    },
  },
})

/**
 * useQuery with the AbortSignal forwarded. When the key changes (e.g. timeline date), the
 * superseded request is cancelled and its result is cached under its own key, so it can
 * never overwrite the newer selection.
 */
export function useApi<T>(key: QueryKey, fn: (signal?: AbortSignal) => Promise<T>, opts: Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'> = {}) {
  return useQuery<T, ApiError>({ queryKey: key, queryFn: ({ signal }) => fn(signal), ...opts })
}

export interface CommandOptions<V, R> {
  run: (vars: V) => Promise<R>
  /** Query key prefixes to invalidate after success. */
  invalidate?: QueryKey[]
  success?: string | ((r: R) => string)
  onSuccess?: (r: R, vars: V) => void
  /** Keep errors inline (dialogs) instead of toasting. */
  silent?: boolean
}

/** Mutation wrapper: invalidates affected queries, toasts outcome, tracks 412 conflicts. */
export function useCommand<V = void, R = unknown>(o: CommandOptions<V, R>) {
  const qc = useQueryClient()
  const toast = useToast()
  const [conflict, setConflict] = useState<ApiError | null>(null)
  const m = useMutation<R, unknown, V>({
    mutationFn: o.run,
    onSuccess: async (r, vars) => {
      setConflict(null)
      await Promise.all((o.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })))
      if (o.success) toast.push({ tone: 'success', title: typeof o.success === 'function' ? o.success(r) : o.success })
      o.onSuccess?.(r, vars)
    },
    onError: (e) => {
      if (isApiError(e) && (e.status === 412 || e.status === 428)) setConflict(e)
      if (!o.silent) {
        const d = describeError(e)
        toast.push({ tone: 'danger', title: d.title, message: d.message, code: d.code })
      }
    },
  })
  return { ...m, conflict, clearConflict: () => setConflict(null) }
}

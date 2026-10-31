import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { integrations, reference } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { EmbeddedContext, Programme, Project } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { isInIframe, readLaunchContext, startSidePanelHandshake, type ProcoreLaunchContext } from '@/embed/procore'
import { todayISO } from '@/lib/format'
import { asList } from '@/lib/utils'

export type MappingState = 'none' | 'loading' | 'mapped' | 'unmapped' | 'error'

export interface AppContextValue {
  programmes: Programme[]
  projects: Project[]
  programme: Programme | null
  project: Project | null
  programmeId: string | null
  projectId: string | null
  /** Projects of the selected programme. */
  programmeProjects: Project[]
  setProgramme: (id: string | null) => void
  setProject: (id: string | null) => void
  businessDate: string
  setBusinessDate: (d: string) => void
  /** null = live (evidence up to now). */
  evidenceCutoff: string | null
  setEvidenceCutoff: (iso: string | null) => void
  embedded: boolean
  launch: ProcoreLaunchContext
  mapping: { state: MappingState; context: EmbeddedContext | null; message?: string }
  projectCode: (id: string | null | undefined) => string | null
}

const Ctx = createContext<AppContextValue | null>(null)

export function useAppContext(): AppContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAppContext outside AppContextProvider')
  return v
}

const STORE = 'pcx.context'
interface Stored {
  programmeId: string | null
  projectId: string | null
  businessDate?: string
  evidenceCutoff?: string | null
}
function load(): Stored {
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) return JSON.parse(raw) as Stored
  } catch {
    /* ignore */
  }
  return { programmeId: null, projectId: null }
}

export function AppContextProvider({ children }: { children: ReactNode }) {
  const session = useSession()
  const internal = session.signedIn && !session.isSupplier
  const initial = useMemo(load, [])
  const [programmeId, setProgrammeId] = useState<string | null>(initial.programmeId)
  const [projectId, setProjectId] = useState<string | null>(initial.projectId)
  const [businessDate, setBusinessDate] = useState<string>(initial.businessDate ?? todayISO())
  const [evidenceCutoff, setEvidenceCutoff] = useState<string | null>(initial.evidenceCutoff ?? null)
  const [launch, setLaunch] = useState<ProcoreLaunchContext>(() => readLaunchContext())
  const embedded = useMemo(isInIframe, [])

  useEffect(() => startSidePanelHandshake(setLaunch), [])

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ programmeId, projectId, businessDate, evidenceCutoff }))
    } catch {
      /* ignore */
    }
  }, [programmeId, projectId, businessDate, evidenceCutoff])

  const progQ = useApi(['ref', 'programmes'], reference.programmes, { enabled: internal, staleTime: 10 * 60_000 })
  const projQ = useApi(['ref', 'projects'], reference.projects, { enabled: internal, staleTime: 10 * 60_000 })
  const programmes = useMemo(() => asList<Programme>(progQ.data), [progQ.data])
  const projects = useMemo(() => asList<Project>(projQ.data), [projQ.data])

  const hasLaunch = !!(launch.companyId || launch.projectId)
  const embQ = useApi(['procore', 'embedded-context', launch.companyId, launch.projectId], (signal) => integrations.embeddedContext({ company_id: launch.companyId, project_id: launch.projectId }, signal), {
    enabled: internal && hasLaunch,
    staleTime: 5 * 60_000,
  })

  // Map the Procore project to the internal project and preselect it.
  useEffect(() => {
    const ctx = embQ.data
    if (!ctx) return
    const pid = ctx.project?.id ?? ctx.pcx_project_id ?? null
    const p = pid ? projects.find((x) => x.id === pid) ?? ctx.project ?? null : null
    if (p) {
      setProjectId(p.id)
      setProgrammeId(p.programme_id)
    }
  }, [embQ.data, projects])

  // Fallback mapping by procore ids on project rows when the endpoint is not available yet.
  const localMatch = useMemo(() => (launch.projectId ? projects.find((p) => p.procore_project_id === launch.projectId) ?? null : null), [launch.projectId, projects])
  useEffect(() => {
    if (embQ.isError && localMatch) {
      setProjectId(localMatch.id)
      setProgrammeId(localMatch.programme_id)
    }
  }, [embQ.isError, localMatch])

  // Default programme once reference data arrives.
  useEffect(() => {
    if (!programmes.length) return
    if (!programmeId || !programmes.some((p) => p.id === programmeId)) {
      const active = programmes.find((p) => projects.some((x) => x.programme_id === p.id && x.status === 'ACTIVE')) ?? programmes[0]
      setProgrammeId(active.id)
    }
  }, [programmes, projects, programmeId])

  useEffect(() => {
    if (projectId && projects.length && !projects.some((p) => p.id === projectId)) setProjectId(null)
  }, [projects, projectId])

  const setProgramme = useCallback(
    (id: string | null) => {
      setProgrammeId(id)
      setProjectId((cur) => (cur && projects.find((p) => p.id === cur)?.programme_id === id ? cur : null))
    },
    [projects],
  )

  let mapping: AppContextValue['mapping'] = { state: 'none', context: null }
  if (hasLaunch) {
    if (embQ.isPending && internal) mapping = { state: 'loading', context: null }
    else if (embQ.data) {
      const mapped = !!(embQ.data.project || embQ.data.pcx_project_id || embQ.data.mapped)
      mapping = { state: mapped ? 'mapped' : 'unmapped', context: embQ.data, message: embQ.data.message }
    } else if (localMatch) mapping = { state: 'mapped', context: { company_id: launch.companyId, project_id: launch.projectId, project: localMatch }, message: 'Matched locally on Procore project id' }
    else if (embQ.isError) mapping = { state: 'error', context: null, message: embQ.error.isEndpointMissing ? 'Embedded-context service not available yet' : embQ.error.detail }
  }

  const programme = programmes.find((p) => p.id === programmeId) ?? null
  const project = projects.find((p) => p.id === projectId) ?? null
  const programmeProjects = projects.filter((p) => !programmeId || p.programme_id === programmeId)
  const codeMap = useMemo(() => new Map(projects.map((p) => [p.id, p.code])), [projects])

  const value: AppContextValue = {
    programmes,
    projects,
    programme,
    project,
    programmeId,
    projectId,
    programmeProjects,
    setProgramme,
    setProject: setProjectId,
    businessDate,
    setBusinessDate,
    evidenceCutoff,
    setEvidenceCutoff,
    embedded,
    launch,
    mapping,
    projectCode: (id) => (id ? codeMap.get(id) ?? null : null),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

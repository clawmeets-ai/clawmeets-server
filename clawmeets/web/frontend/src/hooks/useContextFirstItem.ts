import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'
import { useAgents } from './useAgents'
import { useMyAgents } from './useMyAgents'
import { useAssistantAgent } from './useAssistantAgent'
import { useDmThreads } from './useDmThreads'
import { useUserProjects } from './useProjects'
import { getChatrooms } from '../api/endpoints'
import { counterpartOf, frontDeskSide, isLegacyFdHost } from '../utils/frontDesk'
import { isThreadProject, type AgentCard, type Project } from '../types'
import type { RailContext } from '../stores/uiStore'

export interface ContextFirstItem {
  /** in-app route of the panel's first item, or null when the context is empty. */
  route: string | null
  /** true while the underlying data is still loading (defer the item-vs-guide call). */
  loading: boolean
}

const byModifiedDesc = (a: Project, b: Project) =>
  (b.last_modified ?? b.created_at ?? '').localeCompare(a.last_modified ?? a.created_at ?? '')

/**
 * Resolves the first item a rail context should open, mirroring each panel's own
 * ordering so the "click a tab → open its first item" behavior matches what the
 * side panel shows on top. Returns `loading` so the caller waits for data before
 * deciding between the first item and the per-tab zero state.
 */
export function useContextFirstItem(context: RailContext | undefined): ContextFirstItem {
  const { user } = useAuthStore()
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: myAgents } = useMyAgents()
  const assistant = useAssistantAgent()
  const { groups } = useDmThreads()
  const { data: projects, isLoading: projectsLoading } = useUserProjects()

  // The first host-side Front Desk project, so we can resolve its first channel
  // below (the FD panel selects/highlights by channel route, not project route).
  const firstFdProject = useMemo<Project | null>(() => {
    if (context !== 'frontdesk' || !user) return null
    const agentById = new Map((agents ?? []).map((a) => [a.id, a]))
    return (
      (projects ?? [])
        .filter(
          (p) => frontDeskSide(p, agentById, user.id) === 'host' || isLegacyFdHost(p, user.id),
        )
        .sort(byModifiedDesc)[0] ?? null
    )
  }, [context, agents, projects, user])

  const { data: fdChatrooms } = useQuery({
    queryKey: ['chatrooms', firstFdProject?.id],
    queryFn: () => getChatrooms(firstFdProject!.id),
    enabled: !!firstFdProject,
  })

  return useMemo<ContextFirstItem>(() => {
    const enc = encodeURIComponent
    const agentById = new Map((agents ?? []).map((a) => [a.id, a]))

    switch (context) {
      case 'agents': {
        // Assistant hero first, else the newest owned agent (AgentsPanel order).
        const first: AgentCard | null = assistant ?? myAgents[0] ?? null
        return { route: first ? `/dm/${enc(first.name)}` : null, loading: agentsLoading }
      }
      case 'dms': {
        const g = groups[0]
        const t = g?.threads[0]
        return {
          route: t ? `/dm/${enc(g.agent.name)}/${t.projectId}` : null,
          loading: projectsLoading || agentsLoading,
        }
      }
      case 'projects': {
        const first = (projects ?? []).filter((p) => !isThreadProject(p)).sort(byModifiedDesc)[0]
        // Land on the project's coordinator room (composer focused via ContextLanding),
        // not the bare overview.
        return {
          route: first ? `/projects/${first.id}/chatrooms/user-communication` : null,
          loading: projectsLoading,
        }
      }
      case 'frontdesk': {
        if (!firstFdProject) return { route: null, loading: projectsLoading || agentsLoading }
        // Wait for the channel list so we navigate straight to the first channel
        // (a real FD selection) rather than flashing the bare project route.
        if (fdChatrooms === undefined) return { route: null, loading: true }
        const firstChannel = fdChatrooms[0]?.name
        return {
          route: firstChannel
            ? `/projects/${firstFdProject.id}/chatrooms/${enc(firstChannel)}`
            : `/projects/${firstFdProject.id}`,
          loading: false,
        }
      }
      case 'public': {
        // Foreign agents you've reached via your local FD end; newest first, first
        // whose coordinator card resolves (PublicPanel's grouping key).
        const local = (projects ?? [])
          .filter((p) => !!user && frontDeskSide(p, agentById, user.id) === 'local')
          .sort(byModifiedDesc)
        let route: string | null = null
        for (const p of local) {
          const agent = agentById.get(counterpartOf(p))
          if (agent) {
            route = `/dm/${enc(agent.name)}`
            break
          }
        }
        return { route, loading: projectsLoading || agentsLoading }
      }
      default:
        return { route: null, loading: false }
    }
  }, [context, agents, myAgents, assistant, groups, projects, agentsLoading, projectsLoading, user, firstFdProject, fdChatrooms])
}

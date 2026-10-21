import { useMemo } from 'react'
import { useAgents } from './useAgents'
import { useUserProjects } from './useProjects'
import { useAuthStore } from '../stores/authStore'
import { counterpartOf, frontDeskSide } from '../utils/frontDesk'
import {
  isFrontDeskProject,
  isOwnDMProject,
  isScheduledDMProject,
  parseFrontDeskName,
  type AgentCard,
} from '../types'

export interface DmThread {
  projectId: string
  title: string
  lastModified: string
  /** true for a scheduled-messages DM thread (isScheduledDMProject). */
  isScheduled: boolean
}

export interface DmThreadGroup {
  agent: AgentCard
  threads: DmThread[]
}

export interface DmThreads {
  /** one group per agent (own or foreign) with ≥1 DM/FD thread, newest activity first. */
  groups: DmThreadGroup[]
  /** total threads across all groups (rail DMs badge). */
  totalThreads: number
  /** agent id → its most-recent own-DM thread (drives Recents + active-work dot). */
  mostRecentByAgentId: Map<string, { projectId: string; lastModified: string }>
}

// Own-DM threads are N-per-agent, each a separate project named
// `{username}-dm-{short}-{uuid8}`. The uuid suffix makes parseOwnDMName().agentShort
// unreliable, so threads are grouped by `counterpartOf(p) → agent` (the DM partner:
// `counterpart_id` on an owner-coordinated requester end, else `coordinator_id`).
export function useDmThreads(): DmThreads {
  const userId = useAuthStore((s) => s.user?.id)
  const username = useAuthStore((s) => s.user?.username)
  const { data: agents } = useAgents()
  const { data: projects } = useUserProjects()

  return useMemo(() => {
    const empty: DmThreads = { groups: [], totalThreads: 0, mostRecentByAgentId: new Map() }
    if (!userId || !agents || !projects) return empty

    const agentById = new Map(agents.map((a) => [a.id, a]))
    const threadsByAgent = new Map<string, DmThread[]>()

    for (const p of projects) {
      if (p.created_by !== userId) continue
      // Accept the caller's OWN-DM threads AND their Front Desk requester (local)
      // ends. The FD local ends bring conversations with foreign/public agents
      // into the DMs rail (grouped under their owner). Host ends
      // (frontDeskSide === 'host') are deliberately excluded — they belong in
      // Front Desk, not here.
      const isOwnDm = p.surface === 'dm' && isOwnDMProject(p)
      const isFdLocal =
        frontDeskSide(p, agentById, userId) === 'local' ||
        // Legacy migration window: a shared '-fd-' row (surface==='dm') where
        // the viewer is the requester.
        (isFrontDeskProject(p) && parseFrontDeskName(p.name)?.requester === username)
      if (!isOwnDm && !isFdLocal) continue
      const agent = agentById.get(counterpartOf(p))
      if (!agent) continue
      const arr = threadsByAgent.get(agent.id) ?? []
      arr.push({
        projectId: p.id,
        title: p.display_name || 'New chat',
        lastModified: p.last_modified ?? p.created_at ?? '',
        isScheduled: isScheduledDMProject(p),
      })
      threadsByAgent.set(agent.id, arr)
    }

    const mostRecentByAgentId = new Map<string, { projectId: string; lastModified: string }>()
    const groups: DmThreadGroup[] = []
    let totalThreads = 0

    for (const [agentId, threads] of threadsByAgent.entries()) {
      threads.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
      const agent = agentById.get(agentId)!
      groups.push({ agent, threads })
      totalThreads += threads.length
      mostRecentByAgentId.set(agentId, {
        projectId: threads[0].projectId,
        lastModified: threads[0].lastModified,
      })
    }

    // Groups ordered by most-recent activity (newest agent conversation first).
    groups.sort((a, b) => b.threads[0].lastModified.localeCompare(a.threads[0].lastModified))

    return { groups, totalThreads, mostRecentByAgentId }
  }, [userId, username, agents, projects])
}

import { useMemo } from 'react'
import { useMyAgents } from './useMyAgents'
import { useDmThreads } from './useDmThreads'
import type { AgentCard } from '../types'

export interface RecentAgent {
  agent: AgentCard
  projectId: string
  lastModified: string
}

/**
 * Owned agents you've recently DMed, newest first. `AgentCard` has no recency
 * field, so recency is derived from each agent's most-recent own-DM thread
 * (`useDmThreads`, grouped by counterpart — `counterpart_id ?? coordinator_id` —
 * robust to the N-thread `{username}-dm-{short}-{uuid8}` naming). Agents never
 * DMed are omitted.
 *
 * @param limit  max rows to return.
 * @param excludeAgentId  agent to drop (the pinned assistant, shown separately).
 */
export function useRecentAgents(limit = 6, excludeAgentId?: string): RecentAgent[] {
  const { data: myAgents } = useMyAgents()
  const { mostRecentByAgentId } = useDmThreads()

  return useMemo(() => {
    if (!myAgents) return []
    const out: RecentAgent[] = []
    for (const agent of myAgents) {
      if (excludeAgentId && agent.id === excludeAgentId) continue
      const recent = mostRecentByAgentId.get(agent.id)
      if (!recent || !recent.lastModified) continue
      out.push({ agent, projectId: recent.projectId, lastModified: recent.lastModified })
    }
    out.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    return out.slice(0, limit)
  }, [myAgents, mostRecentByAgentId, limit, excludeAgentId])
}

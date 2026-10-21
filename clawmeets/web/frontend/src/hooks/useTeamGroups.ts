import { useMemo } from 'react'
import { useMyAgents } from './useMyAgents'
import type { AgentCard } from '../types'

export interface TeamGroups {
  /** team label → owned agents carrying that label (Gmail-label semantics). */
  teamBuckets: Map<string, AgentCard[]>
  /** team labels, alphabetically sorted. */
  sortedTeamNames: string[]
  /** owned agents with no team label — listed flush below the teams. */
  untemmedAgents: AgentCard[]
  /** every owned agent (drives the "AGENTS · N" count). */
  myAgents: AgentCard[]
  isLoading: boolean
}

/**
 * Groups the caller's owned agents by `user_teams`. Lifted out of the former
 * `AgentList` so the redesigned sidebar and the command palette share one
 * grouping instead of duplicating the memo.
 */
export function useTeamGroups(): TeamGroups {
  const { data: myAgents, isLoading } = useMyAgents()

  return useMemo(() => {
    const buckets = new Map<string, AgentCard[]>()
    const untemmed: AgentCard[] = []
    for (const agent of myAgents || []) {
      const teams = agent.user_teams || []
      if (teams.length === 0) {
        untemmed.push(agent)
        continue
      }
      for (const t of teams) {
        const bucket = buckets.get(t) ?? []
        bucket.push(agent)
        buckets.set(t, bucket)
      }
    }
    return {
      teamBuckets: buckets,
      sortedTeamNames: Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b)),
      untemmedAgents: untemmed,
      myAgents: myAgents || [],
      isLoading,
    }
  }, [myAgents, isLoading])
}

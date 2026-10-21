import { useQuery } from '@tanstack/react-query'
import {
  getAgentSampleRequests,
  type AgentSampleRequest,
} from '../api/endpoints/templates'

export type { AgentSampleRequest }

// Looks up the sample-request set for an agent by its bare template name
// (i.e. "amy" not "chuswine-amy" — strip the user prefix at the call site
// via utils/agentDisplay.displayName before passing it in).
//
// Single GET aggregates every template's per-agent sample_requests into a
// map; cached forever per session via TanStack Query, so the DM zero-state
// doesn't re-fetch when the user switches between agents.
export function useAgentSampleRequests(bareAgentName: string | null | undefined): {
  samples: AgentSampleRequest[]
  isLoading: boolean
} {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-samples'],
    queryFn: () => getAgentSampleRequests(),
    staleTime: Infinity,
  })
  const samples = bareAgentName ? (data?.[bareAgentName] ?? []) : []
  return { samples, isLoading }
}

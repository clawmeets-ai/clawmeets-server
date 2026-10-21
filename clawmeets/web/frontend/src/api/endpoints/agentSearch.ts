import { get } from '../client'
import type { AgentSearchParams, AgentSearchResponse } from '../../types'

export async function searchAgents(params: AgentSearchParams = {}): Promise<AgentSearchResponse> {
  const searchParams = new URLSearchParams()
  if (params.q) searchParams.set('q', params.q)
  if (params.capabilities) searchParams.set('capabilities', params.capabilities)
  if (params.status) searchParams.set('status', params.status)
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.sort) searchParams.set('sort', params.sort)
  if (params.discoverable_only) searchParams.set('discoverable_only', 'true')
  const qs = searchParams.toString()
  return get<AgentSearchResponse>(`/agents/search${qs ? `?${qs}` : ''}`)
}

export async function getAgentCapabilities(): Promise<string[]> {
  return get<string[]>('/agents/capabilities')
}

import { del, get, post, put } from '../client'

/**
 * Public requests (server/routes/public_requests.py): ask once in plain
 * words; the hub picks the best few public agents and delivers it (each
 * match's `p_fit` is the hub's estimate the agent can help). Each sent match
 * carries the ordinary thread (`project_id`) the answer lands in.
 *
 * Nothing else ranks: with no plan from the hub, asking fails with
 * `hub_required` (409, this server is not on the hub), `hub_unavailable`
 * (503) or `rate_limited` (429), read with `hubErrorCode`, and nothing is
 * stored.
 */

export type MatchStatus = 'not_sent' | 'working' | 'responded'

export interface RequestMatch {
  /** The agent's id in the retain routes. */
  agent_ref: string
  kind: 'local' | 'hub'
  agent_id: string | null
  name: string
  display_name: string
  owner: string
  deployment_name: string | null
  description: string
  expertise: string[]
  teams: string[]
  retained_count: number
  online: boolean
  /** `p_fit` as a whole percent. */
  fit: number
  score: number
  project_id: string | null
  sent_at: number | null
  send_error: string | null
  dismissed: boolean
  status: MatchStatus
  responded_at: number | null
  /** The hub's estimate (0..1) that this agent can help. */
  p_fit?: number | null
  slot?: string | null
  /** The user picked this agent's answer. */
  used?: boolean
}

export interface PublicRequestSummary {
  id: string
  text: string
  created_at: number
  matched: number
  sent: number
  responded: number
}

export interface PublicRequest extends PublicRequestSummary {
  /** The hub's rank order, best first. */
  matches: RequestMatch[]
  /** No agent clearly fit: the user's own assistant got the request. */
  answer_yourself?: boolean
  fallback_project_id?: string | null
  fallback_agent_name?: string | null
}

export async function createPublicRequest(text: string, sendCount = 3): Promise<PublicRequest> {
  return post<PublicRequest>('/me/public-requests', { text, send_count: sendCount })
}

export async function listPublicRequests(): Promise<PublicRequestSummary[]> {
  return get<PublicRequestSummary[]>('/me/public-requests')
}

export async function getPublicRequest(id: string): Promise<PublicRequest> {
  return get<PublicRequest>(`/me/public-requests/${encodeURIComponent(id)}`)
}

/** "Ask for more": a new hub ask for up to `count` agents, excluding everyone asked. */
export async function sendPublicRequest(id: string, body: { count?: number }): Promise<PublicRequest> {
  return post<PublicRequest>(`/me/public-requests/${encodeURIComponent(id)}/send`, body)
}

export async function setMatchDismissed(id: string, agentRef: string, dismissed: boolean): Promise<PublicRequest> {
  const path = `/me/public-requests/${encodeURIComponent(id)}/dismissed/${encodeURIComponent(agentRef)}`
  return dismissed ? put<PublicRequest>(path) : del<PublicRequest>(path)
}

/** "Use this answer" (`used`) or "asked again" (`redone`): reported to the hub. */
export async function reportMatchOutcome(id: string, agentRef: string, kind: 'used' | 'redone'): Promise<PublicRequest> {
  return post<PublicRequest>(`/me/public-requests/${encodeURIComponent(id)}/outcome`, { agent_ref: agentRef, kind })
}

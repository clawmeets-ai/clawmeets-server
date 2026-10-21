import { del, get, post, put } from '../client'

/**
 * Public requests (server/routes/public_requests.py): ask once in plain
 * words; the server ranks every public agent and sends to the best few. Each
 * sent match carries the ordinary thread (`project_id`) the answer lands in.
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
  fit: number
  rep: number
  score: number
  /** Field label → the request terms that hit it. */
  why: Record<string, string[]>
  project_id: string | null
  sent_at: number | null
  send_error: string | null
  dismissed: boolean
  status: MatchStatus
  responded_at: number | null
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
  /** Server rank order, best first. */
  matches: RequestMatch[]
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

/** "Load more" (`count`) or the drawer's "Send my request" (`agent_refs`). */
export async function sendPublicRequest(
  id: string,
  body: { count?: number; agent_refs?: string[] },
): Promise<PublicRequest> {
  return post<PublicRequest>(`/me/public-requests/${encodeURIComponent(id)}/send`, body)
}

export async function setMatchDismissed(id: string, agentRef: string, dismissed: boolean): Promise<PublicRequest> {
  const path = `/me/public-requests/${encodeURIComponent(id)}/dismissed/${encodeURIComponent(agentRef)}`
  return dismissed ? put<PublicRequest>(path) : del<PublicRequest>(path)
}

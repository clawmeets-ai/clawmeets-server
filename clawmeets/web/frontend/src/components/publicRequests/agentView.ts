import type { RetainedAgent } from '../../api/endpoints/hub'
import type { RequestMatch } from '../../api/endpoints/publicRequests'
import { REMOTE_TEXT_CAP, safeRemoteText } from '../../utils/hubDisplay'

/** The ask page; a request's room is under it. Not `/public`: in dev, Vite
 *  serves `/app/public` as the `public.html` entry (the anonymous pages). */
export const REQUESTS_PATH = '/requests'
export const requestPath = (id: string) => `${REQUESTS_PATH}/${encodeURIComponent(id)}`

/** The `?agent=` search param opens the agent drawer, so the sidebar's
 *  retained agents can open it from anywhere under REQUESTS_PATH. */
export const AGENT_PARAM = 'agent'

/**
 * One agent as the card and the drawer show it: a request's match, or a
 * retained agent opened from the sidebar outside any request. Text from
 * another server is remote text and goes through safeRemoteText here, once.
 */
export interface DrawerAgent {
  agent_ref: string
  display_name: string
  owner: string
  /** The agent's server when it is not this one. */
  server: string | null
  description: string
  expertise: string[]
  /** How many users of this server retained it; null when unknown (another server). */
  retained_count: number | null
  match: RequestMatch | null
}

export function fromMatch(m: RequestMatch): DrawerAgent {
  const remote = m.kind === 'hub'
  const text = (s: string, cap: number) => (remote ? safeRemoteText(s, cap) : s)
  return {
    agent_ref: m.agent_ref,
    display_name: text(m.display_name, REMOTE_TEXT_CAP.name),
    owner: text(m.owner, REMOTE_TEXT_CAP.name),
    server: remote ? safeRemoteText(m.deployment_name ?? m.owner, REMOTE_TEXT_CAP.name) : null,
    description: text(m.description, REMOTE_TEXT_CAP.description),
    expertise: m.expertise.map((e) => text(e, REMOTE_TEXT_CAP.capability)),
    retained_count: remote ? null : m.retained_count,
    match: m,
  }
}

export function fromRetained(r: RetainedAgent): DrawerAgent {
  const local = !!r.is_local
  const dash = r.name.indexOf('-')
  return {
    agent_ref: r.hub_agent_id,
    display_name: local && dash > 0 ? r.name.slice(dash + 1) : safeRemoteText(r.name, REMOTE_TEXT_CAP.name),
    owner: local && dash > 0 ? r.name.slice(0, dash) : safeRemoteText(r.deployment_name, REMOTE_TEXT_CAP.name),
    server: local ? null : safeRemoteText(r.deployment_name, REMOTE_TEXT_CAP.name),
    description: local ? r.description : safeRemoteText(r.description, REMOTE_TEXT_CAP.description),
    expertise: r.capabilities.map((c) => (local ? c : safeRemoteText(c, REMOTE_TEXT_CAP.capability))),
    retained_count: null,
    match: null,
  }
}

/** "name" for an agent here, "name@server" for one elsewhere. */
export function agentLabel(a: Pick<DrawerAgent, 'display_name' | 'server'>): string {
  return a.server ? `${a.display_name}@${a.server}` : a.display_name
}

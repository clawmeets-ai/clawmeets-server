// Namespace-aware display helpers for agent names.
//
// Storage keeps the globally unique ``{username}-{suffix}`` identity; the UI
// renders and authors mentions by short name for the viewer's own agents.
//
// The server mirrors this rule for ``@mention`` resolution (see
// ``Agent.short_name`` / ``Agent.resolve_with_namespace`` /
// ``Chatroom.resolve_mention``), so what the user types and what they see
// stay in sync.

import type { AgentCard, User } from '../types'

function ownerPrefix(user: Pick<User, 'username'> | null | undefined): string | null {
  if (!user?.username) return null
  return `${user.username}-`
}

/** Strip the viewer's owner prefix from an agent they own; otherwise return the full name. */
export function displayName(
  agent: Pick<AgentCard, 'name' | 'registered_by'>,
  viewer: Pick<User, 'id' | 'username'> | null | undefined,
): string {
  if (!viewer) return agent.name
  if (agent.registered_by !== viewer.id) return agent.name
  const prefix = ownerPrefix(viewer)
  if (prefix && agent.name.startsWith(prefix)) {
    return agent.name.slice(prefix.length)
  }
  return agent.name
}

/** Handle with the owner prefix stripped, regardless of viewer. Use when the
 *  owner username is already shown (section header). Usernames can't contain '-',
 *  so the first hyphen splits owner/short. */
export function shortName(agent: Pick<AgentCard, 'name'>): string {
  const dash = agent.name.indexOf('-')
  return dash > 0 ? agent.name.slice(dash + 1) : agent.name
}

/**
 * Resolve a stored agent reference against the live roster.
 *
 * Records persist both the id and the full name at write time (a to-do's
 * `by_agent_*`, a briefing tab's `owner_agent_*`, …). The id is authoritative;
 * the name is the fallback for rows written before ids were recorded, or for
 * agents referenced by name only. Returns undefined for human participants and
 * for agents the viewer can no longer see — callers render those without a
 * presence dot, which is correct.
 */
export function findAgent(
  agents: AgentCard[] | undefined,
  ref: { id?: string | null; name?: string | null },
): AgentCard | undefined {
  if (!agents) return undefined
  if (ref.id) {
    const byId = agents.find((a) => a.id === ref.id)
    if (byId) return byId
  }
  if (ref.name) return agents.find((a) => a.name === ref.name)
  return undefined
}

/** Text to insert into a composer after ``@`` when the viewer selects this agent. */
export function mentionInsertText(
  agent: Pick<AgentCard, 'name' | 'registered_by'>,
  viewer: Pick<User, 'id' | 'username'> | null | undefined,
): string {
  return displayName(agent, viewer)
}

/** Match against both full name and namespace-aware short name. */
export function matchesQuery(
  agent: Pick<AgentCard, 'name' | 'registered_by'>,
  query: string,
  viewer: Pick<User, 'id' | 'username'> | null | undefined,
): boolean {
  const q = query.toLowerCase()
  if (agent.name.toLowerCase().includes(q)) return true
  const short = displayName(agent, viewer)
  return short !== agent.name && short.toLowerCase().includes(q)
}

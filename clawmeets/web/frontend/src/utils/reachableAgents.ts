import type { RetainedAgent } from '../api/endpoints/hub'
import type { AgentCard } from '../types'

/**
 * The agents the user can jump to from Cmd-K, the same set their own agents'
 * rosters list: the user's own agents, plus the agents they retained. Another
 * account's agent of this server counts while it is still shared (its row is
 * active); an agent of another server while its row is active. Being public
 * is not enough: other people's agents are found in the hub directory and
 * retained there. A public agent the user already talks to stays reachable
 * through its thread, which Cmd-K lists on its own.
 *
 * `retained` undefined (still loading, or the list failed): own agents only.
 */
export function reachableAgents(
  agents: AgentCard[] | undefined,
  userId: string | undefined,
  retained: RetainedAgent[] | undefined,
): { local: AgentCard[]; hub: RetainedAgent[] } {
  const active = (retained ?? []).filter((r) => r.state === 'active')
  const keptHere = new Set(active.filter((r) => r.is_local && r.agent_id).map((r) => r.agent_id as string))
  const local = (agents ?? []).filter((a) => (!!userId && a.registered_by === userId) || keptHere.has(a.id))
  return { local, hub: active.filter((r) => !r.is_local) }
}

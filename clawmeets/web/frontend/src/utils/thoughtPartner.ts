import type { AgentCard, User } from '../types'
import { displayName } from './agentDisplay'

/** The one name that makes an agent "your thought_partner". */
export const THOUGHT_PARTNER_NAME = 'thought_partner'

/**
 * The viewer's own thought_partner, if they have one.
 *
 * BY NAME, EXACTLY, AND BY NOTHING ELSE. An agent the viewer owns whose short
 * name is `thought_partner` counts; a `coach` that carries the `grill-me` skill
 * does not, and skills are deliberately never consulted — the nudge promises
 * *the* thought_partner, and a user can see at a glance whether they have one.
 *
 * Ownership is re-checked here rather than trusted to the caller's list, so a
 * public `someone-thought_partner` can never satisfy it.
 */
export function findThoughtPartner(
  agents: AgentCard[] | undefined,
  viewer: Pick<User, 'id' | 'username'> | null | undefined,
): AgentCard | undefined {
  if (!agents || !viewer) return undefined
  return agents.find(
    (a) => a.registered_by === viewer.id && displayName(a, viewer) === THOUGHT_PARTNER_NAME,
  )
}

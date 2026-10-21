import type { RetainedAgent } from '../api/endpoints/hub'
import type { AgentCard, User } from '../types'
import { displayName } from './agentDisplay'
import { retainedHubLabel } from './hubDisplay'

/**
 * Who the desk composer sends to: an agent of this server (the user's own, or
 * another account's they retained), or a retained agent of ANOTHER server.
 * The second has no agent card here: a send to it starts a hub thread, it has
 * no model choice, no presence and no own DM to schedule into.
 *
 * Told apart by `hub_agent_id`, which only the hub row carries. Ids never
 * collide: a hub id is `{fp}~{name}` and agent ids never hold a `~`.
 */
export type DeskRecipient = AgentCard | RetainedAgent

export function isHubRecipient(r: DeskRecipient | null | undefined): r is RetainedAgent {
  return !!r && 'hub_agent_id' in r
}

export function recipientId(r: DeskRecipient): string {
  return isHubRecipient(r) ? r.hub_agent_id : r.id
}

/** The name the desk shows and confirms with: the short name for an agent of
 *  this server, `name@server` (remote text, cleaned) for one elsewhere. */
export function recipientLabel(r: DeskRecipient, user: User | null | undefined): string {
  return isHubRecipient(r) ? retainedHubLabel(r) : displayName(r, user ?? null)
}

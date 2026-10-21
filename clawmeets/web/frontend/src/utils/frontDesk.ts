// Front Desk per-side detection for the new-model (surface === 'frontdesk')
// two-owned-projects thread shape. A Front Desk thread is two singly-owned
// projects bound 1-to-1 by a TunnelBinding: the requester owns the LOCAL end,
// the foreign agent's owner owns the HOST end. Both ends are surface==='frontdesk'
// and — because each side is singly-owned by the account viewing it —
// `created_by === user.id` is TRUE on BOTH, so it cannot tell the sides apart.
// The load-bearing discriminator is which account owns the fielding coordinator.

import { isFrontDeskProject, type AgentCard, type Project } from '../types'

/**
 * Who a thread is WITH: its outside party (`counterpart_id`) on a requester
 * end, else its coordinator. Owner isolation made the owning user the
 * coordinator of requester ends and moved the outside agent to
 * `counterpart_id`; older projects (and older servers) still carry the agent
 * as coordinator, so the fallback keeps them grouped the same way. Mirrors the
 * server's `models/project.counterpart_of`. Every thread list that groups or
 * routes by "the agent this thread is with" reads it, never `coordinator_id`.
 */
export function counterpartOf(project: Pick<Project, 'coordinator_id' | 'counterpart_id'>): string {
  return project.counterpart_id || project.coordinator_id
}

/**
 * Classify a Front Desk project relative to the viewer:
 *   - 'host'  = the viewer owns the thread's partner, its fielding agent
 *               (renders in Front Desk)
 *   - 'local' = the partner (`counterpartOf`) is a foreign/public agent
 *               (renders in Public)
 *   - null    = not a new-model FD project (`surface !== 'frontdesk'`, or the
 *               coordinator card is unavailable). Legacy `-fd-` rows classify
 *               via the caller's legacy fallback (`isLegacyFdHost` /
 *               `isFrontDeskProject`), not here.
 *
 * `GET /agents` returns public agents to everyone, so the foreign coordinator
 * card resolves on the requester's account — the same `registered_by` signal
 * `PublicPanel` and `displayName()` already use.
 */
export function frontDeskSide(
  project: Pick<Project, 'surface' | 'coordinator_id' | 'counterpart_id'>,
  agentById: Map<string, AgentCard>,
  userId: string,
): 'host' | 'local' | null {
  if (project.surface !== 'frontdesk') return null
  // The thread's partner, not its coordinator: on a requester end the owner
  // now coordinates and the foreign agent is the counterpart.
  const partnerId = counterpartOf(project)
  const partner = partnerId ? agentById.get(partnerId) : undefined
  if (!partner) return null
  return partner.registered_by === userId ? 'host' : 'local'
}

/**
 * LEGACY host-side detection (migration window only): a legacy shared `-fd-`
 * row (`surface === 'dm'`) the viewer created. New-model host ends are
 * `surface === 'frontdesk'` and are matched by `frontDeskSide(...) === 'host'`
 * instead. Safe to delete alongside `isFrontDeskProject` once the DD5 migration
 * flips every legacy `-fd-` row (Front Desk plan §7).
 */
export function isLegacyFdHost(
  project: { name: string; surface?: string; created_by?: string },
  userId: string,
): boolean {
  return isFrontDeskProject(project) && project.created_by === userId
}

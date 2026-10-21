import type { AgentCard, User } from '../types'
import type { DeskSop } from '../api/endpoints/deskSops'

/**
 * Single home for "who does this SOP go to?".
 *
 * An SOP outlives the agent it was addressed to, so resolution degrades step
 * by step rather than dangling. Precedence mirrors `resolveTodoRecipient` in
 * `todoDraft.ts` — the same problem, one layer over:
 *
 *   agent_id            → restore exactly what the user picked
 *   → agent_name        → survive an id change / re-registration
 *   → {username}-assistant → the user's own coordinator
 *   → first owned agent → anything they can actually send to
 *   → null              → caller decides (the composer keeps its recipient)
 */
export function resolveSopRecipient(
  sop: Pick<DeskSop, 'agent_id' | 'agent_name'>,
  agents: AgentCard[] | undefined,
  user: Pick<User, 'id' | 'username'> | null,
): AgentCard | null {
  const all = agents ?? []
  if (sop.agent_id) {
    const byId = all.find((a) => a.id === sop.agent_id)
    if (byId) return byId
  }
  if (sop.agent_name) {
    const byName = all.find((a) => a.name === sop.agent_name)
    if (byName) return byName
  }
  const assistantName = user ? `${user.username}-assistant` : ''
  return (
    all.find((a) => a.name === assistantName) ??
    all.find((a) => a.registered_by === user?.id) ??
    null
  )
}

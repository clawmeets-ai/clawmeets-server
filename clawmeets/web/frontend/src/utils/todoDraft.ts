import type { AgentCard } from '../types'
import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * Single home for "who does this to-do's draft go to?". Points the desk message
 * box's recipient pill when an item is loaded into it. Precedence, each step
 * degrading gracefully if the stored agent has since left the roster:
 *   draft_recipient_id → draft_recipient_name  (what the user picked, or what a
 *                                               publishing agent suggested)
 *   → `${username}-assistant`                  (the user's own coordinator)
 *   → first agent registered_by the user       (any owned agent)
 *   → null                                     (caller decides the fallback)
 */
export function resolveTodoRecipient(
  task: DeskTodo,
  agents: AgentCard[] | undefined,
  user: { id: string; username: string } | null,
): AgentCard | null {
  const all = agents ?? []
  if (task.draft_recipient_id) {
    const byId = all.find((a) => a.id === task.draft_recipient_id)
    if (byId) return byId
  }
  if (task.draft_recipient_name) {
    const byName = all.find((a) => a.name === task.draft_recipient_name)
    if (byName) return byName
  }
  const assistantName = user ? `${user.username}-assistant` : ''
  return all.find((a) => a.name === assistantName) ?? all.find((a) => a.registered_by === user?.id) ?? null
}

/**
 * True when the stored draft recipient still resolves to a live agent — i.e.
 * `resolveTodoRecipient` will honor the user's pick rather than falling through
 * to the assistant default. Callers use this to warn instead of
 * silently redirecting a draft the user explicitly addressed.
 */
export function draftRecipientResolves(task: DeskTodo, agents: AgentCard[] | undefined): boolean {
  const all = agents ?? []
  if (!task.draft_recipient_id && !task.draft_recipient_name) return false
  return all.some(
    (a) =>
      (!!task.draft_recipient_id && a.id === task.draft_recipient_id) ||
      (!!task.draft_recipient_name && a.name === task.draft_recipient_name),
  )
}

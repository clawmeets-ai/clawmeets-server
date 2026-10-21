import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * Which side of the desk is driving the cross-highlight, and on what.
 *
 * Exactly one side can be the source at a time, and that is a physical fact
 * rather than a rule anyone enforces: the three surfaces that write it — the
 * card list, the To-do rail and the sidebar's My Desk panel — are siblings in
 * different columns, so a pointer cannot be inside two of them.
 *
 * A sidebar sub-row publishes `{ side: 'card' }` rather than a fourth variant.
 * The row IS a proxy for its card — same id, same id space, same answer — and a
 * `'rail'` variant would be a second name for one thing that every consumer
 * would then have to handle twice.
 */
export type DeskHover =
  | { side: 'card'; projectId: string }
  | { side: 'todo'; todoId: string }
  | null

/** The two sides of one cross-highlight: the lit rows and the lit cards. */
export type LinkedPair = {
  linkedTodoIds: ReadonlySet<string>
  linkedProjectIds: ReadonlySet<string>
}

/**
 * Stable empty set — MODULE level, deliberately. `resolveLinkedPair` returns
 * this exact reference whenever nothing is lit, so an unrelated render hands
 * consumers an identical set instead of a fresh `new Set()`, and the resting
 * desk stops repainting itself for nothing.
 */
export const NO_LINKS: ReadonlySet<string> = new Set()

/** `NO_LINKS`'s reason, applied to the pair as a whole. */
export const NO_PAIR: LinkedPair = { linkedTodoIds: NO_LINKS, linkedProjectIds: NO_LINKS }

/**
 * Value equality for a hover. Used by `deskLinkStore` to turn a repeated write
 * of the same pointer target into a true no-op, which is what keeps a store
 * written on every pointer crossing from re-rendering the sidebar on each one.
 *
 * It lives here rather than in the store because it is a fact about the
 * `DeskHover` type, not about how the type is held.
 */
export function sameHover(a: DeskHover, b: DeskHover): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.side === 'card' && b.side === 'card') return a.projectId === b.projectId
  if (a.side === 'todo' && b.side === 'todo') return a.todoId === b.todoId
  return false
}

/**
 * BOTH SIDES OF THE PAIR, resolved together, as a pure function.
 *
 * The two sets are one answer to one question, so they are computed in one pass
 * rather than in two memos that would each have to re-derive the other's gate.
 *
 * It is a free function rather than a `DeskPage` memo because the join now has
 * THREE views — the cards, the to-do rail, and the sidebar's My Desk panel —
 * living in two different React trees. One pure function both trees call is
 * what stops them drifting on what "linked" means.
 *
 * The element under the pointer wears the mark TOO. A mark on only the far side
 * reads as "look over there", which is the opposite of the claim being made: a
 * relationship drawn on one end is not visibly a relationship.
 *
 * Gated on the pair being NON-EMPTY, which is the whole reason this is not a
 * CSS-only `:hover` rule: a card with no to-dos must stay unmarked, or the
 * accent stops meaning "paired" and starts meaning "the pointer is here" — and
 * `.md-card:hover`'s own border + shadow already say that.
 *
 * `platedProjectIds` is the CALLER's own rendered set: the desk passes
 * Review + Working + Recently done, the sidebar panel passes the same three
 * lists it draws sub-rows for. They are the same set; each caller owns its own.
 */
export function resolveLinkedPair(
  hover: DeskHover,
  todos: readonly DeskTodo[],
  platedProjectIds: ReadonlySet<string>,
): LinkedPair {
  // Hovering a CARD ⇒ every LIVE to-do listing this card's projectId.
  // Archived rows are excluded on purpose: the drawer is a record of
  // filed-away work, not the plate, and it is collapsed by default anyway.
  if (hover?.side === 'card') {
    const rows = new Set<string>()
    for (const t of todos) {
      if (!t.archived && t.project_ids.includes(hover.projectId)) rows.add(t.id)
    }
    if (!rows.size) return NO_PAIR
    return { linkedTodoIds: rows, linkedProjectIds: new Set([hover.projectId]) }
  }

  // Hovering a TO-DO ⇒ that row's project_ids verbatim, unfiltered. Ids whose
  // project has left the plate stay in the set and simply match no card:
  // `project_ids` keeps the ids of deleted projects forever, so "links to
  // nothing on screen" is the ordinary case, not an error to report. Nothing
  // renders a match count anywhere, for exactly that reason.
  //
  // The row's OWN mark is the one thing that cannot be resolved that loosely.
  // Carrying an id is not the same as having a partner on screen, so the
  // self-mark asks the stricter question — is any of these actually PLATED? —
  // and a row pointing only at deleted projects stays dark, exactly as the
  // cards it fails to light do.
  if (hover?.side === 'todo') {
    const row = todos.find((t) => t.id === hover.todoId)
    if (!row || row.project_ids.length === 0) return NO_PAIR
    const ids = new Set(row.project_ids)
    const paired = row.project_ids.some((id) => platedProjectIds.has(id))
    return { linkedProjectIds: ids, linkedTodoIds: paired ? new Set([row.id]) : NO_LINKS }
  }

  return NO_PAIR
}

import type { DeskTodo, TicketState } from '../api/endpoints/deskTodos'
import {
  matches,
  TICKET_GROUP_PREFIX,
  type LabelGroup,
  type LabelView,
  type ResolvedRegistry,
} from './labelView'

/**
 * THE TICKET PROJECTION — the second axis, kept in its own module.
 *
 * A SIBLING OF `labelView.ts`, deliberately not a section inside it. A ticket
 * state is not a label: it has no slug, no registry row, no colour and no
 * sigil, and the owner cannot write it. Folding these four functions into the
 * label projection is exactly what would let a ticket state reach `chipsFor`,
 * `labelCounts` or `groupTodos` by accident — one shared helper, one `any`, one
 * copied line, and the derived state is being counted as a label the owner
 * minted.
 *
 * ONE-WAY IMPORT: `ticketView → labelView`, never the reverse. `matchesPlate`
 * delegates the label half to `matches()` unchanged rather than reimplementing
 * it, so there is still exactly one definition of what a label filter means.
 *
 * Pure and total, like its sibling: same inputs, same output, never throws,
 * never reads a store, never touches the network. `groupByTicketState` takes no
 * registry argument at all — and that missing parameter is the type-level
 * reason ticket grouping cannot vanish when the registry does.
 */

/** THE STATE ENUMERATION, and the render order of the FILTER ROWS and the
 *  COUNTS. New first, because NEW IS THE INBOX — there is no "Unprocessed"
 *  pile to put ahead of it any more, and there must never be one again.
 *
 *  The RAIL orders its groups differently — see `TICKET_GROUP_ORDER`. The two
 *  are separate constants because they answer different questions: this one is
 *  "what states exist, and in what order do you pick one", the other is "what
 *  does the owner want under their eyes first". */
export const TICKET_STATES: readonly TicketState[] = ['new', 'working', 'failed', 'completed']

/** THE RAIL'S GROUP ORDER: WORK IN FLIGHT FIRST, then what BROKE, then the
 *  inbox, then what is already done. The rail is a worklist read top-down, so
 *  the pile the owner is actually inside belongs above the pile they have not
 *  looked at yet, and Completed — the only group that only ever grows — sinks
 *  to the bottom where it cannot push the others off the screen.
 *
 *  FAILED SITS SECOND, directly under work in flight and ABOVE the inbox,
 *  which is the one place it differs from `TICKET_STATES`' lifecycle order: a
 *  row that broke needs a hand now, where an untouched one is merely waiting.
 *
 *  A PERMUTATION OF `TICKET_STATES`, never a subset: same four members, so
 *  grouping stays total no matter which of the two a reader reaches for. */
export const TICKET_GROUP_ORDER: readonly TicketState[] = ['working', 'failed', 'new', 'completed']

/**
 * The words. The wire carries lowercase slugs precisely so this one function
 * owns the copy — nothing else in the browser spells "Working" or "Done".
 *
 * `'completed'` RENDERS AS "Done", and the asymmetry is deliberate. The slug is
 * the value the state is derived from (`ProjectStatus.COMPLETED`), so renaming
 * it would buy a translation layer and nothing else — while silently dropping
 * every owner's saved Completed filter and orphaning their collapsed group key,
 * both of which are persisted by slug in localStorage.
 *
 * The visible word had to move because the desk already spends "Done" on the
 * card button next to these chips, and that button now completes the project it
 * belongs to. One word, one meaning, on one screen.
 */
export function ticketLabel(s: TicketState): string {
  switch (s) {
    case 'working':
      return 'Working'
    // The slug and the word agree here, unlike `completed`/"Done": nothing
    // else on the desk spends the word "Failed", so there is nothing to
    // disambiguate against and no reason to translate.
    case 'failed':
      return 'Failed'
    case 'completed':
      return 'Done'
    default:
      return 'New'
  }
}

/**
 * Does this to-do pass the WHOLE plate filter — both axes?
 *
 * THE STATE TERM RUNS FIRST, and it runs BEFORE `matches()`'s own
 * empty-filter early return and OUTSIDE its registry branch. That ordering is
 * the criterion: state filtering consults no registry, so it has to survive a
 * registry that will not load, and it cannot do that from behind a function
 * that answers `true` as soon as the label filter is empty.
 *
 * Several states WIDEN (OR). There is no ALL/AND toggle on this axis and there
 * must not be one: a to-do has exactly one state, so an AND across two of them
 * is unsatisfiable and the control could only ever produce an empty plate.
 */
export function matchesPlate(
  t: DeskTodo,
  view: LabelView,
  reg: ResolvedRegistry,
): boolean {
  if (view.states.length && !view.states.includes(t.state)) return false
  return matches(t, view, reg)
}

/**
 * How many UNARCHIVED items read each state.
 *
 * Computed from the same `open` list the label counts come from, never from the
 * filtered list, so the two columns of the filter popover agree and a count
 * does not shrink as you filter.
 *
 * RETURNS ALL FOUR KEYS, zeros included. A blank count beside a context row
 * that has one reads as broken, and "0" is the honest and useful answer.
 */
export function stateCounts(open: DeskTodo[]): Map<TicketState, number> {
  const counts = new Map<TicketState, number>(TICKET_STATES.map((s) => [s, 0]))
  for (const t of open) counts.set(t.state, (counts.get(t.state) ?? 0) + 1)
  return counts
}

/**
 * DOES THIS ROW RENDER A TICKET CHIP AT ALL?
 *
 * The "New renders nothing" decision, in exactly one place. Both readers need
 * it as a BOOLEAN and neither may re-derive it: `TicketChip` returns null, and
 * `TodoItem`'s strip guard cannot ask the element — a JSX element is truthy
 * even when the component it names renders null, so `{ticket && …}` would
 * render an empty `.todo-labels` line on every label-less row.
 */
export function hasTicketChip(t: DeskTodo): boolean {
  return t.state !== 'new'
}

/** The group key for one ticket state. Namespaced via `TICKET_GROUP_PREFIX` so
 *  it can never collide with a label slug in the store's `collapsed` map. */
export function ticketGroupKey(s: TicketState): string {
  return `${TICKET_GROUP_PREFIX}${s}`
}

/**
 * EXACTLY FOUR GROUPS, partitioning on the derived `state`, in
 * `TICKET_GROUP_ORDER` — Working, then Failed, then New, then Completed.
 *
 * Every to-do lands in exactly one, none is duplicated, none is dropped, and
 * none is folded away for being empty — a missing "Done" header would
 * read as a missing feature rather than as an empty group, and the four
 * together are a map of the plate, which only works if all four are on it.
 *
 * THE COST OF THE FOURTH, named because this axis is the one place it is
 * paid: an empty group still renders its header, so every plate grew one
 * ~24px row. That is the deliberate trade for Failed being legible on a plate
 * where it is rare — a group you only see when it has rows is a group you
 * never learn to look for.
 *
 * THERE IS NO RESIDUAL. That is the replacement, not an adjustment: the old
 * "Unprocessed · no state" pile was computed from label MEMBERSHIP, so once
 * nothing carries a state label it would swallow the entire plate into one
 * red group. `state` is required and never null, so every to-do has a real
 * group to go in, and the one that used to be the residual — New — is now an
 * ordinary group with nothing to nag about.
 */
export function groupByTicketState(shown: DeskTodo[]): LabelGroup[] {
  return TICKET_GROUP_ORDER.map((s) => ({
    key: ticketGroupKey(s),
    name: ticketLabel(s),
    // No `ResolvedLabel`: there is no registry row behind a ticket state, and
    // inventing one is how it would start being treated as a label.
    label: null,
    items: shown.filter((t) => t.state === s),
    tone: 'ticket' as const,
    collapsedByDefault: false,
  }))
}

import { create } from 'zustand'
import type { DeskSop } from '../api/endpoints/deskSops'
import type { DeskTodo } from '../api/endpoints/deskTodos'

// Cross-tree signal bus for My Desk. Things in the Sidebar tree (column 1) need
// to drive the main desk pane (column 2, in the router Outlet tree) — "jump to
// a section" and "scroll to one card" from the rail panel, "load this SOP" from
// the ⌘K palette. Those two React trees don't share props, so a tiny shared
// store replaces the design prototype's window CustomEvent bus. All are
// one-shot requests: the consumer acts and clears. Counts are NOT stored here:
// every consumer derives them from the same react-query cache via
// useDeskUpdates, so they stay in sync without a lifted counter.
//
// Opening a briefing used to live here as `openBriefSlug`. It does not any
// more: a briefing is a route now (`/desk/briefings/:slug`), so the URL carries
// that state — which is also what made Back work, since store state has no
// history entry to go back to.
/** The two tabs of the My Desk right rail (`DeskSideRail`). */
export type DeskRailTab = 'todo' | 'sop'

interface DeskState {
  // A section id the main pane should scroll to (consumed once, then cleared).
  scrollTarget: string | null
  // A card the main pane should scroll to, keyed by projectId (consumed once,
  // then cleared). Sibling of `scrollTarget`: that one aims at a section
  // heading, this one at an individual update card inside it. Kept separate
  // rather than overloading `scrollTarget` because the consumers differ — a
  // section is a DOM id query, a card is a `cardRefs` handle lookup that may
  // not exist yet on a cold /desk mount.
  focusCardId: string | null
  // An SOP the desk should load into its composer (consumed once, then cleared).
  // Carries the whole record rather than an id so the consumer needs no second
  // fetch and can't race the ['desk-sops'] query on a cold /desk mount.
  pendingSop: DeskSop | null
  // A to-do the desk should load into its message box (consumed once, then
  // cleared). Carries the whole record for the same reason `pendingSop` does:
  // no second fetch, and no race with the ['desk-todos'] query on a cold mount.
  pendingTask: DeskTodo | null
  // A right-rail tab the desk should open on. The rail's own tab state is
  // local and defaults to To-do, so ⌘K's "…and show SOP" needs a way to say
  // which side it meant. `requestSop` sets it too — landing an SOP pick on the
  // To-do tab would hide the thing that was just picked.
  pendingRailTab: DeskRailTab | null

  requestScroll: (sectionId: string) => void
  clearScroll: () => void
  requestCardFocus: (projectId: string) => void
  clearCardFocus: () => void
  requestSop: (sop: DeskSop) => void
  clearPendingSop: () => void
  requestTask: (task: DeskTodo) => void
  clearPendingTask: () => void
  requestRailTab: (tab: DeskRailTab) => void
  clearPendingRailTab: () => void
  /** Drop every parked one-shot. Called from the shared per-user reset list
   *  (`stores/perUserStores.ts`), which BOTH `authStore.logout()` and
   *  `authStore.switchTo()` run.
   *
   *  This store looks stateless enough not to need one — every field is
   *  transient and "the consumer acts and clears". It needs one anyway, and the
   *  switcher is why: `pendingSop` and `pendingTask` carry WHOLE `DeskSop` /
   *  `DeskTodo` RECORDS, not ids. Park one from ⌘K, switch account before the
   *  desk consumes it, and account A's to-do is loaded into account B's
   *  composer, under B's name, ready to send (AC-3.4). */
  reset: () => void
}

/** The parked-one-shot half of the state, so `reset` and the initializer cannot
 *  drift apart when a field is added. */
const EMPTY = {
  scrollTarget: null,
  focusCardId: null,
  pendingSop: null,
  pendingTask: null,
  pendingRailTab: null,
} as const

export const useDeskStore = create<DeskState>((set) => ({
  ...EMPTY,
  requestScroll: (sectionId) => set({ scrollTarget: sectionId }),
  clearScroll: () => set({ scrollTarget: null }),
  requestCardFocus: (projectId) => set({ focusCardId: projectId }),
  clearCardFocus: () => set({ focusCardId: null }),
  requestSop: (sop) => set({ pendingSop: sop, pendingRailTab: 'sop' }),
  clearPendingSop: () => set({ pendingSop: null }),
  // Sets the rail tab in the same update for the same reason `requestSop` does:
  // landing a task pick on the SOP tab would hide the rail row just aimed at.
  requestTask: (task) => set({ pendingTask: task, pendingRailTab: 'todo' }),
  clearPendingTask: () => set({ pendingTask: null }),
  requestRailTab: (tab) => set({ pendingRailTab: tab }),
  clearPendingRailTab: () => set({ pendingRailTab: null }),
  reset: () => set({ ...EMPTY }),
}))

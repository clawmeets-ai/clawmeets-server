import { create } from 'zustand'
import { sameHover, type DeskHover } from '../utils/deskLinks'

/**
 * The My Desk ↔ To-do cross-highlight's pointer channel, shared across trees.
 *
 * WHY THIS IS NOT IN `deskStore`. That store's header states its contract in
 * one line — every field is a one-shot request and "the consumer acts and
 * clears". A pointer position never clears itself that way: it is continuous,
 * it is written on every crossing, and nothing consumes it. Putting it there
 * would break the invariant that makes `deskStore` readable.
 *
 * WHY A STORE AT ALL. The cross-highlight used to be `DeskPage`'s `useState`,
 * which was right while both ends of the pair lived under `DeskPage`. The
 * sidebar's `MyDeskRailPanel` is now a third view of the same set and lives in
 * the Sidebar tree (column 1), not the router Outlet tree (column 2) — the two
 * share no props, which is the same problem `deskStore` was created to solve.
 *
 * SUBSCRIBE THROUGH `selectHover`, never by destructuring the store. This
 * setter fires on every pointer crossing, and a whole-store subscription would
 * re-render the entire sidebar on each one.
 */
interface DeskLinkState {
  /** What the pointer is on, or `null`. `null` is the resting state. */
  hover: DeskHover
  /**
   * Point the highlight at something, or clear it.
   *
   * Writing the value already held is a TRUE no-op — the updater returns the
   * state object itself and zustand bails on `Object.is` before notifying
   * anyone. That guard is load-bearing rather than defensive: without it, a
   * repeated `setHover({ side: 'card', projectId })` would hand every selector
   * a fresh object literal and repaint the desk and the sidebar for nothing.
   *
   * CLEARING IS THE CALLER'S JUDGEMENT, not this setter's: a `mouseleave` must
   * only clear its OWN side of the pair, so callers check the live `hover`
   * before writing `null`.
   */
  setHover: (next: DeskHover) => void
  /** Drop the highlight. Called from the shared per-user reset list
   *  (`stores/perUserStores.ts`), which BOTH `authStore.logout()` and
   *  `authStore.switchTo()` run — every per-user store is on that list, and a
   *  hover parked over account A's card has no meaning under account B. */
  reset: () => void
}

export const useDeskLinkStore = create<DeskLinkState>((set) => ({
  hover: null,
  setHover: (next) => set((s) => (sameHover(s.hover, next) ? s : { hover: next })),
  reset: () => set((s) => (s.hover === null ? s : { hover: null })),
}))

/** The ONE way to read the hover. See the note on `DeskLinkState`. */
export const selectHover = (s: DeskLinkState): DeskHover => s.hover

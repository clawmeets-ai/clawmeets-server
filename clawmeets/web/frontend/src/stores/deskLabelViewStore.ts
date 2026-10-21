import { create } from 'zustand'
import type { TicketState } from '../api/endpoints/deskTodos'
import type { GroupAxis, MergeHint } from '../utils/labelView'
import { TICKET_STATES } from '../utils/ticketView'

/**
 * DURABLE VIEW STATE for the labelled to-do rail: which axis it is grouped by,
 * what it is filtered to, whether contexts AND rather than OR, and which
 * groups are folded.
 *
 * A SIBLING OF `deskStore`, not a tenant in it. That store's own header says
 * every field in it is one-shot — "the consumer acts and clears" — and that
 * counts are deliberately not stored there. Durable state would quietly
 * falsify the comment, and the next person to read it would trust it.
 *
 * NOT `TodoRail` useState either, and this one is a bug by construction rather
 * than a preference: `DeskSideRail` renders `{tab === 'todo' ? <TodoRail/> :
 * <SopRail/>}`, so the rail UNMOUNTS on every tab switch and a local filter
 * would die the moment the owner glances at SOP.
 *
 * And not the URL: one route, persistent chrome, Back would "undo a filter",
 * and a shared link would carry a stale filter into someone else's session.
 *
 * PERSISTED BY HAND rather than through `zustand/middleware`'s `persist`, and
 * the reason is the per-user key. `persist` takes ONE static name; re-pointing
 * it at `<key>:<userId>` on a user switch means calling `rehydrate()`, which
 * is a promise — so the rail renders once with an empty filter before the
 * stored one lands. `announcementStore` is the precedent the per-user rule
 * comes from in the first place, and it reads and writes by hand for exactly
 * this reason. Same posture here: synchronous, and guarded in BOTH directions,
 * because Safari private mode throws on `getItem` and quota throws on
 * `setItem`, and this store backs a component inside the desk shell — an
 * escaping throw takes down the desk, not one banner.
 */

const STORAGE_PREFIX = 'clawmeets-desk-label-view-v1'

/** Per-user, following `announcementStore`, whose comment states the rule: a
 *  shared browser must not leak one user's state into another's. Flat-keyed,
 *  user B lands on a rail filtered to a slug they have never had, reading
 *  "To do 0 of 35", and the reconcile then clears it naming a label they have
 *  never seen. One interpolation; wrong by default if nobody says it. */
export function storageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}:${userId || 'anon'}`
}

/** Exactly the durable half. `mergeHints` is absent on purpose — see below. */
export interface PersistedView {
  group: null | GroupAxis
  filter: string[]
  matchAll: boolean
  /** The ticket-state narrowing. Its OWN key, never slugs in `filter` — see
   *  `LabelView.states` for why that separation is load-bearing. */
  states: TicketState[]
  collapsed: Record<string, boolean>
}

const EMPTY: PersistedView = {
  group: null,
  filter: [],
  matchAll: false,
  states: [],
  collapsed: {},
}

/** Tolerates absent, corrupt and foreign-shaped blobs; a storage failure
 *  degrades to "nothing stored", never to a crashed rail. */
export function loadView(userId: string | null | undefined): PersistedView {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(storageKey(userId))
  } catch {
    return { ...EMPTY }
  }
  if (!raw) return { ...EMPTY }
  try {
    const p = JSON.parse(raw) as Partial<PersistedView>
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ...EMPTY }
    return {
      // A STORED `'state'` IS COERCED TO `'ticket'`, not to null. The owner
      // asked for lifecycle grouping and now there is a real one; coercing to
      // null instead would switch grouping silently off for every owner who
      // had it on — the same outcome the deleted "your last state was deleted"
      // notice reached, just by a quieter road. No storage-key bump is needed:
      // this loader already tolerates values it does not recognise.
      group:
        p.group === 'context' || p.group === 'ticket'
          ? p.group
          : (p.group as unknown) === 'state'
            ? 'ticket'
            : null,
      filter: Array.isArray(p.filter) ? p.filter.filter((s) => typeof s === 'string') : [],
      matchAll: p.matchAll === true,
      // Validated like `filter`, and against the closed set rather than by
      // `typeof`: this key is new, so every blob written before today is
      // missing it, and a foreign value here would narrow the plate to nothing
      // with no row in the popover to turn off.
      states: Array.isArray(p.states)
        ? (p.states.filter((s) => TICKET_STATES.includes(s as TicketState)) as TicketState[])
        : [],
      collapsed:
        p.collapsed && typeof p.collapsed === 'object' && !Array.isArray(p.collapsed)
          ? Object.fromEntries(
              Object.entries(p.collapsed).filter(([, v]) => typeof v === 'boolean'),
            )
          : {},
    }
  } catch {
    return { ...EMPTY }
  }
}

function saveView(userId: string | null | undefined, view: PersistedView): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(view))
  } catch {
    // Quota or disabled storage: the in-memory state still holds for this
    // session, which is the useful half.
  }
}

export interface LabelViewState extends PersistedView {
  userId: string | null

  /**
   * Merges seen since the last reconcile. EPHEMERAL — never written to
   * storage, because replaying one on a cold load would re-apply a merge that
   * was already applied and re-point a filter the owner has since changed.
   *
   * Written from two places that learn the same fact differently: the tab that
   * performed the merge reads `into` off the response, and every other tab
   * reads it off the `DESK_LABEL_SYNC` envelope. Both drain here, which is what
   * makes a live filter follow a merge in EVERY open tab rather than only in
   * the one that made the call.
   */
  mergeHints: MergeHint[]

  setGroup: (group: null | GroupAxis) => void
  toggleFilter: (slug: string) => void
  toggleState: (s: TicketState) => void
  /** Clears BOTH axes. One button says "Clear filter" and the owner means all
   *  of it; leaving `states` set would empty the plate under a control that
   *  just reported itself off. */
  clearFilter: () => void
  setMatchAll: (on: boolean) => void
  /** `currentlyCollapsed` is passed in rather than read off the map because
   *  the map holds OVERRIDES: an absent key means "the owner has not said" and
   *  falls through to the group's own default, so the caller — which knows the
   *  default — is the only one that can compute the flip. */
  toggleCollapsed: (key: string, currentlyCollapsed: boolean) => void
  noteMerge: (from: string, into: string) => void
  /** Commit a `reconcileView` result and drop the hints it consumed. */
  applyReconcile: (next: PersistedView) => void
  /** Point the store at a user and load that user's blob. No-op when the user
   *  is unchanged, so it is safe in an effect keyed on `userId`. */
  hydrate: (userId: string | null) => void
  /** Called from `authStore.logout()`'s siblings — clears the IN-MEMORY view
   *  only. The stored blob stays: it is still true for that user and should
   *  survive their next login, and the key is already per-user so nothing
   *  leaks through storage. It is the in-memory carry-over that leaks. */
  reset: () => void
}

/** Persist the durable half after every mutation. One helper so a new verb
 *  cannot forget — the failure mode otherwise is "this one setting doesn't
 *  survive a reload", which nobody reports and everybody works around. */
function persisted(
  set: (fn: (s: LabelViewState) => Partial<LabelViewState>) => void,
  get: () => LabelViewState,
  update: (s: LabelViewState) => Partial<PersistedView>,
) {
  set((s) => {
    const patch = update(s)
    const next: PersistedView = {
      group: patch.group !== undefined ? patch.group : s.group,
      filter: patch.filter ?? s.filter,
      matchAll: patch.matchAll ?? s.matchAll,
      states: patch.states ?? s.states,
      collapsed: patch.collapsed ?? s.collapsed,
    }
    saveView(get().userId, next)
    return next
  })
}

export const useDeskLabelViewStore = create<LabelViewState>((set, get) => ({
  ...EMPTY,
  userId: null,
  mergeHints: [],

  setGroup: (group) => persisted(set, get, () => ({ group })),

  toggleFilter: (slug) =>
    persisted(set, get, (s) => ({
      filter: s.filter.includes(slug)
        ? s.filter.filter((x) => x !== slug)
        : [...s.filter, slug],
    })),

  toggleState: (st) =>
    persisted(set, get, (s) => ({
      states: s.states.includes(st)
        ? s.states.filter((x) => x !== st)
        : [...s.states, st],
    })),

  clearFilter: () => persisted(set, get, () => ({ filter: [], states: [] })),

  setMatchAll: (matchAll) => persisted(set, get, () => ({ matchAll })),

  toggleCollapsed: (key, currentlyCollapsed) =>
    persisted(set, get, (s) => ({
      collapsed: { ...s.collapsed, [key]: !currentlyCollapsed },
    })),

  noteMerge: (from, into) =>
    set((s) =>
      s.mergeHints.some((m) => m.from === from && m.into === into)
        ? s
        : { mergeHints: [...s.mergeHints, { from, into }] },
    ),

  applyReconcile: (next) => {
    saveView(get().userId, next)
    set({ ...next, mergeHints: [] })
  },

  hydrate: (userId) => {
    if (get().userId === userId) return
    set({ userId, ...loadView(userId), mergeHints: [] })
  },

  reset: () => set({ userId: null, ...EMPTY, mergeHints: [] }),
}))

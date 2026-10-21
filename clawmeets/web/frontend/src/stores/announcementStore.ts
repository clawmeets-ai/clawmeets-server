import { create } from 'zustand'
import type { Runner } from '../types'
import type { AnnouncementEntry } from '../hooks/useAnnouncements'

/**
 * The user's DISMISSAL STATE — and nothing else.
 *
 * Ported forward from the reverted store, which got this half right. What
 * changed in the redesign: the entries are now DERIVED (useAnnouncements) rather
 * than pushed, so `announcements` and `apply` left this store entirely, and
 * `visibleCount()` is DELETED rather than ported — it existed only to clamp a
 * server-owned `affected_count` the client had to trust, and there is no
 * `affected_count` any more. The headline is `remainingRunners(...).length`, the
 * same list the disclosure expands, so the two cannot disagree.
 *
 * Dismissal is keyed on the (agent_id, announcement_id) PAIR, not on the
 * announcement alone. "I've seen that my laptop runner is old" must not also
 * silence the same warning for a runner the user hasn't seen yet, so a banner
 * keeps rendering while ANY affected runner is absent from the dismissed set,
 * and a newly affected runner resurfaces a previously dismissed banner.
 */

/** `{ "<announcement_id>": ["<agentId>", ...] }` — the persisted shape. */
export type DismissedMap = Record<string, string[]>

/** Still v2: the persisted shape is UNCHANGED by this redesign, so a blob that
 *  survived the revert is still correct and must keep working. (v2 was the bump
 *  for the move from announcement-only keys to the pair key.) */
const STORAGE_PREFIX = 'claw-announcement-dismissed-v2'

/** Dismissals are per-user; a shared browser must not leak one user's dismissed
 *  set into another's. Logged-out sessions share the `anon` bucket. */
export function storageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}:${userId || 'anon'}`
}

/** Reads the persisted map, tolerating absent/corrupt/foreign-shaped values.
 *
 *  EVERY localStorage ACCESS IN THIS MODULE IS GUARDED — Safari private mode
 *  throws outright on getItem and a quota error throws on setItem. A storage
 *  failure must degrade to "nothing dismissed", NEVER to a crashed layout: this
 *  module backs a component mounted in AppLayout, so an escaping throw takes
 *  down the whole app shell, not just the banner. */
export function loadDismissed(userId: string | null | undefined): DismissedMap {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(storageKey(userId))
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: DismissedMap = {}
    for (const [id, agents] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(agents)) {
        out[id] = agents.filter((a): a is string => typeof a === 'string')
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveDismissed(userId: string | null | undefined, map: DismissedMap): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(map))
  } catch {
    // Quota or disabled storage: the in-memory state still holds for this
    // session, which is the useful half. Nothing to recover here.
  }
}

/** Affected runners the user has NOT yet dismissed for this announcement. */
export function remainingRunners(entry: AnnouncementEntry, dismissed: DismissedMap): Runner[] {
  const seen = new Set(dismissed[entry.id] ?? [])
  return entry.affected.filter(runner => !seen.has(runner.id))
}

/** A banner shows while ANY affected runner is still undismissed — which is also
 *  why a NEWLY affected runner RESURFACES a previously dismissed banner (its id
 *  is not in the dismissed set) while a dismissed runner merely reconnecting
 *  does not (its id is). Both directions have tests. */
export function isVisible(entry: AnnouncementEntry, dismissed: DismissedMap): boolean {
  return remainingRunners(entry, dismissed).length > 0
}

interface AnnouncementState {
  dismissed: DismissedMap
  userId: string | null

  /** Point the store at a user and load that user's dismissed set. No-op when
   *  the user is unchanged, so it is safe in an effect keyed on userId. */
  hydrate: (userId: string | null) => void

  /** Dismiss for every runner the announcement CURRENTLY affects. */
  dismiss: (announcementId: string, affected: Runner[]) => void

  /** Drop dismissals for agents that no longer exist. */
  pruneDeletedAgents: (liveAgentIds: string[]) => void

  /** §4.8 — called from authStore.logout(). */
  reset: () => void
}

export const useAnnouncementStore = create<AnnouncementState>((set, get) => ({
  dismissed: {},
  userId: null,

  hydrate: (userId) => {
    if (get().userId === userId) return
    set({ userId, dismissed: loadDismissed(userId) })
  },

  dismiss: (announcementId, affected) => {
    const { dismissed, userId } = get()
    // Union of what was already dismissed with everyone currently affected.
    //
    // `affected` is an ARGUMENT rather than read off this store because the
    // snapshot now lives in runnerVersionStore and the entries are derived. The
    // caller passes the exact list it rendered, so what the user saw and what
    // gets dismissed cannot drift.
    const union = new Set(dismissed[announcementId] ?? [])
    for (const runner of affected) union.add(runner.id)
    const next: DismissedMap = { ...dismissed, [announcementId]: [...union] }
    set({ dismissed: next })
    saveDismissed(userId, next)
  },

  pruneDeletedAgents: (liveAgentIds) => {
    // ASYMMETRIC BY DESIGN, and the asymmetry IS the design:
    //
    //   - An ANNOUNCEMENT missing from the config is NOT pruned. It may be
    //     absent only because every affected runner is currently offline; if it
    //     comes back, the user's dismissal must come back with it.
    //   - An AGENT that no longer exists IS pruned, because its id will never be
    //     re-issued and would otherwise accumulate forever.
    //
    // GUARDED ON A NON-EMPTY ROSTER: useMyAgents returns [] while loading AND on
    // failure, so an empty list here far more likely means "the fetch hasn't
    // resolved" than "the user deleted every agent" — and acting on it would
    // wipe every dismissal the user has. Refusing to prune costs a few stale
    // ids; the alternative costs the user their dismissals.
    if (!liveAgentIds.length) return
    const live = new Set(liveAgentIds)
    const { dismissed, userId } = get()

    const next: DismissedMap = {}
    let changed = false
    for (const [announcementId, agentIds] of Object.entries(dismissed)) {
      const kept = agentIds.filter(id => live.has(id))
      if (kept.length !== agentIds.length) changed = true
      // An entry whose agents are all gone carries no information; drop the key.
      if (kept.length) next[announcementId] = kept
    }
    if (!changed) return
    set({ dismissed: next })
    saveDismissed(userId, next)
  },

  // Clears the IN-MEMORY dismissed set and userId. Deliberately does NOT delete
  // the persisted blob: those dismissals are still true for that user and should
  // survive their next login. The key is already per-user, so nothing leaks
  // through storage — it is the in-memory carry-over across a session change
  // that leaks (§4.8).
  reset: () => set({ dismissed: {}, userId: null }),
}))

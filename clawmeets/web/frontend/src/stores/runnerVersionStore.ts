import { create } from 'zustand'
import type { Runner } from '../types'

/**
 * RAW SOCKET FACTS ONLY — this user's live runners and the version each reports,
 * exactly as RUNNER_VERSIONS delivered them.
 *
 * TWO STORES, DELIBERATELY: this one holds what the WIRE said; announcementStore
 * holds what the USER did (dismissals). Mixing them is how the seam blurs back
 * into the old server-side-grouping design. Nothing in this file parses a
 * version, matches a spec, or groups anything — that is versionMatch.ts and
 * useAnnouncements.ts.
 */
interface RunnerVersionState {
  /** `null` = NEVER HYDRATED, no push has arrived. `[]` = the server
   *  AFFIRMATIVELY said zero live runners.
   *
   *  DO NOT COLLAPSE THESE. The distinction is the whole reason "no envelope
   *  means keep what you have" is expressible, and it is also what §4.7 renders
   *  nothing on. */
  runners: Runner[] | null

  /** Apply a RUNNER_VERSIONS payload. */
  apply: (payload: unknown) => void

  /** §4.8 — back to the never-hydrated state. Called from authStore.logout(). */
  reset: () => void
}

export const useRunnerVersionStore = create<RunnerVersionState>((set) => ({
  runners: null,

  apply: (payload) => {
    // IGNORE any payload that is not an object with a `runners` ARRAY.
    //
    // The server sends NO ENVELOPE AT ALL when an update push fails internally,
    // precisely so a transient error cannot erase banners that are still true.
    // Treating a key-less or malformed payload as `[]` here would reintroduce
    // that exact erase bug from the client side. Only a well-formed array may
    // change state. Named tests assert the state is UNTOUCHED starting from a
    // populated list — not merely that nothing threw.
    if (!payload || typeof payload !== 'object') return
    const next = (payload as { runners?: unknown }).runners
    if (!Array.isArray(next)) return

    // REPLACE, NEVER MERGE. Every push is a full snapshot, so the new list is
    // the whole truth: a runner absent from the payload is OFFLINE, not
    // still-present-but-unmentioned. Do NOT "improve" this into a merge-by-id —
    // that resurrects stale runners forever and is exactly how the guarantee
    // dies quietly. There is a named test on this.
    //
    // Elements are not filtered or coerced beyond the array check; a malformed
    // element is a contract violation, and group() (§4.5) reads defensively.
    set({ runners: next as Runner[] })
  },

  // Resets to `null`, NOT `[]`: after a logout we genuinely have not been told
  // anything, whereas `[]` would assert "this user has zero live runners".
  reset: () => set({ runners: null }),
}))

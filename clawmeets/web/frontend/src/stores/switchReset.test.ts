import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { useAuthStore } from './authStore'
import { useUnreadStore, storageKey } from './unreadStore'
import { useDeskStore } from './deskStore'
import { useRunnerVersionStore } from './runnerVersionStore'
import { useAnnouncementStore } from './announcementStore'
import { queryClient } from '../queryClient'
import { makeSession, seedSessions } from '../test/authFixtures'
import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * M3's store half: what a SWITCH tears down (AC-3.4 / AC-3.7) and what
 * it re-keys (AC-3.5).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `authStore.test.ts`. That file's own
 * `beforeEach` resets the MIRROR and never `sessions` / `activeUserId`, so
 * session state leaks between its cases (followup B7 — M5's AC-5.6 sweep is its
 * fix, and adjusting it now would be adjusting a test to pass). Every case below
 * needs TWO real sessions and a real switch between them, which that fixture
 * cannot express. `seedSessions` is used throughout: it installs through the same
 * `setSession` the login page uses and never writes the mirror.
 */

const A = 'user-a'
const B = 'user-b'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  seedSessions([])
  useUnreadStore.getState().reset()
  useDeskStore.getState().reset()
})

afterEach(() => {
  seedSessions([])
  // Module singleton: a case that seeds the cache must not hand it to the next
  // file.
  queryClient.clear()
  vi.restoreAllMocks()
})

/** Two signed-in accounts, A active. Returns them so assertions can name tokens
 *  and ids rather than string literals. */
function seedTwo() {
  const a = makeSession({ id: A, username: 'alice' })
  const b = makeSession({ id: B, username: 'bob' })
  seedSessions([a, b], a.userId)
  return { a, b }
}

describe('AC-3.4 / AC-3.7 — a switch runs the SAME reset list a logout runs', () => {
  /**
   * The failure this catches is not subtle once seen and invisible until then:
   * there is no page reload anywhere in this app, so a store left out of the
   * list survives the switch IN MEMORY. `runnerVersionStore` holds runner NAMES,
   * which is A's data rendered in B's banners.
   */
  it('clears the per-user stores on switchTo, not only on logout', () => {
    seedTwo()
    useRunnerVersionStore.setState({
      runners: [{ id: 'a1', name: 'alices-laptop-runner', version: '1.2.9' }],
    })
    useAnnouncementStore.setState({ dismissed: { 'upgrade-1-2-9': ['a1'] }, userId: A })

    useAuthStore.getState().switchTo(B)

    // Back to NEVER HYDRATED, not to `[]`: after a switch we genuinely have not
    // been told anything about B's runners.
    expect(useRunnerVersionStore.getState().runners).toBeNull()
    expect(useAnnouncementStore.getState().dismissed).toEqual({})
    expect(JSON.stringify(useRunnerVersionStore.getState())).not.toContain('alices-laptop-runner')
  })

  /**
   * AC-3.4 names this one specifically, and it is the reason `deskStore.reset()`
   * had to be WRITTEN rather than merely called: the store shipped without one.
   * `pendingSop` / `pendingTask` carry whole records as one-shot handoff state,
   * so a switch performed mid-handoff drops account A's to-do into B's composer,
   * under B's name, ready to send.
   */
  it("does not carry A's parked to-do into B's composer", () => {
    seedTwo()
    useDeskStore.getState().requestTask({ id: 't1', text: "alice's private task" } as DeskTodo)
    expect(useDeskStore.getState().pendingTask).not.toBeNull()

    useAuthStore.getState().switchTo(B)

    expect(useDeskStore.getState().pendingTask).toBeNull()
    expect(useDeskStore.getState().pendingSop).toBeNull()
    expect(useDeskStore.getState().pendingRailTab).toBeNull()
  })

  /** 154 of the 156 query keys in this app carry no user identity, so a switch
   *  that spares the cache renders A's data under B's name. */
  it('clears the react-query cache on every switch', () => {
    seedTwo()
    const clear = vi.spyOn(queryClient, 'clear')

    useAuthStore.getState().switchTo(B)
    expect(clear).toHaveBeenCalledTimes(1)

    // ...and NOT on a no-op switch: nothing changed, so nothing may be thrown
    // away and the epoch must not move.
    const epoch = useAuthStore.getState().authEpoch
    useAuthStore.getState().switchTo(B)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().authEpoch).toBe(epoch)
  })

  /**
   * AC-5.2, and the reason it is a SECOND case rather than two more lines in the
   * one above.
   *
   * The case above asserts that `queryClient.clear` was CALLED. That is an
   * assertion about the switch's control flow, and it is worth having — it is
   * what catches the clear being dropped from `tearDownPerUserState` — but it
   * is not what AC-5.2 says. AC-5.2 says the cache is CLEAR, which is an
   * assertion about the outcome, and the two come apart in exactly one way that
   * matters: a `clear()` that ran but did not empty the cache (a scoped
   * `removeQueries`, a `resetQueries` that leaves entries in place with
   * undefined data, a future React Query whose `clear` keeps disabled queries)
   * would keep the case above green while rendering A's projects under B's
   * name. Spying on the collaborator cannot see that; reading the cache back
   * can.
   *
   * The key here is deliberately one of the 154 that carry NO user identity.
   * That is the whole hazard: nothing about `['projects']` says whose projects
   * they are, so nothing but the clear stands between A's data and B's screen.
   */
  it("leaves no entry of A's behind — the cache is EMPTY, not merely cleared once", () => {
    const { a } = seedTwo()

    queryClient.setQueryData(['projects'], [{ id: 'p1', name: "alice's project" }])
    queryClient.setQueryData(['agents'], [{ id: 'a1', name: 'alices-assistant' }])
    queryClient.setQueryData(['chatrooms', 'p1'], [{ id: 'user-communication' }])
    expect(queryClient.getQueryCache().getAll().length).toBe(3)

    useAuthStore.getState().switchTo(B)

    expect(queryClient.getQueryCache().getAll()).toEqual([])
    expect(queryClient.getQueryData(['projects'])).toBeUndefined()
    expect(queryClient.getQueryData(['agents'])).toBeUndefined()
    expect(queryClient.getQueryData(['chatrooms', 'p1'])).toBeUndefined()

    // Said the way a reviewer can check at a glance: nothing of A's is reachable
    // through the cache at all, by any key.
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain('alice')
    // ...and the switch really did happen, so the emptiness above is the
    // switch's doing and not a cache that was never populated.
    expect(useAuthStore.getState().activeUserId).toBe(B)
    expect(useAuthStore.getState().accessToken).not.toBe(a.accessToken)
  })

  /** AC-3.7's actual subject: ONE list, TWO callers. Asserting each caller
   *  clears the same store is what stops the list drifting — it has drifted
   *  before (`deskLabelViewStore.ts:125`'s comment is false on `main`). */
  it('logout clears everything the switch clears, including the new deskStore entry', () => {
    seedTwo()
    useDeskStore.getState().requestTask({ id: 't1', text: 'x' } as DeskTodo)
    useRunnerVersionStore.setState({ runners: [{ id: 'a1', name: 'r', version: null }] })

    useAuthStore.getState().logout()

    expect(useDeskStore.getState().pendingTask).toBeNull()
    expect(useRunnerVersionStore.getState().runners).toBeNull()
  })
})

describe('AC-3.5 — read watermarks are keyed per user', () => {
  const KEY = 'p1|user-communication'

  /**
   * The keys are `${projectId}|user-communication` — project ids, which carry no
   * user identity and cannot be told apart after the fact. Under the old single
   * flat `clawmeets-unread` name, A's marks were read back for B: B's desk hides
   * cards B has never seen, and B's own marks overwrite A's.
   */
  it("does not read A's watermarks back for B", () => {
    seedTwo()
    useUnreadStore.getState().hydrate(A)
    useUnreadStore.getState().markAsSeen(KEY, 'msg-from-alice')
    expect(useUnreadStore.getState().lastSeenMessages[KEY]).toBe('msg-from-alice')

    useAuthStore.getState().switchTo(B)

    // switchTo hydrates as its LAST step, so this is already B's view — the desk
    // never renders a frame against A's marks.
    expect(useUnreadStore.getState().userId).toBe(B)
    expect(useUnreadStore.getState().lastSeenMessages).toEqual({})
  })

  it("B's own mark does not overwrite A's, and A's survives switching back", () => {
    seedTwo()
    useUnreadStore.getState().hydrate(A)
    useUnreadStore.getState().markAsSeen(KEY, 'msg-a')

    useAuthStore.getState().switchTo(B)
    useUnreadStore.getState().markAsSeen(KEY, 'msg-b')

    useAuthStore.getState().switchTo(A)
    expect(useUnreadStore.getState().lastSeenMessages[KEY]).toBe('msg-a')

    // Both blobs exist, under their own keys, at the same time.
    expect(localStorage.getItem(storageKey(A))).toContain('msg-a')
    expect(localStorage.getItem(storageKey(B))).toContain('msg-b')
  })

  /** The durable half still survives a reload — the point of persisting at all.
   *  `reset()` clears memory only; the stored blob stays true for its user. */
  it('reset clears memory but leaves the stored blob for the next sign-in', () => {
    seedTwo()
    useUnreadStore.getState().hydrate(A)
    useUnreadStore.getState().markAsSeen(KEY, 'msg-a')

    useUnreadStore.getState().reset()
    expect(useUnreadStore.getState().lastSeenMessages).toEqual({})
    expect(useUnreadStore.getState().userId).toBeNull()

    useUnreadStore.getState().hydrate(A)
    expect(useUnreadStore.getState().lastSeenMessages[KEY]).toBe('msg-a')
  })

  /** `localStorage` is user-writable, so the loader has to tolerate anything. */
  it('degrades to empty on a corrupt or foreign-shaped blob', () => {
    localStorage.setItem(storageKey(A), '{not json')
    useUnreadStore.getState().hydrate(A)
    expect(useUnreadStore.getState().lastSeenMessages).toEqual({})

    useUnreadStore.getState().reset()
    localStorage.setItem(storageKey(A), JSON.stringify({ lastSeenMessages: { k: 7 } }))
    useUnreadStore.getState().hydrate(A)
    expect(useUnreadStore.getState().lastSeenMessages).toEqual({})
  })
})

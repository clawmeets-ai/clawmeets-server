import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

// The socket half of AC-2.12 is a NEGATIVE assertion — "connectAsUser was not
// called again" — so the manager has to be a spy. Nothing else is mocked: the
// store, the persist middleware and refreshSession are all the real ones.
vi.mock('../api/websocket', () => ({
  wsManager: {
    connectAsUser: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}))

import { wsManager } from '../api/websocket'
import {
  useAuthStore,
  LAST_LOGOUT_USER_KEY,
  bearerFor,
  hasSession,
  isSessionExpired,
} from './authStore'
import { decodeExp } from './tokenExp'
import { useWebSocketConnection } from '../hooks/useWebSocket'
import { makeSession, mintToken, seedSessions } from '../test/authFixtures'
import { installFetchHarness, settle, type FetchHarness } from '../test/fetchHarness'

let h: FetchHarness

beforeEach(() => {
  h = installFetchHarness()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  // `globals: false` in vitest.config.ts means testing-library's auto-cleanup
  // never registers. A hook left mounted stays SUBSCRIBED to the store, so the
  // next test's seedSessions() re-renders it and fires its effect again — which
  // is exactly the socket call count the assertions here are counting.
  cleanup()
  seedSessions([])
  vi.unstubAllGlobals()
})

describe('AC-2.12 — the mirror is referentially stable across background mutations', () => {
  /**
   * WHY REFERENTIAL STABILITY IS A CONTRACT AND NOT AN OPTIMISATION. 27
   * non-test call sites subscribe with an un-selected `useAuthStore()`.
   * `hooks/useWebSocket.ts` is one of them and its effect dep array is
   * `[isAuthenticated, accessToken, user]` — compared by reference, and `user`
   * is an object. If a BACKGROUND account's silent refresh produced a new `user`
   * here, the ACTIVE account's socket would tear down (the cleanup is
   * `wsManager.disconnect()`) and reconnect, then fire the 14-key
   * reconnect-invalidation burst. It compiles, there is no error, and there is
   * no log line. Hence the assertion on object identity rather than on value.
   */
  it("refreshing B's token while A is active moves no mirror reference and reconnects nothing", async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)

    const { unmount } = renderHook(() => useWebSocketConnection())
    expect(wsManager.connectAsUser).toHaveBeenCalledTimes(1)
    expect(wsManager.connectAsUser).toHaveBeenCalledWith(a.userId, a.accessToken)

    const before = useAuthStore.getState()
    const userBefore = before.user
    const accessBefore = before.accessToken
    const refreshBefore = before.refreshToken

    // A real refresh of the BACKGROUND session, through the real store action
    // and the real refreshSession.
    const refreshed = useAuthStore.getState().refreshAccessToken(b.userId)
    const call = await h.awaitRefresh(b.refreshToken)
    call.rotate('b-access-2', 'b-refresh-2')
    expect(await refreshed).toBe(true)
    await settle()

    // B's own session really did move...
    expect(useAuthStore.getState().sessions.find((s) => s.userId === b.userId)?.accessToken).toBe(
      'b-access-2',
    )

    // ...and the mirror did not, by reference.
    const after = useAuthStore.getState()
    expect(after.user).toBe(userBefore)
    expect(after.accessToken).toBe(accessBefore)
    expect(after.refreshToken).toBe(refreshBefore)
    expect(after.isAuthenticated).toBe(true)

    // The whole point of the reference assertion.
    expect(wsManager.connectAsUser).toHaveBeenCalledTimes(1)
    expect(wsManager.disconnect).not.toHaveBeenCalled()
    unmount()
  })

  /**
   * The control for the test above. Without it, "connectAsUser was called once"
   * would also pass if the hook were simply broken — a negative assertion is
   * only worth what its positive twin proves.
   *
   * M5 (AC-5.3, socket half) EXTENDS this case rather than adding a second one,
   * because the thing it was missing is not a separate scenario — it is two
   * more properties of this one. It asserted that a disconnect happened and
   * that the reconnect carried B, and neither of those pins the ORDER or the
   * COUNT:
   *
   *   - ORDER. A reconnect that runs BEFORE the disconnect leaves A's socket
   *     open, then drops the socket that was just opened for B. The end state
   *     the old assertions read — "disconnect called, connectAsUser last called
   *     with B" — is identical either way, and the app is left with A's stream
   *     still delivering into B's cache and no live socket for B.
   *   - COUNT. `disconnect` is the effect's CLEANUP, so it must fire exactly
   *     once for one switch. Twice means the effect is re-running on something
   *     other than the switch, which is the AC-2.12 flapping failure arriving
   *     through the positive path instead of the negative one.
   *
   * `invocationCallOrder` is a global monotonic counter across all `vi.fn()`s,
   * which is why it can compare two different spies.
   */
  it('a real switch DOES move the mirror and reconnect as the incoming account', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)

    const { unmount } = renderHook(() => useWebSocketConnection())
    expect(wsManager.connectAsUser).toHaveBeenCalledTimes(1)
    // It connected AS A. Named, because "disconnects as A and reconnects as B"
    // is the criterion and the first half of it is an assertion too.
    expect(wsManager.connectAsUser).toHaveBeenCalledWith(a.userId, a.accessToken)

    act(() => {
      useAuthStore.getState().switchTo(b.userId)
    })

    expect(wsManager.disconnect).toHaveBeenCalledTimes(1)
    expect(wsManager.connectAsUser).toHaveBeenCalledTimes(2)
    expect(wsManager.connectAsUser).toHaveBeenLastCalledWith(b.userId, b.accessToken)

    // A's connect, THEN the disconnect, THEN B's connect. The middle term is
    // the one the old assertions could not see.
    const [connectA, connectB] = vi.mocked(wsManager.connectAsUser).mock.invocationCallOrder
    const [disconnect] = vi.mocked(wsManager.disconnect).mock.invocationCallOrder
    expect(connectA).toBeLessThan(disconnect)
    expect(disconnect).toBeLessThan(connectB)

    unmount()
  })

  it('syncActive does not touch the mirror when nothing about the active session changed', () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)

    const userBefore = useAuthStore.getState().user
    // A no-op switch: already active. Must not clear the cache, must not bump
    // the epoch, must not rebuild the mirror.
    const epochBefore = useAuthStore.getState().authEpoch
    useAuthStore.getState().switchTo(a.userId)
    expect(useAuthStore.getState().authEpoch).toBe(epochBefore)
    expect(useAuthStore.getState().user).toBe(userBefore)
  })
})

describe('AC-2.6 — a switch does not trip PostLoginRedirect', () => {
  it('writes no LAST_LOGOUT_USER_KEY on switchTo or on a scoped logout with sessions remaining', () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)

    useAuthStore.getState().switchTo(b.userId)
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBeNull()

    useAuthStore.getState().logout(undefined, a.userId)
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBeNull()
    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([b.userId])

    // The LAST session leaving is a real logout, and it does write the key.
    useAuthStore.getState().logout(undefined, b.userId)
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBe(b.userId)
  })
})

describe('AC-2.8 — persistence and the v0 -> v1 migration', () => {
  const KEY = 'clawmeets-auth'

  /** Seed localStorage as the deployed tab would have it, then rehydrate through
   *  the real persist middleware — including `onRehydrateStorage`, which is what
   *  recomputes the derived mirror. */
  async function rehydrate(blob: unknown): Promise<void> {
    localStorage.setItem(KEY, JSON.stringify(blob))
    await useAuthStore.persist.rehydrate()
  }

  it('lifts a v0 blob into a one-element sessions array, still signed in', async () => {
    const accessToken = mintToken({ sub: 'u1', kind: 'access' })
    const refreshToken = mintToken({ sub: 'u1', kind: 'refresh', ttlSeconds: 30 * 24 * 3600 })
    await rehydrate({
      version: 0,
      state: {
        accessToken,
        refreshToken,
        user: { id: 'u1', username: 'bob', created_at: '2026-01-01T00:00:00Z' },
        isAuthenticated: true,
      },
    })

    const s = useAuthStore.getState()
    expect(s.sessions).toHaveLength(1)
    expect(s.sessions[0].userId).toBe('u1')
    expect(s.activeUserId).toBe('u1')
    // The mirror was recomputed after rehydration — without it the tab renders
    // signed out and the deploy logs everyone out.
    expect(s.isAuthenticated).toBe(true)
    expect(s.accessToken).toBe(accessToken)
    expect(s.user?.username).toBe('bob')

    // Decoded from the tokens' own exp. Never fetched.
    expect(s.sessions[0].accessExpiresAt).toBe(decodeExp(accessToken))
    expect(s.sessions[0].refreshExpiresAt).toBe(decodeExp(refreshToken))
    expect(s.sessions[0].accessExpiresAt).toBeGreaterThan(Date.now())
  })

  it.each([
    [
      'isAuthenticated: false',
      { accessToken: 'a', refreshToken: 'r', user: { id: 'u1' }, isAuthenticated: false },
    ],
    // Reachable independently of the flag: v0's logout nulled all four together,
    // but a hand-edited or partially-written blob is bounded by neither.
    ['a null access token', { accessToken: null, refreshToken: 'r', user: { id: 'u1' }, isAuthenticated: true }],
    ['a null refresh token', { accessToken: 'a', refreshToken: null, user: { id: 'u1' }, isAuthenticated: true }],
    ['no user', { accessToken: 'a', refreshToken: 'r', user: null, isAuthenticated: true }],
    ['a user with no id', { accessToken: 'a', refreshToken: 'r', user: {}, isAuthenticated: true }],
  ])('migrates a v0 blob with %s to signed out', async (_label, state) => {
    await rehydrate({ version: 0, state })
    const s = useAuthStore.getState()
    expect(s.sessions).toEqual([])
    expect(s.activeUserId).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(s.accessToken).toBeNull()
  })

  it('round-trips three v1 sessions with the right one active', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    const c = makeSession({ id: 'user-c' })
    seedSessions([a, b, c], b.userId)

    // What the real middleware wrote, read back through the real middleware.
    const written = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    expect(written.version).toBe(1)
    // The epoch is deliberately not persisted: a reload has nothing in flight.
    expect(written.state).not.toHaveProperty('authEpoch')
    expect(written.state).not.toHaveProperty('accessToken')

    seedSessions([])

    // A fresh tab, same storage. The store is a module singleton so `authEpoch`
    // cannot be observed at its initial value by re-importing; zeroing it here
    // is what makes the assertion below mean "rehydration wrote no epoch"
    // rather than "nothing has happened yet".
    // Zero the epoch BEFORE re-seeding storage: every `set()` re-persists, so
    // a write after the setItem would overwrite the blob under test.
    useAuthStore.setState({ authEpoch: 0 })
    localStorage.setItem(KEY, JSON.stringify(written))
    await useAuthStore.persist.rehydrate()

    const s = useAuthStore.getState()
    expect(s.sessions.map((x) => x.userId)).toEqual([a.userId, b.userId, c.userId])
    expect(s.activeUserId).toBe(b.userId)
    expect(s.accessToken).toBe(b.accessToken)
    expect(s.authEpoch).toBe(0)
    expect(s.listSessions()).toHaveLength(3)

    // AC-5.1's second half, added in M5. Everything above proves the three
    // sessions are IN THE BAG. None of it proves any of them can still make a
    // request, and those are different claims: `api/client.ts` reaches a token
    // ONLY through `bearerFor(userId)`, so a round trip that restored the bag
    // but left the tokens unreadable — a persist `partialize` that dropped a
    // field, a migration that rebuilt `Session` with a renamed key — satisfies
    // every assertion above and signs all three accounts out on the next
    // request.
    //
    // The background accounts are the sharp end. The ACTIVE one is covered
    // incidentally by the mirror assertion above; A and C are reachable only
    // through their own sessions, which is the thing a reload has to preserve
    // for the chip to be able to switch to them at all.
    for (const seeded of [a, b, c]) {
      expect(bearerFor(seeded.userId)).toBe(seeded.accessToken)
      expect(hasSession(seeded.userId)).toBe(true)
      // Expiries are decoded from the tokens' own `exp` at hydration, and they
      // survive the JSON round trip — a session that reloaded as expired would
      // render with the chip's "expired" badge and offer re-auth for an account
      // that is perfectly good.
      expect(isSessionExpired(s.sessions.find((x) => x.userId === seeded.userId)!)).toBe(false)
    }
    // Nothing that was never signed in came back signed in.
    expect(hasSession('user-d')).toBe(false)
    expect(bearerFor('user-d')).toBeNull()
  })
})

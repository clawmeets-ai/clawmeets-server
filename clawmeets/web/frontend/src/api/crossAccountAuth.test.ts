import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { ApiError, get } from './client'
import { useAuthStore, LAST_LOGOUT_USER_KEY } from '../stores/authStore'
import { makeSession, seedSessions } from '../test/authFixtures'
import { installFetchHarness, settle, until, type FetchHarness } from '../test/fetchHarness'

/**
 * The cross-account request path (AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, and
 * M5's AC-5.4 / AC-5.5 brought forward with them).
 *
 * THE BUG THESE EXIST TO CATCH, stated once. Before this milestone
 * `refreshPromise` was a single module-level slot and `refreshAccessToken` wrote
 * into whichever session happened to be active. Switch A -> B while A's refresh
 * is in flight, B's first request 401s, the single-flight handler hands B back
 * A's promise, and A's fresh tokens land in B's slot. Both accounts corrupted,
 * no error, no log line, and it type-checks.
 *
 * Everything below runs against the REAL `client.ts` module singleton, the REAL
 * `authStore` and the REAL `refreshSession`. Only `fetch` is replaced. Mocking
 * any of the three would prove nothing: the defect lives in the interaction
 * between the refresh map, the entry-time capture and the store.
 */

let h: FetchHarness

beforeEach(() => {
  h = installFetchHarness()
})

afterEach(() => {
  seedSessions([])
  vi.unstubAllGlobals()
})

const bearer = (token: string) => `Bearer ${token}`
const sessionFor = (userId: string) =>
  useAuthStore.getState().sessions.find((s) => s.userId === userId)

describe('AC-5.5 / AC-5.4 — the ordered negative test', () => {
  /**
   * ==========================================================================
   * DO NOT REORDER THE TWO `rotate()` CALLS IN THIS TEST. B RESOLVES FIRST.
   * ==========================================================================
   *
   * The ordering is the criterion, not decoration. Resolve A's refresh FIRST and
   * the assertions below pass against the broken code too: A's promise is the
   * one B was handed, A's tokens are written while A is still active, and the
   * corruption is invisible. B-then-A is the order that only the fixed code
   * survives, and without it written down it is the version that gets built.
   *
   * THIS IS MEASURED, NOT ARGUED. At the gate-2 review the naive A-first variant
   * was written out — the same seeding, the same five assertions, the same
   * everything, with only the two `rotate()` calls swapped — and run against the
   * FULLY BROKEN implementation (one module-level `refreshPromise`, tokens
   * written into whichever session happened to be active). IT PASSED. Not
   * narrowly: every assertion in it was satisfied.
   *
   * WHY, mechanically, so the property can be reasoned about rather than
   * memorised. Under the broken code B's 401 is handed A's still-open
   * `refreshPromise` instead of starting B's own exchange. Resolve A first and
   * that shared promise settles with A's tokens WHILE A IS STILL THE SESSION
   * THEY BELONG TO, so the active-slot write puts A's tokens in A's slot — right
   * answer, wrong reason — and B's replay then goes out on a token that has not
   * yet been overwritten. Every assertion holds. Resolve B first and the same
   * shared promise settles with B's tokens into the ACTIVE slot, which the
   * switch has just made B's, and A's later resolution lands on top; the
   * corruption becomes visible at `sessions[A].accessToken` and at A's replay
   * header.
   *
   * SO: IF YOU FLIP THIS ORDER, this test stops being a proof and becomes a
   * decoration. It will still be green. It will still be green if the per-session
   * `refreshInFlight` map is deleted and replaced with a single module-level
   * promise — which is precisely the #1 ranked risk in the plan, the one this
   * whole milestone's request path exists to close. Nothing will tell you. The
   * ordering looks like an incidental detail of how the harness is driven, and
   * that is exactly why this comment is here and this long: it is the single
   * thing in this file that a well-intentioned tidy-up can silently destroy.
   *
   * The `until(...)` awaits between the two rotations are part of the ordering,
   * not scaffolding around it — they are what make "B has fully finished before
   * A resolves" true rather than merely likely.
   */
  it("resolves B's refresh, THEN A's, and each pair lands in its own session", async () => {
    const a = makeSession({ id: 'user-a', username: 'alice' })
    const b = makeSession({ id: 'user-b', username: 'bob' })
    seedSessions([a, b], a.userId)

    // A is active and issues a request. It 401s, so A starts a refresh — which
    // the harness parks. This is the "A's refresh is in flight" precondition.
    const aRequest = get('/a-thing')
    ;(await h.awaitCall('/a-thing')).respond(401)
    const aRefresh = await h.awaitRefresh(a.refreshToken)

    // The switch happens while A's refresh is still open.
    useAuthStore.getState().switchTo(b.userId)

    // B issues a request. Post-switch 401s are the common case: access tokens
    // live an hour, so a backgrounded account is almost always stale.
    const bRequest = get('/b-thing')
    ;(await h.awaitCall('/b-thing')).respond(401)
    const bRefresh = await h.awaitRefresh(b.refreshToken)

    // The map is keyed by userId, so these are two different exchanges. Under
    // the old single module-level slot they would have been the same promise.
    expect(bRefresh).not.toBe(aRefresh)
    expect(aRefresh.refreshToken).toBe(a.refreshToken)
    expect(bRefresh.refreshToken).toBe(b.refreshToken)

    // B resolves first...
    const bAccess2 = 'b-access-2'
    bRefresh.rotate(bAccess2, 'b-refresh-2')
    const bReplay = await until(
      () => h.calls.filter((c) => c.path === '/b-thing')[1],
      "B's replay",
    )
    bReplay.ok({ ok: true })
    await bRequest

    // ...and only THEN does A's, into a session that has been in the background
    // for the whole exchange.
    const aAccess2 = 'a-access-2'
    aRefresh.rotate(aAccess2, 'a-refresh-2')
    const aReplay = await until(
      () => h.calls.filter((c) => c.path === '/a-thing')[1],
      "A's replay",
    )

    // The sharpest assertion in the file: A's retry carries A's NEW token. It
    // did not re-read the mirror (which holds B's), and it did not re-use the
    // stale token it was issued with.
    expect(aReplay.authorization).toBe(bearer(aAccess2))
    expect(bReplay.authorization).toBe(bearer(bAccess2))

    aReplay.ok({ ok: true })
    await aRequest

    expect(sessionFor(a.userId)?.accessToken).toBe(aAccess2)
    expect(sessionFor(b.userId)?.accessToken).toBe(bAccess2)
    // The mirror follows the ACTIVE session and nothing else.
    expect(useAuthStore.getState().accessToken).toBe(bAccess2)
    expect(useAuthStore.getState().user?.id).toBe(b.userId)
  })

  it('answers a burst of post-switch 401s with exactly one refresh, for the issuing session only', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)
    useAuthStore.getState().switchTo(b.userId)

    // Clearing the query cache on a switch re-issues every visible query at
    // once, so the post-switch 401s arrive as a burst rather than one at a time.
    const burst = [1, 2, 3, 4, 5].map((n) => get(`/burst?n=${n}`))
    for (const n of [1, 2, 3, 4, 5]) {
      ;(await h.awaitCall(`/burst?n=${n}`)).respond(401)
    }
    await settle()

    // AC-2.3: single-flight WITHIN a session, and zero leakage across.
    expect(h.refreshCalls()).toHaveLength(1)
    expect(h.refreshCalls(b.refreshToken)).toHaveLength(1)
    expect(h.refreshCalls(a.refreshToken)).toHaveLength(0)

    const bAccess2 = 'b-access-2'
    h.refreshCalls(b.refreshToken)[0].rotate(bAccess2, 'b-refresh-2')

    for (const n of [1, 2, 3, 4, 5]) {
      const replay = await until(
        () => h.calls.filter((c) => c.path === `/burst?n=${n}`)[1],
        `replay ${n}`,
      )
      expect(replay.authorization).toBe(bearer(bAccess2))
      replay.ok({ ok: true })
    }
    await Promise.all(burst)

    // AC-2.3's second half: the burst wrote no tokens into any other session.
    expect(sessionFor(a.userId)?.accessToken).toBe(a.accessToken)
    expect(sessionFor(a.userId)?.refreshToken).toBe(a.refreshToken)
    expect(sessionFor(b.userId)?.accessToken).toBe(bAccess2)
  })
})

describe('AC-2.4 / AC-2.5 / AC-2.6 — a background account runs out of road', () => {
  /**
   * AC-2.4's own words: "Staleness is not the failure; misdirection is." A
   * request issued for A before a switch is legitimate — it must NOT be aborted
   * for predating the switch, it must still refresh and retry against A's own
   * session, and it must still be able to reach the scoped-logout branch.
   */
  it('refreshes, retries and then logs out ONLY the issuing session', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], b.userId)

    // Issued for B, captured at entry, before the switch.
    const backgrounded = get('/b-owned')
    const epochAtEntry = useAuthStore.getState().authEpoch
    useAuthStore.getState().switchTo(a.userId)
    expect(useAuthStore.getState().authEpoch).toBeGreaterThan(epochAtEntry)

    ;(await h.awaitCall('/b-owned')).respond(401)

    // Not aborted: the ladder still runs, for B, with B's refresh token.
    const refresh = await h.awaitRefresh(b.refreshToken)
    refresh.rotate('b-access-2', 'b-refresh-2')

    // The refresh landed in B's own slot even though B is no longer active —
    // AC-2.4's "a background account's in-flight refresh completes into its own
    // slot across a switch".
    await until(() => (sessionFor(b.userId)?.accessToken === 'b-access-2' ? true : undefined), "B's rotation")

    // Still 401 on the replay: B is genuinely dead.
    const replay = await until(() => h.calls.filter((c) => c.path === '/b-owned')[1], "B's replay")
    expect(replay.authorization).toBe(bearer('b-access-2'))
    replay.respond(401)

    await expect(backgrounded).rejects.toBeInstanceOf(ApiError)

    // AC-2.5: B is gone, A is untouched and still active.
    const state = useAuthStore.getState()
    expect(state.sessions.map((s) => s.userId)).toEqual([a.userId])
    expect(state.activeUserId).toBe(a.userId)
    expect(state.isAuthenticated).toBe(true)
    expect(state.accessToken).toBe(a.accessToken)

    // AC-2.4: the active-scoped half did not run — no banner over A.
    expect(state.error).toBeNull()
    // AC-2.6: PostLoginRedirect is not tripped while a session remains.
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBeNull()
  })

  /**
   * The mirror image, and the reason the guard is a guard rather than a blanket
   * suppression: when nothing has been switched, the epoch is current and the
   * user is told their session expired.
   */
  it('raises the banner when the dying session is the only one and no switch intervened', async () => {
    const a = makeSession({ id: 'user-a' })
    seedSessions([a], a.userId)

    const request = get('/only')
    ;(await h.awaitCall('/only')).respond(401)
    ;(await h.awaitRefresh(a.refreshToken)).rotate('a-access-2', 'a-refresh-2')
    ;(await until(() => h.calls.filter((c) => c.path === '/only')[1], 'the replay')).respond(401)

    await expect(request).rejects.toBeInstanceOf(ApiError)

    const state = useAuthStore.getState()
    expect(state.sessions).toEqual([])
    expect(state.isAuthenticated).toBe(false)
    expect(state.error).toBe('Your session has expired. Please sign in again.')
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBe(a.userId)
  })

  /**
   * RIDER C1 — THE ACTIVE ACCOUNT'S EXPIRY IS NOT SILENT.
   *
   * This is the probe from the gate-2 review, verbatim: A active, B backgrounded,
   * NO switch since the request was issued (so the epoch is current), and A's
   * refresh credential genuinely dead. Before the fix the scoped branch returned
   * before ever reaching the `error` write, so the `reason` handed in from
   * `client.ts:220` was discarded whenever another session remained — regardless
   * of epoch. The app silently became B: B's sidebar, B's projects, B's name,
   * with no banner, no toast and no log line. The likeliest reading for a real
   * user is that the app switched accounts by itself, or that their data is gone.
   *
   * AC-2.4 presumes this banner: it gates "the user-visible half only", which
   * only means something if the un-gated case raises it. This is the un-gated
   * case.
   */
  it('raises the banner over the ACTIVE account when another session remains and the epoch is current', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)
    const epochAtEntry = useAuthStore.getState().authEpoch

    // A is active and looking at A. No switch happens anywhere below, so every
    // epoch comparison in the ladder is against the epoch captured right here.
    const request = get('/a-owned')
    ;(await h.awaitCall('/a-owned')).respond(401)
    ;(await h.awaitRefresh(a.refreshToken)).rotate('a-access-2', 'a-refresh-2')
    ;(await until(() => h.calls.filter((c) => c.path === '/a-owned')[1], 'the replay')).respond(401)

    await expect(request).rejects.toBeInstanceOf(ApiError)

    const state = useAuthStore.getState()
    // The epoch really was current for the whole exchange — the fallback
    // switchTo is what bumps it, and it bumps it exactly once.
    expect(state.authEpoch).toBe(epochAtEntry + 1)

    // The re-point happened: A is gone, B is active and signed in.
    expect(state.sessions.map((s) => s.userId)).toEqual([b.userId])
    expect(state.activeUserId).toBe(b.userId)
    expect(state.isAuthenticated).toBe(true)

    // C1.1 — and the user is TOLD. This assertion is the whole rider.
    expect(state.error).toBe('Your session has expired. Please sign in again.')

    // C1.2 — LAST_LOGOUT_USER_KEY stays unwritten while any session remains.
    // AC-2.6 forbids it unconditionally, and "fix C1 by falling through into the
    // full-teardown path" is the wrong fix that this catches.
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBeNull()
  })

  /**
   * The dead session is the one the user is looking at (A -> B -> A: the request
   * predates two switches, but A is active again). The removal is unavoidable —
   * A's refresh token failed against the freshest token A had. What must NOT
   * happen is `activeUserId` left naming a session that no longer exists: the
   * mirror would go null and App.tsx would route to /login while B sits signed
   * in in the bag, which is exactly what AC-2.5 forbids.
   */
  it('re-points the active account when the removed session was the active one', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)

    const request = get('/a-owned')
    useAuthStore.getState().switchTo(b.userId)
    useAuthStore.getState().switchTo(a.userId)

    ;(await h.awaitCall('/a-owned')).respond(401)
    ;(await h.awaitRefresh(a.refreshToken)).rotate('a-access-2', 'a-refresh-2')
    ;(await until(() => h.calls.filter((c) => c.path === '/a-owned')[1], 'the replay')).respond(401)

    await expect(request).rejects.toBeInstanceOf(ApiError)

    const state = useAuthStore.getState()
    expect(state.sessions.map((s) => s.userId)).toEqual([b.userId])
    expect(state.activeUserId).toBe(b.userId)
    expect(state.isAuthenticated).toBe(true)
    expect(state.user?.id).toBe(b.userId)
    expect(state.accessToken).toBe(b.accessToken)
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBeNull()

    // C1.4's companion, and the reason C1 is a guard rather than a blanket
    // "always raise the banner". Two switches intervened, so this request's
    // epoch is stale and the user-visible half stays suppressed — AC-2.4's rule,
    // unchanged by C1. The re-point above still ran, because that half is never
    // epoch-gated.
    expect(state.error).toBeNull()
  })
})

describe('AC-2.2 / AC-2.10 — the token comes from the issuing session', () => {
  it('sends the session that was active AT ENTRY, not the one active at send time', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)

    const request = get('/captured')
    // The switch lands between capture and the response.
    useAuthStore.getState().switchTo(b.userId)

    const call = await h.awaitCall('/captured')
    expect(call.authorization).toBe(bearer(a.accessToken))
    call.ok({ ok: true })
    await request
  })

  it('omits Authorization entirely when nobody is signed in', async () => {
    seedSessions([])
    const request = get('/anon')
    const call = await h.awaitCall('/anon')
    expect(call.authorization).toBeNull()
    call.ok({ ok: true })
    await request
  })

  it('does not refresh-retry a 401 for a session that has since been logged out', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], b.userId)

    const request = get('/gone')
    // B signs out while its own request is in flight. The guard is
    // hasSession(ctx.userId) — "is THIS session still signed in" — so the ladder
    // stops rather than retrying a dead session against a live active one.
    useAuthStore.getState().logout(undefined, b.userId)
    ;(await h.awaitCall('/gone')).respond(401)

    await expect(request).rejects.toBeInstanceOf(ApiError)
    await settle()
    expect(h.refreshCalls()).toHaveLength(0)
    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([a.userId])
  })
})

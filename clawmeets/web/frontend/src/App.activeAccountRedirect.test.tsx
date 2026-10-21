import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'

/**
 * AC-3.2's RIDER — `ActiveAccountRedirect` (`App.tsx:88-100`), the involuntary
 * re-point that also has to move the URL.
 *
 * WHY THIS FILE EXISTS AND WHY IT MOUNTS THE WHOLE APP.
 *
 * `hooks/accountNavigation.test.tsx` covers the two DELIBERATE paths —
 * `useSwitchAccount()` owns (switch + navigate), `useLogout()` owns (end session
 * + navigate) — and on those paths the watcher is redundant BY DESIGN (followup
 * B22). It is not redundant on the third way `activeUserId` moves, and that path
 * is the whole reason the component was written: a BACKGROUND request for the
 * active account 401s, its refresh credential is genuinely dead, and
 * `authStore.logout(reason, userId, epoch)` removes that session and falls back
 * to a remaining one FROM INSIDE THE STORE. Nobody clicked anything. No hook is
 * in the call stack. There is nothing for a `renderHook` test to render.
 *
 * So the subject is not reachable by the technique the sibling file uses, and it
 * is not exported either — deliberately, since `AuthenticatedApp` is what wires
 * it to the router. The only honest way to assert on it is to mount the real
 * `<App/>` under a real router and read the real URL back out.
 *
 * WHAT IS AND IS NOT MOCKED. Only `api/websocket` (a jsdom `WebSocket` to
 * nowhere is noise, not fidelity) and `fetch`, which the shared harness parks.
 * `App`, the whole route table, `AppLayout`, `ProjectView`, the sidebar,
 * `queryClient`, `authStore`, its persist middleware, `client.ts`'s
 * refresh-and-retry ladder and `refreshSession` are ALL the shipped ones. The
 * mounted tree issues its own eight authenticated requests for the active
 * account, and the 401 driven below is one of THOSE — not a synthetic call this
 * file invents. That matters: "a background request 401s" is the premise, and a
 * hand-rolled `get()` would be this test asserting against its own setup.
 *
 * `<StrictMode>` matches `main.tsx`, which is not decoration here. The
 * watcher's memory is a `useRef` compared across effect runs, and StrictMode's
 * mount/unmount/remount double-fires exactly that effect — a ref-vs-state
 * mistake in it shows up here and nowhere else in the suite.
 */

vi.mock('./api/websocket', () => ({
  wsManager: {
    connectAsUser: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    onAny: vi.fn(() => () => {}),
    onConnect: vi.fn(() => () => {}),
  },
}))

import App from './App'
import { queryClient } from './queryClient'
import { useAuthStore, LAST_LOGOUT_USER_KEY, type Session } from './stores/authStore'
import { makeSession, seedSessions } from './test/authFixtures'
import { installFetchHarness, settle, type FetchHarness } from './test/fetchHarness'

let h: FetchHarness

/** The URL as the router sees it. A sibling of `<App/>` inside the SAME
 *  `MemoryRouter`, so it reads the genuine location rather than a `useNavigate`
 *  spy's argument. The distinction is the point of the file: a spy proves the
 *  watcher CALLED navigate, this proves the browser actually moved — and the
 *  failure this criterion exists to prevent is a URL, not a call. */
let path = ''
function LocationProbe() {
  path = useLocation().pathname
  return null
}

/**
 * A genuinely background poll. `useActiveWorkBootstrap` issues it from the
 * authenticated shell on mount; no component on screen is waiting for it and no
 * hook of ours is in its call stack when it comes back. It is the closest thing
 * in the app to the scenario in the component's own header comment.
 */
const BACKGROUND = '/me/active-work'

function mountAppAt(entry: string) {
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
}

/**
 * Run one background request all the way to the end of the ladder: 401, one
 * silent refresh, that refresh REJECTED (the credential is dead, not merely
 * stale), still 401 -> `logoutSession(ctx.userId, reason, ctx.epoch)`.
 *
 * Every step is the real `client.ts`. Nothing here calls `logout()` directly —
 * a test that did would prove the watcher reacts to a store write, which was
 * never in doubt, rather than that this PATH reaches it.
 */
async function backgroundCredentialDeath(session: Session): Promise<void> {
  const request = await h.awaitCall(BACKGROUND)
  request.respond(401, { detail: 'Not authenticated' })
  const refresh = await h.awaitRefresh(session.refreshToken)
  refresh.respond(401, { detail: 'Refresh token expired' })
  await settle()
}

beforeEach(() => {
  h = installFetchHarness()
  localStorage.clear()
  sessionStorage.clear()
  path = ''
})

afterEach(() => {
  // `globals: false` in vitest.config.ts means testing-library's auto-cleanup
  // never registers (followup B11). This tree mounts the ENTIRE app — a leaked
  // one keeps `useWebSocketConnection` subscribed to the auth store, and
  // `authStore.multiSession.test.ts` proves AC-2.12 by COUNTING that spy.
  cleanup()
  seedSessions([])
  queryClient.clear()
  vi.unstubAllGlobals()
})

describe("AC-3.2 rider — a background 401 moves the URL, not just the shell's identity", () => {
  /**
   * THE OUTCOME BEING MADE UNREACHABLE, concretely. A is active and the user is
   * looking at A's project. A's refresh credential dies on a poll nobody was
   * watching. The store drops A and falls back to B, so the shell re-renders as
   * B — B's sidebar, B's name — while the URL still names A's project. What is
   * then on screen is a spinner, then the flat grey "Project not found"
   * (`components/project/ProjectView.tsx:117-123`) once `retry: 1` has doubled
   * the wait, under somebody else's sidebar.
   *
   * NON-VACUOUS, MEASURED. With the single line `<ActiveAccountRedirect />`
   * deleted from `AuthenticatedApp`, this case reports
   * `expected '/projects/proj-a' to be '/desk'` — the URL sits on A's project
   * exactly as described above, and every other assertion in the case still
   * passes. That is the failure mode in one line of output.
   */
  it("drops the dead account, falls back to B, and lands the URL on B's own page", async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a, b], a.userId)

    mountAppAt('/projects/proj-a')
    await act(async () => {
      await settle()
    })
    // The premise: the shell really is A's, on A's project.
    expect(useAuthStore.getState().activeUserId).toBe(a.userId)
    expect(path).toBe('/projects/proj-a')

    await act(async () => {
      await backgroundCredentialDeath(a)
    })

    // The store did its half: A is gone, B is active, and RIDER C1's banner is
    // up because the account the user was LOOKING AT is the one that died.
    const state = useAuthStore.getState()
    expect(state.sessions.map((s) => s.userId)).toEqual([b.userId])
    expect(state.activeUserId).toBe(b.userId)
    expect(state.isAuthenticated).toBe(true)
    expect(state.error).toBe('Your session has expired. Please sign in again.')

    // ...and the URL did too. `/desk` rather than `/`: the watcher navigates to
    // '/', `LandingRedirect` is what '/' renders, and it sends an account WITH a
    // linked assistant to the desk (AC-4.6). Asserting the end of that chain
    // rather than its first step is deliberate — '/' is a redirect, not a
    // destination, and "the user ends up somewhere that belongs to B" is the
    // claim. Nothing here is A's.
    expect(path).toBe('/desk')

    // AC-2.6: a scoped death while another session remains is not a logout, so
    // the resume key stays unwritten and `PostLoginRedirect` is not tripped.
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBeNull()
  })

  /**
   * THE OTHER BOUND — SAME BACKGROUND-401 PATH, ONE FEWER SESSION. WHAT IT
   * PINS IS NARROWER THAN IT LOOKS, AND THE LIMIT IS STATED RATHER THAN LEFT
   * FOR SOMEBODY TO DISCOVER.
   *
   * The behaviour: when the LAST session dies the URL is left alone ON PURPOSE.
   * `logout()` writes LAST_LOGOUT_USER_KEY, `App` renders the unauthenticated
   * tree, and on a same-user re-login `PostLoginRedirect` (`App.tsx:44-53`)
   * resumes the page they were signed out of. Both halves are asserted below,
   * because either one alone is not the resume.
   *
   * THIS IS NOT A TEST OF THE WATCHER'S `activeUserId !== null` CLAUSE, and
   * saying otherwise would be the decoration this milestone keeps warning about.
   * MEASURED, by logging `(from, to)` inside the effect for both cases in this
   * file: on this path the watcher fires exactly twice, `user-a -> user-a` both
   * times (StrictMode's double mount), and NEVER observes `null`. `logout()`'s
   * writes land in one React batch, so `App` re-reads `isAuthenticated: false`
   * and unmounts `AuthenticatedApp` — watcher included — before any effect could
   * see the transition. Widening the guard to `from !== activeUserId` leaves
   * this case green; it was run.
   *
   * So the clause is structurally redundant UNDER TODAY'S COMPOSITION, in the
   * same sense B22 records for the deliberate paths, and it stops being
   * redundant the moment those writes are not batched or the watcher is hoisted
   * above `App`'s `isAuthenticated` branch. Keep it. What this case is worth is
   * the observable end state — after a background credential death that ends the
   * last account, the URL and the resume key both survive — which is exactly the
   * precondition `PostLoginRedirect` depends on and which nothing else asserts.
   */
  it('leaves the URL alone when that was the last session, so the login can resume it', async () => {
    const a = makeSession({ id: 'user-a' })
    seedSessions([a], a.userId)

    mountAppAt('/projects/proj-a')
    await act(async () => {
      await settle()
    })
    expect(path).toBe('/projects/proj-a')

    await act(async () => {
      await backgroundCredentialDeath(a)
    })

    const state = useAuthStore.getState()
    expect(state.sessions).toEqual([])
    expect(state.activeUserId).toBeNull()
    expect(state.isAuthenticated).toBe(false)

    // The URL survived the teardown, and the key that makes it useful was
    // written. Together they are the resume; either one alone is not.
    expect(path).toBe('/projects/proj-a')
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBe(a.userId)
  })
})

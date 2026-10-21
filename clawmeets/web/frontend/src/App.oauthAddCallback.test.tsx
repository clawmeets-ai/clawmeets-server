import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'

/**
 * AC-3.1 — CAN THE 'add'-MODE ROUND TRIP ACTUALLY LAND? (gate-3 finding F1.)
 *
 * WHY A ROUTE-LEVEL FILE EXISTS FOR A COMPONENT THAT ALREADY HAS TESTS.
 *
 * `components/auth/OAuthCallbackPage.test.tsx` covers the 'add' branch twice and
 * both cases are correct — but they `render(<OAuthCallbackPage />)` DIRECTLY,
 * with `useNavigate` and `useAuthStore` module-mocked. They assert what the
 * component does GIVEN THAT IT MOUNTED. Nothing in them, and nothing anywhere
 * else in the suite, asserted that anything could mount it.
 *
 * It could not. `/auth/callback` was registered only in `App`'s UNAUTHENTICATED
 * branch, and an 'add' is BY DEFINITION performed while authenticated: the user
 * has a session already, which is the thing the new account is being added to.
 * So the provider redirected the browser back into `AuthenticatedApp`'s
 * `<Routes>`, which has no `auth/callback` and no `*` fallback, and the round
 * trip ended on:
 *
 *   - a blank page — no route matched, nothing rendered;
 *   - no `POST /auth/oauth/exchange` — the single-use handoff code (~120s)
 *     discarded unused, so even a manual reload cannot recover it;
 *   - no second session, so the account was simply never added; and
 *   - `OAUTH_ADD_FLAG` still standing in `sessionStorage`, which outlives the
 *     failure for the life of the tab and turns the NEXT ordinary OAuth sign-in
 *     in it into a silent 'add'.
 *
 * The tell was inside the component test itself: `OAuthCallbackPage.test.tsx`
 * reasons "the user is authenticated, so App.tsx would bounce /login to '/'" —
 * correct reasoning about the authenticated tree, written about a component the
 * authenticated tree could not reach.
 *
 * THE GENERAL LESSON, because the fix is one line and the lesson is not. Every
 * coverage hole M5 named for itself was a hole in BEHAVIOUR UNDER TEST. This was
 * a hole in REACHABILITY, and a self-audit conducted by reading one's own tests
 * structurally cannot find that class: the tests are precisely where the wiring
 * is stubbed out. Only a test that mounts the real `<App/>` and lets the real
 * route table answer a URL can see it. The harness for that already existed
 * (`App.activeAccountRedirect.test.tsx`, ~250ms) — it had just never been
 * pointed here.
 *
 * WHAT IS AND IS NOT MOCKED — the same contract as the sibling file. Only
 * `api/websocket` (a jsdom `WebSocket` to nowhere is noise, not fidelity) and
 * `fetch`, which the shared harness parks. `App` and its whole route table,
 * `OAuthCallbackPage`, `LandingRedirect`, `ActiveAccountRedirect`, `authStore`
 * with its persist middleware, `switchTo`, `queryClient` and
 * `endpoints/auth.ts`'s real `exchangeOAuthCode` are ALL the shipped ones. The
 * exchange asserted below is the one the mounted tree issued for itself.
 *
 * NON-VACUOUS, MEASURED. With the `<Route path="auth/callback">` line deleted
 * from `AuthenticatedApp`, both cases report
 * `Error: timed out waiting for a pending /auth/oauth/exchange` — the exchange
 * is never issued, exactly as described above. That is the shipped bug in one
 * line of output.
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
import { useAuthStore } from './stores/authStore'
import { OAUTH_ADD_FLAG, OAUTH_LINKED_FLAG } from './components/auth/OAuthCallbackPage'
import { makeSession, payloadFor, seedSessions } from './test/authFixtures'
import { installFetchHarness, settle, type FetchHarness } from './test/fetchHarness'

let h: FetchHarness

const EXCHANGE = '/auth/oauth/exchange'

/**
 * The URL as the router sees it, plus the TRAIL of every path it passed
 * through. A sibling of `<App/>` inside the same `MemoryRouter`, so it reads the
 * genuine location rather than a `useNavigate` spy's argument — the failure this
 * criterion exists to prevent is a URL, not a call.
 *
 * The trail (rather than just the final value) is what pins the watcher
 * interaction in the `created` case below: it shows which navigate the router
 * actually COMMITTED, which is not the same question as which one was called.
 */
let path = ''
let trail: string[] = []
function LocationProbe() {
  path = useLocation().pathname
  if (trail[trail.length - 1] !== path) trail.push(path)
  return null
}

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

beforeEach(() => {
  h = installFetchHarness()
  localStorage.clear()
  sessionStorage.clear()
  path = ''
  trail = []
})

afterEach(() => {
  // followup B11 — `globals: false` means testing-library's auto-cleanup never
  // registers, and this tree mounts the ENTIRE app. Asserted suite-wide by
  // `src/test/suiteHygiene.test.ts`.
  cleanup()
  seedSessions([])
  queryClient.clear()
  vi.unstubAllGlobals()
})

describe("AC-3.1 — the 'add' round trip returns to a route that exists", () => {
  /**
   * THE WHOLE FLOW, END TO END, THROUGH THE REAL ROUTE TABLE.
   *
   * A is signed in and looking at their desk. They open "add an account", pick a
   * provider, `ProviderButtons` parks OAUTH_ADD_FLAG and hands the browser to
   * the provider; the provider hands it back to /app/auth/callback?code=…, which
   * is where this test starts — WHILE STILL AUTHENTICATED AS A. Everything after
   * `mountAppAt` is the app's own doing.
   */
  it('exchanges the code, adds B alongside A, clears the flag, and lands on B', async () => {
    const a = makeSession({ id: 'user-a' })
    const b = makeSession({ id: 'user-b' })
    seedSessions([a], a.userId)
    sessionStorage.setItem(OAUTH_ADD_FLAG, '1')

    mountAppAt('/auth/callback?code=handoff-abc&status=linked')

    // THE FINDING, INVERTED INTO AN ASSERTION: the route matched, the component
    // mounted, and it issued its exchange. This line is what times out against
    // the shipped bug.
    const exchange = await h.awaitCall(EXCHANGE)
    expect(exchange.method).toBe('POST')
    expect(exchange.body).toEqual({ code: 'handoff-abc' })
    // Exactly once, under StrictMode's double mount — the handoff code is
    // single-use, so a replay is a hard failure and not a retry.
    expect(h.calls.filter((c) => c.path === EXCHANGE)).toHaveLength(1)

    await act(async () => {
      exchange.ok(payloadFor(b))
      await settle()
    })

    // 'add', NOT 'replace': A is still there. This is the criterion's own words
    // and the reason the flag has to survive the round trip at all.
    const state = useAuthStore.getState()
    expect(state.sessions.map((s) => s.userId)).toEqual([a.userId, b.userId])
    expect(state.activeUserId).toBe(b.userId)
    expect(state.isAuthenticated).toBe(true)
    // A's credentials came through untouched — an add is not a clobber.
    expect(state.sessions[0].accessToken).toBe(a.accessToken)
    expect(state.sessions[0].refreshToken).toBe(a.refreshToken)
    // ...and the mirror is B's, derived by syncActive() rather than written.
    expect(state.accessToken).toBe(b.accessToken)
    expect(state.user?.id).toBe(b.userId)

    // Read-and-cleared. A flag left standing outlives this tab's next sign-in
    // and turns it into a silent add — the second half of what the missing
    // route cost.
    expect(sessionStorage.getItem(OAUTH_ADD_FLAG)).toBeNull()

    // The URL ends somewhere belonging to B. `/desk` rather than `/`: the
    // component navigates to '/', `LandingRedirect` is what '/' renders, and it
    // sends an account WITH a linked assistant to the desk (AC-4.6). Asserting
    // the end of the chain rather than its first step is deliberate — '/' is a
    // redirect, not a destination.
    expect(path).toBe('/desk')
    expect(trail).toEqual(['/auth/callback', '/', '/desk'])

    // status=linked's one-time reassurance made it all the way ONTO THE SCREEN,
    // under B's shell. Asserted as rendered text rather than as the raw flag,
    // because by now the flag is correctly GONE: `OAuthLinkedBanner`
    // (mounted by `AppLayout`, which only exists in the authenticated tree)
    // read-and-clears it on its first render. Reading the key here would assert
    // that the banner had NOT yet run — the opposite of the intended outcome,
    // and a mistake this test made on its first draft.
    expect(sessionStorage.getItem(OAUTH_LINKED_FLAG)).toBeNull()
    expect(
      screen.getByText('Your account is now linked for one-click sign-in.'),
    ).toBeTruthy()
  })

  /**
   * THE WATCHER INTERACTION, PINNED RATHER THAN ASSUMED.
   *
   * Putting `auth/callback` in the authenticated tree means
   * `ActiveAccountRedirect` (`App.tsx:88-100`) is MOUNTED during the exchange —
   * which it was not before, because nothing of the authenticated tree was. So
   * `setSession(payload, 'add')` -> `switchTo` moves `activeUserId` non-null ->
   * non-null and the watcher fires, navigating '/' AFTER `OAuthCallbackPage`'s
   * own navigate has already landed.
   *
   * For `status=linked` above that is invisible: both go to '/'. For
   * `status=created` it is not — the component sends a brand-new account to
   * `/welcome` and the watcher overrides it with '/'. That is SAFE rather than
   * merely tolerated: '/' is `LandingRedirect`, and an account with no linked
   * assistant is sent straight back to `/welcome` (AC-4.6). It self-corrects.
   *
   * "Self-corrects" is a claim about a SEQUENCE, so the trail is asserted and
   * not just the destination — and the measured trail is
   * `['/auth/callback', '/', '/welcome']`, with the component's own `/welcome`
   * never appearing. That is not a missing step: both navigates land inside one
   * React batch, so the router commits only the last of them and the probe never
   * renders against the intermediate value. Logging `(from, to)` inside the
   * watcher and the page's navigate confirms the order is
   * `[PAGE] -> /welcome`, then `[WATCHER] user-a -> user-b`, then `/` — i.e. the
   * page really does go first and really is overridden.
   *
   * Which makes the honest statement stronger than "it self-corrects": for a
   * brand-new account, `OAuthCallbackPage`'s `/welcome` is ENTIRELY discarded and
   * `LandingRedirect` is the SOLE reason onboarding is reached. If a future
   * change stops it catching this — a different landing rule, an assistant-id
   * read that becomes async — nothing else is behind it, and a brand-new account
   * silently skips onboarding. This case is where that surfaces.
   */
  it("a brand-new account still reaches onboarding, though the watcher overrides it first", async () => {
    const a = makeSession({ id: 'user-a' })
    // No linked assistant — a freshly provisioned account, AC-4.6's subject.
    const b = makeSession({ id: 'user-b', assistantAgentId: null })
    seedSessions([a], a.userId)
    sessionStorage.setItem(OAUTH_ADD_FLAG, '1')

    mountAppAt('/auth/callback?code=handoff-new&status=created')

    const exchange = await h.awaitCall(EXCHANGE)
    await act(async () => {
      exchange.ok(payloadFor(b))
      await settle()
    })

    expect(useAuthStore.getState().activeUserId).toBe(b.userId)
    expect(useAuthStore.getState().sessions).toHaveLength(2)
    // status=created is NOT a link, so no reassurance flag.
    expect(sessionStorage.getItem(OAUTH_LINKED_FLAG)).toBeNull()

    // The destination.
    expect(path).toBe('/welcome')
    // ...and the sequence that got there: the watcher's '/' is what the router
    // committed, and `LandingRedirect` is what turned it back into onboarding.
    expect(trail).toEqual(['/auth/callback', '/', '/welcome'])
  })
})

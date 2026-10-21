/**
 * The shared auth fixture module (AC-5.6 / plan §2).
 *
 * Nothing shared existed before this: nineteen test files each rolled their own
 * auth seed, and the four worst of them seeded by writing the MIRROR
 * (`useAuthStore.setState({ accessToken, user, isAuthenticated })`). Once
 * `syncActive()` derives the mirror from `sessions[activeUserId]`, such a
 * fixture builds a state production can never reach: there is no session behind
 * it, `bearerFor()` returns null, every request goes out with NO Authorization
 * header at all, and the next `syncActive()` silently reverts the write. A
 * fixture the code under test can undo is worse than no fixture.
 *
 * So: build a `Session`, and install it through the SAME action the login page
 * and the OAuth exchange use. `seedSessions` never touches the mirror.
 *
 * Brought forward from M5 into M2 because M2's own criteria (AC-2.3, AC-2.4,
 * AC-2.12) each read "tests prove ..." and those tests need it now. The M5
 * sweep of the remaining files (AC-5.6) still lands in M5.
 */

import type { LoginResponse, User } from '../types'
import { useAuthStore, LAST_LOGOUT_USER_KEY, type Session } from '../stores/authStore'

/** Makes every minted token distinguishable even when two are minted for the
 *  same subject in the same second — the AC-5.5 assertions are "A's session
 *  holds A's NEW token", which is unprovable if old and new are equal strings. */
let mintCounter = 0

function base64url(json: string): string {
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A JWT-SHAPED string carrying a real `exp`, in the same base64url spelling the
 * server emits. Not signed and never verified — `decodeExp` reads one claim out
 * of an already-trusted token and does no signature check.
 *
 * The `exp` is load-bearing: a fixture token that will not decode gets
 * `accessExpiresAt = 0` from `decodeExp`, and every seeded session then renders
 * as expired.
 */
export function mintToken(spec: { sub: string; kind?: string; ttlSeconds?: number }): string {
  const { sub, kind = 'access', ttlSeconds = 3600 } = spec
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      sub,
      kind,
      jti: `${sub}-${kind}-${++mintCounter}`,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  )
  return `${header}.${payload}.not-a-signature`
}

export interface SessionSpec {
  id: string
  username?: string
  /** `null` means the account has NO linked assistant — a freshly-created one,
   *  and AC-4.6's whole subject. It has to be distinguishable from `undefined`:
   *  a default parameter cannot express "explicitly none", so passing
   *  `undefined` would silently hand back the default `${id}-assistant` and the
   *  test would be asserting on the opposite of what it seeded. */
  assistantAgentId?: string | null
  /** Access tokens live 1 h on the server; refresh tokens 30 d. */
  accessTtlSeconds?: number
  refreshTtlSeconds?: number
}

/**
 * Describe one signed-in account. The returned object is a real `Session`, so a
 * test can assert against `spec.accessToken` directly.
 *
 * One field does NOT survive installation: `user.created_at`. `LoginResponse`
 * carries none and `sessionFrom()` synthesises it at hydration, which is
 * production behaviour and not something a fixture should paper over. Assert on
 * `userId`, the tokens and `username`; read anything else back out of
 * `listSessions()`.
 */
export function makeSession(spec: SessionSpec): Session {
  const {
    id,
    username = id,
    accessTtlSeconds = 3600,
    refreshTtlSeconds = 30 * 24 * 3600,
  } = spec
  // NOT a default parameter, deliberately — see SessionSpec.assistantAgentId.
  // `null` has to survive as "none" all the way to `User.assistant_agent_id`,
  // where `undefined` is the shape `sessionFrom()` produces in production for a
  // payload whose `assistant_agent_id` was null.
  const assistantAgentId =
    spec.assistantAgentId === undefined ? `${id}-assistant` : (spec.assistantAgentId ?? undefined)
  const accessToken = mintToken({ sub: id, kind: 'access', ttlSeconds: accessTtlSeconds })
  const refreshToken = mintToken({ sub: id, kind: 'refresh', ttlSeconds: refreshTtlSeconds })
  const user: User = {
    id,
    username,
    assistant_agent_id: assistantAgentId,
    created_at: '2026-01-01T00:00:00Z',
  }
  return {
    userId: id,
    accessToken,
    refreshToken,
    user,
    accessExpiresAt: Date.now() + accessTtlSeconds * 1000,
    refreshExpiresAt: Date.now() + refreshTtlSeconds * 1000,
  }
}

/** The `/auth/login`-shaped payload for a Session — the one thing the store
 *  accepts. Also what an OAuth exchange returns, byte for byte. */
export function payloadFor(session: Session): LoginResponse {
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    user: {
      id: session.user.id,
      username: session.user.username,
    },
    assistant_agent_id: session.user.assistant_agent_id ?? null,
    assistant_agent_name: `${session.user.username}-assistant`,
  }
}

/**
 * Install exactly these sessions and make `activeUserId` active, hydrating each
 * one through `setSession` — the real path, never a mirror write.
 *
 * Starts with a full `logout()` so nothing leaks between cases. That matters
 * more than it used to: `stores/authStore.test.ts`'s own `beforeEach` resets the
 * mirror and never `sessions` / `activeUserId`, so session state DOES leak
 * between cases in that file today (followup B7 — M5's AC-5.6 sweep is its fix,
 * and adjusting it now would be adjusting a test to pass).
 *
 * `logout()` writes LAST_LOGOUT_USER_KEY, which `PostLoginRedirect` reads and
 * AC-2.6 is about; clearing it here means a test asserting "the switch did not
 * write it" is asserting on its own subject and not on its own setup.
 *
 * Each 'add' routes through `switchTo`, so `authEpoch` is non-zero after
 * seeding. That is correct — it is what N real logins do — and no assertion
 * should read an absolute epoch value.
 */
export function seedSessions(sessions: Session[], activeUserId?: string): void {
  const store = useAuthStore.getState()
  store.logout()
  sessions.forEach((session, i) => {
    useAuthStore.getState().setSession(payloadFor(session), i === 0 ? 'replace' : 'add')
  })
  if (activeUserId) {
    useAuthStore.getState().switchTo(activeUserId)
  }
  sessionStorage.removeItem(LAST_LOGOUT_USER_KEY)
}

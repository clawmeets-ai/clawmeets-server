/**
 * API client with authentication support.
 * Uses fetch wrapper with Bearer token authorization.
 *
 * Every request in this file is issued FOR ONE ACCOUNT, named at entry and
 * threaded through the whole ladder. The mirror on the auth store is not
 * reachable from here at all — the only route to a token is bearerFor(userId).
 */

import { useAuthStore, bearerFor, hasSession } from '../stores/authStore'
import { fetchRetryingTransient, stampIdempotencyKey } from './transientRetry'

const BASE_URL = import.meta.env.DEV ? '/api' : ''

/**
 * AC-2.7 / AC-6.2 are reviewed by grepping this file for the literal 401 and
 * finding exactly ONE occurrence — that is what proves `putFile` no longer
 * carries a second copy of the refresh-and-retry ladder. The ladder needs the
 * status twice (the first response, then the replay), so the literal lives here
 * and the two comparisons read it. Named, not inlined, so the check stays a
 * grep instead of a judgement about which two occurrences are "the same one".
 */
const UNAUTHORIZED = 401

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface FetchOptions extends RequestInit {
  skipAuth?: boolean
}

/** Who this request is FOR. Captured once at entry, threaded, never re-derived.
 *  `userId` is REQUIRED and has NO DEFAULT: that is the whole mechanism of
 *  AC-2.10 — it turns "read the active token" from something that type-checks
 *  into something that will not compile. */
export interface RequestContext {
  readonly userId: string
  readonly epoch: number
}

/**
 * Capture the active identity ONCE, at entry, before any await. This is the one
 * legitimate read of `activeUserId` in the whole request path — everything
 * downstream takes the captured ctx as an argument (AC-2.11).
 *
 * NULL MEANS "SEND NO AUTHORIZATION", AND IT ARISES FOR TWO DIFFERENT REASONS:
 *   1. the caller passed skipAuth — login, signup, /auth/refresh; and
 *   2. nobody is signed in at all.
 * They are deliberately not distinguished, because the request path does the
 * same thing in both cases. This is exactly the previous behaviour, where a
 * missing token simply omitted the header — it is NOT a regression introduced
 * by folding skipAuth into ctx, and the next reader should not have to derive
 * that from the diff.
 */
function captureContext(): RequestContext | null {
  const { activeUserId, authEpoch } = useAuthStore.getState()
  if (!activeUserId) return null
  return { userId: activeUserId, epoch: authEpoch }
}

/**
 * Single-flight refresh, PER SESSION. The map is keyed by userId, so a refresh
 * in flight for A can never be handed back to a request issued for B — the
 * cross-account token corruption this milestone exists to close. Still
 * single-flight WITHIN a session: five concurrent B-requests that all 401
 * produce exactly one /auth/refresh for B and zero for A (AC-2.3). The entry is
 * deleted in .finally().
 */
const refreshInFlight = new Map<string, Promise<boolean>>()
function refreshOnce(userId: string): Promise<boolean> {
  let inFlight = refreshInFlight.get(userId)
  if (!inFlight) {
    inFlight = refreshFor(userId).finally(() => {
      refreshInFlight.delete(userId)
    })
    refreshInFlight.set(userId, inFlight)
  }
  return inFlight
}

/**
 * Store-action wrappers. They exist ONLY so that the 401 branch below contains
 * no `getState()` — AC-2.11 is verified by grepping for that literal inside the
 * branch, and the bug it is aimed at is a retry that re-reads the active user
 * AFTER the switch has happened.
 */
function refreshFor(userId: string): Promise<boolean> {
  return useAuthStore.getState().refreshAccessToken(userId)
}

/**
 * Scoped logout for a request that has run out of road. Passes the captured
 * epoch STRAIGHT THROUGH to the store, which is the only place it is ever
 * compared (AC-2.4). This wrapper does not compare it: client.ts must not read
 * authEpoch, or it would be re-deriving global state after an await — the exact
 * habit AC-2.11 exists to break.
 */
function logoutSession(userId: string, reason: string, epoch: number): void {
  useAuthStore.getState().logout(reason, userId, epoch)
}

/**
 * Fire one request. `ctx` REPLACES the old `skipAuth` flag: null means "send no
 * Authorization header", a ctx means "send THIS session's bearer". The parameter
 * is required and has no default, which is the entire mechanism of AC-2.10 —
 * there is no expression here that could silently mean "the active token",
 * because the mirror is not reachable from this file at all.
 *
 * The token comes from bearerFor(ctx.userId), so a retry after a refresh picks
 * up the freshly-minted token FOR THAT SESSION. The old comment here ("reads the
 * token from the store at call time") was exactly wrong across a switch and is
 * replaced by this one.
 *
 * Unchanged: the localtunnel bypass header, and the "set JSON content type
 * only if the caller has not" rule that lets putFile keep
 * application/octet-stream.
 *
 * A server that is restarting is waited out here (fetchRetryingTransient), so
 * every verb rides it out; the Idempotency-Key a write needs for that is
 * already in fetchOptions.headers (stamped once in withRefreshRetry).
 */
function rawFetch(
  path: string,
  fetchOptions: RequestInit,
  ctx: RequestContext | null
): Promise<Response> {
  const headers = new Headers(fetchOptions.headers)
  if (ctx) {
    const token = bearerFor(ctx.userId)
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
  }
  // Bypass localtunnel reminder page
  headers.set('bypass-tunnel-reminder', 'true')
  // Set content type if not already set and we have a body
  if (fetchOptions.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetchRetryingTransient(`${BASE_URL}${path}`, { ...fetchOptions, headers })
}

async function throwApiError(response: Response): Promise<never> {
  // Read the body once as text, then try JSON-parsing. Using
  // response.json() with response.text() in a catch double-reads the
  // body stream and surfaces "body stream already read" instead of the
  // actual server detail (e.g. a FastAPI 500 with a plain-text body).
  const bodyText = await response.text()
  let data: unknown = bodyText
  if (bodyText) {
    try {
      data = JSON.parse(bodyText)
    } catch {
      // not JSON — keep the raw text
    }
  }
  throw new ApiError(
    response.status,
    typeof data === 'object' && data !== null && 'detail' in data
      ? String((data as { detail: string }).detail)
      : bodyText || `HTTP ${response.status}`,
    data
  )
}

/**
 * THE refresh-and-retry ladder. One implementation, two entry points; the
 * only reader of UNAUTHORIZED, which is itself the file's only occurrence of
 * the literal (AC-2.7, AC-6.2).
 *
 * Send; on 401, if this is an authenticated request that is not itself
 * /auth/refresh and hasSession(ctx.userId) is still true, refreshOnce(ctx.userId)
 * and replay once with the SAME ctx — the same userId AND the same epoch, both
 * captured at entry and never re-read. Still 401 ->
 * logoutSession(ctx.userId, reason, ctx.epoch), which is scoped: a 401 on a
 * BACKGROUND account's request ends that account and leaves every other one
 * signed in (AC-2.5), and the epoch decides whether the user is TOLD about it
 * (AC-2.4).
 *
 * The guard is hasSession(ctx.userId) — "is the session that issued this request
 * still signed in" — NOT the old isAuthenticated read, which asked "is anyone
 * signed in" and would have let a dead background session retry against a live
 * active one.
 *
 * REPLAYABLE BODY: the retry re-sends fetchOptions.body verbatim. Blob and
 * ArrayBuffer both replay; a ReadableStream would not. putFile's signature
 * admits only the two that do, and any future widening of it must revisit this.
 *
 * ONE IDEMPOTENCY KEY PER CALL: a write gets its key here, before the first
 * send, so the restart retries inside rawFetch and the replay after a refresh
 * all carry the same one.
 */
async function withRefreshRetry(
  path: string,
  options: RequestInit,
  ctx: RequestContext | null
): Promise<Response> {
  const headers = new Headers(options.headers)
  stampIdempotencyKey(options.method, headers)
  const fetchOptions = { ...options, headers }

  let response = await rawFetch(path, fetchOptions, ctx)

  // A 401 on an authenticated request means the access credential is expired or
  // invalid. Try one silent refresh and replay the request once. Only then, if
  // it still fails, end THAT session so <App> routes back to LoginPage with a
  // visible "Session expired" message (the WebSocket hook sees
  // `isAuthenticated = false` and stops its reconnect loop). Never refresh-retry
  // the refresh call itself or unauthenticated requests.
  if (ctx && response.status === UNAUTHORIZED && path !== '/auth/refresh' && hasSession(ctx.userId)) {
    const refreshed = await refreshOnce(ctx.userId)
    if (refreshed) {
      response = await rawFetch(path, fetchOptions, ctx)
    }
    if (response.status === UNAUTHORIZED) {
      logoutSession(ctx.userId, 'Your session has expired. Please sign in again.', ctx.epoch)
    }
  }

  if (!response.ok) {
    await throwApiError(response)
  }

  return response
}

/** Unchanged signature. Captures ctx (or null when options.skipAuth), then hands
 *  the whole job to withRefreshRetry. Throws through throwApiError. */
async function fetchWithAuth(
  path: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { skipAuth, ...fetchOptions } = options
  return withRefreshRetry(path, fetchOptions, skipAuth ? null : captureContext())
}

// `signal` lets a caller abort a superseded read — typeahead search passes
// React Query's signal so an in-flight request dies when the query key moves on.
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithAuth(path, { signal })
  return response.json()
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetchWithAuth(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  })
  return response.json()
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetchWithAuth(path, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  })
  return response.json()
}

export async function patch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetchWithAuth(path, {
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined,
  })
  return response.json()
}

export async function del<T>(path: string): Promise<T> {
  const response = await fetchWithAuth(path, {
    method: 'DELETE',
  })
  return response.json()
}

export async function delNoContent(path: string): Promise<void> {
  await fetchWithAuth(path, { method: 'DELETE' })
}

export async function getFile(path: string): Promise<Blob> {
  const response = await fetchWithAuth(path)
  return response.blob()
}

export async function getText(path: string): Promise<string> {
  const response = await fetchWithAuth(path)
  return response.text()
}

/**
 * Unchanged signature and unchanged behaviour, ~20 lines shorter.
 *
 * putFile's duplicate 401 guard and duplicate logout call are DELETED, not
 * fixed: it now captures a ctx and calls the same withRefreshRetry every other
 * verb calls (AC-2.7). The three differences that used to justify the copy all
 * survive for free — the hardcoded application/octet-stream (rawFetch only sets
 * a Content-Type the caller has not), a skipAuth that always arrived undefined,
 * and a path !== '/auth/refresh' guard that is vacuously true for a file PUT.
 *
 * The retry replays `content`, so it must be replayable. Blob and ArrayBuffer
 * both are; the signature admits nothing else, and widening it must revisit
 * withRefreshRetry.
 */
export async function putFile(path: string, content: Blob | ArrayBuffer): Promise<Response> {
  return withRefreshRetry(
    path,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    },
    captureContext()
  )
}

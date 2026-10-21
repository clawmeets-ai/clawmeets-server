/**
 * The deferred fetch harness (plan §11, priced at 0.25d and named there as "the
 * single hardest thing in M5"; brought forward to M2 with the tests that need
 * it).
 *
 * WHY DEFERRED AND NOT JUST STUBBED. AC-5.5 is an ORDERING criterion: hold A's
 * `/auth/refresh` open, switch to B, let B's 401 and B's refresh happen and
 * resolve, and only THEN resolve A's. A stub that answers immediately — which is
 * what `api/chatroomsBatch.test.tsx` does — cannot express "still in flight",
 * and the A-resolves-first ordering it produces passes trivially against the
 * broken code. So NOTHING here answers on its own. Every `fetch()` parks as a
 * `PendingCall` and the test says when, and with what, it comes back.
 *
 * This runs against the REAL module-singleton `api/client.ts` and the REAL
 * `authStore` — the `refreshInFlight` map, `captureContext()` and the ladder are
 * all the shipped ones. `fetch` is the only thing replaced, which is the whole
 * point: the bug being tested for lives in the interaction between the map, the
 * capture and the store, and any of those three mocked away would prove nothing.
 */

import { vi } from 'vitest'

/** The `/api` prefix `client.ts` and `endpoints/auth.ts` both prepend in DEV. */
const BASE_URL = '/api'

/** One in-flight request, parked until the test answers it. */
export class PendingCall {
  settled = false

  constructor(
    /** BASE_URL-stripped, query string included. */
    readonly path: string,
    readonly method: string,
    /** The `Authorization` header as sent — null when none was attached. This
     *  is the assertion that catches a request resolving its token from the
     *  mirror instead of from its own session. */
    readonly authorization: string | null,
    readonly body: unknown,
    /** For `/auth/refresh`: the refresh token presented, i.e. WHICH session is
     *  refreshing. null for every other path. */
    readonly refreshToken: string | null,
    private readonly deliver: (response: Response) => void,
    private readonly fail: (error: Error) => void,
  ) {}

  /** Answer with this status. */
  respond(status: number, body: unknown = {}): void {
    this.finish(() =>
      this.deliver(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
  }

  ok(body: unknown = {}): void {
    this.respond(200, body)
  }

  /** Answer a `/auth/refresh` with a fresh pair, in the server's own shape. */
  rotate(accessToken: string, refreshToken: string): void {
    this.ok({ access_token: accessToken, refresh_token: refreshToken })
  }

  /** Reject the fetch itself — the network is down, not the server. */
  networkError(message = 'network down'): void {
    this.finish(() => this.fail(new Error(message)))
  }

  private finish(send: () => void): void {
    if (this.settled) throw new Error(`${this.method} ${this.path} was already answered`)
    this.settled = true
    send()
  }
}

export class FetchHarness {
  /** Every call ever made, in issue order, answered or not. */
  readonly calls: PendingCall[] = []

  /** Calls for `path` that are still parked, oldest first. */
  pendingFor(path: string): PendingCall[] {
    return this.calls.filter((c) => c.path === path && !c.settled)
  }

  /** The oldest parked call for `path`. Throws rather than returning undefined:
   *  a test that answers a request which was never issued has already failed,
   *  and it should say so at the answering line. */
  pending(path: string): PendingCall {
    const call = this.pendingFor(path)[0]
    if (!call) {
      throw new Error(
        `no pending ${path}; calls so far: ${this.calls.map((c) => `${c.path}${c.settled ? '' : ' (pending)'}`).join(', ') || '(none)'}`,
      )
    }
    return call
  }

  /** Every `/auth/refresh` issued so far, answered or not. The count IS the
   *  single-flight assertion (AC-2.3). */
  refreshCalls(refreshToken?: string): PendingCall[] {
    return this.calls.filter(
      (c) => c.path === '/auth/refresh' && (refreshToken === undefined || c.refreshToken === refreshToken),
    )
  }

  /** The parked `/auth/refresh` presenting THIS refresh token — i.e. this
   *  session's, not "the" refresh. Waits for it to be issued. */
  async awaitRefresh(refreshToken: string): Promise<PendingCall> {
    return until(
      () => this.refreshCalls(refreshToken).find((c) => !c.settled),
      `a pending /auth/refresh presenting ${refreshToken.slice(0, 24)}…`,
    )
  }

  /** Wait for a request to `path` to be issued and park. */
  async awaitCall(path: string): Promise<PendingCall> {
    return until(() => this.pendingFor(path)[0], `a pending ${path}`)
  }

  /** Answer every parked call for `path`, oldest first — the burst case. */
  respondAll(path: string, status: number, body: unknown = {}): number {
    const parked = this.pendingFor(path)
    parked.forEach((c) => c.respond(status, body))
    return parked.length
  }
}

/**
 * Replace `fetch` for the duration of a test. Returns the harness; call
 * `vi.unstubAllGlobals()` in `afterEach`.
 */
export function installFetchHarness(): FetchHarness {
  const harness = new FetchHarness()

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url
    const headers = new Headers(init?.headers)
    const bodyText = typeof init?.body === 'string' ? init.body : null

    let body: unknown = bodyText
    if (bodyText) {
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = bodyText
      }
    }

    // `refreshSession` posts {refresh_token}. Reading it back is how the harness
    // knows WHICH session a refresh belongs to — there is no other discriminator
    // on the wire, and "which session" is the entire subject of AC-2.3.
    const refreshToken =
      path === '/auth/refresh' && body && typeof body === 'object' && 'refresh_token' in body
        ? String((body as { refresh_token: unknown }).refresh_token)
        : null

    return new Promise<Response>((resolve, reject) => {
      harness.calls.push(
        new PendingCall(
          path,
          (init?.method ?? 'GET').toUpperCase(),
          headers.get('Authorization'),
          body,
          refreshToken,
          resolve,
          reject,
        ),
      )
    })
  })

  return harness
}

/**
 * Poll a predicate across macrotask ticks.
 *
 * The ladder is several awaits deep (fetch -> refreshOnce -> refreshAccessToken
 * -> refreshSession -> fetch -> replay), so "the next request has been issued"
 * is not reachable by a fixed number of microtask flushes. Ticking a real
 * zero-delay timer drains the whole microtask queue between attempts and keeps
 * the tests free of magic flush counts.
 */
export async function until<T>(probe: () => T | undefined, what: string, ticks = 200): Promise<T> {
  for (let i = 0; i < ticks; i++) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Let every already-queued continuation run. For asserting a NEGATIVE — that
 *  nothing further was issued — where there is no state to poll for. */
export async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

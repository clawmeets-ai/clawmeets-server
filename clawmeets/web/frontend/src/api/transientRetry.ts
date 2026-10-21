/**
 * Ride out a server restart: a request that finds the server unreachable is
 * retried with jittered backoff instead of failing, and every write carries an
 * Idempotency-Key so a retry of a write that DID land is answered from the
 * server's record (server/idempotency.py) instead of being applied twice.
 *
 * The browser twin of clawmeets/api/retry_transport.py — same rule, same budget:
 *
 * - Retried: fetch rejecting with a network error (connection refused, reset,
 *   dropped mid-response), and 502 / 503 / 504 whose body is NOT JSON. A
 *   restart shows up as nginx's HTML error page; the app's own 5xx are JSON
 *   ({"detail": ...}) and mean something a retry would only delay.
 * - Never retried: an abort (the caller moved on), any other status.
 * - Budget: 60 s in total, full-jitter backoff capped at 8 s per wait. After it
 *   the last error is thrown, or the last response returned, exactly as the
 *   caller would have seen it without retries.
 *
 * While any request is between attempts, `isServerRetrying()` is true, so the
 * UI can say "reconnecting" instead of looking frozen.
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const RETRY_STATUSES = new Set([502, 503, 504])

export interface RetryPolicy {
  budgetMs: number
  baseMs: number
  capMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { budgetMs: 60_000, baseMs: 500, capMs: 8_000 }

/** Give a write that has no key one, so every retry of it is safe. Mutates
 *  `headers`; the caller builds them once per call and reuses them on every
 *  attempt, which is what keeps the key stable across retries. */
export function stampIdempotencyKey(method: string | undefined, headers: Headers): void {
  if (!SAFE_METHODS.has((method ?? 'GET').toUpperCase()) && !headers.has(IDEMPOTENCY_HEADER)) {
    headers.set(IDEMPOTENCY_HEADER, crypto.randomUUID())
  }
}

function isRetryableResponse(response: Response): boolean {
  if (!RETRY_STATUSES.has(response.status)) return false
  return !(response.headers.get('content-type') ?? '').startsWith('application/json')
}

/** fetch rejects with a TypeError for every network-level failure; an abort is
 *  a DOMException named AbortError and must not be retried. */
function isRetryableError(err: unknown): boolean {
  return err instanceof TypeError
}

function backoff(policy: RetryPolicy, attempt: number, remainingMs: number): number | null {
  if (remainingMs <= 0) return null
  return Math.min(Math.random() * Math.min(policy.capMs, policy.baseMs * 2 ** attempt), remainingMs)
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ── "reconnecting" state ──────────────────────────────────────────────────
// A count, not a flag: two requests retrying at once must both finish before
// the UI says the server is back.
let retrying = 0
const listeners = new Set<(retrying: boolean) => void>()

function setRetrying(delta: 1 | -1): void {
  const before = retrying > 0
  retrying += delta
  const after = retrying > 0
  if (before !== after) listeners.forEach((cb) => cb(after))
}

/** True while at least one request is waiting to retry. */
export function isServerRetrying(): boolean {
  return retrying > 0
}

/** Called with true when the first request starts retrying and with false when
 *  the last one stops. Returns the unsubscribe. */
export function onTransientRetry(cb: (retrying: boolean) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * fetch(), retried through a server restart. `init.body` is re-sent on every
 * attempt, so it must be replayable (a string, Blob or ArrayBuffer — never a
 * ReadableStream). `init.headers` is sent as given: stamp the key with
 * stampIdempotencyKey first.
 */
export async function fetchRetryingTransient(
  url: string,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Promise<Response> {
  const deadline = Date.now() + policy.budgetMs
  let attempt = 0
  try {
    for (;;) {
      let wait: number | null
      try {
        const response = await fetch(url, init)
        if (!isRetryableResponse(response)) return response
        wait = backoff(policy, attempt, deadline - Date.now())
        if (wait === null) return response
        // Free the connection; the body is an error page nobody reads.
        await response.body?.cancel().catch(() => {})
      } catch (err) {
        if (!isRetryableError(err)) throw err
        wait = backoff(policy, attempt, deadline - Date.now())
        if (wait === null) throw err
      }
      if (attempt === 0) setRetrying(1)
      attempt += 1
      await sleep(wait, init.signal)
    }
  } finally {
    if (attempt > 0) setRetrying(-1)
  }
}

import { BatchItemError, type BatchEnvelope } from './endpoints/batch'

export interface BatchLoaderOptions<V> {
  /** Raw wire call for one chunk. Never called with more than `maxChunk` ids. */
  fetchChunk: (ids: string[]) => Promise<BatchEnvelope<V>>
  /** Server cap on ids per request. */
  maxChunk: number
}

export interface BatchLoader<V> {
  /** Rejects with BatchItemError if the envelope reported this id in `errors`. */
  load(id: string): Promise<V>
  /** Test hook: drop any pending batch without firing it. */
  reset(): void
}

interface Waiter<V> {
  id: string
  resolve: (value: V) => void
  reject: (reason: unknown) => void
}

/**
 * Tick-batching, deduping, chunking id loader. Framework-agnostic on purpose —
 * no React, no React Query — so the whole coalescing policy is testable with
 * fake timers.
 *
 * Lifecycle of one flush:
 *   load(id) called 1..N times in a tick
 *     -> push {id, resolve, reject} onto the pending buffer
 *     -> if no flush is scheduled, schedule one with setTimeout(flush, 0)
 *   flush()
 *     -> take + clear the buffer (re-entrant: a load() during flush starts a
 *        NEW batch rather than joining the one being fired)
 *     -> DEDUPE by id: one wire entry per project, all waiters on that id share
 *        its settlement. Coalescing keys on the PID, not on the calling hook,
 *        so two components wanting the same project in one tick cost one id.
 *     -> CHUNK into groups of maxChunk and fire them CONCURRENTLY. Serializing
 *        would reintroduce exactly the latency this change removes.
 *     -> per chunk: resolve ids present in `results`, reject ids present in
 *        `errors` with BatchItemError(code), and reject ids in NEITHER with
 *        BatchItemError('missing') — a malformed envelope must fail loudly
 *        instead of leaving a promise pending forever.
 *     -> if the chunk request itself throws (network / 4xx / 5xx), reject every
 *        waiter in that chunk with the transport error. That is the same shape
 *        callers already see when a single-project GET fails, and sibling
 *        chunks are unaffected.
 *
 * Why setTimeout(flush, 0) and not queueMicrotask: React Query fires queryFns
 * across a render commit AND the following effect flush. A macrotask boundary
 * catches both in one batch; a microtask boundary would split the sidebar's
 * mount into two requests. The window is one macrotask, not a fixed delay —
 * nothing is held back waiting for stragglers, so time-to-first-byte is
 * unchanged.
 *
 * There is deliberately NO persistent in-flight map across flushes: an
 * invalidateQueries arriving 200ms into a batch must produce a fresh read.
 * Suppressing it would be a correctness bug dressed as an optimization.
 */
export function createBatchLoader<V>({
  fetchChunk,
  maxChunk,
}: BatchLoaderOptions<V>): BatchLoader<V> {
  let pending: Waiter<V>[] = []
  let scheduled: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    scheduled = null
    const batch = pending
    pending = []
    if (batch.length === 0) return

    const waitersById = new Map<string, Waiter<V>[]>()
    for (const w of batch) {
      const existing = waitersById.get(w.id)
      if (existing) existing.push(w)
      else waitersById.set(w.id, [w])
    }
    // Insertion order — first-seen wins, matching the server's dedupe.
    const ids = Array.from(waitersById.keys())

    for (let i = 0; i < ids.length; i += maxChunk) {
      const chunk = ids.slice(i, i + maxChunk)
      fetchChunk(chunk).then(
        (envelope) => {
          const results = envelope?.results ?? {}
          const errors = envelope?.errors ?? {}
          for (const id of chunk) {
            const waiters = waitersById.get(id) ?? []
            // Key presence, NOT truthiness: `results[id] === []` is a valid
            // answer meaning "no rooms" and must not fall through to `errors`.
            if (Object.prototype.hasOwnProperty.call(results, id)) {
              const value = results[id]
              for (const w of waiters) w.resolve(value)
            } else if (Object.prototype.hasOwnProperty.call(errors, id)) {
              for (const w of waiters) w.reject(new BatchItemError(errors[id], id))
            } else {
              for (const w of waiters) w.reject(new BatchItemError('missing', id))
            }
          }
        },
        (err: unknown) => {
          for (const id of chunk) {
            for (const w of waitersById.get(id) ?? []) w.reject(err)
          }
        },
      )
    }
  }

  return {
    load(id: string): Promise<V> {
      return new Promise<V>((resolve, reject) => {
        pending.push({ id, resolve, reject })
        if (scheduled === null) scheduled = setTimeout(flush, 0)
      })
    },
    reset(): void {
      if (scheduled !== null) clearTimeout(scheduled)
      scheduled = null
      pending = []
    },
  }
}

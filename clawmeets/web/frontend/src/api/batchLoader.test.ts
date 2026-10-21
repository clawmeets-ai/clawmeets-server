import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBatchLoader, type BatchLoader } from './batchLoader'
import { BatchItemError, type BatchEnvelope } from './endpoints/batch'

type Rooms = string[]

function env(
  results: Record<string, Rooms>,
  errors: Record<string, string> = {},
): BatchEnvelope<Rooms> {
  return { results, errors }
}

/** Envelope that answers every requested id with one room named after it. */
function echo(ids: string[]): BatchEnvelope<Rooms> {
  return env(Object.fromEntries(ids.map((id) => [id, [`room-${id}`]])))
}

const pids = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => `p${i + offset}`)

/**
 * Attach the outcome handler SYNCHRONOUSLY at load() time. Asserting with
 * `expect(p).rejects` only subscribes after the timers have run, which leaves a
 * real window where the rejection is unhandled — noise that would mask a
 * genuine unhandled rejection in these tests.
 */
function capture<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
}

describe('createBatchLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces every load() in one tick into exactly one request', async () => {
    const fetchChunk = vi.fn(async (ids: string[]) => echo(ids))
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const ids = pids(10)
    const promises = ids.map((id) => loader.load(id))
    await vi.runAllTimersAsync()

    expect(fetchChunk).toHaveBeenCalledTimes(1)
    expect(fetchChunk.mock.calls[0][0]).toEqual(ids)
    await expect(Promise.all(promises)).resolves.toEqual(
      ids.map((id) => [`room-${id}`]),
    )
  })

  it('dedupes repeated ids to one wire entry, settling every waiter', async () => {
    const fetchChunk = vi.fn(async (ids: string[]) => echo(ids))
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    // Two hooks wanting the same project in the same tick is ONE id.
    const a1 = loader.load('a')
    const a2 = loader.load('a')
    const b = loader.load('b')
    await vi.runAllTimersAsync()

    expect(fetchChunk).toHaveBeenCalledTimes(1)
    expect(fetchChunk.mock.calls[0][0]).toEqual(['a', 'b'])
    await expect(a1).resolves.toEqual(['room-a'])
    await expect(a2).resolves.toEqual(['room-a'])
    await expect(b).resolves.toEqual(['room-b'])
  })

  it('chunks at the cap and fires the chunks concurrently', async () => {
    const seen: string[][] = []
    const release: Array<() => void> = []
    const fetchChunk = vi.fn(
      (ids: string[]) =>
        new Promise<BatchEnvelope<Rooms>>((resolve) => {
          seen.push(ids)
          release.push(() => resolve(echo(ids)))
        }),
    )
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const ids = pids(130) // the measured Front Desk rail
    const promises = ids.map((id) => loader.load(id))
    await vi.advanceTimersByTimeAsync(0)

    // All three are in flight BEFORE any of them has settled — serializing
    // would reintroduce the latency this change exists to remove.
    expect(seen.map((c) => c.length)).toEqual([50, 50, 30])
    release.forEach((r) => r())
    await expect(Promise.all(promises)).resolves.toHaveLength(130)
  })

  it('resolves an empty list as "no rooms", NOT as an error', async () => {
    // 8 of 552 live projects genuinely have zero rooms. `results[pid] === []`
    // must be distinguishable from `errors[pid]`, so membership is tested by
    // key presence rather than truthiness.
    const fetchChunk = vi.fn(async () => env({ a: [], b: ['room-b'] }))
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const a = loader.load('a')
    const b = loader.load('b')
    await vi.runAllTimersAsync()

    await expect(a).resolves.toEqual([])
    await expect(b).resolves.toEqual(['room-b'])
  })

  it('rejects only the ids reported in `errors`, leaving siblings resolved', async () => {
    const fetchChunk = vi.fn(async () =>
      env({ a: ['room-a'] }, { b: 'unavailable' }),
    )
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const a = capture(loader.load('a'))
    const b = capture(loader.load('b'))
    await vi.runAllTimersAsync()

    expect(await a).toEqual({ status: 'fulfilled', value: ['room-a'] })
    const bOutcome = await b
    expect(bOutcome.status).toBe('rejected')
    expect((bOutcome as { reason: unknown }).reason).toBeInstanceOf(BatchItemError)
    expect((bOutcome as { reason: unknown }).reason).toMatchObject({
      code: 'unavailable',
      projectId: 'b',
    })
  })

  it("rejects 'missing' for an id in neither map instead of hanging forever", async () => {
    // Contract §3: every requested id appears in exactly one map. An id in
    // neither is a server bug — hard-reject rather than paper over it.
    const fetchChunk = vi.fn(async () => env({ a: ['room-a'] }))
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const a = capture(loader.load('a'))
    const ghost = capture(loader.load('ghost'))
    await vi.runAllTimersAsync()

    expect(await a).toEqual({ status: 'fulfilled', value: ['room-a'] })
    const ghostOutcome = await ghost
    expect(ghostOutcome.status).toBe('rejected')
    expect((ghostOutcome as { reason: unknown }).reason).toMatchObject({
      code: 'missing',
      projectId: 'ghost',
    })
  })

  it('fails only the chunk that threw; sibling chunks still resolve', async () => {
    const boom = new Error('network down')
    const fetchChunk = vi.fn(async (ids: string[]) => {
      if (ids.includes('p0')) throw boom
      return echo(ids)
    })
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const ids = pids(60)
    const settled = Promise.allSettled(ids.map((id) => loader.load(id)))
    await vi.runAllTimersAsync()
    const outcomes = await settled

    expect(outcomes.slice(0, 50).every((o) => o.status === 'rejected')).toBe(true)
    expect(outcomes.slice(50).every((o) => o.status === 'fulfilled')).toBe(true)
    expect((outcomes[0] as PromiseRejectedResult).reason).toBe(boom)
  })

  it('starts a NEW batch for a load() issued during a flush', async () => {
    const calls: string[][] = []
    let loader!: BatchLoader<Rooms>
    const fetchChunk = vi.fn(async (ids: string[]) => {
      calls.push(ids)
      if (ids.includes('a')) void loader.load('b').catch(() => {})
      return echo(ids)
    })
    loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const a = loader.load('a')
    await vi.runAllTimersAsync()

    await expect(a).resolves.toEqual(['room-a'])
    expect(calls).toEqual([['a'], ['b']])
  })

  it('does not hold an in-flight map across ticks (a later load refetches)', async () => {
    // An invalidateQueries arriving mid-batch must produce a fresh read;
    // suppressing it would be a correctness bug dressed as an optimization.
    const fetchChunk = vi.fn(async (ids: string[]) => echo(ids))
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    const first = loader.load('a')
    await vi.runAllTimersAsync()
    const second = loader.load('a')
    await vi.runAllTimersAsync()

    await Promise.all([first, second])
    expect(fetchChunk).toHaveBeenCalledTimes(2)
  })

  it('reset() drops a pending batch without firing it', async () => {
    const fetchChunk = vi.fn(async (ids: string[]) => echo(ids))
    const loader = createBatchLoader<Rooms>({ fetchChunk, maxChunk: 50 })

    void loader.load('a').catch(() => {})
    loader.reset()
    await vi.runAllTimersAsync()

    expect(fetchChunk).not.toHaveBeenCalled()
  })
})

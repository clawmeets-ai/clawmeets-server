import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { ApiError, get, post, putFile } from './client'
import { refreshSession } from './endpoints/auth'
import {
  IDEMPOTENCY_HEADER,
  fetchRetryingTransient,
  isServerRetrying,
  onTransientRetry,
} from './transientRetry'

/**
 * A request sent while the server restarts goes through once it is back, a
 * write retried that way carries ONE Idempotency-Key, and the UI is told while
 * the wait is on. Only `fetch` is replaced; backoff is zero (Math.random = 0).
 */

const gatewayPage = (status = 502) =>
  new Response('<html>502 Bad Gateway</html>', { status, headers: { 'Content-Type': 'text/html' } })
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

/** Answer successive fetches in order: a Response, or an Error to reject with. */
function answer(...replies: (Response | Error | DOMException)[]): void {
  for (const reply of replies) {
    fetchMock.mockImplementationOnce(() =>
      reply instanceof Response ? Promise.resolve(reply) : Promise.reject(reply),
    )
  }
}

const sentHeaders = (i: number) => new Headers((fetchMock.mock.calls[i][1] as RequestInit).headers)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what is retried', () => {
  it('a gateway error page, then success, gives the caller one result', async () => {
    answer(gatewayPage(502), gatewayPage(503), json(200, { id: 'm1' }))
    await expect(get('/projects')).resolves.toEqual({ id: 'm1' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a network failure (fetch rejects with TypeError) is retried', async () => {
    answer(new TypeError('Failed to fetch'), json(200, { ok: true }))
    await expect(get('/projects')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("the app's own JSON 503 is not retried — it means something", async () => {
    answer(json(503, { detail: 'agent runner is not connected' }))
    await expect(get('/agents/a/fs/list')).rejects.toMatchObject({
      status: 503,
      message: 'agent runner is not connected',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 400 is not retried', async () => {
    answer(json(400, { detail: 'bad' }))
    await expect(post('/projects', { name: 'x' })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an abort is not retried', async () => {
    answer(new DOMException('aborted', 'AbortError'))
    await expect(get('/me/search/messages?q=x')).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an abort during the wait ends the retry', async () => {
    vi.mocked(Math.random).mockReturnValue(1) // a real wait, so there is time to abort
    answer(gatewayPage())
    const controller = new AbortController()
    const pending = get('/projects', controller.signal)
    await vi.waitFor(() => expect(isServerRetrying()).toBe(true))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isServerRetrying()).toBe(false)
  })

  it('after the budget, the last response is what the caller sees', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(gatewayPage(504)))
    const response = await fetchRetryingTransient('/x', {}, { budgetMs: 0, baseMs: 0, capMs: 0 })
    expect(response.status).toBe(504)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('Idempotency-Key', () => {
  it('a write carries one key, reused on every retry', async () => {
    answer(new TypeError('Failed to fetch'), gatewayPage(), json(200, { id: 'm1' }))
    await post('/projects/p/chatrooms/r/user-message', { content: 'hi' })
    const keys = [0, 1, 2].map((i) => sentHeaders(i).get(IDEMPOTENCY_HEADER))
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Set(keys).size).toBe(1)
  })

  it('two writes get two keys', async () => {
    answer(json(200), json(200))
    await post('/a', {})
    await post('/a', {})
    expect(sentHeaders(0).get(IDEMPOTENCY_HEADER)).not.toBe(sentHeaders(1).get(IDEMPOTENCY_HEADER))
  })

  it('putFile keeps its content type and gets a key', async () => {
    answer(gatewayPage(), json(200))
    await putFile('/projects/p/files/a.bin', new Blob(['x']))
    expect(sentHeaders(1).get('Content-Type')).toBe('application/octet-stream')
    expect(sentHeaders(1).get(IDEMPOTENCY_HEADER)).toBe(sentHeaders(0).get(IDEMPOTENCY_HEADER))
  })

  it('a read carries no key', async () => {
    answer(json(200))
    await get('/projects')
    expect(sentHeaders(0).has(IDEMPOTENCY_HEADER)).toBe(false)
  })

  it('a session refresh rides out a restart without a key', async () => {
    answer(gatewayPage(), json(200, { access_token: 'a', refresh_token: 'r' }))
    await expect(refreshSession('old')).resolves.toEqual({ access_token: 'a', refresh_token: 'r' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentHeaders(1).has(IDEMPOTENCY_HEADER)).toBe(false)
  })
})

describe('reconnecting state', () => {
  it('turns on while a request waits and off when the server answers', async () => {
    const seen: boolean[] = []
    const unsubscribe = onTransientRetry((r) => seen.push(r))
    answer(gatewayPage(), gatewayPage(), json(200))
    await get('/projects')
    unsubscribe()
    expect(seen).toEqual([true, false])
    expect(isServerRetrying()).toBe(false)
  })

  it('stays on until the last of two retrying requests is through', async () => {
    const seen: boolean[] = []
    const unsubscribe = onTransientRetry((r) => seen.push(r))
    let releaseSecond!: () => void
    answer(gatewayPage(), gatewayPage(), json(200))
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseSecond = () => resolve(json(200)))),
    )
    const first = get('/a')
    const second = get('/b')
    await first
    expect(isServerRetrying()).toBe(true)
    await vi.waitFor(() => expect(releaseSecond).toBeDefined())
    releaseSecond()
    await second
    unsubscribe()
    expect(seen).toEqual([true, false])
  })

  it('a request that never retried does not touch it', async () => {
    const cb = vi.fn()
    const unsubscribe = onTransientRetry(cb)
    answer(json(200))
    await get('/projects')
    unsubscribe()
    expect(cb).not.toHaveBeenCalled()
  })
})

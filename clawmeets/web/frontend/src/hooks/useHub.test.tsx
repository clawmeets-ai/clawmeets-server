import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import { delivery, hubAgent, hubChannel, hubConfig } from '../test/hubFixtures'

/**
 * The hub hooks' rules that a refactor could quietly break: read-only history
 * (deliveries, avatars) never waits on the hub's mode; the offline confirm and
 * the enable retry reuse their ids; a rate-limited search keeps what it showed.
 */

const api = {
  getHubConfig: vi.fn(),
  getHubChannel: vi.fn(),
  enableHubChannel: vi.fn(),
  listHubDeliveries: vi.fn(),
  getHubAvatar: vi.fn(),
  searchHubAgents: vi.fn(),
  sendHubMessage: vi.fn(),
}
vi.mock('../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../api/endpoints/hub')>()
  return {
    ...real,
    getHubConfig: (...a: unknown[]) => api.getHubConfig(...a),
    getHubChannel: (...a: unknown[]) => api.getHubChannel(...a),
    enableHubChannel: (...a: unknown[]) => api.enableHubChannel(...a),
    listHubDeliveries: (...a: unknown[]) => api.listHubDeliveries(...a),
    getHubAvatar: (...a: unknown[]) => api.getHubAvatar(...a),
    searchHubAgents: (...a: unknown[]) => api.searchHubAgents(...a),
    sendHubMessage: (...a: unknown[]) => api.sendHubMessage(...a),
  }
})
const uploadUserFile = vi.fn()
vi.mock('../api/endpoints/files', () => ({ uploadUserFile: (...a: unknown[]) => uploadUserFile(...a) }))

const {
  HUB_CONFIG_KEY, useHubAvatar, useHubChannel, useHubDeliveries, useHubDirectory, useHubSend,
} = await import('./useHub')

let qc: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
const hubErr = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, code, { detail: { code, message: '', ...extra } })

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const f of Object.values(api)) f.mockReset()
  uploadUserFile.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:avatar'),
    revokeObjectURL: vi.fn(),
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('read-only history is never gated', () => {
  it('deliveries load with mode off and registration none', async () => {
    qc.setQueryData(HUB_CONFIG_KEY, hubConfig({ mode: 'off', registration: 'none' }))
    api.listHubDeliveries.mockResolvedValue([delivery({ message_id: 'm1', state: 'delivered' })])
    const { result } = renderHook(() => useHubDeliveries('p1'), { wrapper })
    await waitFor(() => expect(result.current.get('m1')?.state).toBe('delivered'))
    expect(api.getHubConfig).not.toHaveBeenCalled()
  })

  it('the avatar loads with mode off, and refetches on a newer listing refresh', async () => {
    qc.setQueryData(HUB_CONFIG_KEY, hubConfig({ mode: 'off', registration: 'none' }))
    api.getHubAvatar.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    const url = '/api/hub/agents/3f9a1c2e5b7d9f00~scout/avatar'
    const { result, rerender } = renderHook(({ at }) => useHubAvatar(url, at), { wrapper, initialProps: { at: 1 } })
    await waitFor(() => expect(result.current).toBe('blob:avatar'))
    expect(api.getHubAvatar).toHaveBeenCalledTimes(1)
    rerender({ at: 2 })
    await waitFor(() => expect(api.getHubAvatar).toHaveBeenCalledTimes(2))
  })

  it('a non-PNG answer is refused (initials), and a non-proxy URL is never fetched', async () => {
    api.getHubAvatar.mockResolvedValue(new Blob(['<svg/>'], { type: 'image/svg+xml' }))
    const { result } = renderHook(() => useHubAvatar('/api/hub/agents/3f9a1c2e5b7d9f00~scout/avatar', 1), { wrapper })
    await waitFor(() => expect(api.getHubAvatar).toHaveBeenCalled())
    expect(result.current).toBeNull()
    renderHook(() => useHubAvatar('https://evil.dev/x.png', 1), { wrapper })
    expect(api.getHubAvatar).toHaveBeenCalledTimes(1)
  })

  it('a pending row polls; a merged older row never regresses a newer one', async () => {
    qc.setQueryData(['hub-deliveries', 'p1'], { m1: delivery({ state: 'delivered', state_at: 50 }) })
    api.listHubDeliveries.mockResolvedValue([delivery({ state: 'sent_to_hub', state_at: 10 })])
    const { result } = renderHook(() => useHubDeliveries('p1'), { wrapper })
    await waitFor(() => expect(api.listHubDeliveries).toHaveBeenCalled())
    expect(result.current.get('m1')?.state).toBe('delivered')
  })
})

describe('useHubSend', () => {
  it('the offline confirm re-sends with the SAME client_message_id and confirm_offline', async () => {
    api.sendHubMessage
      .mockRejectedValueOnce(hubErr(409, 'target_offline_confirm_required', { send_warning: 'deployment_offline' }))
      .mockResolvedValueOnce({ message_id: 'm9', delivery: delivery({ message_id: 'm9', state: 'waiting_for_target' }) })
    const { result } = renderHook(() => useHubSend(), { wrapper })
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send('p1', 'hi', []) })
    expect(ok).toBe(false)
    expect(result.current.confirmPending).toBe('deployment_offline')
    await act(async () => { ok = await result.current.confirm() })
    expect(ok).toBe(true)
    const [first, second] = api.sendHubMessage.mock.calls
    expect(first[1]).toMatchObject({ text: 'hi', confirm_offline: false })
    expect(second[1]).toMatchObject({ text: 'hi', confirm_offline: true, client_message_id: first[1].client_message_id })
    expect(result.current.confirmPending).toBeNull()
    expect(qc.getQueryData<Record<string, unknown>>(['hub-deliveries', 'p1'])).toHaveProperty('m9')
  })

  it('uploads files first and sends their names', async () => {
    api.sendHubMessage.mockResolvedValue({ message_id: 'm1', delivery: delivery() })
    const { result } = renderHook(() => useHubSend(), { wrapper })
    const f = new File(['x'], 'deck.pdf')
    await act(async () => { await result.current.send('p1', 'see file', [f]) })
    expect(uploadUserFile).toHaveBeenCalledWith('p1', 'user-communication', 'deck.pdf', f)
    expect(api.sendHubMessage.mock.calls[0][1].file_ids).toEqual(['deck.pdf'])
  })

  it('a 503 or a 429 keeps the draft and records the error', async () => {
    api.sendHubMessage.mockRejectedValueOnce(hubErr(503, 'hub_unreachable', { last_connected_at: 1 }))
    const { result } = renderHook(() => useHubSend(), { wrapper })
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send('p1', 'hi', []) })
    expect(ok).toBe(false)
    expect(result.current.lastError?.code).toBe('hub_unreachable')
    api.sendHubMessage.mockRejectedValueOnce(hubErr(429, 'rate_limited', { retry_after: 30 }))
    await act(async () => { ok = await result.current.send('p1', 'hi', []) })
    expect(ok).toBe(false)
    expect(result.current.rateLimitedUntil).toBeGreaterThan(Date.now() + 25_000)
  })
})

describe('useHubSend retry after a send whose fate is unknown', () => {
  it('a network failure, then a retry of the same draft, sends the SAME client_message_id and uploads once', async () => {
    api.sendHubMessage
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ message_id: 'm1', delivery: delivery({ message_id: 'm1' }) })
    const { result } = renderHook(() => useHubSend(), { wrapper })
    const f = new File(['x'], 'deck.pdf')
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.send('p1', 'please book Friday', [f]) })
    expect(ok).toBe(false)
    expect(result.current.failed).toBe(true)
    await act(async () => { ok = await result.current.send('p1', 'please book Friday', [f]) })
    expect(ok).toBe(true)
    const [first, second] = api.sendHubMessage.mock.calls
    expect(second[1].client_message_id).toBe(first[1].client_message_id)
    expect(uploadUserFile).toHaveBeenCalledTimes(1)
  })

  it('a reply with no hub body (a proxy 502) is also unknown, and its retry reuses the id', async () => {
    api.sendHubMessage
      .mockRejectedValueOnce(new ApiError(502, 'Bad Gateway', '<html>bad gateway</html>'))
      .mockResolvedValueOnce({ message_id: 'm1', delivery: delivery() })
    const { result } = renderHook(() => useHubSend(), { wrapper })
    await act(async () => { await result.current.send('p1', 'hi', []) })
    await act(async () => { await result.current.send('p1', 'hi', []) })
    const [first, second] = api.sendHubMessage.mock.calls
    expect(second[1].client_message_id).toBe(first[1].client_message_id)
  })

  it('editing the draft after a network failure mints a new id', async () => {
    api.sendHubMessage.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ message_id: 'm1', delivery: delivery() })
    const { result } = renderHook(() => useHubSend(), { wrapper })
    await act(async () => { await result.current.send('p1', 'please book Friday', []) })
    await act(async () => { await result.current.send('p1', 'please book Saturday', []) })
    const [first, second] = api.sendHubMessage.mock.calls
    expect(second[1].client_message_id).not.toBe(first[1].client_message_id)
  })

  it('a definite refusal, or a success, mints a new id for the next send of the same text', async () => {
    api.sendHubMessage
      .mockRejectedValueOnce(hubErr(503, 'hub_unreachable', { last_connected_at: 1 }))
      .mockResolvedValueOnce({ message_id: 'm1', delivery: delivery() })
      .mockResolvedValueOnce({ message_id: 'm2', delivery: delivery({ message_id: 'm2' }) })
    const { result } = renderHook(() => useHubSend(), { wrapper })
    await act(async () => { await result.current.send('p1', 'ok', []) })
    await act(async () => { await result.current.send('p1', 'ok', []) })
    await act(async () => { await result.current.send('p1', 'ok', []) })
    const ids = api.sendHubMessage.mock.calls.map((c) => c[1].client_message_id)
    expect(new Set(ids).size).toBe(3)
  })
})

describe('useHubChannel enable', () => {
  it('reuses its request id on retry, and mints a new one after success', async () => {
    api.getHubChannel.mockResolvedValue(hubChannel())
    api.enableHubChannel
      .mockRejectedValueOnce(hubErr(503, 'hub_unreachable'))
      .mockResolvedValue(hubChannel({ enabled: true, status: 'enabling' }))
    const { result } = renderHook(() => useHubChannel('alice-bot'), { wrapper })
    await act(async () => { await result.current.enable.mutateAsync().catch(() => undefined) })
    await act(async () => { await result.current.enable.mutateAsync() })
    await act(async () => { await result.current.enable.mutateAsync() })
    const ids = api.enableHubChannel.mock.calls.map((c) => c[1])
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
    expect(qc.getQueryData(['hub-channel', 'alice-bot'])).toMatchObject({ status: 'enabling' })
  })
})

describe('useHubDirectory', () => {
  it('a rate-limited new search keeps the previous results and gives the wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      api.searchHubAgents.mockResolvedValueOnce({ agents: [hubAgent()], next_cursor: null, served_from: 'live', cache_age_s: null, cached_at: null })
      const { result, rerender } = renderHook(({ q }) => useHubDirectory({ q, capabilities: [], onlineOnly: false, enabled: true }), {
        wrapper, initialProps: { q: 'scout' },
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(450) })
      await waitFor(() => expect(result.current.agents).toHaveLength(1))
      api.searchHubAgents.mockRejectedValueOnce(hubErr(429, 'rate_limited', { retry_after: 12 }))
      rerender({ q: 'lex' })
      await act(async () => { await vi.advanceTimersByTimeAsync(450) })
      await waitFor(() => expect(result.current.retryAfter).toBe(12))
      expect(result.current.agents.map((a) => a.name)).toEqual(['scout'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing while disabled (mode off)', async () => {
    renderHook(() => useHubDirectory({ q: '', capabilities: [], onlineOnly: false, enabled: false }), { wrapper })
    await new Promise((r) => setTimeout(r, 450))
    expect(api.searchHubAgents).not.toHaveBeenCalled()
  })
})

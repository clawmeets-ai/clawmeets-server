import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../client'

/**
 * The hub calls at the seam where a wrong path, verb or body becomes a 404 or
 * a 422 the user reads. Error bodies are parsed from the existing
 * ApiError.data, so client.ts is untouched.
 */

const get = vi.fn()
const post = vi.fn()
const del = vi.fn()
const getFile = vi.fn()
vi.mock('../client', async (orig) => ({
  ...(await orig<typeof import('../client')>()),
  get: (...a: unknown[]) => get(...a),
  post: (...a: unknown[]) => post(...a),
  del: (...a: unknown[]) => del(...a),
  getFile: (...a: unknown[]) => getFile(...a),
}))

const hub = await import('./hub')

beforeEach(() => {
  get.mockReset().mockResolvedValue({ blocked: [] })
  post.mockReset().mockResolvedValue({ blocked: [] })
  del.mockReset().mockResolvedValue({ blocked: [] })
  getFile.mockReset().mockResolvedValue(new Blob())
})

describe('paths and bodies', () => {
  it('enrollment', async () => {
    await hub.getHubEnrollment()
    expect(get).toHaveBeenCalledWith('/me/channels/hub/enrollment')
    await hub.startHubEnrollment('2026-10')
    expect(post).toHaveBeenCalledWith('/me/channels/hub/enrollment', { accept_tos_version: '2026-10' })
    await hub.confirmHubEnrollment('123456')
    expect(post).toHaveBeenCalledWith('/me/channels/hub/enrollment/confirm', { code: '123456' })
  })

  it('config', async () => {
    await hub.getHubConfig()
    expect(get).toHaveBeenCalledWith('/api/hub/config')
  })

  it('encodes the agent full name in channel paths', async () => {
    await hub.getHubChannel('alice-bot/x')
    expect(get).toHaveBeenCalledWith('/me/channels/hub/alice-bot%2Fx')
  })

  it('enable sends the client_request_id it was given', async () => {
    await hub.enableHubChannel('alice-bot', 'req-1')
    expect(post).toHaveBeenCalledWith('/me/channels/hub/alice-bot/enable', { client_request_id: 'req-1' })
  })

  it('disable always confirms and passes stop_now', async () => {
    await hub.disableHubChannel('alice-bot', true)
    expect(post).toHaveBeenCalledWith('/me/channels/hub/alice-bot/disable', { confirm: true, stop_now: true })
  })

  it('unwraps BlockedList on all three verbs', async () => {
    const row = { deployment_fingerprint: 'fp', deployment_name: 'acme', created_at: 1 }
    get.mockResolvedValue({ blocked: [row] })
    post.mockResolvedValue({ blocked: [row] })
    del.mockResolvedValue({ blocked: [] })
    expect(await hub.listBlockedDeployments('a')).toEqual([row])
    expect(await hub.blockDeployment('a', 'fp')).toEqual([row])
    expect(post).toHaveBeenCalledWith('/me/channels/hub/a/blocked_deployments', { deployment_fingerprint: 'fp' })
    expect(await hub.unblockDeployment('a', 'f p')).toEqual([])
    expect(del).toHaveBeenCalledWith('/me/channels/hub/a/blocked_deployments?deployment_fingerprint=f%20p')
  })

  it('search repeats capabilities and always sends a limit', async () => {
    await hub.searchHubAgents({ q: 'wine', capabilities: ['a', 'b c'], online_only: true })
    const path = get.mock.calls[0][0] as string
    expect(path.startsWith('/api/hub/agents?')).toBe(true)
    const qs = new URLSearchParams(path.split('?')[1])
    expect(qs.get('q')).toBe('wine')
    expect(qs.getAll('capabilities')).toEqual(['a', 'b c'])
    expect(qs.get('online_only')).toBe('true')
    expect(qs.get('limit')).toBe('20')
    expect(qs.has('cursor')).toBe(false)
  })

  it('encodes hub agent ids (the ~ and any slash)', async () => {
    await hub.getHubAgent('abcd~bot/../x')
    expect(get).toHaveBeenCalledWith('/api/hub/agents/abcd~bot%2F..%2Fx')
  })

  it('report sends the note only when there is one', async () => {
    await hub.reportHubAgent('id', { reason: 'spam' })
    expect(post).toHaveBeenLastCalledWith('/api/hub/agents/id/report', { reason: 'spam' })
    await hub.reportHubAgent('id', { reason: 'other', note: 'why' })
    expect(post).toHaveBeenLastCalledWith('/api/hub/agents/id/report', { reason: 'other', note: 'why' })
  })

  it('start and send', async () => {
    await hub.startHubConversation('id', 'key-1')
    expect(post).toHaveBeenLastCalledWith('/api/hub/conversations', { hub_agent_id: 'id', client_thread_key: 'key-1' })
    const body = { text: 'hi', client_message_id: 'm1', confirm_offline: false, file_ids: [] }
    await hub.sendHubMessage('p1', body)
    expect(post).toHaveBeenLastCalledWith('/api/hub/conversations/p1/messages', body)
  })

  it('deliveries, with and without since_message_id', async () => {
    get.mockResolvedValue([])
    await hub.listHubDeliveries('p1')
    expect(get).toHaveBeenLastCalledWith('/api/hub/conversations/p1/deliveries')
    await hub.listHubDeliveries('p1', 'm 1')
    expect(get).toHaveBeenLastCalledWith('/api/hub/conversations/p1/deliveries?since_message_id=m%201')
  })
})

describe('hubError', () => {
  const err = (status: number, data: unknown) => new ApiError(status, 'x', data)

  it('reads a HubError body and keeps its extras', () => {
    const b = hub.hubError(err(429, { detail: { code: 'rate_limited', message: 'slow down', retry_after: 12 } }))
    expect(b).toMatchObject({ code: 'rate_limited', message: 'slow down' })
    expect(hub.retryAfterSeconds(b)).toBe(12)
  })

  it('is null for a 422 string detail, a non-JSON body and a non-ApiError', () => {
    expect(hub.hubError(err(422, { detail: 'invalid search' }))).toBeNull()
    expect(hub.hubError(err(502, '<html>bad gateway</html>'))).toBeNull()
    expect(hub.hubError(new Error('network'))).toBeNull()
    expect(hub.hubError(err(400, { detail: { message: 'no code' } }))).toBeNull()
  })

  it('a missing message reads as empty', () => {
    expect(hub.hubError(err(503, { detail: { code: 'hub_unreachable' } }))?.message).toBe('')
  })

  it('reads the pinned extras of their own code, and checks them at runtime', () => {
    const b = (code: string, d: Record<string, unknown>) => hub.hubError(err(409, { detail: { code, message: '', ...d } }))
    expect(hub.sendWarningOf(b('target_offline_confirm_required', { send_warning: 'agent_offline' }))).toBe('agent_offline')
    expect(hub.sendWarningOf(b('target_offline_confirm_required', { send_warning: 'surprise' }))).toBeNull()
    expect(hub.sendWarningOf(b('agent_unlisted', { send_warning: 'agent_offline' }))).toBeNull()
    expect(hub.lastConnectedOf(b('hub_unreachable', { last_connected_at: 1700000000.5 }))).toBe(1700000000.5)
    expect(hub.lastConnectedOf(b('hub_unreachable', { last_connected_at: null }))).toBeNull()
    expect(hub.lastConnectedOf(b('hub_unreachable', {}))).toBeNull()
    expect(hub.fileIdOf(b('file_not_found', { file_id: 'a.png' }))).toBe('a.png')
    expect(hub.fileIdOf(b('own_agent', { file_id: 'a.png' }))).toBeNull()
    expect(hub.retryAfterSeconds(b('rate_limited', { retry_after: 'soon' }))).toBeNull()
    expect(hub.retryAfterSeconds(b('rate_limited', {}))).toBeNull()
  })

  it('payload_too_large and local_agent extras', () => {
    const big = hub.hubError(err(413, { detail: { code: 'payload_too_large', message: '', limit: 'file', max: 10, actual: 20, file_id: 'x.bin' } }))
    expect(hub.payloadTooLargeOf(big)).toEqual({ limit: 'file', max: 10, actual: 20, file_id: 'x.bin' })
    const local = hub.hubError(err(409, { detail: { code: 'local_agent', message: '', use_path: '/dm/bob-x', agent_name: 'bob-x' } }))
    expect(hub.localAgentOf(local)).toEqual({ use_path: '/dm/bob-x', agent_name: 'bob-x' })
    expect(hub.localAgentOf(big)).toBeNull()
  })

  it('HUB_STATE_ERRORS is the five of browser.py', () => {
    expect([...hub.HUB_STATE_ERRORS].sort()).toEqual(
      ['hub_discover_only', 'hub_not_registered', 'hub_off_on_server', 'hub_unreachable', 'hub_untrusted'],
    )
  })
})

describe('agent access calls', () => {
  it('retain posts an empty body; unretain deletes', async () => {
    await hub.retainHubAgent('abc~scout')
    expect(post).toHaveBeenCalledWith('/api/hub/agents/abc~scout/retain', {})
    await hub.unretainHubAgent('abc~scout')
    expect(del).toHaveBeenCalledWith('/api/hub/agents/abc~scout/retain')
  })

  it('the retained list is unwrapped', async () => {
    get.mockResolvedValueOnce({ agents: [{ hub_agent_id: 'a' }] })
    expect(await hub.listRetained()).toEqual([{ hub_agent_id: 'a' }])
    expect(get).toHaveBeenCalledWith('/api/hub/retained')
  })

  it('bridge deliveries pass message_ids comma-joined and unwrap', async () => {
    get.mockResolvedValueOnce({ deliveries: [] })
    expect(await hub.listBridgeDeliveries('p 1', 'work-room', ['m1', 'm2'])).toEqual([])
    expect(get).toHaveBeenCalledWith('/api/hub/bridges/p%201/work-room/deliveries?message_ids=m1,m2')
    get.mockResolvedValueOnce({ deliveries: [] })
    await hub.listBridgeDeliveries('p', 'r')
    expect(get).toHaveBeenLastCalledWith('/api/hub/bridges/p/r/deliveries')
  })

  it('agent usage and conversation messages', async () => {
    await hub.getAgentHubUsage('agent-1')
    expect(get).toHaveBeenCalledWith('/api/hub/agents-usage/agent-1')
    await hub.listHubConversationMessages('p1', 1700000000, 20)
    expect(get).toHaveBeenLastCalledWith('/api/hub/conversations/p1/messages?before=1700000000&limit=20')
    await hub.listHubConversationMessages('p1')
    expect(get).toHaveBeenLastCalledWith('/api/hub/conversations/p1/messages')
  })

  it('isHeldForReview is true only for held: true', () => {
    expect(hub.isHeldForReview({ held: true, reason: 'flow_stopped', message: 'x' })).toBe(true)
    expect(hub.isHeldForReview({ held: false })).toBe(false)
    expect(hub.isHeldForReview({ held: 'true' })).toBe(false)
    expect(hub.isHeldForReview({ id: 'm1', content: 'hi' })).toBe(false)
    expect(hub.isHeldForReview(null)).toBe(false)
  })
})


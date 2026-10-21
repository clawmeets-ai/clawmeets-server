import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { useWebSocketUpdates } from './useWebSocket'
import { bridgeDelivery, delivery, hubChannel } from '../test/hubFixtures'
import { bridgeDeliveriesKey, type BridgeDeliveryMap } from './useAgentAccess'

/** Both hub events update their caches; removing either case must turn this red. */

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static last: FakeWebSocket | null = null
  readyState = FakeWebSocket.OPEN
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(public url: string) {
    FakeWebSocket.last = this
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

let qc: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)

beforeEach(() => {
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket)
  localStorage.clear()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  wsManager.disconnect()
  vi.unstubAllGlobals()
})

describe('hub WebSocket events', () => {
  it('hub_delivery_state merges into the thread\'s deliveries by state_at', () => {
    qc.setQueryData(['hub-deliveries', 'p1'], { m1: delivery({ state: 'sent_to_hub', state_at: 10 }) })
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.receive({ type: 'hub_delivery_state', payload: { project_id: 'p1', delivery: delivery({ state: 'delivered', state_at: 20 }) } })
    expect(qc.getQueryData<Record<string, { state: string }>>(['hub-deliveries', 'p1'])?.m1.state).toBe('delivered')
    // an older frame changes nothing
    FakeWebSocket.last!.receive({ type: 'hub_delivery_state', payload: { project_id: 'p1', delivery: delivery({ state: 'waiting_for_target', state_at: 15 }) } })
    expect(qc.getQueryData<Record<string, { state: string }>>(['hub-deliveries', 'p1'])?.m1.state).toBe('delivered')
    unmount()
  })

  it('a closing failure refetches the project so hub_target catches up', () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.receive({ type: 'hub_delivery_state', payload: { project_id: 'p1', delivery: delivery({ state: 'failed', failed_reason: 'agent_unlisted' }) } })
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey)).toContainEqual(['project', 'p1'])
    unmount()
  })

  it('hub_channel_status replaces the whole cached channel', () => {
    qc.setQueryData(['hub-channel', 'alice-bot'], hubChannel({ status: 'enabling', enabled: true, key_last4: 'old1' }))
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    const pushed = hubChannel({ status: 'connected', enabled: true, key_last4: null })
    FakeWebSocket.last!.receive({ type: 'hub_channel_status', payload: { agent_full_name: 'alice-bot', channel: pushed } })
    expect(qc.getQueryData(['hub-channel', 'alice-bot'])).toEqual(pushed)
    unmount()
  })

  it('hub_bridge_delivery merges into the room\'s delivery lines; a relay only moves forward', () => {
    const key = bridgeDeliveriesKey('p1', 'work')
    qc.setQueryData<BridgeDeliveryMap>(key, { m1: [bridgeDelivery({ state: 'queued' })] })
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    const frame = (state: string) => ({
      type: 'hub_bridge_delivery',
      payload: { project_id: 'p1', chatroom_name: 'work', delivery: bridgeDelivery({ state }) },
    })
    FakeWebSocket.last!.receive(frame('delivered'))
    expect(qc.getQueryData<BridgeDeliveryMap>(key)?.m1.map((d) => d.state)).toEqual(['delivered'])
    FakeWebSocket.last!.receive(frame('relayed'))
    expect(qc.getQueryData<BridgeDeliveryMap>(key)?.m1.map((d) => d.state)).toEqual(['delivered'])
    FakeWebSocket.last!.receive({
      type: 'hub_bridge_delivery',
      payload: { project_id: 'p1', chatroom_name: 'work', delivery: bridgeDelivery({ room_message_id: 'm2', hub_agent_id: 'x~y' }) },
    })
    expect(Object.keys(qc.getQueryData<BridgeDeliveryMap>(key) ?? {}).sort()).toEqual(['m1', 'm2'])
    unmount()
  })

  it('chatroom_flow_changed writes the flow into the cached room and room list, with no refetch', () => {
    qc.setQueryData(['chatroom', 'p1', 'work'], { id: 'r', name: 'work', project_id: 'p1', participants: [], version: 1, created_at: '' })
    qc.setQueryData(['chatrooms', 'p1'], [{ id: 'r', name: 'work', project_id: 'p1', participants: [], version: 1, created_at: '' }])
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    const flow = { inbound_flow: 'stopped', stopped_by: 'inspector', stopped_at: 1700000000, reason: null, held_count: 3 }
    FakeWebSocket.last!.receive({ type: 'chatroom_flow_changed', payload: { project_id: 'p1', chatroom_name: 'work', flow } })
    expect(qc.getQueryData<{ flow: unknown }>(['chatroom', 'p1', 'work'])?.flow).toEqual(flow)
    expect(qc.getQueryData<Array<{ flow: unknown }>>(['chatrooms', 'p1'])?.[0].flow).toEqual(flow)
    expect(spy).not.toHaveBeenCalled()
    unmount()
  })
})


import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wsManager } from './websocket'
import { ControlMessageType } from '../types'

/**
 * RESYNC: behind the websocket edge a core restart keeps the socket open, so
 * the reconnect catch-up never runs on its own. The server asks for it with a
 * RESYNC envelope instead — but only on sockets whose auth frame listed
 * 'resync'; the rest are closed with 1012 and reconnect.
 */

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
}

function resync(scope: 'full' | 'changelog', jitter_s = 10): void {
  FakeWebSocket.last!.onmessage?.({
    data: JSON.stringify({
      type: 'resync',
      payload: { scope, reason: 'core_restart', jitter_s },
    }),
  })
}

beforeEach(() => {
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.useFakeTimers()
  // Pin the jitter draw to its maximum so "not before the jitter" is exact.
  vi.spyOn(Math, 'random').mockReturnValue(0.999)
  ;(wsManager as unknown as {
    state: { hasEverConnected: boolean }
  }).state.hasEverConnected = false
})

afterEach(() => {
  wsManager.disconnect()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RESYNC', () => {
  it('advertises the resync capability in the auth frame', () => {
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.onopen?.({})
    expect(JSON.parse(FakeWebSocket.last!.send.mock.calls[0][0])).toEqual({
      token: 'tok',
      capabilities: ['resync'],
    })
  })

  it('fires the connect handlers as a reconnect after the jitter, once per burst', () => {
    const onConnect = vi.fn()
    const onResync = vi.fn()
    const unsubConnect = wsManager.onConnect(onConnect)
    const unsubResync = wsManager.on(ControlMessageType.RESYNC, onResync)
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.onopen?.({})
    expect(onConnect.mock.calls).toEqual([[false]])

    resync('changelog', 10)
    resync('full', 10) // folded into the pending one
    expect(onResync).toHaveBeenCalledTimes(2) // still dispatched to on(RESYNC)

    vi.advanceTimersByTime(9_000)
    expect(onConnect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(onConnect.mock.calls).toEqual([[false], [true]])

    vi.advanceTimersByTime(60_000)
    expect(onConnect).toHaveBeenCalledTimes(2)

    // After it fired, a new RESYNC schedules again.
    resync('full', 1)
    vi.advanceTimersByTime(1_000)
    expect(onConnect.mock.calls).toEqual([[false], [true], [true]])

    unsubConnect()
    unsubResync()
  })

  it('drops a pending resync on disconnect()', () => {
    const onConnect = vi.fn()
    const unsub = wsManager.onConnect(onConnect)
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.onopen?.({})
    resync('full', 5)
    wsManager.disconnect()
    vi.advanceTimersByTime(60_000)
    expect(onConnect.mock.calls).toEqual([[false]])
    unsub()
  })
})

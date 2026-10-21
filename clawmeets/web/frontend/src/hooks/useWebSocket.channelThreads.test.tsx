import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { useWebSocketUpdates } from './useWebSocket'
import { CHANNEL_THREADS_KEY } from './useChannelThreads'

/**
 * A NEW CHANNEL THREAD REACHES THE SIDEBAR THROUGH THE WEBSOCKET. When a new
 * contact writes in, the server sends a `changelog_update` for the new thread's
 * project. The Front Desk sidebar files a channel thread only from the thread
 * list, so that list must be refetched too: if only the project list is, the
 * `ch-…` room name doesn't parse and the thread lands in "—" / "user". The open
 * thread's delivery status is refreshed by the same frame.
 *
 * DELETING EITHER INVALIDATION IN useWebSocket.ts MUST TURN THIS TEST RED.
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

  /** Deliver a raw server frame exactly as the browser would. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

let queryClient: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

beforeEach(() => {
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket)
  localStorage.clear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  wsManager.disconnect()
  vi.unstubAllGlobals()
})

function invalidatedKeys(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  return spy.mock.calls.map(call => (call[0] as { queryKey: unknown }).queryKey)
}

describe('changelog_update refreshes the channel thread list and the thread\'s outbox', () => {
  it('invalidates the thread list and that project\'s outbox', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive({
      type: 'changelog_update',
      payload: { project_id: 'p-new', project_name: 'ch-1a2b3c4d-deadbeef', new_version: 1 },
    })

    expect(invalidatedKeys(spy)).toContainEqual(CHANNEL_THREADS_KEY)
    expect(invalidatedKeys(spy)).toContainEqual(['channel-outbox', 'p-new'])
    unmount()
  })
})

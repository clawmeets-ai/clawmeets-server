import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { useWebSocketUpdates } from './useWebSocket'

/**
 * RUNTIME ROUTING TEST for `host_sync` and `install_sync` — same shape and same
 * reason as useWebSocket.runnerVersions.test.tsx.
 *
 * Both types had a `case` in useWebSocketUpdates but were missing from the
 * `types` array in `onAny()`, so dispatch() dropped every frame silently. The
 * visible symptom: saving an env var (or Start / Stop) on the Computers page
 * spun "Saving…" until its 120s timeout even though the machine applied it in
 * a second, because the ['computers'] refetch never fired.
 *
 * DELETING EITHER onAny() ENTRY MUST TURN THIS TEST RED WHILE THE CODE STILL
 * COMPILES.
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

describe('host_sync / install_sync routing — RAW frame -> query invalidation', () => {
  it('host_sync refetches the computers roster', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    // The literal wire string, not the enum — this is what the server sends.
    FakeWebSocket.last!.receive({ type: 'host_sync', payload: {} })

    expect(invalidatedKeys(spy)).toContainEqual(['computers'])
    unmount()
  })

  it('install_sync refetches install progress', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive({ type: 'install_sync', payload: {} })

    expect(invalidatedKeys(spy)).toContainEqual(['install-progress'])
    unmount()
  })
})

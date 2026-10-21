import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { ControlMessageType } from '../types'
import { useRunnerVersionStore } from '../stores/runnerVersionStore'
import { useWebSocketUpdates } from './useWebSocket'

/**
 * MANDATORY TEST (c) — THE RUNTIME ROUTING TEST.
 *
 * Registering a control message type takes edits in TWO files, and only one of
 * them fails loudly. Adding the enum member to `types/index.ts` makes the `case`
 * in useWebSocket compile; forgetting the same type in the `types` array inside
 * `onAny()` (`api/websocket.ts`) makes `dispatch()` drop the frame with no
 * handler, no warning and no console.error. The result type-checks, it lints,
 * and it ships completely inert — the same failure signature as a banner that
 * never renders.
 *
 * A grep proves the lines exist. Only this proves the WIRE REACHES THE STORE: it
 * pushes a RAW `runner_versions` frame in over the socket's own `onmessage` and
 * asserts the store was written.
 *
 * DELETING THE onAny() ENTRY MUST TURN THIS TEST RED WHILE THE CODE STILL
 * COMPILES. That is the entire point of the file.
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
  useRunnerVersionStore.setState({ runners: null })
})

afterEach(() => {
  wsManager.disconnect()
  vi.unstubAllGlobals()
})

const FRAME = {
  // The literal wire string, not the enum — this is what the server sends.
  type: 'runner_versions',
  payload: {
    runners: [
      { id: 'a1b2', name: 'clawmeets-backend', version: '1.2.10' },
      { id: 'c3d4', name: 'clawmeets-frontend', version: null },
    ],
  },
}

describe('runner_versions routing — RAW frame -> store', () => {
  it('reaches the store through onAny + dispatch', () => {
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    const socket = FakeWebSocket.last!
    expect(socket).toBeTruthy()

    // Never hydrated before the first frame.
    expect(useRunnerVersionStore.getState().runners).toBeNull()

    socket.receive(FRAME)

    const runners = useRunnerVersionStore.getState().runners
    expect(runners).toHaveLength(2)
    expect(runners![0]).toEqual({ id: 'a1b2', name: 'clawmeets-backend', version: '1.2.10' })
    // `version: null` survives the round trip as null — never "unknown", never
    // omitted. This is the field most likely to drift from api/control.py.
    expect(runners![1].version).toBeNull()

    unmount()
  })

  it('invalidates the announcements config query on the same frame', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(FRAME)

    // This is what preserves "editing announcements.json takes effect with no
    // server restart"; the ETag makes it a 304 in the common case.
    expect(spy).toHaveBeenCalledWith(
      { queryKey: ['announcements'] },
      { cancelRefetch: false },
    )

    unmount()
  })

  it('is subscribed by onAny — an unregistered type would be dropped silently', () => {
    // Subscribing through the same seam the app uses proves RUNNER_VERSIONS is
    // in the `types` array, not merely in the enum.
    const seen: string[] = []
    const unsubscribe = wsManager.onAny(env => { seen.push(env.type) })
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.receive({ type: 'runner_versions', payload: { runners: [] } })
    unsubscribe()

    expect(seen).toContain('runner_versions')
  })

  it('the wire string and the enum member agree', () => {
    // Cheap guard against a rename on one side only.
    expect(ControlMessageType.RUNNER_VERSIONS).toBe('runner_versions')
  })

  it('an initial push with an empty runners list hydrates to [] , not null', () => {
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive({ type: 'runner_versions', payload: { runners: [] } })

    // The `runners` key is always present on the initial browser-connect push,
    // `[]` included — so there is exactly one empty state.
    expect(useRunnerVersionStore.getState().runners).toEqual([])

    unmount()
  })

  it('a later frame with no runners key leaves the delivered list intact', () => {
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    const socket = FakeWebSocket.last!

    socket.receive(FRAME)
    expect(useRunnerVersionStore.getState().runners).toHaveLength(2)

    // A degenerate push must not clear a correct snapshot.
    socket.receive({ type: 'runner_versions', payload: {} })
    expect(useRunnerVersionStore.getState().runners).toHaveLength(2)

    unmount()
  })
})

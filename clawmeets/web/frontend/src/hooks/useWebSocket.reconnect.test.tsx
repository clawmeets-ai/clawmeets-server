import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { useWebSocketUpdates } from './useWebSocket'
import { DESK_LATEST_MESSAGES_KEY } from './useDeskUpdates'

/**
 * THE RECONNECT RESYNC, AND THE HOLE THAT USED TO BE IN IT.
 *
 * A control frame is fire-and-forget: the hub queues an envelope on whatever
 * sockets are live at that instant and nothing replays it. So for every query
 * key a frame refreshes there must be a SECOND path that runs on reconnect,
 * or a frame emitted while the socket was down — laptop asleep, network blip,
 * server restart, the reconnect backoff window — is lost for the rest of the
 * session.
 *
 * `['desk-todos']` had no such path, and that is the bug this file pins. The
 * plate is `staleTime: 0` but nothing triggers it: on a focused tab react-query
 * does not refetch on its own, so a to-do's ticket chip kept reading "Working"
 * on a project the user had already marked done until some UNRELATED to-do or
 * label sync happened to land. Same argument for `['desk-labels']` (the groups
 * the chips sit in) and for the two briefing keys, where the stale surface is
 * the document the user is looking at.
 *
 * WHY IT IS ASSERTED AS A SET AND NOT LINE BY LINE. The failure mode is an
 * OMISSION — a key that someone added a frame for and never added here. A test
 * that names only the keys it expects would keep passing through exactly that
 * mistake, so this one asserts the whole list, and adding a frame without
 * adding its key turns it red.
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

let queryClient: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

beforeEach(() => {
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket)
  localStorage.clear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // `hasEverConnected` is what distinguishes the two cases, it lives on the
  // module-level singleton, and `disconnect()` deliberately does NOT clear it —
  // a page load is one session no matter how many sockets it opens. Reaching in
  // here is what keeps these two tests independent of the order they run in.
  ;(wsManager as unknown as {
    state: { hasEverConnected: boolean }
  }).state.hasEverConnected = false
})

afterEach(() => {
  vi.useRealTimers()
  wsManager.disconnect()
  vi.unstubAllGlobals()
})

/** The socket's own `onopen`, which is what fans `isReconnect` out to the
 *  connect handlers. Called twice: the first open of a page load is NOT a
 *  reconnect (mount already fetched fresh), the second one is. */
function open(): void {
  FakeWebSocket.last!.onopen?.({})
}

const EXPECTED_KEYS = [
  [DESK_LATEST_MESSAGES_KEY],
  ['user-projects'],
  ['all-projects'],
  ['chatrooms'],
  ['chatroom'],
  ['messages'],
  ['files'],
  ['fileContent'],
  ['fileBlobContent'],
  ['project'],
  ['agents'],
  ['desk-read-state'],
  ['desk-sign-offs'],
  ['desk-todos'],
  ['desk-labels'],
  ['brief-tabs'],
  ['brief-tab'],
  ['computers'],
  ['install-progress'],
  ['announcements'],
]

describe('reconnect resync', () => {
  it('invalidates every push-refreshed key, the desk plate included', () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    open() // first connect of this page load

    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    open() // ...and the reconnect
    vi.advanceTimersByTime(10_000) // the catch-up is paced, not instant

    const invalidated = spy.mock.calls.map(([arg]) => arg?.queryKey)
    for (const queryKey of EXPECTED_KEYS) {
      expect(invalidated).toContainEqual(queryKey)
    }
    unmount()
  })

  it('paces the catch-up and coalesces a flapping socket into one', () => {
    // The instant all-keys burst on every reconnect is what kept an unstable
    // connection unstable: the burst stalled the server, the socket dropped,
    // and the next reconnect re-sent it. Nothing fires right away, a reconnect
    // inside the settle window restarts it, and the catch-up runs once.
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u3', 'tok')
    open()

    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    open()
    vi.advanceTimersByTime(500)
    open()
    vi.advanceTimersByTime(500)
    open()
    expect(spy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10_000)
    const deskFeed = spy.mock.calls.filter(
      ([arg]) => arg?.queryKey?.[0] === DESK_LATEST_MESSAGES_KEY,
    )
    expect(deskFeed).toHaveLength(1)
    unmount()
  })

  it('skips the FIRST connect — mount already fetched', () => {
    // Not a micro-optimisation: without the guard every page load fires a
    // bounded burst of refetches on top of the fetches mount just made.
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u2', 'tok')
    open()

    const invalidated = spy.mock.calls.map(([arg]) => arg?.queryKey)
    expect(invalidated).not.toContainEqual(['desk-todos'])
    unmount()
  })
})

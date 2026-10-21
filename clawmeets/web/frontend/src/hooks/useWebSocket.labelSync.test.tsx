import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { ControlMessageType } from '../types'
import { useDeskLabelViewStore } from '../stores/deskLabelViewStore'
import { useWebSocketUpdates } from './useWebSocket'

/**
 * THE RUNTIME ROUTING TEST for DESK_LABEL_SYNC.
 *
 * Registering a control message type takes edits in four files and SIX places,
 * and exactly ONE of them fails loudly (the enum member, which makes the
 * `case` compile). The rest fail silently, and one of them ships completely
 * inert: a type present in the enum but missing from the `types` array inside
 * `onAny()` is dropped by `dispatch()` with no handler, no warning and no
 * console.error. It type-checks, it lints, and registry edits in another tab
 * simply never land.
 *
 * A grep proves the lines exist. Only this proves THE WIRE REACHES THE STORE:
 * it pushes a RAW `desk_label_sync` frame in over the socket's own `onmessage`
 * and asserts what the app does with it.
 *
 * DELETING THE onAny() ENTRY MUST TURN THIS FILE RED WHILE THE CODE STILL
 * COMPILES. That is the entire point of it.
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
  useDeskLabelViewStore.getState().reset()
})

afterEach(() => {
  wsManager.disconnect()
  vi.unstubAllGlobals()
})

const frame = (payload: Record<string, unknown>) => ({
  // The literal wire string, not the enum — this is what the server sends.
  type: 'desk_label_sync',
  payload,
})

describe('desk_label_sync routing — RAW frame -> query cache + store', () => {
  it('invalidates BOTH query keys', () => {
    // The registry key alone is not enough: delete and merge move both
    // documents, so a client that refetches only the registry renders correct
    // groups over stale items.
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(frame({ action: 'add', slug: 'infra' }))

    expect(spy).toHaveBeenCalledWith({ queryKey: ['desk-labels'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['desk-todos'] })

    unmount()
  })

  it('is subscribed by onAny — an unregistered type would be dropped silently', () => {
    // Subscribing through the same seam the app uses proves DESK_LABEL_SYNC is
    // in the `types` array, not merely in the enum. THIS is the assertion that
    // catches edit site #3.
    const seen: string[] = []
    const unsubscribe = wsManager.onAny((env) => {
      seen.push(env.type)
    })
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.receive(frame({ action: 'reorder', slug: null }))
    unsubscribe()

    expect(seen).toContain('desk_label_sync')
  })

  it('the wire string and the enum member agree', () => {
    expect(ControlMessageType.DESK_LABEL_SYNC).toBe('desk_label_sync')
  })

  it('a merge frame records the hint so a filter can FOLLOW the merge', () => {
    // This is the whole reason `into` is on the envelope: a tab that did not
    // perform the merge has no response to read it from, and without it the
    // filter would have to degrade to clear-and-notice.
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(frame({ action: 'merge', slug: 'office', into: 'work' }))

    expect(useDeskLabelViewStore.getState().mergeHints).toEqual([
      { from: 'office', into: 'work' },
    ])

    unmount()
  })

  it('a DELETE frame records no merge hint — the two are not the same case', () => {
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(frame({ action: 'delete', slug: 'office' }))

    expect(useDeskLabelViewStore.getState().mergeHints).toEqual([])

    unmount()
  })

  it('a merge frame missing `into` degrades instead of recording a bad hint', () => {
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(frame({ action: 'merge', slug: 'office' }))

    // No hint, so the reconcile treats it as a deletion and CLEARS the filter
    // with a notice — the documented fallback, not a crash and not a silent
    // re-point at nothing.
    expect(useDeskLabelViewStore.getState().mergeHints).toEqual([])

    unmount()
  })

  it('an auto-registration frame from a to-do write is handled like any other', () => {
    // POST/PATCH /me/desk/todos emit one add per slug they auto-register, so
    // this envelope arrives from more than the six registry endpoints.
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(frame({ action: 'add', slug: 'waiting-on-bank' }))

    expect(spy).toHaveBeenCalledWith({ queryKey: ['desk-labels'] })

    unmount()
  })
})

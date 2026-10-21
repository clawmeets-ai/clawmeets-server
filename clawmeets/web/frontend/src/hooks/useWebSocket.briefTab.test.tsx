import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { ControlMessageType } from '../types'
import { useWebSocketUpdates } from './useWebSocket'

/**
 * F2 — THE INVALIDATION THE PER-SLUG SPLIT ADDED.
 *
 * The document used to arrive inside the list, so invalidating ['brief-tabs']
 * refreshed everything there was. It lives under its own key now, and a
 * scheduled refresh landing on the briefing the user is CURRENTLY LOOKING AT
 * would otherwise update the list and leave the open document stale — with the
 * "Refreshed …" line in the page header disagreeing with the content beneath
 * it, and nothing anywhere reporting a problem. That is AC-4.2's frontend half
 * failing silently, which is the only kind of failure worth a test this cheap.
 *
 * Driven through a RAW wire frame rather than by calling the handler: the
 * envelope has to reach the handler at all, and a type missing from `onAny()`'s
 * subscription list is dropped with no warning.
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
})

afterEach(() => {
  wsManager.disconnect()
  vi.unstubAllGlobals()
})

const frame = (payload: Record<string, unknown>) => ({
  // The literal wire string, not the enum — this is what the server sends.
  type: 'brief_tab_sync',
  payload,
})

describe('brief_tab_sync routing — the list AND the open document', () => {
  it('invalidates BOTH query keys', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(
      frame({
        action: 'upsert',
        slug: 'wine',
        title: 'Wine inventory',
        generated_at: '2026-09-08T10:00:00Z',
      }),
    )

    expect(spy).toHaveBeenCalledWith({ queryKey: ['brief-tabs'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brief-tab'] })

    unmount()
  })

  it('a delete envelope invalidates both too', () => {
    // A briefing deleted while open must stop rendering its cached document,
    // not keep showing one the server would now 404.
    //
    // THE LIST HALF IS WHAT MAKES A DELETE CROSS TABS. The owner deletes a
    // briefing in one tab; the server broadcasts to every session they have
    // open, and it is THIS invalidation — nothing in the rail — that takes the
    // row off the My Desk rail in the others without a reload. The rail has no
    // delete code of its own on this path, which is exactly why the assertion
    // belongs here.
    //
    // And note what is NOT here: no navigation. A tab that received this
    // envelope rather than pressing the button is left where it is — if it is
    // reading the deleted briefing, the document invalidation above walks it
    // into BriefingPage's "no longer published" frame with its way back, which
    // is a better answer than yanking the page out from under someone who
    // pressed nothing. Only the tab that pressed delete redirects, and that
    // lives in `useDeleteBriefTab`.
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(frame({ action: 'delete', slug: 'wine' }))

    expect(spy).toHaveBeenCalledWith({ queryKey: ['brief-tabs'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['brief-tab'] })

    unmount()
  })

  it('the two keys do not collide', () => {
    // react-query matches keys ELEMENT-WISE, so ['brief-tab'] is not a prefix
    // match for ['brief-tabs'] even though the strings are. If that were not
    // true, one invalidation would do and the added line would be noise —
    // which is the reading this assertion exists to rule out.
    const list = queryClient.getQueryCache().build(queryClient, {
      queryKey: ['brief-tabs', 'u1'],
    })
    const doc = queryClient.getQueryCache().build(queryClient, {
      queryKey: ['brief-tab', 'u1', 'wine'],
    })

    const matchesDocKey = queryClient
      .getQueryCache()
      .findAll({ queryKey: ['brief-tab'] })
      .map((q) => q.queryHash)

    expect(matchesDocKey).toContain(doc.queryHash)
    expect(matchesDocKey).not.toContain(list.queryHash)
  })

  it('the wire string and the enum member agree', () => {
    expect(ControlMessageType.BRIEF_TAB_SYNC).toBe('brief_tab_sync')
  })
})

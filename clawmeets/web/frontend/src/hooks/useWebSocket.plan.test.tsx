import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { ControlMessageType } from '../types'
import { useWebSocketUpdates } from './useWebSocket'

/**
 * THE RUNTIME ROUTING TEST for PROJECT_PLAN_SYNC.
 *
 * Registering a control message type takes edits in FOUR files and only one of
 * them fails loudly. The enum member in `types/index.ts` makes the `case` in
 * useWebSocket compile — miss it and nothing builds. Miss the same type in the
 * `types` array inside `onAny()` (`api/websocket.ts`) and `dispatch()` drops the
 * frame with no handler, no warning and no console.error: it type-checks, it
 * lints, and it ships completely inert. The Plan tab simply stops updating and
 * nothing anywhere says why.
 *
 * A grep proves the lines exist. Only this proves the WIRE REACHES THE QUERY
 * CACHE: it pushes a RAW `project_plan_sync` frame in over the socket's own
 * `onmessage` and asserts the invalidation happened.
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

/** The literal wire frame, transcribed from `ProjectPlanSyncPayload`. Seven
 *  members, `by_agent_name` and `updated_at` among them, and NO `project_name`.
 *  The action vocabulary is eleven values; `write` is one. */
const FRAME = {
  type: 'project_plan_sync',
  payload: {
    project_id: 'p-1',
    action: 'write',
    sections: ['milestones'],
    sha: 'abc123',
    revision: 4,
    by_agent_name: 'clawmeets-backend',
    updated_at: '2026-08-23T10:00:00Z',
  },
}

describe('project_plan_sync routing — RAW frame -> query invalidation', () => {
  it('reaches the query cache through onAny + dispatch', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')
    expect(FakeWebSocket.last).toBeTruthy()

    FakeWebSocket.last!.receive(FRAME)

    expect(spy).toHaveBeenCalledWith({ queryKey: ['project-plan', 'p-1'] })
    unmount()
  })

  it('invalidates the PROJECT LISTS too, because PlanSummary rides the record', () => {
    // `open_notes_for_you` — the integer the execution gate reads — hangs on the
    // project record, not on the plan index. Leaving the lists out is how the
    // tab and the desk card come to disagree about one number.
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive(FRAME)

    expect(spy).toHaveBeenCalledWith({ queryKey: ['project', 'p-1'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['user-projects'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['all-projects'] })
    unmount()
  })

  it('is subscribed by onAny — an unregistered type would be dropped silently', () => {
    const seen: string[] = []
    const unsubscribe = wsManager.onAny((env) => {
      seen.push(env.type)
    })
    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.receive(FRAME)
    unsubscribe()

    expect(seen).toContain('project_plan_sync')
  })

  it('the wire string and the enum member agree', () => {
    expect(ControlMessageType.PROJECT_PLAN_SYNC).toBe('project_plan_sync')
  })

  it('a note-only action carries no sections and still refreshes', () => {
    // `sections` is `[]` for an action that wrote no bytes. That is honest
    // rather than empty, and it must not gate the refresh: a filed note changes
    // `open_notes_for_you` without moving one byte of the document.
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive({
      type: 'project_plan_sync',
      payload: {
        project_id: 'p-1',
        action: 'note',
        sections: [],
        sha: '',
        revision: 0,
        by_agent_name: 'someone',
        updated_at: '2026-08-23T10:00:00Z',
      },
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ['project-plan', 'p-1'] })
    unmount()
  })

  it('a frame with no project_id invalidates nothing', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useWebSocketUpdates(), { wrapper })
    wsManager.connectAsUser('u1', 'tok')

    FakeWebSocket.last!.receive({ type: 'project_plan_sync', payload: {} })

    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['project-plan']) }),
    )
    unmount()
  })
})

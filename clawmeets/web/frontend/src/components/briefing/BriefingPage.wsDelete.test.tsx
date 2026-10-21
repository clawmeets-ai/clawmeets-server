import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../stores/authStore'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { wsManager } from '../../api/websocket'
import { ApiError } from '../../api/client'
import { useWebSocketUpdates } from '../../hooks/useWebSocket'
import BriefingPage from './BriefingPage'

/**
 * AC-2.2, THE HALF THAT IS AN ABSENCE.
 *
 * The owner has the same briefing open in two tabs and deletes it in one. The
 * tab that PRESSED delete goes back to `/desk` — that is `useDeleteBriefTab`'s
 * job and `MyDeskRailPanel.delete.test.tsx` pins it. THIS file is the other
 * tab: the one that pressed nothing and only received the broadcast. It must
 * NOT be navigated anywhere. It stays on `/desk/briefings/wine` and walks into
 * the "no longer published" frame, because yanking the page out from under a
 * reader who did not ask for anything is the worse answer.
 *
 * Why a whole file rather than a case in `BriefingPage.test.tsx`: that suite
 * mocks `useBriefTabDocument` and hands the page a 404 directly, so it can
 * assert what the page RENDERS for an error but can never show that a delete
 * envelope is what produced it. The behaviour under test here is a chain —
 * wire frame → `useWebSocketUpdates` → `['brief-tab']` invalidation → refetch
 * → 404 → the lifecycle branch — and every link has to be real or the test
 * proves nothing. So the mock boundary is the ENDPOINT, and the envelope goes
 * in as a raw wire frame.
 *
 * And the assertion that carries the criterion is the negative one: the
 * location is unchanged. It would fail the moment someone "helpfully" moved
 * the redirect out of the mutation and into the websocket handler, where it
 * would look like a tidy consolidation and would silently start closing the
 * page on the reader.
 */

const getBriefTab = vi.fn()

vi.mock('../../api/endpoints/briefTabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/briefTabs')>()
  return { ...actual, getBriefTab: (slug: string) => getBriefTab(slug) }
})

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

const DOCUMENT = {
  slug: 'wine',
  title: 'Wine inventory',
  owner_user_id: 'u1',
  owner_agent_id: 'a1',
  owner_agent_name: 'sommelier',
  generated_at: '2026-09-08T10:00:00Z',
  html: '<!doctype html><html><head></head><body>cases</body></html>',
}

let queryClient: QueryClient
let location: string

function Probe() {
  location = useLocation().pathname
  return null
}

/** Mounts the websocket subscription as a SIBLING of the page, which is how
 *  the app has it: `useWebSocketUpdates` lives up in the shell, not in
 *  `BriefingPage`. A test that called the handler directly could not catch the
 *  failure that actually happens here — a message type missing from `onAny()`'s
 *  subscription list, which is dropped with no warning. */
function WsListener() {
  useWebSocketUpdates()
  return null
}

function renderReader() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/desk/briefings/wine']}>
        <Probe />
        <WsListener />
        <Routes>
          <Route path="/desk/briefings/:slug" element={<BriefingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket)
  localStorage.clear()
  // The document query is `enabled: !!userId` — without a real session it
  // never fires and every assertion below would pass against a page that
  // simply never asked for anything.
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  getBriefTab.mockResolvedValue(DOCUMENT)
})

afterEach(() => {
  cleanup()
  wsManager.disconnect()
  vi.unstubAllGlobals()
  useAuthStore.getState().logout()
})

describe("a delete arriving from the owner's OTHER tab", () => {
  it('leaves this reader where they are, on the "no longer published" frame', async () => {
    const { unmount } = renderReader()
    // Reading it for real first: the frame is on screen and the location is
    // the briefing's own URL. Starting from the error state would make the
    // "did not navigate" assertion vacuous.
    await screen.findByTitle('Wine inventory')
    expect(location).toBe('/desk/briefings/wine')

    wsManager.connectAsUser('u1', 'tok')
    // The briefing is gone from the server now; the refetch the envelope
    // triggers is what discovers it, exactly as it would in the real tab.
    getBriefTab.mockRejectedValue(new ApiError(404, 'Not Found'))
    FakeWebSocket.last!.receive({
      // The literal wire string, not the enum — this is what the server sends.
      type: 'brief_tab_sync',
      payload: { action: 'delete', slug: 'wine' },
    })

    await waitFor(() => expect(screen.getByText(/no longer published/i)).toBeTruthy())
    // The way back is offered, not taken for them.
    expect(screen.getByText(/Back to My Desk/i)).toBeTruthy()
    expect(location).toBe('/desk/briefings/wine')

    unmount()
  })

  it('does not navigate away when a DIFFERENT briefing is deleted either', async () => {
    const { unmount } = renderReader()
    await screen.findByTitle('Wine inventory')

    wsManager.connectAsUser('u1', 'tok')
    FakeWebSocket.last!.receive({
      type: 'brief_tab_sync',
      payload: { action: 'delete', slug: 'sales' },
    })

    // The invalidation is deliberately slug-blind on the document key, so this
    // briefing refetches too — and answers 200, because it still exists.
    await waitFor(() => expect(getBriefTab).toHaveBeenCalledTimes(2))
    expect(screen.getByTitle('Wine inventory')).toBeTruthy()
    expect(location).toBe('/desk/briefings/wine')

    unmount()
  })
})

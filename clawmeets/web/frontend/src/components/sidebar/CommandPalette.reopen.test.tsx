import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentCard, MessageSearchResponse, SearchHit } from '../../types'

/**
 * Review finding 3 — close → reopen must not flash the previous search.
 *
 * This lives in its own file because it needs the things CommandPalette.test.tsx
 * deliberately stubs away: the REAL useMessageSearch (so the 150 ms debounce is
 * real) and a REAL QueryClient that keeps its cache across the close (so the
 * previous query's response is still there to be served synchronously). Neither
 * of the two other palette suites can see this defect — they hand the component
 * a `MessageSearchState` literal, so no sequence of opens and closes they drive
 * can produce a stale one.
 *
 * The pre-fix mechanism, for whoever reads this after breaking it again:
 * `query` was reset by an on-open EFFECT, and an effect runs after the render
 * it is meant to correct. So the first render after ⌘K still had `invoice` in
 * state, `useDebouncedValue` still held `invoice`, React Query answered the
 * key `['message-search','invoice']` from cache, and the Messages section
 * painted the old hits. Clearing the box then started a fresh 150 ms timer, so
 * the hits stayed up under an empty input for the whole window. The fix is
 * structural: the palette body unmounts on close, so there is no surviving
 * state to be stale.
 */

const navigate = vi.fn()
const onClose = vi.fn()
const searchMessages = vi.fn()

const HIT: SearchHit = {
  message_id: 'm1',
  project_id: 'p1',
  project_name: 'chat-search-typeahead',
  room_id: 'shared-context',
  room_type: 'project',
  room_label: 'shared-context',
  ts: '2026-07-26T14:03:11.482000Z',
  author_id: 'agent_1',
  author_name: 'clawmeets-backend',
  snippet: 'the invoice never arrived',
  snippet_truncated_start: false,
  snippet_truncated_end: false,
  match_offsets: [[4, 11]],
  score: 6.2,
  deep_link: {
    path: '/projects/p1/chatrooms/shared-context?msg=m1',
    kind: 'project_room',
    project_id: 'p1',
    chatroom_name: 'shared-context',
    agent_name: null,
    message_id: 'm1',
  },
}

function response(query: string, hits: SearchHit[]): MessageSearchResponse {
  return {
    query,
    hits,
    limit: 20,
    offset: 0,
    has_more: false,
    next_offset: null,
    indexing: false,
    took_ms: 12,
  }
}

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('../../hooks/useSops', () => ({ useSops: () => ({ sops: [], isLoading: false }) }))
vi.mock('../../hooks/useTodos', () => ({ useTodos: () => ({ todos: [], isLoading: false }) }))
vi.mock('../../hooks/useSopRecents', () => ({
  useSopRecents: () => ({ recentIds: [], touch: vi.fn() }),
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] as AgentCard[] }) }))
vi.mock('../../hooks/useAgentAccess', () => ({ useRetainedAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useTeamGroups', () => ({
  useTeamGroups: () => ({ sortedTeamNames: [], teamBuckets: new Map() }),
}))
vi.mock('../../hooks/useChannelThreads', () => ({
  useChannelThreads: () => ({ state: 'ready', byProject: new Map() }),
}))
vi.mock('../../hooks/useDmThreads', () => ({ useDmThreads: () => ({ groups: [] }) }))
vi.mock('../../hooks/useProjects', () => ({
  useUserProjects: () => ({ data: [] }),
  useAllProjects: () => ({ data: [] }),
}))
vi.mock('../../stores/uiStore', () => ({
  useUIStore: () => ({
    expandedAgentTeams: new Set<string>(),
    toggleAgentTeam: vi.fn(),
    expandAgentTeam: vi.fn(),
    setRailContext: vi.fn(),
    setProjectExpanded: vi.fn(),
  }),
}))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (sel?: (s: Record<string, unknown>) => unknown) => {
    const state = { user: { id: 'u1', username: 'ana' } }
    return sel ? sel(state) : state
  },
}))
vi.mock('../../stores/deskStore', () => ({
  useDeskStore: (sel: (s: Record<string, () => void>) => unknown) =>
    sel({ requestSop: vi.fn(), requestTask: vi.fn(), requestRailTab: vi.fn() }),
}))
vi.mock('../../stores/unsavedGuard', () => ({ confirmLeaveIfDirty: () => true }))

// The ONE thing stubbed on the search path: the HTTP call. Everything above it
// — debounce, query key, cache, the `data.query === debounced` guard — is real.
vi.mock('../../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints')>()
  return { ...actual, searchMessages: (...args: unknown[]) => searchMessages(...args) }
})

Element.prototype.scrollIntoView = vi.fn()

const { default: CommandPalette } = await import('./CommandPalette')

// One client for the whole sequence: the close must NOT throw the cache away,
// or the test would pass for the wrong reason.
let client: QueryClient

function paletteAt(open: boolean) {
  return (
    <QueryClientProvider client={client}>
      <CommandPalette open={open} onClose={onClose} />
    </QueryClientProvider>
  )
}

const input = () => screen.queryByPlaceholderText(/Jump to a tab/) as HTMLInputElement | null

describe('CommandPalette — reopening after a search', () => {
  beforeEach(() => {
    navigate.mockReset()
    onClose.mockReset()
    searchMessages.mockReset()
    searchMessages.mockImplementation(async (params: { q: string }) =>
      response(params.q, [HIT]),
    )
    client = new QueryClient({
      // Mirrors src/queryClient.ts — the cache retention that makes the stale
      // render possible is the production setting, not a test artefact.
      defaultOptions: { queries: { staleTime: 30000, retry: 1 } },
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('shows no trace of the previous query on reopen', async () => {
    const { rerender } = render(paletteAt(true))

    fireEvent.change(input()!, { target: { value: 'invoice' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200) // past the 150 ms debounce
    })
    await waitFor(() => expect(screen.getByText(/never arrived/)).toBeTruthy())
    expect(searchMessages).toHaveBeenCalledTimes(1)

    // Esc / click-away.
    rerender(paletteAt(false))
    expect(input()).toBeNull()
    // The response is still cached — this is the retention the defect needs.
    expect(client.getQueryData(['message-search', 'invoice'])).toBeTruthy()

    // ⌘K. No timers advanced and nothing awaited: this assertion is the FIRST
    // paint after reopening, which is the frame the defect lived in.
    rerender(paletteAt(true))
    expect(input()!.value).toBe('')
    expect(screen.queryByText(/never arrived/)).toBeNull()
    expect(document.querySelector('mark')).toBeNull()

    // ...and still nothing once the old debounce window would have expired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(screen.queryByText(/never arrived/)).toBeNull()
    // An empty box searches for nothing: no second request went out either.
    expect(searchMessages).toHaveBeenCalledTimes(1)
  })

  it('searches again normally once the reopened palette is typed into', async () => {
    // The fix must not cost the feature: a fresh mount still searches, and it
    // may legitimately serve the same cached response for the same query.
    const { rerender } = render(paletteAt(true))
    fireEvent.change(input()!, { target: { value: 'invoice' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    await waitFor(() => expect(screen.getByText(/never arrived/)).toBeTruthy())

    rerender(paletteAt(false))
    rerender(paletteAt(true))

    fireEvent.change(input()!, { target: { value: 'invoice' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    await waitFor(() => expect(screen.getByText(/never arrived/)).toBeTruthy())
  })
})

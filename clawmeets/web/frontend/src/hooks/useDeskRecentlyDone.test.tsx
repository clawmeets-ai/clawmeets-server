import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SignOffCard, SignOffFeed } from '../api/endpoints/deskSignOffs'
import type { DeskUpdate } from './useDeskUpdates'

/**
 * "Recently done" is the server's newest-first sign-off page put through three
 * client-side passes — drop projects that came back to life, collapse a project
 * that holds rows for two chatrooms, then take five. Those passes are the whole
 * behavior of the section and none of them is visible to the server, so this
 * file is what stands between them and a silent regression.
 *
 * What each test pins down:
 *   - the request carries a COUNT and no date (the day boundary is gone, which
 *     is the point of the change — a section keyed on local midnight empties
 *     itself every morning);
 *   - a project that is live again is dropped even though its watermark stands,
 *     because it renders in Working and must not also render as history;
 *   - one project never spends two of the five slots;
 *   - the cap is five, applied AFTER the two filters so a dropped row is
 *     backfilled rather than costing a slot;
 *   - server order survives untouched — nothing here re-sorts;
 *   - a signed-off card carries the SAME Plan + Report facts its live sibling
 *     carried in Review, hydrated from the project list rather than the
 *     sign-off feed (which ships neither) — and a DM, absent from that list,
 *     stays Response-only.
 */

const getDeskSignOffs = vi.fn<(p?: { sinceIso?: string; limit?: number }) => Promise<SignOffFeed>>()

vi.mock('../api/endpoints/deskSignOffs', () => ({
  getDeskSignOffs: (p?: { sinceIso?: string; limit?: number }) => getDeskSignOffs(p),
}))

vi.mock('../stores/authStore', () => ({
  useAuthStore: (sel: (s: { user: { id: string; role?: string } }) => unknown) =>
    sel({ user: { id: 'u1' } }),
}))

vi.mock('./useAgents', () => ({
  useAgents: () => ({ data: [{ id: 'coord-1', name: 'bob-backend' }] }),
}))

// The project list the bands are hydrated from — the same source the live desk
// lanes read `plan` / `report_published_at` off. Mutated per-test before render.
let projectViews: Array<Record<string, unknown>> = []
let projectsLoading = false
vi.mock('./useProjectsWithChatrooms', () => ({
  useProjectsWithChatrooms: () => ({
    data: projectViews.length > 0 ? projectViews : undefined,
    isLoading: projectsLoading,
    error: null,
  }),
}))

// The live feed the hook subtracts. Mutated per-test before render.
let liveUpdates: DeskUpdate[] = []
vi.mock('./useDeskUpdates', () => ({
  useDeskUpdates: () => ({ updates: liveUpdates }),
}))

const { useDeskRecentlyDone } = await import('./useDeskRecentlyDone')

/** One wire row. `room` matters only for the two-rooms-one-project case. */
function row(projectId: string, room = 'user-communication'): SignOffCard {
  return {
    project_id: projectId,
    chatroom_name: room,
    kind: 'project',
    coordinator_id: 'coord-1',
    agent_name: 'bob-backend',
    source_name: projectId,
    title: projectId,
    quote: 'done',
    quoted_message_id: `m-${projectId}-${room}`,
    files: [],
    signed_off_at: '2035-01-01T00:00:00+00:00',
  }
}

function feed(cards: SignOffCard[]): SignOffFeed {
  return { cards, last_signed_off_at: '2035-01-01T00:00:00+00:00' }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  liveUpdates = []
  projectViews = []
  projectsLoading = false
  getDeskSignOffs.mockReset()
})
afterEach(cleanup)

describe('useDeskRecentlyDone', () => {
  it('asks for a count, not a day boundary', async () => {
    getDeskSignOffs.mockResolvedValue(feed([row('p1')]))

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    await waitFor(() => expect(result.current.cards).toHaveLength(1))
    const params = getDeskSignOffs.mock.calls[0][0]
    expect(params?.sinceIso).toBeUndefined()
    // Deliberately more than the five shown, so the filters below have slack to
    // backfill from.
    expect(params?.limit).toBeGreaterThan(5)
  })

  it('drops a project that has come back to life', async () => {
    liveUpdates = [{ projectId: 'p2' } as DeskUpdate]
    getDeskSignOffs.mockResolvedValue(feed([row('p1'), row('p2'), row('p3')]))

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    await waitFor(() => expect(result.current.cards).toHaveLength(2))
    expect(result.current.cards.map((c) => c.projectId)).toEqual(['p1', 'p3'])
  })

  it('collapses two chatrooms of one project into a single slot', async () => {
    getDeskSignOffs.mockResolvedValue(
      feed([row('p1', 'user-communication'), row('p1', 'milestone-1'), row('p2')]),
    )

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    await waitFor(() => expect(result.current.cards).toHaveLength(2))
    expect(result.current.cards.map((c) => c.projectId)).toEqual(['p1', 'p2'])
    // The newest row wins — the first one the server handed back.
    expect(result.current.cards[0].latestMessageId).toBe('m-p1-user-communication')
  })

  it('shows five, backfilling past dropped rows instead of shortening', async () => {
    liveUpdates = [{ projectId: 'p2' } as DeskUpdate]
    getDeskSignOffs.mockResolvedValue(
      feed([
        row('p1'),
        row('p2'), // live again — dropped
        row('p3'),
        row('p3', 'milestone-1'), // same project — collapsed
        row('p4'),
        row('p5'),
        row('p6'),
        row('p7'), // past the cap
      ]),
    )

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    await waitFor(() => expect(result.current.cards).toHaveLength(5))
    // Server order preserved; nothing re-sorted.
    expect(result.current.cards.map((c) => c.projectId)).toEqual([
      'p1', 'p3', 'p4', 'p5', 'p6',
    ])
  })

  it('reports the all-time last sign-off even when every card is filtered out', async () => {
    liveUpdates = [{ projectId: 'p1' } as DeskUpdate]
    getDeskSignOffs.mockResolvedValue(feed([row('p1')]))

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    // The empty state's "Last one …" sentence hangs off this, so it must
    // outlive the filtering that emptied the section.
    await waitFor(() =>
      expect(result.current.lastSignedOffAt).toBe('2035-01-01T00:00:00+00:00'),
    )
    expect(result.current.cards).toEqual([])
  })

  it('hydrates the Plan and Report facts off the project list', async () => {
    // Neither value rides the sign-off feed; both ride the project list, and
    // the card must carry them so its bands render exactly as they did while
    // the same project sat in Review.
    projectViews = [
      {
        project_id: 'p1',
        plan: { surface: 'regular', phase: 'complete', open_notes_for_you: 0, revision: 4 },
        report_published_at: '2035-01-02T00:00:00+00:00',
      },
    ]
    getDeskSignOffs.mockResolvedValue(feed([row('p1')]))

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    await waitFor(() => expect(result.current.cards).toHaveLength(1))
    expect(result.current.cards[0].plan?.revision).toBe(4)
    expect(result.current.cards[0].reportPublishedAt).toBe('2035-01-02T00:00:00+00:00')
  })

  it('leaves a project the list does not carry band-less rather than placeheld', async () => {
    // A DM is thread-shaped and therefore absent from the project list. It has
    // no plan and no report, so the miss is the correct answer, not a gap.
    getDeskSignOffs.mockResolvedValue(feed([row('p1')]))

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    await waitFor(() => expect(result.current.cards).toHaveLength(1))
    expect(result.current.cards[0].plan).toBeNull()
    expect(result.current.cards[0].reportPublishedAt).toBeNull()
  })

  it('emits nothing until the project list settles', async () => {
    // UpdateCard seeds its open band ONCE, on mount. A card mounted before the
    // contract lands would seed `response` and stay there after the report
    // arrives — so the section stays in its loading state instead.
    projectsLoading = true
    getDeskSignOffs.mockResolvedValue(feed([row('p1')]))

    const { result } = renderHook(() => useDeskRecentlyDone(), { wrapper })

    await waitFor(() =>
      expect(result.current.lastSignedOffAt).toBe('2035-01-01T00:00:00+00:00'),
    )
    expect(result.current.cards).toEqual([])
    expect(result.current.isLoading).toBe(true)
  })
})

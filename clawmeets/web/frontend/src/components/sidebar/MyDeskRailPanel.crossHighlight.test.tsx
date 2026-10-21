import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskUpdate } from '../../hooks/useDeskUpdates'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import { useDeskLinkStore } from '../../stores/deskLinkStore'

/**
 * THE SIDEBAR AS THE THIRD VIEW OF THE PAIR.
 *
 * `DeskPage.crossHighlight.test.tsx` proves the join and the two desk surfaces.
 * What is unproven here is the CROSS-TREE half: this panel lives in the Sidebar
 * tree and the desk in the router Outlet tree, they share no props, and the
 * only thing connecting them is `deskLinkStore`. A version that read the store
 * but never wrote it — or wrote a fourth hover variant the desk cannot read —
 * type-checks perfectly and is silently one-directional.
 *
 * So the store runs FOR REAL and is driven from BOTH ends: writing it directly
 * stands in for the desk (rail as RECEIVER), and a pointer on a sub-row stands
 * in for the user (rail as DRIVER). `useTodos` runs for real too, against a
 * mocked endpoint, because "no new data and no new request" is a claim about
 * the react-query cache and a mocked hook would assert it away.
 *
 * The class name is the assertion because it is the contract the stylesheet
 * keys off; `desk.css.test.ts` pins the other end — that `.mdr-sub--linked`
 * still paints.
 */

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (sel?: (s: { user: { id: string; username: string } }) => unknown) => {
    const state = { user: { id: 'u1', username: 'ana' } }
    return sel ? sel(state) : state
  },
}))
vi.mock('../../hooks/useBriefTabs', () => ({
  useBriefTabs: () => ({ data: [] }),
  useDeleteBriefTab: () => ({ mutate: vi.fn(), isPending: false }),
  usePrefetchBriefTab: () => vi.fn(),
}))
vi.mock('../../hooks/useProjects', () => ({ useUserProjects: () => ({ data: [] }) }))

const CARD = (projectId: string, lane: DeskUpdate['lane'], title: string): DeskUpdate =>
  ({
    projectId,
    lane,
    kind: 'project',
    agent: null,
    agentName: 'ana-analyst',
    sourceName: `proj-${projectId}`,
    roomLabel: '# user-communication',
    title,
    quote: 'a line of the update',
    ts: '2026-01-01T00:00:00Z',
    latestMessageId: null,
    files: [],
    navTo: `/projects/${projectId}`,
    plan: null,
    reportPublishedAt: null,
  }) as DeskUpdate

// One card per section the panel draws sub-rows for, so the highlight is
// proven to cross sections rather than only working inside Review.
const CARDS = [
  CARD('p-alpha', 'reply', 'Alpha needs an answer'),
  CARD('p-lonely', 'reply', 'Lonely has no to-dos'),
  CARD('p-beta', 'progress', 'Beta is running'),
]

vi.mock('../../hooks/useDeskUpdates', () => ({
  useDeskUpdates: () => ({
    updates: CARDS,
    counts: { reply: 2, report: 0, progress: 1, read: 0 },
    ready: true,
  }),
}))
vi.mock('../../hooks/useDeskRecentlyDone', () => ({
  useDeskRecentlyDone: () => ({ cards: [], lastSignedOffAt: null, isLoading: false }),
}))

const TODO = (id: string, text: string, project_ids: string[]): DeskTodo => ({
  id,
  owner_user_id: 'u1',
  text,
  state: 'new',
  archived: false,
  association_count: project_ids.length,
  project_ids,
  created_at: '',
  updated_at: '',
  attachments: [],
})

const TODOS: DeskTodo[] = [
  TODO('t-both', 'spans alpha and beta', ['p-alpha', 'p-beta']),
  TODO('t-dangling', 'points at a deleted project', ['p-gone']),
]

const getDeskTodos = vi.fn()
vi.mock('../../api/endpoints/deskTodos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/deskTodos')>()
  return { ...actual, getDeskTodos: () => getDeskTodos() }
})

const { default: MyDeskRailPanel } = await import('./MyDeskRailPanel')

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  getDeskTodos.mockReset().mockResolvedValue(TODOS)
  // A module singleton outlives `cleanup()`, so a hover left by one case would
  // land the next one pre-lit.
  useDeskLinkStore.getState().reset()
})
afterEach(cleanup)

async function renderRail() {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/desk']}>
        <MyDeskRailPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // The plate arrives through react-query; nothing can be lit until it lands.
  await screen.findByText('Alpha needs an answer')
}

/** The sub-row button for a card title. */
function sub(title: string): HTMLElement {
  const el = screen.getByText(title).closest('.mdr-sub')
  if (!el) throw new Error(`no .mdr-sub around "${title}"`)
  return el as HTMLElement
}

/** Titles of every sub-row currently wearing the cross-highlight. */
function litSubs(): string[] {
  return Array.from(document.querySelectorAll('.mdr-sub--linked')).map(
    (el) => el.textContent ?? '',
  )
}

/** Stand in for the desk publishing a hover from the other React tree. */
function deskHovers(projectId: string | null) {
  act(() => {
    useDeskLinkStore
      .getState()
      .setHover(projectId === null ? null : { side: 'card', projectId })
  })
}

describe('My Desk sidebar panel — cross-highlight', () => {
  it('starts with nothing lit', async () => {
    await renderRail()
    expect(litSubs()).toEqual([])
  })

  describe('as a RECEIVER — the desk drives', () => {
    it('lights the sub-row for a card hovered on the desk', async () => {
      await renderRail()
      deskHovers('p-alpha')
      expect(litSubs()).toEqual(['Alpha needs an answer'])
    })

    it('lights sub-rows across sections when a to-do hover names several', async () => {
      await renderRail()
      // The to-do side of the pair, published exactly as `DeskPage` publishes
      // it. `t-both` carries alpha (Review) and beta (Working), so this also
      // proves the highlight is not scoped to one nav section.
      act(() => {
        useDeskLinkStore.getState().setHover({ side: 'todo', todoId: 't-both' })
      })
      expect(litSubs().sort()).toEqual(['Alpha needs an answer', 'Beta is running'])
    })

    it('leaves a card no to-do points at dark', async () => {
      await renderRail()
      deskHovers('p-lonely')
      // The same non-empty gate the desk applies, from the same function: the
      // mark means "paired", not "the pointer is here".
      expect(litSubs()).toEqual([])
    })

    it('clears when the desk clears', async () => {
      await renderRail()
      deskHovers('p-alpha')
      expect(litSubs()).not.toEqual([])
      deskHovers(null)
      expect(litSubs()).toEqual([])
    })
  })

  describe('as a DRIVER — the pointer is on the rail', () => {
    it('publishes a CARD hover, not a fourth variant', async () => {
      await renderRail()
      fireEvent.mouseEnter(sub('Alpha needs an answer'))
      // The sub-row is a proxy for its card — same id, same id space, same
      // answer — so the desk needs no new branch to understand it.
      expect(useDeskLinkStore.getState().hover).toEqual({ side: 'card', projectId: 'p-alpha' })
    })

    it('marks the hovered sub-row TOO, so the pair reads as a pair', async () => {
      await renderRail()
      fireEvent.mouseEnter(sub('Alpha needs an answer'))
      expect(litSubs()).toEqual(['Alpha needs an answer'])
    })

    it('clears the channel on leave', async () => {
      await renderRail()
      fireEvent.mouseEnter(sub('Alpha needs an answer'))
      fireEvent.mouseLeave(sub('Alpha needs an answer'))
      expect(useDeskLinkStore.getState().hover).toBeNull()
      expect(litSubs()).toEqual([])
    })

    it('moves the highlight when the pointer crosses to another sub-row', async () => {
      await renderRail()
      fireEvent.mouseEnter(sub('Alpha needs an answer'))
      // Real pointer order: leave the old row before entering the new one.
      fireEvent.mouseLeave(sub('Alpha needs an answer'))
      fireEvent.mouseEnter(sub('Beta is running'))
      expect(litSubs()).toEqual(['Beta is running'])
    })

    it('publishes an unpaired hover but marks nothing', async () => {
      await renderRail()
      fireEvent.mouseEnter(sub('Lonely has no to-dos'))
      // The channel carries the pointer faithfully; it is the JOIN that decides
      // nothing is lit. Swallowing the write here instead would make the rail
      // and the desk disagree about what the pointer is on.
      expect(useDeskLinkStore.getState().hover).toEqual({ side: 'card', projectId: 'p-lonely' })
      expect(litSubs()).toEqual([])
    })

    it('does not clear a TO-DO hover it does not own', async () => {
      await renderRail()
      act(() => {
        useDeskLinkStore.getState().setHover({ side: 'todo', todoId: 't-both' })
      })
      // A stray `mouseleave` on a row lit from the far side must not clear the
      // desk's own hover: a leave only ever clears its OWN side of the pair.
      fireEvent.mouseLeave(sub('Alpha needs an answer'))
      expect(useDeskLinkStore.getState().hover).toEqual({ side: 'todo', todoId: 't-both' })
    })
  })
})

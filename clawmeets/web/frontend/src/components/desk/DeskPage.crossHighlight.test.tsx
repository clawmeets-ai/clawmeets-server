import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskUpdate } from '../../hooks/useDeskUpdates'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import { useDeskLinkStore } from '../../stores/deskLinkStore'

/**
 * THE JOIN, IN BOTH DIRECTIONS, driven from the pointer.
 *
 * `project_ids` was carried on every to-do for a whole milestone and read by
 * nothing, so the one thing genuinely unproven here is that its values line up
 * with a card's `projectId` in the shape the desk actually renders. That is why
 * the page is rendered FOR REAL, with real `UpdateCard`, `DeskSideRail`,
 * `TodoRail` and `TodoItem` beneath it and only the network and the stores
 * mocked: a version that resolved the join against the wrong field, or lit one
 * end of the pair instead of both, type-checks perfectly.
 *
 * BOTH ends wear the mark — the hovered element included — because a highlight
 * drawn only on the far side reads as "look over there" rather than "these two
 * go together". The gate that keeps that honest is that the pair must be
 * non-empty: a card nothing points at, and a row whose ids match no card on the
 * plate, both stay dark under the pointer.
 *
 * The class names are the assertion because they are the contract the
 * stylesheet keys off. `desk.css.test.ts` pins the other end of it — that the
 * two selectors still carry an outline.
 */

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (sel?: (s: { user: { id: string; username: string } }) => unknown) => {
    const state = { user: { id: 'u1', username: 'ana' } }
    return sel ? sel(state) : state
  },
}))
vi.mock('../../stores/uiStore', () => ({
  useUIStore: () => ({
    rightPanelWidth: 320,
    setRightPanelWidth: vi.fn(),
    isMobileRightPanelOpen: false,
    openMobileRightPanel: vi.fn(),
    closeMobileRightPanel: vi.fn(),
    setRailContext: vi.fn(),
    setProjectExpanded: vi.fn(),
  }),
}))
// Selector-aware: `DeskPage` destructures the whole store, `DeskSideRail`
// reads `pendingRailTab` through a selector. A mock that only honoured one of
// the two shapes fails inside an effect, which surfaces as a bare
// "x is not a function" rather than as a mock that drifted.
const deskState = {
  scrollTarget: null,
  clearScroll: vi.fn(),
  focusCardId: null,
  clearCardFocus: vi.fn(),
  pendingSop: null,
  clearPendingSop: vi.fn(),
  pendingTask: null,
  clearPendingTask: vi.fn(),
  pendingRailTab: null,
  clearPendingRailTab: vi.fn(),
}
vi.mock('../../stores/deskStore', () => ({
  useDeskStore: (sel?: (s: typeof deskState) => unknown) => (sel ? sel(deskState) : deskState),
}))

/** One card per lane the desk renders, so the sections are covered too. */
const CARD = (projectId: string, lane: DeskUpdate['lane'], title: string): DeskUpdate => ({
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
})

const CARDS = [
  CARD('p-alpha', 'reply', 'Alpha needs an answer'),
  // No to-do points at this one — the case that proves the mark means "paired"
  // and not "the pointer is here". Listed after alpha so the keyboard cursor's
  // first stop is unchanged.
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
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({
    data: [{ id: 'a1', name: 'ana-analyst', registered_by: 'u1', status: 'online' }],
  }),
}))
// The cards' trust rule reads the project and agent lists; not under test here.
vi.mock('../../hooks/useRoomTrust', () => ({
  useRoomTrust: () => ({
    untrustedBodies: false, isOutsideAuthor: () => false, isUntrusted: () => false, unknownAuthorUntrusted: false,
  }),
}))
vi.mock('./DeskZeroState', () => ({ default: () => null }))
vi.mock('../common/ModelSelector', () => ({ default: () => null }))
vi.mock('../../api/endpoints/deskTodoAttachments', () => ({
  fetchTodoAttachment: vi.fn(),
  cachedTodoAttachment: () => undefined,
  forgetTodoAttachment: () => {},
}))
vi.mock('../../api/endpoints/dm', () => ({
  createDMThread: vi.fn(),
  sendDMMessage: vi.fn(),
  ensureOwnDMProject: vi.fn(),
}))
vi.mock('../../api/endpoints/deskSops', () => ({ getDeskSops: async () => [] }))

const TODO = (
  id: string,
  text: string,
  project_ids: string[],
  over: Partial<DeskTodo> = {},
): DeskTodo => ({
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
  ...over,
})

// The fixture is the whole point of the suite, so it is realistic rather than
// minimal — a to-do on two projects, a shared project on two to-dos, a to-do
// linked to nothing, one whose id no longer resolves to any card, and an
// ARCHIVED row that must stay dark even though its ids match.
const TODOS: DeskTodo[] = [
  TODO('t-both', 'spans alpha and beta', ['p-alpha', 'p-beta']),
  TODO('t-alpha', 'also on alpha', ['p-alpha']),
  TODO('t-none', 'linked to nothing', []),
  TODO('t-dangling', 'points at a deleted project', ['p-gone']),
  TODO('t-filed', 'filed away, still lists alpha', ['p-alpha'], { archived: true }),
]

const getDeskTodos = vi.fn()
vi.mock('../../api/endpoints/deskTodos', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/endpoints/deskTodos')>(
      '../../api/endpoints/deskTodos',
    )
  return { ...actual, getDeskTodos: () => getDeskTodos() }
})

const { default: DeskPage } = await import('./DeskPage')

let queryClient: QueryClient

// jsdom implements neither on an element, and the desk scrolls the feed in
// handlers unrelated to anything here.
Element.prototype.scrollTo = function scrollTo() {}
Element.prototype.scrollIntoView = function scrollIntoView() {}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  getDeskTodos.mockReset().mockResolvedValue(TODOS)
  // `deskLinkStore` runs FOR REAL here — it is the thing under test now that
  // the hover left `DeskPage`'s `useState`, and a mock would assert away the
  // cross-tree channel this suite exists to prove. Being a module singleton, it
  // survives `cleanup()`, so a hover left set by one case would leak into the
  // next one's "starts with nothing lit" assertion.
  useDeskLinkStore.getState().reset()
})
afterEach(cleanup)

async function renderDesk() {
  render(
    <QueryClientProvider client={queryClient}>
      <DeskPage />
    </QueryClientProvider>,
  )
  // The plate arrives through react-query; the rail is empty until it lands.
  await screen.findByText('spans alpha and beta')
}

/** The card element for a project, found through its title. */
function card(title: string): HTMLElement {
  const el = screen.getByText(title).closest('.md-card')
  if (!el) throw new Error(`no .md-card around "${title}"`)
  return el as HTMLElement
}

/** The live to-do row carrying this text. */
function row(text: string): HTMLElement {
  const el = screen.getByText(text).closest('.todo-item')
  if (!el) throw new Error(`no .todo-item around "${text}"`)
  return el as HTMLElement
}

/** Texts of every to-do row currently wearing the cross-highlight. */
function litRows(): string[] {
  return Array.from(document.querySelectorAll('.todo-item.linked')).map(
    (el) => el.querySelector('.todo-text')?.textContent ?? '',
  )
}

/** Titles of every desk card currently wearing the cross-highlight. */
function litCards(): string[] {
  return Array.from(document.querySelectorAll('.md-card--linked')).map(
    (el) => el.querySelector('.md-card-title')?.textContent ?? '',
  )
}

describe('My Desk ↔ To-do cross-highlight', () => {
  it('starts with nothing lit on either side', async () => {
    await renderDesk()
    expect(litRows()).toEqual([])
    expect(litCards()).toEqual([])
  })

  describe('hovering a card lights its to-dos', () => {
    it('lights every to-do listing that projectId, and only those', async () => {
      await renderDesk()
      fireEvent.mouseEnter(card('Alpha needs an answer'))
      // Both rows that carry `p-alpha` — the many-to-many case in the direction
      // where one project appears on several to-dos.
      expect(litRows().sort()).toEqual(['also on alpha', 'spans alpha and beta'])
    })

    it('marks the hovered card TOO, so the pair reads as a pair', async () => {
      await renderDesk()
      fireEvent.mouseEnter(card('Alpha needs an answer'))
      // The card under the pointer wears the same mark it hands the rail, and
      // no other card does: the highlight is a claim about a relationship, not
      // a spotlight on the far end of one.
      expect(litCards()).toEqual(['Alpha needs an answer'])
    })

    it('excludes archived rows even when their ids match', async () => {
      await renderDesk()
      fireEvent.mouseEnter(card('Alpha needs an answer'))
      // `t-filed` lists p-alpha and is deliberately not lit: the drawer is a
      // record of filed-away work, not the plate.
      expect(litRows()).not.toContain('filed away, still lists alpha')
    })

    it('clears both ends on leave', async () => {
      await renderDesk()
      fireEvent.mouseEnter(card('Alpha needs an answer'))
      expect(litRows()).not.toEqual([])
      fireEvent.mouseLeave(card('Alpha needs an answer'))
      expect(litRows()).toEqual([])
      expect(litCards()).toEqual([])
    })

    it('moves the highlight when the pointer crosses to another card', async () => {
      await renderDesk()
      fireEvent.mouseEnter(card('Alpha needs an answer'))
      // Real pointer order: leave fires on the old card before enter on the new.
      fireEvent.mouseLeave(card('Alpha needs an answer'))
      fireEvent.mouseEnter(card('Beta is running'))
      expect(litRows()).toEqual(['spans alpha and beta'])
      // The self-mark moves with the pointer rather than accumulating.
      expect(litCards()).toEqual(['Beta is running'])
    })

    it('leaves a card no to-do points at dark on BOTH ends', async () => {
      await renderDesk()
      fireEvent.mouseEnter(card('Lonely has no to-dos'))
      expect(litRows()).toEqual([])
      // The card does NOT mark itself either: with no partner there is no pair
      // to claim, and `.md-card:hover` already says "the pointer is here".
      expect(litCards()).toEqual([])
    })
  })

  describe('hovering a to-do lights its cards', () => {
    it('lights every card the row lists that is still on the plate', async () => {
      await renderDesk()
      fireEvent.mouseEnter(row('spans alpha and beta'))
      // The other direction of many-to-many: one to-do carrying two ids. Also
      // proves the highlight crosses SECTIONS — alpha is in Review, beta in
      // Working.
      expect(litCards().sort()).toEqual(['Alpha needs an answer', 'Beta is running'])
    })

    it('marks the hovered row TOO, so the pair reads as a pair', async () => {
      await renderDesk()
      fireEvent.mouseEnter(row('spans alpha and beta'))
      expect(litRows()).toEqual(['spans alpha and beta'])
    })

    it('lights nothing, quietly, for an id whose project left the plate', async () => {
      await renderDesk()
      fireEvent.mouseEnter(row('points at a deleted project'))
      // `project_ids` keeps the ids of deleted projects forever, so this is the
      // ordinary case. No error, no "0 linked", no card lit — and no self-mark
      // either: carrying an id is not the same as having a partner on screen.
      expect(litCards()).toEqual([])
      expect(litRows()).toEqual([])
    })

    it('lights nothing for a row carrying no ids at all', async () => {
      await renderDesk()
      fireEvent.mouseEnter(row('linked to nothing'))
      expect(litCards()).toEqual([])
      expect(litRows()).toEqual([])
    })

    it('clears both ends on leave', async () => {
      await renderDesk()
      fireEvent.mouseEnter(row('also on alpha'))
      expect(litCards()).toEqual(['Alpha needs an answer'])
      expect(litRows()).toEqual(['also on alpha'])
      fireEvent.mouseLeave(row('also on alpha'))
      expect(litCards()).toEqual([])
      expect(litRows()).toEqual([])
    })
  })

  describe('keyboard parity', () => {
    it('arrowing the card cursor lights that card’s to-dos', async () => {
      await renderDesk()
      // ArrowDown from no selection puts the cursor on the first card in
      // `flat` (Review → Working), which is alpha.
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      expect(litRows().sort()).toEqual(['also on alpha', 'spans alpha and beta'])
      // The cursor's own card is the other end of that pair, marked as if the
      // pointer were on it.
      expect(litCards()).toEqual(['Alpha needs an answer'])
    })

    it('lets the pointer override the keyboard cursor while it is on a row', async () => {
      await renderDesk()
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.mouseEnter(row('also on alpha'))
      // Pointer wins: the rail narrows to the hovered row alone (the second
      // alpha row goes dark) and the card side lights from it instead.
      expect(litRows()).toEqual(['also on alpha'])
      expect(litCards()).toEqual(['Alpha needs an answer'])
    })

    it('falls back to the keyboard cursor once the pointer leaves', async () => {
      await renderDesk()
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.mouseEnter(row('also on alpha'))
      fireEvent.mouseLeave(row('also on alpha'))
      expect(litRows().sort()).toEqual(['also on alpha', 'spans alpha and beta'])
    })

    it('keeps the keyboard cursor OUT of the cross-tree channel', async () => {
      await renderDesk()
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      // `selectedId` is this page's own cursor, and the widening that lets it
      // drive the highlight is this page's own. Publishing it would mean an
      // effect mirroring derived state into a store to keep two trees in step —
      // the shape the store was introduced to avoid. So the sidebar panel stays
      // dark while you arrow the feed, and only the pointer crosses trees.
      expect(litCards()).toEqual(['Alpha needs an answer'])
      expect(useDeskLinkStore.getState().hover).toBeNull()
    })
  })

  describe('the cross-tree channel', () => {
    it('publishes the pointer so the sidebar panel can read it', async () => {
      await renderDesk()
      fireEvent.mouseEnter(card('Alpha needs an answer'))
      // A card hover and a sidebar sub-row hover are the SAME value: the
      // sub-row is a proxy for its card, so there is no fourth hover variant
      // for consumers to handle.
      expect(useDeskLinkStore.getState().hover).toEqual({ side: 'card', projectId: 'p-alpha' })
      fireEvent.mouseLeave(card('Alpha needs an answer'))
      expect(useDeskLinkStore.getState().hover).toBeNull()
    })

    it('clears the channel when the desk UNMOUNTS under the pointer', async () => {
      const { unmount } = render(
        <QueryClientProvider client={queryClient}>
          <DeskPage />
        </QueryClientProvider>,
      )
      await screen.findByText('spans alpha and beta')
      fireEvent.mouseEnter(card('Alpha needs an answer'))
      expect(useDeskLinkStore.getState().hover).not.toBeNull()
      // `mouseleave` does NOT fire when an element unmounts under the pointer,
      // and opening a card navigates away from exactly that position. Without
      // the unmount cleanup, this hover outlives the desk and leaves its
      // sidebar sub-row lit with nothing on screen able to clear it.
      unmount()
      expect(useDeskLinkStore.getState().hover).toBeNull()
    })
  })

  describe('the halo’s precondition', () => {
    it('keeps both marked roots non-focusable plain divs', async () => {
      await renderDesk()
      // `desk.css` parks a resting TRANSPARENT outline on `.md-card` and
      // `.todo-item` so the lit one has something to fade from. That is only
      // legal while neither can take focus: the app ships no global
      // `:focus-visible` rule outside `landing.css`, so a resting outline on a
      // focusable root would swallow its focus ring outright and nothing would
      // put one back. Assert it here, where the real DOM can answer — the
      // descendants of both roots DO carry `tabIndex`, so grepping the source
      // cannot tell the roots apart from their contents.
      for (const el of [card('Alpha needs an answer'), row('also on alpha')]) {
        expect(el.tagName).toBe('DIV')
        expect(el.getAttribute('tabindex')).toBeNull()
      }
    })
  })
})

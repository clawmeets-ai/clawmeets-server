import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentCard, SearchHit } from '../../types'
import type { DeskSop } from '../../api/endpoints/deskSops'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import type { MessageSearchState } from '../../hooks/useMessageSearch'
import type { Session } from '../../stores/authStore'
import type { RetainedAgent } from '../../api/endpoints/hub'

/**
 * ⌘K's SOP rows. Every other palette kind just navigates; an SOP row *acts* —
 * it has to reproduce a SopRail click from anywhere in the app, which means
 * crossing into the router-Outlet tree via `deskStore`. These cover the match
 * surface (title / default agent), the hand-off, and the one case
 * where the hand-off must NOT happen: the unsaved-changes guard keeping the user
 * where they are.
 */

const navigate = vi.fn()
const touch = vi.fn()
const requestSop = vi.fn()
const requestTask = vi.fn()
const requestRailTab = vi.fn()
const setRailContext = vi.fn()
const onClose = vi.fn()
let confirmLeave = true
let sops: DeskSop[] = []
let todos: DeskTodo[] = []
let agents: AgentCard[] = []
let retained: RetainedAgent[] = []
let sessions: Session[] = []
let searchState: MessageSearchState = { kind: 'idle' }
const switchAccount = vi.fn()

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    message_id: 'm1',
    project_id: 'p1',
    project_name: 'chat-search-typeahead',
    room_id: 'shared-context',
    room_type: 'project',
    room_label: 'shared-context',
    ts: '2026-07-26T14:03:11.482000Z',
    author_id: 'agent_1',
    author_name: 'clawmeets-backend',
    snippet: 'a recency weight beats a stale match',
    snippet_truncated_start: false,
    snippet_truncated_end: false,
    match_offsets: [[2, 9]],
    score: 6.2,
    deep_link: {
      path: '/projects/p1/chatrooms/shared-context?msg=m1',
      kind: 'project_room',
      project_id: 'p1',
      chatroom_name: 'shared-context',
      agent_name: null,
      message_id: 'm1',
    },
    ...over,
  }
}

/** A `Session` shaped like the store's own, without minting a JWT: this file
 *  stubs the store outright, so only the two fields the account rows read
 *  (`user.username` and `refreshExpiresAt`) are load-bearing. A far-future
 *  expiry is the live case; a past one is AC-4.2's expired state. */
function session(id: string, username: string, refreshExpiresAt = Date.now() + 864e5): Session {
  return {
    userId: id,
    accessToken: `at-${id}`,
    refreshToken: `rt-${id}`,
    user: { id, username, created_at: '' },
    accessExpiresAt: Date.now() + 36e5,
    refreshExpiresAt,
  }
}

function sop(over: Partial<DeskSop> = {}): DeskSop {
  return {
    id: 's1',
    owner_user_id: 'u1',
    title: 'Weekly reel batch',
    agent_id: 'a1',
    agent_name: 'ana-editor',
    body: 'Cut {{Count|number:6}} reels.',
    created_at: '',
    updated_at: '',
    ...over,
  }
}

function todo(over: Partial<DeskTodo> = {}): DeskTodo {
  return {
    id: 't1',
    owner_user_id: 'u1',
    text: 'Approve the Q3 render budget',
    state: 'new',
    archived: false,
    association_count: 0,
    project_ids: [],
    created_at: '',
    updated_at: '',
    attachments: [],
    ...over,
  }
}

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('../../hooks/useSops', () => ({ useSops: () => ({ sops, isLoading: false }) }))
vi.mock('../../hooks/useTodos', () => ({ useTodos: () => ({ todos, isLoading: false }) }))
vi.mock('../../hooks/useSopRecents', () => ({ useSopRecents: () => ({ recentIds: [], touch }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../hooks/useAgentAccess', () => ({ useRetainedAgents: () => ({ data: retained }) }))
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
    setRailContext,
    setProjectExpanded: vi.fn(),
  }),
}))
// Session-aware, because AC-4.5's rows are built from `sessions` /
// `activeUserId` alongside the `user` the rest of the palette already reads.
// A mock that answered only `user` would leave the account rows silently empty
// and every assertion about them vacuous.
vi.mock('../../stores/authStore', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useAuthStore: (sel?: (s: Record<string, unknown>) => unknown) => {
      const state = { user: { id: 'u1', username: 'ana' }, sessions, activeUserId: 'u1' }
      return sel ? sel(state) : state
    },
  }
})
vi.mock('../../hooks/useSwitchAccount', () => ({ useSwitchAccount: () => switchAccount }))
vi.mock('../../stores/deskStore', () => ({
  useDeskStore: (
    sel: (s: {
      requestSop: typeof requestSop
      requestTask: typeof requestTask
      requestRailTab: typeof requestRailTab
    }) => unknown,
  ) => sel({ requestSop, requestTask, requestRailTab }),
}))
vi.mock('../../stores/unsavedGuard', () => ({ confirmLeaveIfDirty: () => confirmLeave }))
vi.mock('../../hooks/useMessageSearch', () => ({ useMessageSearch: () => searchState }))

// jsdom ships no layout engine, so it implements neither scrollIntoView (the
// palette keeps the cursor row in view) nor the portal target's scroll box.
Element.prototype.scrollIntoView = vi.fn()

const { default: CommandPalette } = await import('./CommandPalette')

function open() {
  render(<CommandPalette open onClose={onClose} />)
}

function type(q: string) {
  fireEvent.change(screen.getByPlaceholderText(/Jump to a tab/), { target: { value: q } })
}

/** Group headers, in render order — the palette's ranking made visible. */
function groups(): string[] {
  return Array.from(document.querySelectorAll('.uppercase')).map((el) => el.textContent ?? '')
}

describe('CommandPalette — SOPs', () => {
  beforeEach(() => {
    sops = [sop()]
    todos = []
    agents = []
    sessions = [session('u1', 'ana')]
    confirmLeave = true
    navigate.mockReset()
    touch.mockReset()
    requestSop.mockReset()
    setRailContext.mockReset()
    onClose.mockReset()
    searchState = { kind: 'idle' }
  })
  // `globals: false` means RTL registers no auto-cleanup.
  afterEach(cleanup)

  it('lists the library under its own group with no query typed', () => {
    open()
    expect(screen.getByText('Weekly reel batch')).toBeTruthy()
    // The header names the rail tab the rows live in, not a free-floating "SOPs".
    expect(groups()).toContain('My Desk › SOP')
  })

  it('ranks SOPs after Agents, both under the nav tabs', () => {
    agents = [{ id: 'a1', name: 'ana-editor', registered_by: 'u1' } as AgentCard]
    open()
    expect(groups()).toEqual(['Go to', 'Agents', 'My Desk › SOP', 'Accounts'])
  })

  it("matches the stored default agent's name", () => {
    sops = [sop(), sop({ id: 's2', title: 'Cold email', agent_name: 'bo-sales' })]
    open()
    type('bo-sales')
    expect(screen.getByText('Cold email')).toBeTruthy()
    expect(screen.queryByText('Weekly reel batch')).toBeNull()
  })

  it('caps the list so an empty query stays readable', () => {
    sops = Array.from({ length: 12 }, (_, i) => sop({ id: `s${i}`, title: `SOP ${i}` }))
    open()
    expect(screen.getAllByText(/^SOP \d+$/).length).toBe(8)
  })

  it('picking one navigates to the desk and hands the SOP over the bus', () => {
    open()
    fireEvent.click(screen.getByText('Weekly reel batch'))
    expect(navigate).toHaveBeenCalledWith('/desk')
    expect(setRailContext).toHaveBeenCalledWith('desk')
    // The whole record, so DeskPage needs no second fetch on a cold mount.
    expect(requestSop).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    expect(touch).toHaveBeenCalledWith('s1')
    expect(onClose).toHaveBeenCalled()
  })

  it('does nothing when the unsaved-changes guard keeps the user in place', () => {
    confirmLeave = false
    open()
    fireEvent.click(screen.getByText('Weekly reel batch'))
    expect(navigate).not.toHaveBeenCalled()
    // Critically: no recents entry and no parked request for a jump that never
    // happened — otherwise the next visit to /desk would load a stale SOP.
    expect(touch).not.toHaveBeenCalled()
    expect(requestSop).not.toHaveBeenCalled()
  })
})

/**
 * ⌘K's to-do rows — the second acting kind, alongside SOPs. A pick has to
 * reproduce a TodoRail body click from anywhere in the app: land on /desk with
 * the rail on To-do and the take-over already open over the centre pane. That
 * crosses into the router-Outlet tree via `deskStore.requestTask`, so these
 * cover the match surface, the rail order the rows preserve, the hand-off, and
 * the two things that must NOT appear: done items, and a hand-off for a jump the
 * unsaved-changes guard blocked.
 */
describe('CommandPalette — desk to-dos', () => {
  beforeEach(() => {
    sops = []
    todos = [todo()]
    agents = []
    sessions = [session('u1', 'ana')]
    confirmLeave = true
    navigate.mockReset()
    requestTask.mockReset()
    setRailContext.mockReset()
    onClose.mockReset()
    searchState = { kind: 'idle' }
  })
  afterEach(cleanup)

  it('lists open items under a group naming their rail tab', () => {
    open()
    expect(screen.getByText('Approve the Q3 render budget')).toBeTruthy()
    expect(groups()).toContain('My Desk › To-do')
  })

  it('ranks to-dos after Agents and before SOPs, mirroring the rail', () => {
    agents = [{ id: 'a1', name: 'ana-editor', registered_by: 'u1' } as AgentCard]
    sops = [sop()]
    open()
    expect(groups()).toEqual(['Go to', 'Agents', 'My Desk › To-do', 'My Desk › SOP', 'Accounts'])
  })

  it('leaves ARCHIVED items out — they live in the rail’s collapsed drawer', () => {
    // Re-pointed from `status: 'done'`. The rule is unchanged — a jump-to
    // surface should only offer rows that still want something — but the field
    // that decides it is now the owner's `archived`, not a lifecycle state.
    todos = [todo(), todo({ id: 't2', text: 'Ship the deck', archived: true })]
    open()
    expect(screen.getByText('Approve the Q3 render budget')).toBeTruthy()
    expect(screen.queryByText('Ship the deck')).toBeNull()
  })

  it('KEEPS a Done row that is still on the plate', () => {
    // The consequence the plan accepted, asserted where it would surprise
    // someone: `state: 'completed'` is not `archived`. The row's projects all
    // finished, the owner has not filed it, so it is still on the plate and
    // still reachable from ⌘K. Filing it is what removes it.
    todos = [todo({ id: 't3', text: 'Ship the deck', state: 'completed' })]
    open()
    expect(screen.getByText('Ship the deck')).toBeTruthy()
  })

  it('keeps the rail’s drag order on an empty query rather than sorting', () => {
    todos = [
      todo({ id: 't1', text: 'Zebra first because the user dragged it there' }),
      todo({ id: 't2', text: 'Alpha second' }),
    ]
    open()
    const rows = Array.from(document.querySelectorAll('button')).map((b) => b.textContent ?? '')
    const zebra = rows.findIndex((t) => t.includes('Zebra first'))
    const alpha = rows.findIndex((t) => t.includes('Alpha second'))
    expect(zebra).toBeLessThan(alpha)
  })

  it('matches the item text', () => {
    todos = [todo(), todo({ id: 't2', text: 'Reconcile the vendor invoices' })]
    open()
    type('vendor')
    expect(screen.getByText('Reconcile the vendor invoices')).toBeTruthy()
    expect(screen.queryByText('Approve the Q3 render budget')).toBeNull()
  })

  it('folds the draft recipient and the label slugs in as substring hits', () => {
    todos = [
      todo(),
      todo({
        id: 't2',
        text: 'Reply to the studio',
        draft_recipient_name: 'ana-scout',
        labels: ['colour-pass'],
      }),
    ]
    open()
    type('colour-pass')
    expect(screen.getByText('Reply to the studio')).toBeTruthy()
    cleanup()

    open()
    type('ana-scout')
    expect(screen.getByText('Reply to the studio')).toBeTruthy()
    expect(screen.queryByText('Approve the Q3 render budget')).toBeNull()
  })

  it('caps the list so an empty query stays readable', () => {
    todos = Array.from({ length: 12 }, (_, i) => todo({ id: `t${i}`, text: `Task ${i}` }))
    open()
    expect(screen.getAllByText(/^Task \d+$/).length).toBe(8)
  })

  it('picking one navigates to the desk and hands the task over the bus', () => {
    open()
    fireEvent.click(screen.getByText('Approve the Q3 render budget'))
    expect(navigate).toHaveBeenCalledWith('/desk')
    expect(setRailContext).toHaveBeenCalledWith('desk')
    // The whole record, so DeskPage needs no second fetch on a cold mount.
    expect(requestTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('does nothing when the unsaved-changes guard keeps the user in place', () => {
    confirmLeave = false
    open()
    fireEvent.click(screen.getByText('Approve the Q3 render budget'))
    expect(navigate).not.toHaveBeenCalled()
    // No parked request for a jump that never happened — otherwise the next
    // visit to /desk would pop a take-over nobody asked for.
    expect(requestTask).not.toHaveBeenCalled()
  })
})

/**
 * The two My Desk right-rail deep links. /desk always mounts the rail on To-do,
 * so "go to SOP" is only a real jump if the row also parks a rail-tab request —
 * these cover both halves, and the guard case where neither must happen.
 */
describe('CommandPalette — desk rail tabs', () => {
  beforeEach(() => {
    sops = []
    todos = []
    agents = []
    sessions = [session('u1', 'ana')]
    confirmLeave = true
    navigate.mockReset()
    requestRailTab.mockReset()
    setRailContext.mockReset()
    onClose.mockReset()
    searchState = { kind: 'idle' }
  })
  afterEach(cleanup)

  it('sits under My Desk in the Go to group with no query typed', () => {
    open()
    const tabs = Array.from(document.querySelectorAll('button')).map((b) => b.textContent ?? '')
    const desk = tabs.findIndex((t) => t.startsWith('My Desk'))
    expect(tabs[desk + 1]).toContain('To-do')
    expect(tabs[desk + 2]).toContain('SOP')
    // Still one group — these are nav rows, not a new kind.
    expect(groups()).toEqual(['Go to', 'Accounts'])
  })

  it.each([
    ['to-do', 'To-do', 'todo'],
    ['sop', 'SOP', 'sop'],
    // The qualified name matches too, though only the leaf is displayed.
    ['desk sop', 'SOP', 'sop'],
  ])('%s jumps to the desk and asks for the %s tab', (q, label, tab) => {
    open()
    type(q)
    fireEvent.click(screen.getByText(label))
    expect(navigate).toHaveBeenCalledWith('/desk')
    expect(setRailContext).toHaveBeenCalledWith('desk')
    expect(requestRailTab).toHaveBeenCalledWith(tab)
    expect(onClose).toHaveBeenCalled()
  })

  it('parks no rail request when the unsaved-changes guard blocks the jump', () => {
    confirmLeave = false
    open()
    type('sop')
    fireEvent.click(screen.getByText('SOP'))
    expect(navigate).not.toHaveBeenCalled()
    expect(requestRailTab).not.toHaveBeenCalled()
  })
})

/**
 * The Messages section — remote chat search inside the same ⌘K palette
 * (SEARCH_API_CONTRACT.md v1.0, plan §1.1/§1.2). What matters here is that the
 * new section is strictly additive: local rows keep their order and their
 * indices, and the section's status lines never become keyboard targets.
 */
describe('CommandPalette — message search', () => {
  beforeEach(() => {
    sops = []
    todos = []
    agents = []
    sessions = [session('u1', 'ana')]
    confirmLeave = true
    navigate.mockReset()
    onClose.mockReset()
    searchState = { kind: 'idle' }
  })
  afterEach(cleanup)

  function ready(hits: SearchHit[], over: Partial<Extract<MessageSearchState, { kind: 'ready' }>> = {}) {
    searchState = { kind: 'ready', hits, indexing: false, hasMore: false, ...over }
  }

  it('appends Messages after every local group, never interleaved', () => {
    ready([hit()])
    open()
    expect(groups()).toEqual(['Go to', 'Accounts', 'Messages'])
  })

  it('keeps the server ranking and groups hits by room', () => {
    ready([
      hit({ message_id: 'm1', room_id: 'shared-context', room_label: 'shared-context' }),
      hit({
        message_id: 'm2',
        room_id: 'milestone-1',
        room_label: 'milestone-1',
        snippet: 'second room',
        match_offsets: [],
      }),
      hit({
        message_id: 'm3',
        room_id: 'shared-context',
        room_label: 'shared-context',
        snippet: 'back to the first room',
        match_offsets: [],
      }),
    ])
    open()
    // Room subheaders follow the hits' own order — a re-sort would collapse the
    // two shared-context runs into one.
    const headers = Array.from(document.querySelectorAll('.font-bold.text-ink-2')).map(
      (el) => el.textContent,
    )
    expect(headers).toEqual(['shared-context', 'milestone-1', 'shared-context'])
    // project_name is the secondary line for project rooms.
    expect(screen.getAllByText('chat-search-typeahead').length).toBe(3)
  })

  it('never displays the opaque score', () => {
    ready([hit({ score: 6.204 })])
    open()
    expect(document.body.textContent).not.toContain('6.204')
  })

  it('landing hits do not move the cursor off the first local row', () => {
    // The whole reason hits are appended rather than merged: a user who has
    // already aimed at a local row must still hit that row when the debounced
    // response lands.
    ready([hit()])
    open()
    fireEvent.keyDown(screen.getByPlaceholderText(/Jump to a tab/), { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/desk')
  })

  it('Enter on a hit navigates to deep_link.path verbatim', () => {
    ready([hit()])
    open()
    type('zzzznomatch') // clears every local row, leaving the hit at index 0
    fireEvent.keyDown(screen.getByPlaceholderText(/Jump to a tab/), { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/projects/p1/chatrooms/shared-context?msg=m1')
    expect(onClose).toHaveBeenCalled()
  })

  it('routes a DM hit through the same call — no branch on kind', () => {
    ready([
      hit({
        room_type: 'dm',
        room_label: 'chengtao-assistant',
        deep_link: {
          path: '/dm/chengtao-assistant/e9451c3f?msg=b31d0e55',
          kind: 'dm',
          project_id: 'e9451c3f',
          chatroom_name: 'user-communication',
          agent_name: 'chengtao-assistant',
          message_id: 'b31d0e55',
        },
      }),
    ])
    open()
    type('zzzznomatch')
    fireEvent.keyDown(screen.getByPlaceholderText(/Jump to a tab/), { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/dm/chengtao-assistant/e9451c3f?msg=b31d0e55')
  })

  it('the unsaved-changes guard blocks a hit the same as any other row', () => {
    confirmLeave = false
    ready([hit()])
    open()
    type('zzzznomatch')
    fireEvent.keyDown(screen.getByPlaceholderText(/Jump to a tab/), { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders indexing:true WITH its hits, never as a bare no-results', () => {
    ready([hit()], { indexing: true })
    open()
    expect(screen.getByText(/Still indexing your history/)).toBeTruthy()
    expect(screen.queryByText(/No messages match/)).toBeNull()
    expect(document.querySelector('mark')).toBeTruthy()
  })

  it('surfaces the loading, empty, unavailable and error states', () => {
    searchState = { kind: 'loading' }
    open()
    expect(screen.getByText('Searching messages…')).toBeTruthy()
    cleanup()

    ready([])
    open()
    expect(screen.getByText('No messages match.')).toBeTruthy()
    cleanup()

    searchState = { kind: 'unavailable' }
    open()
    expect(screen.getByText('Message search is unavailable.')).toBeTruthy()
    cleanup()

    searchState = { kind: 'error' }
    open()
    expect(screen.getByText("Couldn't search messages.")).toBeTruthy()
  })

  it('status lines are not keyboard targets', () => {
    // Arrow past the end of the local rows: the cursor must clamp on the last
    // real row rather than landing on "Searching messages…".
    searchState = { kind: 'loading' }
    open()
    type('zzzznomatch')
    const input = screen.getByPlaceholderText(/Jump to a tab/)
    for (let i = 0; i < 5; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('Escape closes the palette', () => {
    ready([hit()])
    open()
    fireEvent.keyDown(screen.getByPlaceholderText(/Jump to a tab/), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})


/**
 * AC-4.5 — `CommandPalette` gains `kind: 'account'`, WITH NO RESTRUCTURING.
 *
 * The criterion has two halves and the second is the load-bearing one. These
 * cases cover the rows themselves, and the fact that adding them moved nothing:
 * the account group is appended after every other local group, so a keyboard
 * cursor sitting on a row does not jump because a session was added or expired
 * — the same reason message hits are appended after all the local ones.
 */
describe('CommandPalette — accounts', () => {
  beforeEach(() => {
    sops = []
    todos = []
    agents = []
    sessions = [session('u1', 'ana'), session('u2', 'bo')]
    confirmLeave = true
    navigate.mockReset()
    switchAccount.mockReset()
    setRailContext.mockReset()
    onClose.mockReset()
    searchState = { kind: 'idle' }
  })
  afterEach(cleanup)

  it('lists the other signed-in accounts under their own group', () => {
    open()
    expect(groups()).toEqual(['Go to', 'Accounts'])
    expect(screen.getByText('bo')).toBeTruthy()
  })

  it('B21 — the ACTIVE account is not offered as a switch target', () => {
    open()
    // A row for the account you are already on would call
    // `useSwitchAccount()`, which redirects unconditionally (AC-3.6) — so it
    // would throw away the page you are on and give nothing back.
    expect(screen.queryByText('ana')).toBeNull()
  })

  it('picking one switches through the HOOK, which owns the redirect', () => {
    open()
    fireEvent.click(screen.getByText('bo'))
    expect(switchAccount).toHaveBeenCalledWith('u2')
    // Not `go()`: switching is the one palette action whose navigation belongs
    // elsewhere (AC-3.2), so the row must not navigate on its own account.
    expect(navigate).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('respects the unsaved-changes guard — a switch destroys a draft too', () => {
    confirmLeave = false
    open()
    fireEvent.click(screen.getByText('bo'))
    // `switchTo` clears the query cache and every per-user store, so it takes a
    // dirty composer with it at least as thoroughly as a navigation would.
    expect(switchAccount).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an EXPIRED account re-authorises instead of switching to a dead session', () => {
    sessions = [session('u1', 'ana'), session('u2', 'bo', Date.now() - 1000)]
    open()
    expect(screen.getByText('Session expired — sign in again')).toBeTruthy()

    fireEvent.click(screen.getByText('bo'))
    expect(switchAccount).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/account/add?username=bo')
  })

  it('always offers "Add another account", including with nobody else to switch to', () => {
    sessions = [session('u1', 'ana')]
    open()
    // The single-account case is where this row does the most work: it is the
    // only route to a second account other than the chip.
    expect(screen.getByText('Add another account')).toBeTruthy()
    fireEvent.click(screen.getByText('Add another account'))
    expect(navigate).toHaveBeenCalledWith('/account/add')
    expect(onClose).toHaveBeenCalled()
  })

  it('matches by username, and "add account" finds the add row', () => {
    open()
    type('bo')
    expect(screen.getByText('bo')).toBeTruthy()
    expect(screen.queryByText('My Desk')).toBeNull()

    type('add account')
    expect(screen.getByText('Add another account')).toBeTruthy()
  })

  it('sits LAST, so no existing row index moves when the bag changes', () => {
    agents = [{ id: 'a1', name: 'ana-editor', registered_by: 'u1' } as AgentCard]
    sops = [sop()]
    open()
    expect(groups()).toEqual(['Go to', 'Agents', 'My Desk › SOP', 'Accounts'])
  })
})

/**
 * ⌘K's agent rows are the user's own agents plus the agents they retained,
 * the same set their agents' rosters list: another account's public agent of
 * this server shows only once retained, and a retained agent of another server
 * opens its hub thread.
 */
describe('CommandPalette — retained agents', () => {
  const kept = (over: Partial<RetainedAgent>): RetainedAgent => ({
    hub_agent_id: 'fp~far-scout', name: 'far-scout', deployment_name: 'elsewhere', deployment_fingerprint: 'fp',
    description: 'Scouts.', capabilities: [], retained_at: 1, state: 'active', live_rooms: 0, ...over,
  })
  beforeEach(() => {
    sops = []
    todos = []
    sessions = []
    agents = [
      { id: 'a1', name: 'ana-editor', registered_by: 'u1' } as AgentCard,
      { id: 'b1', name: 'bo-kept', registered_by: 'u2' } as AgentCard,
      { id: 'c1', name: 'cy-public', registered_by: 'u3' } as AgentCard,
    ]
    retained = [kept({ is_local: true, agent_id: 'b1', hub_agent_id: 'own~bo-kept', name: 'bo-kept' }), kept({})]
  })
  afterEach(() => { cleanup(); retained = [] })

  it("lists own and retained agents, never another account's agent that is only public", () => {
    open()
    expect(screen.getByText('editor')).toBeTruthy()
    expect(screen.getByText('bo-kept')).toBeTruthy()
    expect(screen.getByText('far-scout@elsewhere')).toBeTruthy()
    expect(screen.queryByText('cy-public')).toBeNull()
  })

  it('a retained agent of another server opens its hub thread', () => {
    open()
    fireEvent.click(screen.getByText('far-scout@elsewhere'))
    expect(navigate).toHaveBeenCalledWith('/hub/fp~far-scout')
  })
})

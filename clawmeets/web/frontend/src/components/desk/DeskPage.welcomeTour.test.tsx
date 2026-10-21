import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * THE MY DESK WELCOME TOUR — when it opens, what closing it does, and what the
 * last button loads.
 *
 * The rule is "once per account": the server's `seen_at` decides the first
 * open, every way out stamps it, and a read that FAILED must never count as
 * "not seen" (an older server would otherwise throw the tour over every
 * established desk on every load). The ⓘ replays it at any time.
 *
 * The page is rendered for real with only its data hooks mocked, because the
 * timing — the tour waits for the flag, then latches — is the subject.
 */

const desk = vi.hoisted(() => ({
  ready: true,
  updates: [] as unknown[],
  lastSignedOffAt: null as string | null,
  doneLoading: false,
  seenAt: null as string | null,
  tourFails: false,
  puts: 0,
  todos: [] as unknown[],
  agents: [] as unknown[],
}))

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
vi.mock('../../stores/deskStore', () => ({
  useDeskStore: () => ({
    scrollTarget: null,
    clearScroll: vi.fn(),
    focusCardId: null,
    clearCardFocus: vi.fn(),
    openBriefSlug: null,
    closeBrief: vi.fn(),
    pendingSop: null,
    clearPendingSop: vi.fn(),
    pendingTask: null,
    clearPendingTask: vi.fn(),
  }),
}))
vi.mock('../../hooks/useDeskUpdates', () => ({
  useDeskUpdates: () => ({ updates: desk.updates, counts: {}, ready: desk.ready }),
}))
vi.mock('../../hooks/useDeskRecentlyDone', () => ({
  useDeskRecentlyDone: () => ({
    cards: [],
    lastSignedOffAt: desk.lastSignedOffAt,
    isLoading: desk.doneLoading,
  }),
}))
vi.mock('../../hooks/useBriefTabs', () => ({ useBriefTabs: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ data: desk.agents }),
}))
vi.mock('./DeskSideRail', () => ({ default: () => null }))
vi.mock('./DeskZeroState', () => ({ default: () => null }))
// forwardRef, not `() => null`: the page hands every card a ref, and a plain
// function component makes React warn on each one.
vi.mock('./UpdateCard', async () => {
  const { forwardRef } = await vi.importActual<typeof import('react')>('react')
  return { default: forwardRef(() => null) }
})
vi.mock('./BriefingOverlay', () => ({ default: () => null }))
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
vi.mock('../../api/endpoints/deskTodoProjects', () => ({ associateTodoProject: vi.fn() }))
vi.mock('../../api/endpoints/deskTodos', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/endpoints/deskTodos')>(
      '../../api/endpoints/deskTodos',
    )
  return { ...actual, getDeskTodos: async () => desk.todos }
})
vi.mock('../../api/endpoints/deskSops', () => ({ getDeskSops: async () => [] }))

vi.mock('../../api/endpoints/deskTour', () => ({
  getDeskTour: async () => {
    if (desk.tourFails) throw new Error('404')
    return { seen_at: desk.seenAt }
  },
  putDeskTourSeen: async () => {
    desk.puts += 1
    return { seen_at: desk.seenAt ?? '2026-10-08T00:00:00Z' }
  },
}))

const { default: DeskPage } = await import('./DeskPage')

const ASSISTANT = { id: 'a1', name: 'ana-assistant', registered_by: 'u1', status: 'online' }

const STARTER = {
  id: 't-seed-onboarding-know-me',
  owner_user_id: 'u1',
  text: 'Get to know me & staff my priorities',
  project_ids: [],
  labels: [],
  archived: false,
  drafted: true,
  draft_prompt: 'Help me get set up.',
  draft_recipient_id: 'a1',
  draft_recipient_name: 'ana-assistant',
  attachments: [],
  created_at: '',
  updated_at: '',
}

Element.prototype.scrollTo = function scrollTo() {}

let queryClient: QueryClient
const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DeskPage />
    </QueryClientProvider>,
  )

const info = () => screen.getByRole('button', { name: /how my desk works/i })
const tour = () => screen.queryByRole('dialog')

beforeEach(() => {
  desk.ready = true
  desk.updates = []
  desk.lastSignedOffAt = null
  desk.doneLoading = false
  desk.seenAt = null
  desk.tourFails = false
  desk.puts = 0
  desk.todos = []
  desk.agents = [ASSISTANT]
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})
afterEach(cleanup)

describe('My Desk welcome tour', () => {
  it('opens on its own for an account that has never closed it', async () => {
    mount()
    await waitFor(() => expect(tour()).toBeTruthy())
    expect(screen.getByText(/1 of 5/)).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: /run your agents from one desk/i }),
    ).toBeTruthy()
  })

  it('stays shut for an account that has already seen it', async () => {
    desk.seenAt = '2026-01-01T00:00:00Z'
    mount()
    await waitFor(() => expect(queryClient.getQueryData(['desk-tour'])).toBeTruthy())
    expect(tour()).toBeNull()
  })

  it('stays shut when the flag could not be read', async () => {
    desk.tourFails = true
    mount()
    await waitFor(() => expect(queryClient.getQueryState(['desk-tour'])?.status).toBe('error'))
    expect(tour()).toBeNull()
  })

  it('walks five steps with Next, Back and the arrow keys', async () => {
    mount()
    await waitFor(() => expect(tour()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/2 of 5/)).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText(/5 of 5/)).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText(/5 of 5/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText(/4 of 5/)).toBeTruthy()
  })

  it('marks it seen on Esc, and does not reopen on a refetch', async () => {
    mount()
    await waitFor(() => expect(tour()).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(tour()).toBeNull()
    await waitFor(() => expect(desk.puts).toBe(1))
    await queryClient.refetchQueries({ queryKey: ['desk-tour'] })
    expect(tour()).toBeNull()
  })

  it('replays from the ⓘ on a desk that has already seen it', async () => {
    desk.seenAt = '2026-01-01T00:00:00Z'
    mount()
    await waitFor(() => expect(queryClient.getQueryData(['desk-tour'])).toBeTruthy())
    fireEvent.click(info())
    expect(tour()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(tour()).toBeNull()
    // Already stamped — a replay writes nothing.
    expect(desk.puts).toBe(0)
  })

  it('names only the model agents the owner actually has', async () => {
    mount()
    await waitFor(() => expect(tour()).toBeTruthy())
    // The roster mock holds the assistant and no model agents, so the step
    // falls back to the usual three rather than naming an invented agent.
    expect(screen.getByText(/already on this computer \(claude, codex, gemini\)/i)).toBeTruthy()
  })

  it('drops the model agents the owner does not have', async () => {
    desk.agents = [
      ASSISTANT,
      { id: 'a2', name: 'ana-codex', registered_by: 'u1', status: 'online' },
      { id: 'a3', name: 'ana-gemini_api', registered_by: 'u1', status: 'online' },
      // Someone else's claude is not this owner's mentor.
      { id: 'a4', name: 'bo-claude', registered_by: 'u2', status: 'online' },
    ]
    mount()
    await waitFor(() => expect(tour()).toBeTruthy())
    expect(screen.getByText(/already on this computer \(codex, gemini_api\)/i)).toBeTruthy()
    expect(screen.getByText('your Gemini API history')).toBeTruthy()
  })

  it('finishes by loading the onboarding to-do, without sending it', async () => {
    desk.todos = [STARTER]
    mount()
    await waitFor(() => expect(tour()).toBeTruthy())
    // Let the plate land before finishing — the last button reads it.
    await waitFor(() => expect(queryClient.getQueryData(['desk-todos'])).toBeTruthy())
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: /start with “get to know me”/i }))
    expect(tour()).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        /Loaded “Get to know me & staff my priorities”/,
      ),
    )
  })
})

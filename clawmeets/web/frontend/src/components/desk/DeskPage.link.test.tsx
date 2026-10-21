import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import type { DeskTodo } from '../../api/endpoints/deskTodos'

/**
 * THE PAGE'S HALF OF THE LINK, driven from the button the owner actually
 * presses. The composer's own suite proves it captures the id and honours the
 * answer; this one proves the id reaches the association route, and that a
 * refusal reaches the screen.
 *
 * The page is rendered for real with the two hooks under test real beneath it
 * (`useTodos`, `useDeskDispatch`) and only the network mocked, because the
 * whole risk here is in the twelve lines of glue between them — a handler that
 * links the wrong id, or swallows a throw, type-checks perfectly.
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
  useDeskUpdates: () => ({ updates: [], counts: {}, ready: true }),
}))
vi.mock('../../hooks/useDeskRecentlyDone', () => ({
  useDeskRecentlyDone: () => ({ cards: [], lastSignedOffAt: null, isLoading: false }),
}))
vi.mock('../../hooks/useBriefTabs', () => ({ useBriefTabs: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({
    data: [{ id: 'a1', name: 'ana-analyst', registered_by: 'u1', status: 'online' }],
  }),
}))
// The rail stands in for the plate: one button that calls the SAME
// `onUseTodo` prop the real row calls, so the box is bound the way production
// binds it (through `loadTodoDraft` and the page's own state) rather than by a
// prop this test arranged. Everything downstream of the click is real.
const staged = vi.hoisted(() => ({ todo: null as unknown }))
vi.mock('./DeskSideRail', () => ({
  default: ({ onUseTodo }: { onUseTodo: (t: unknown) => void }) => (
    <button onClick={() => onUseTodo(staged.todo)}>bind the to-do</button>
  ),
}))
vi.mock('./DeskZeroState', () => ({ default: () => null }))
vi.mock('./BriefingOverlay', () => ({ default: () => null }))
vi.mock('../common/ModelSelector', () => ({ default: () => null }))
vi.mock('../../api/endpoints/deskTodoAttachments', () => ({
  fetchTodoAttachment: vi.fn(),
  cachedTodoAttachment: () => undefined,
  forgetTodoAttachment: () => {},
}))

const createDMThread = vi.fn()
const sendDMMessage = vi.fn()
vi.mock('../../api/endpoints/dm', () => ({
  createDMThread: (...a: unknown[]) => createDMThread(...a),
  sendDMMessage: (...a: unknown[]) => sendDMMessage(...a),
  ensureOwnDMProject: vi.fn(),
}))

const associateTodoProject = vi.fn()
vi.mock('../../api/endpoints/deskTodoProjects', () => ({
  associateTodoProject: (...a: unknown[]) => associateTodoProject(...a),
}))

const TODO: DeskTodo = {
  id: 't-9a3f21',
  owner_user_id: 'u1',
  text: 'Chase the Northwind renewal',
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  attachments: [],
  drafted: true,
  draft_prompt: 'Can you pull the renewal numbers?',
}

const getDeskTodos = vi.fn()
vi.mock('../../api/endpoints/deskTodos', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/endpoints/deskTodos')>(
      '../../api/endpoints/deskTodos',
    )
  return { ...actual, getDeskTodos: () => getDeskTodos() }
})
vi.mock('../../api/endpoints/deskSops', () => ({ getDeskSops: async () => [] }))

const { default: DeskPage } = await import('./DeskPage')

let queryClient: QueryClient

// jsdom implements no `scrollTo` on an element, and the page scrolls the feed
// to the top when a to-do is loaded. Unrelated to anything under test, but an
// unhandled throw out of a click handler is noise that hides a real one.
Element.prototype.scrollTo = function scrollTo() {}

beforeEach(() => {
  staged.todo = TODO
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  getDeskTodos.mockReset().mockResolvedValue([TODO])
  createDMThread.mockReset().mockResolvedValue({ id: 'p-thread1', name: 'ana-dm-analyst-1' })
  sendDMMessage.mockReset().mockResolvedValue({})
  associateTodoProject.mockReset().mockResolvedValue({ ...TODO, state: 'working' })
})
afterEach(cleanup)

/** Render the desk, bind the box to the to-do through the plate's own path,
 *  type, and press **command**. */
async function press(text = 'pull the renewal numbers') {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DeskPage />
    </QueryClientProvider>,
  )
  await act(async () => {})
  const box = () => view.container.querySelector('[contenteditable="true"]')!
  const bind = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /bind the to-do/i }))
    })
  }
  const type = async (t: string) => {
    await act(async () => {
      fireEvent.input(box(), { target: { textContent: t } })
    })
  }
  const command = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^command$/i }))
    })
  }
  return { view, box, bind, type, command, text }
}

describe('DeskPage links the thread command just spawned', () => {
  it('associates the BOUND to-do with the freshly minted thread', async () => {
    const { bind, type, command } = await press()
    await bind()
    await type('pull the renewal numbers')
    await command()
    // The id the link is made with is the one that was bound at the press —
    // not `null`, which is what reading it after the clear would produce.
    expect(createDMThread).toHaveBeenCalled()
    expect(associateTodoProject).toHaveBeenCalledWith('t-9a3f21', 'p-thread1')
  })

  it('links AFTER the send and BEFORE the confirmation', async () => {
    // Ordering, not just occurrence. "Sent" appearing first would be a
    // confirmation of half the work, and the owner would read it as all of it.
    const order: string[] = []
    sendDMMessage.mockImplementation(async () => { order.push('send'); return {} })
    associateTodoProject.mockImplementation(async () => { order.push('link'); return TODO })
    const { bind, type, command } = await press()
    await bind()
    await type('pull the renewal numbers')
    await command()
    expect(order).toEqual(['send', 'link'])
    expect(screen.getByText(/their reply lands on your desk/)).toBeTruthy()
  })

  it('attempts NO association on a free-form send', async () => {
    // The ordinary unbound send. `null` has to stay distinguishable from "we
    // forgot to read the binding", and this is the assertion that keeps it so.
    const { type, command } = await press()
    await type('morning')
    await command()
    expect(createDMThread).toHaveBeenCalled()
    expect(associateTodoProject).not.toHaveBeenCalled()
  })

  it('passes the same thread key twice, so a double-press is one thread', async () => {
    let release: (v: unknown) => void = () => {}
    createDMThread.mockImplementation(
      () => new Promise((r) => { release = r }),
    )
    const { bind, type } = await press()
    await bind()
    await type('pull the renewal numbers')
    await act(async () => {
      const b = screen.getByRole('button', { name: /^command$/i })
      fireEvent.click(b)
      fireEvent.click(b)
    })
    expect(createDMThread).toHaveBeenCalledTimes(1)
    await act(async () => { release({ id: 'p-thread1', name: 'x' }) })
  })
})

describe('DeskPage when the message went out and the link did not', () => {
  const REFUSAL =
    "No project or thread with id 'p-thread1' — check the id, or it may have been deleted."

  beforeEach(() => {
    associateTodoProject.mockRejectedValue(new ApiError(404, REFUSAL))
  })

  it('says so on screen — never silent', async () => {
    // A silent failure leaves the owner believing the to-do is wired to a
    // thread it will read New beside forever. That is the one outcome this
    // path must not produce.
    const { bind, type, command } = await press()
    await bind()
    await type('pull the renewal numbers')
    await command()
    expect(screen.getByRole('status').textContent).toContain(
      "didn't get linked to the new thread",
    )
  })

  it('does not claim the message failed, and names the repair path', async () => {
    const { bind, type, command } = await press()
    await bind()
    await type('pull the renewal numbers')
    await command()
    const said = screen.getByRole('status').textContent ?? ''
    expect(said).toContain('the message went out')
    expect(said).toContain(REFUSAL)
    expect(said).toContain('clawmeets todo associate t-9a3f21 p-thread1')
  })

  it('drops the green check — the glyph must not contradict the sentence', async () => {
    const { bind, type, command } = await press()
    await bind()
    await type('pull the renewal numbers')
    await command()
    expect(screen.getByRole('status').className).toContain('warn')
  })

  it('keeps the to-do BOUND, so the sentence points at something on screen', async () => {
    // The page cannot re-bind after the fact — its own clear fires when the
    // dispatch resolves and wins that race — so this is carried by the
    // composer honouring `linked: false`, end to end from the button.
    const { bind, type, command } = await press()
    await bind()
    await type('pull the renewal numbers')
    await command()
    expect(screen.getByTitle(/Bound to the to-do/)).toBeTruthy()
  })
})

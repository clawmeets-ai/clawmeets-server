import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { ApiError } from '../../api/client'
import type { ChannelThread, ChannelThreadRow, OutboxItem } from '../../api/endpoints/channels'
import type { AgentCard, ChatMessage, Project } from '../../types'
import { CHANNEL_THREADS_KEY } from '../../hooks/useChannelThreads'
import { OUTBOX_POLL_MS } from '../../hooks/useThreadOutbox'
import { DELIVERY_COPY, THREAD_COPY } from '../../utils/channelThreads'
import ChatroomView from './ChatroomView'

/**
 * A CHANNEL THREAD, OPENED BY ITS OWNER: the header says which channel and who
 * the person is; Take over / Hand back pause the agent on this thread only, and
 * show the server's answer; the composer says where the text goes before it is
 * sent; each outgoing message says whether it reached the person.
 *
 * The room's own data (chatroom, messages, project list) comes from mocked
 * hooks; every channel call goes through a mocked HTTP client, so the paths
 * and bodies are the real ones.
 */

// jsdom has no layout engine: the room's header and editor observe their size.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const OWNER = 'u1'
const AGENT = 'a-support'
let projects: Project[] = []
let messages: ChatMessage[] = []
let viewer = false
let rows: ChannelThreadRow[] | Error = []
let outbox: OutboxItem[] | Error = []
let threadStatus: ChannelThread | Error = new ApiError(404, 'Not a channel thread')
let pauseAnswer: (paused: boolean) => Promise<unknown> = (paused) => Promise.resolve({ project_id: 'p1', paused })
const requested: string[] = []
const puts: Array<{ path: string; body: unknown }> = []
const sent: Array<{ projectId: string; room: string; body: unknown }> = []

vi.mock('../../hooks/useProjects', () => ({
  // The server always lists participant_info; the owner's own agent is inside.
  useChatroom: () => ({
    data: {
      id: 'r', name: 'user-communication', project_id: 'p1', participants: [AGENT],
      participant_info: [{ id: AGENT, kind: 'agent', outside: false, hub: null }],
    },
    isLoading: false,
  }),
  useMessages: () => ({ data: messages, isLoading: false }),
  useUserProjects: () => ({ data: projects }),
  useProject: (id: string) => ({ data: projects.find((p) => p.id === id) }),
  useCancelInvocation: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('../../hooks/useSharing', () => ({ useIsProjectViewer: () => viewer }))
vi.mock('../../hooks/useAgents', () => ({
  useAllParticipants: () => ({ data: [{ id: AGENT, name: 'support', registered_by: OWNER, status: 'online' } as AgentCard] }),
  // The Forward picker's own agents.
  useAgents: () => ({ data: [{ id: AGENT, name: 'support', registered_by: OWNER, status: 'online' } as AgentCard] }),
}))
vi.mock('../../hooks/useFiles', () => ({ useFiles: () => ({ data: [], isLoading: false }) }))
vi.mock('../../api/endpoints/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/endpoints/messages')>()),
  sendUserMessage: (projectId: string, room: string, body: unknown) => {
    sent.push({ projectId, room, body })
    return Promise.resolve({})
  },
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  const answer = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v))
  return {
    ...actual,
    get: (path: string) => {
      requested.push(path)
      if (path === '/me/channels/threads') return answer(rows)
      if (path === '/me/channels/threads/p1/outbox') return answer(outbox)
      if (path === '/me/channels/threads/p1') return answer(threadStatus)
      return Promise.reject(new actual.ApiError(404, 'unmocked'))
    },
    put: (path: string, body: { paused: boolean }) => {
      puts.push({ path, body })
      // The server's state follows its own answer, so the refetch agrees.
      return pauseAnswer(body.paused).then((answer) => {
        const { paused } = answer as { paused: boolean }
        if (Array.isArray(rows)) rows = rows.map((r) => ({ ...r, paused }))
        return answer
      })
    },
  }
})

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'ch-1a2b3c4d-deadbeef', surface: 'frontdesk', created_by: OWNER, coordinator_id: AGENT,
    status: 'active', created_at: '', ...over,
  } as Project
}

function row(over: Partial<ChannelThreadRow> = {}): ChannelThreadRow {
  return {
    project_id: 'p1', channel: 'telegram', connection_id: 'c1', connection_enabled: true,
    connection_removed: false, contact_id: 'k1', contact_name: 'Ana', paused: false, ...over,
  }
}

function msg(id: string, from: string, content: string, ts = ago(10 * 60_000)): ChatMessage {
  return {
    entry_type: 'message', id, ts, from_participant_id: from, from_participant_name: from,
    content, expects_response_from: [], is_ack: false,
  } as unknown as ChatMessage
}

function item(message_id: string, state: string, reason: string | null = null, part_index = 0): OutboxItem {
  return { message_id, part_index, state, reason, attempts: 1 }
}

let queryClient: QueryClient
function renderView() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p1/chatrooms/user-communication']}>
        <Routes>
          <Route path="/projects/:projectId/chatrooms/:chatroomName" element={<ChatroomView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const bar = () => screen.queryByTestId('channel-thread-bar')
const sendButton = () => screen.getAllByRole('button').find((b) => b.title === 'Command (⌘/Ctrl+Enter)')!

beforeEach(() => {
  seedSessions([makeSession({ id: OWNER, username: 'owner' })], OWNER)
  projects = [project()]
  messages = [msg('m1', 'contact:k1', 'Is the table free?')]
  viewer = false
  rows = [row()]
  outbox = []
  threadStatus = new ApiError(404, 'Not a channel thread')
  pauseAnswer = (paused) => Promise.resolve({ project_id: 'p1', paused })
  requested.length = 0
  puts.length = 0
  sent.length = 0
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

// ── where the control appears ───────────────────────────────────────────

describe('the control is on a channel thread the viewer owns, and nowhere else', () => {
  it('a channel thread: badge, "via Telegram · Ana", and Take over', async () => {
    renderView()
    expect((await screen.findByTestId('channel-thread-via')).textContent).toBe('via Telegram · Ana')
    expect(screen.getByRole('img', { name: 'Telegram' })).toBeTruthy()
    expect(screen.getByRole('button', { name: THREAD_COPY.pause })).toBeTruthy()
  })

  it('an ordinary Front Desk thread (no row in the list): no control', async () => {
    projects = [project({ name: 'alice-fd-support-1a2b3c4d' })]
    rows = []
    renderView()
    await waitFor(() => expect(requested).toContain('/me/channels/threads'))
    expect(bar()).toBeNull()
    expect(sendButton().textContent).toBe('command')
  })

  it('a DM: no control, and the thread list is not even asked for', async () => {
    projects = [project({ surface: 'dm', name: 'owner-dm-support-1a2b3c4d' })]
    renderView()
    await screen.findByText('Is the table free?')
    expect(bar()).toBeNull()
    expect(requested).not.toContain('/me/channels/threads')
  })

  it('a regular project: no control', async () => {
    projects = [project({ surface: 'regular', name: 'launch' })]
    renderView()
    await screen.findByText('Is the table free?')
    expect(bar()).toBeNull()
  })

  it('a viewer of a shared channel thread: no control and no "Send on"', async () => {
    viewer = true
    renderView()
    await screen.findByText('Is the table free?')
    expect(bar()).toBeNull()
    expect(screen.queryByText(/Send on/)).toBeNull()
  })

  it('a removed connection: badge and name, no pause control, and the "stays in ClawMeets" line', async () => {
    rows = [row({ connection_removed: true, connection_id: null, contact_id: null })]
    renderView()
    await screen.findByTestId('channel-thread-via')
    expect(screen.queryByRole('button', { name: THREAD_COPY.pause })).toBeNull()
    expect(screen.getByText(THREAD_COPY.removedNote('telegram'))).toBeTruthy()
    expect(sendButton().textContent).toBe('command')
  })
})

// ── pause and resume ────────────────────────────────────────────────────

describe('Take over / Hand back', () => {
  it('Take over pauses this thread: PUT {paused: true}, then the banner and "Send on Telegram"', async () => {
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: THREAD_COPY.pause }))
    await screen.findByTestId('channel-paused-banner')
    expect(puts).toEqual([{ path: '/me/channels/threads/p1/pause', body: { paused: true } }])
    expect(screen.getByTestId('channel-paused-banner').textContent).toBe(THREAD_COPY.pausedBanner('Ana', 'telegram'))
    expect(screen.getByTestId('channel-pause-state').textContent).toBe('Paused: yes')
    expect(sendButton().textContent).toBe('Send on Telegram')
  })

  it("shows the server's answer, not the request: asked to pause, told {paused: false}", async () => {
    pauseAnswer = () => Promise.resolve({ project_id: 'p1', paused: false })
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: THREAD_COPY.pause }))
    await waitFor(() => expect(puts).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('channel-pause-state').textContent).toBe('Paused: no'))
    expect(screen.queryByTestId('channel-paused-banner')).toBeNull()
  })

  it('Hand back un-pauses and says what happens next', async () => {
    rows = [row({ paused: true })]
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: THREAD_COPY.resume }))
    expect((await screen.findByTestId('channel-resume-note')).textContent).toBe(THREAD_COPY.resumeNote('Ana'))
    expect(puts[0].body).toEqual({ paused: false })
    expect(screen.queryByTestId('channel-paused-banner')).toBeNull()
  })

  it('Take over says a reply already on its way may still be delivered', async () => {
    renderView()
    await screen.findByRole('button', { name: THREAD_COPY.pause })
    expect(screen.getByText(THREAD_COPY.pauseNote)).toBeTruthy()
  })

  it.each([
    [403, THREAD_COPY.forbidden],
    [404, THREAD_COPY.gone],
    [500, THREAD_COPY.failed],
  ])('a %i from the PUT shows inline and leaves the control as it was', async (status, text) => {
    pauseAnswer = () => Promise.reject(new ApiError(status, 'nope'))
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: THREAD_COPY.pause }))
    expect((await screen.findByTestId('channel-pause-error')).textContent).toBe(text)
    expect(screen.getByTestId('channel-pause-state').textContent).toBe('Paused: no')
  })

  it('another tab paused it: the list refreshes and this tab shows paused', async () => {
    renderView()
    await screen.findByRole('button', { name: THREAD_COPY.pause })
    rows = [row({ paused: true })]
    await act(() => queryClient.invalidateQueries({ queryKey: CHANNEL_THREADS_KEY }))
    await screen.findByTestId('channel-paused-banner')
  })

  it('the post itself goes to the ordinary messages route, with no extra flag', async () => {
    rows = [row({ paused: true })]
    const { container } = renderView()
    await screen.findByTestId('channel-paused-banner')
    const editor = container.querySelector('.pe-input') as HTMLDivElement
    editor.textContent = 'Owner here'
    fireEvent.input(editor)
    fireEvent.click(sendButton())
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({ projectId: 'p1', room: 'user-communication', body: { content: 'Owner here', files: [] } })
  })
})

// ── the composer says where the text goes ───────────────────────────────

describe('the composer, before sending', () => {
  it('un-paused: still "Send on Telegram", and it says the agent also reads it', async () => {
    renderView()
    await screen.findByTestId('channel-thread-bar')
    expect(sendButton().textContent).toBe('Send on Telegram')
    expect(screen.getByText(THREAD_COPY.unpausedNote('telegram'))).toBeTruthy()
  })

  it('a disabled connection: it will wait and be sent on Enable', async () => {
    rows = [row({ connection_enabled: false, paused: true })]
    renderView()
    expect(await screen.findByText(THREAD_COPY.disabledNote('telegram'))).toBeTruthy()
  })

  it("WhatsApp with the window closed: warns before sending; open window: no warning", async () => {
    rows = [row({ channel: 'whatsapp', paused: true })]
    threadStatus = { project_id: 'p1', channel: 'whatsapp', paused: true, contact_name: 'Ana', window_closed_at: 1_760_000_000, held: [] }
    renderView()
    expect(await screen.findByText(THREAD_COPY.windowClosed('Ana'))).toBeTruthy()
    cleanup()
    threadStatus = { ...threadStatus, window_closed_at: null }
    renderView()
    await screen.findByTestId('channel-paused-banner')
    await waitFor(() => expect(requested.filter((p) => p === '/me/channels/threads/p1').length).toBeGreaterThan(1))
    expect(screen.queryByText(THREAD_COPY.windowClosed('Ana'))).toBeNull()
  })
})

// ── what reached the person ─────────────────────────────────────────────

describe('a delivery line under each outgoing message', () => {
  beforeEach(() => {
    messages = [
      msg('m1', 'contact:k1', 'Is the table free?'),
      msg('m2', AGENT, 'Yes, 8pm works.'),
      msg('m3', OWNER, 'Owner here, confirming.'),
    ]
  })

  async function lines() {
    await waitFor(() => expect(requested).toContain('/me/channels/threads/p1/outbox'))
    return screen.findAllByTestId('delivery-line')
  }

  it("the contact's own message has no line; the agent's and the owner's do", async () => {
    outbox = [item('m2', 'sent'), item('m3', 'sent')]
    renderView()
    await waitFor(async () => expect(await lines()).toHaveLength(2))
  })

  it('an agent reply held by the pause says so, and keeps saying so after Hand back', async () => {
    rows = [row({ paused: true })]
    outbox = [item('m2', 'held_paused', 'paused'), item('m3', 'sent')]
    renderView()
    await waitFor(async () => expect((await lines())[0].textContent).toBe(DELIVERY_COPY.heldPaused))
    fireEvent.click(screen.getByRole('button', { name: THREAD_COPY.resume }))
    await screen.findByTestId('channel-resume-note')
    expect((await lines())[0].textContent).toBe(DELIVERY_COPY.heldPaused)
  })

  it("the owner's post that failed: Not delivered, a reason, Copy text, and nothing resent", async () => {
    outbox = [item('m2', 'sent'), item('m3', 'failed', 'token_rejected')]
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    renderView()
    await waitFor(async () => expect((await lines())[1].textContent).toContain('Not delivered: the connection was refused by the provider'))
    fireEvent.click(screen.getByRole('button', { name: DELIVERY_COPY.copy }))
    expect(writeText).toHaveBeenCalledWith('Owner here, confirming.')
    expect(sent).toHaveLength(0)
  })

  it('a reply already being sent when the owner paused shows sent, not held', async () => {
    rows = [row({ paused: true })]
    outbox = [item('m2', 'sent')]
    renderView()
    await waitFor(async () => expect((await lines())[0].textContent).toBe(DELIVERY_COPY.sent))
  })

  it('polls while something is sending, and stops once everything is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    outbox = [item('m2', 'sending'), item('m3', 'sent')]
    renderView()
    await waitFor(() => expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(1))
    outbox = [item('m2', 'sent'), item('m3', 'sent')]
    await vi.advanceTimersByTimeAsync(OUTBOX_POLL_MS + 10)
    await waitFor(() => expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(2)
  })

  it('a fresh reply that already has a sent row: one outbox call in 10 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    messages = [msg('m1', 'contact:k1', 'hi'), msg('m2', AGENT, 'reply', ago(5_000))]
    outbox = [item('m2', 'sent')]
    renderView()
    await waitFor(() => expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(1)
  })

  it('a fresh reply with no rows: polls, then stops by 2 minutes plus one interval, and its "Sending" line goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    messages = [msg('m1', 'contact:k1', 'hi'), msg('m2', AGENT, 'reply', ago(5_000))]
    outbox = []
    renderView()
    await waitFor(() => expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(1))
    expect(screen.getAllByTestId('delivery-line')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(OUTBOX_POLL_MS * 3)
    expect(requested.filter((p) => p.endsWith('/outbox')).length).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(2 * 60_000 + OUTBOX_POLL_MS)
    const settled = requested.filter((p) => p.endsWith('/outbox')).length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(settled)
    expect(screen.queryAllByTestId('delivery-line')).toHaveLength(0)
  })

  it('an outbox call that fails stops the poll, even with a pending row from the last good answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    outbox = [item('m2', 'pending'), item('m3', 'sent')]
    renderView()
    await waitFor(() => expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(1))
    outbox = new ApiError(404, 'Not a channel thread')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(2)
  })

  it('a removed connection: a fresh reply with no rows is not waited for, so no "Sending" line and one outbox call', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    rows = [row({ connection_removed: true, connection_id: null, contact_id: null })]
    messages = [msg('m1', 'contact:k1', 'hi'), msg('m2', AGENT, 'reply', ago(10_000))]
    outbox = []
    renderView()
    await waitFor(() => expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requested.filter((p) => p.endsWith('/outbox'))).toHaveLength(1)
    expect(screen.queryByText(/Sending on/)).toBeNull()
  })

  it('a removed connection: the waiting reply reads "Not delivered: the connection was removed"', async () => {
    rows = [row({ connection_removed: true, connection_id: null, contact_id: null })]
    outbox = [item('m2', 'failed', 'connection_removed')]
    renderView()
    await waitFor(async () =>
      expect((await lines())[0].textContent).toBe('Not delivered: the connection was removed'))
    expect(screen.getAllByTestId('delivery-line')).toHaveLength(1) // the later owner post has no row: no line
  })

  it('a disabled connection: a pending row reads "Waiting: connection disabled"', async () => {
    rows = [row({ connection_enabled: false })]
    outbox = [item('m2', 'sent'), item('m3', 'pending')]
    renderView()
    await waitFor(async () => expect((await lines())[1].textContent).toBe(DELIVERY_COPY.waitingDisabled))
  })
})

// ── a Hub thread's bodies are untrusted ─────────────────────────────────

describe("a Hub requester's message renders as untrusted Markdown on the host side", () => {
  const HOSTILE = 'Hi ![pixel](https://x.example/p.png?u=owner) and [click](javascript:alert(1))'
  const imgs = () => document.querySelectorAll('img')
  const jsLinks = () => [...document.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'))

  it('a Hub thread: no <img> and no javascript: anchor in a requester body', async () => {
    rows = [row({ channel: 'hub', contact_name: '' })]
    messages = [msg('m1', 'contact:k1', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    await waitFor(() => expect(requested).toContain('/me/channels/threads'))
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  // Forward and Save to knowledge pack copy the body out word for word into
  // a trusted room (the owner's DM) or a pack, so a remote body never gets them.
  const forwardButton = () => screen.queryByRole('button', { name: /Forward/ })
  const packButton = () => screen.queryByRole('button', { name: /Save to knowledge pack/ })

  it('a Hub requester\'s message on the host side shows neither Forward nor Save to knowledge pack', async () => {
    rows = [row({ channel: 'hub', contact_name: '' })]
    messages = [msg('m1', 'contact:k1', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    await waitFor(() => expect(requested).toContain('/me/channels/threads'))
    expect(forwardButton()).toBeNull()
    expect(packButton()).toBeNull()
  })

  it('a Hub thread on the requester side (hub_target) shows neither Forward nor Save to knowledge pack', async () => {
    projects = [project({ surface: 'dm', hub_target: { agent_id: 'scout.acme.dev' } } as unknown as Partial<Project>)]
    messages = [msg('m1', 'stand-in', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    expect(forwardButton()).toBeNull()
    expect(packButton()).toBeNull()
  })

  it('an ordinary channel thread: the agent\'s reply shows both and Forward opens its preview; the contact is outside', async () => {
    // A channel contact is a requester: outside content under the fail-closed
    // rule, so its body is fenced and gets neither, with the "outside" badge.
    messages = [msg('m1', 'contact:k1', 'Is the table free?'), msg('m2', AGENT, 'It is free at eight.')]
    renderView()
    await screen.findByText(/free at eight/)
    await waitFor(() => expect(packButton()).not.toBeNull())
    expect(screen.getAllByRole('button', { name: /Forward/ })).toHaveLength(1)
    expect(screen.getAllByTestId('outside-badge')).toHaveLength(1)
    fireEvent.click(forwardButton()!)
    expect(await screen.findByText(/Forwarded from/)).toBeTruthy()
  })

  it('an owned Front Desk room whose channel is not known yet is treated as a Hub thread', async () => {
    rows = new Promise<never>(() => {}) as unknown as ChannelThreadRow[]
    messages = [msg('m1', 'contact:k1', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  // The room is trusted only on positive evidence: a loaded thread row whose
  // channel is not Hub. Each case below has no such row.
  it('a project list that has loaded without the new Request yet: untrusted', async () => {
    projects = [project({ id: 'p-older', name: 'older' })]
    messages = [msg('m1', 'contact:k1', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  it('a thread list that has loaded without the row yet: untrusted', async () => {
    rows = [row({ project_id: 'p-older' })]
    messages = [msg('m1', 'contact:k1', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    await waitFor(() => expect(requested).toContain('/me/channels/threads'))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  it('a thread list that answers 404 (channels off on this server): untrusted', async () => {
    rows = new ApiError(404, 'Not Found')
    messages = [msg('m1', 'contact:k1', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    await waitFor(() => expect(requested).toContain('/me/channels/threads'))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  it('an ordinary room still renders trusted Markdown: the image is drawn', async () => {
    projects = [project({ surface: 'regular', name: 'launch' })]
    messages = [msg('m1', AGENT, 'Chart: ![chart](https://example.com/c.png)')]
    renderView()
    await screen.findByText(/Chart/)
    expect(imgs().length).toBe(1)
  })

  it('a Telegram thread keeps trusted Markdown once its row says so', async () => {
    messages = [msg('m1', AGENT, 'Chart: ![chart](https://example.com/c.png)')]
    renderView()
    await screen.findByTestId('channel-thread-via')
    await waitFor(() => expect(imgs().length).toBe(1))
  })
})

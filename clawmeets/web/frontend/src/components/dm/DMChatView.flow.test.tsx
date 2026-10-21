import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { participantInfo, roomFlow } from '../../test/hubFixtures'
import type { ChatFileEvent, ChatMessage, Chatroom, Project } from '../../types'
import { useHeldPostsStore } from '../../stores/heldPostsStore'
import DMChatView from './DMChatView'

/**
 * The DM view of a thread, as the room view: per-author trust (another
 * account's agent renders untrusted), a held post (202) clears the draft,
 * is sent once and shows its notice, and a refused post (409
 * room_flow_stopped) keeps the draft, says why and offers the owner Resume,
 * in the thread it came from only. The Files sidebar follows the per-author
 * rule too.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= vi.fn()

const OWNER = 'u1'
const AGENT = { id: 'a-support', name: 'owner-support', registered_by: OWNER, status: 'online', description: '', capabilities: [] }
const HOSTILE = 'Hi ![pixel](https://x.example/p.png?u=owner)'
let room: Chatroom
let thread: Project
let messages: Array<ChatMessage | ChatFileEvent>
let fileNames: string[]
let sendAnswer: () => Promise<unknown>
const posts: Array<{ path: string; body: unknown }> = []
const puts: Array<{ path: string; body: unknown }> = []

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ data: [AGENT], isLoading: false }),
  useAllParticipants: () => ({ data: [AGENT] }),
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    get: (path: string) => {
      if (path === `/participants/${OWNER}/projects`) return Promise.resolve([thread, { ...thread, id: 't2' }])
      const m = /^\/projects\/(t1|t2)(.*)$/.exec(path)
      if (m?.[2] === '') return Promise.resolve({ ...thread, id: m[1] })
      if (m?.[2] === '/chatrooms/user-communication') return Promise.resolve(room)
      if (m?.[2] === '/chatrooms/user-communication/messages') return Promise.resolve(messages)
      if (m?.[2] === '/chatrooms/user-communication/files') return Promise.resolve(fileNames)
      return Promise.reject(new actual.ApiError(404, 'unmocked'))
    },
    getFile: () => Promise.resolve(new Blob(['<script>alert(1)</script>'], { type: 'text/html' })),
    post: (path: string, body: unknown) => {
      posts.push({ path, body })
      return sendAnswer()
    },
    put: (path: string, body: unknown) => {
      puts.push({ path, body })
      return Promise.resolve(roomFlow())
    },
  }
})
const { ApiError } = await import('../../api/client')

// Switches threads the way the DM rail does: same route, new :threadId, so
// React Router keeps the one DMChatView instance mounted.
function GoToThread2() {
  const navigate = useNavigate()
  return <button type="button" data-testid="go-t2" onClick={() => navigate(`/dm/${AGENT.name}/t2`)} />
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { qc, ...render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/dm/${AGENT.name}/t1`]}>
        <Routes>
          <Route path="/dm/:agentName/:threadId" element={<><DMChatView /><GoToThread2 /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ) }
}

const msg = (id: string, from: string, content: string): ChatMessage => ({
  entry_type: 'message', id, ts: '2026-10-11T10:00:00Z', from_participant_id: from,
  from_participant_name: from, content, expects_response_from: [],
}) as ChatMessage

beforeEach(() => {
  AGENT.name = 'owner-support'
  seedSessions([makeSession({ id: OWNER, username: 'owner' })], OWNER)
  thread = {
    id: 't1', name: 'owner-dm-support-1', surface: 'dm', created_by: OWNER, coordinator_id: AGENT.id,
    status: 'active', created_at: '',
  } as Project
  room = {
    id: 'r', name: 'user-communication', project_id: 't1', participants: [AGENT.id], version: 1, created_at: '',
    participant_info: [participantInfo(AGENT.id)], flow: roomFlow(),
  } as Chatroom
  messages = [msg('m1', AGENT.id, 'Hello there')]
  fileNames = []
  sendAnswer = () => Promise.resolve(msg('m-new', OWNER, 'x'))
  posts.length = 0
  puts.length = 0
  useHeldPostsStore.getState().reset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const imgs = () => document.querySelectorAll('img[src*="x.example"]')

async function type(container: HTMLElement, text: string) {
  const editor = await waitFor(() => {
    const el = container.querySelector('.pe-input') as HTMLDivElement | null
    if (!el) throw new Error('no editor yet')
    return el
  })
  editor.textContent = text
  fireEvent.input(editor)
  return editor
}
const send = () => fireEvent.click(screen.getAllByRole('button').find((b) => b.title === 'Command (⌘/Ctrl+Enter)')!)

describe('per-author trust in the DM view', () => {
  it("another account's agent (outside:true) renders untrusted with the outside badge", async () => {
    room = { ...room, participant_info: [participantInfo('a-theirs', { outside: true })] }
    messages = [msg('m1', 'a-theirs', HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    await waitFor(() => expect(screen.getAllByTestId('outside-badge').length).toBe(1))
    expect(imgs().length).toBe(0)
    expect(screen.queryByRole('button', { name: /Forward/ })).toBeNull()
  })

  it("the owner's own agent, listed inside, stays trusted", async () => {
    messages = [msg('m1', AGENT.id, HOSTILE)]
    renderView()
    await screen.findByText(/Hi/)
    await waitFor(() => expect(imgs().length).toBe(1))
    expect(screen.queryByTestId('outside-badge')).toBeNull()
  })
})

describe('a post the server holds (202) in the DM view', () => {
  it('clears the draft, sends once, and shows the held notice', async () => {
    sendAnswer = () => Promise.resolve({ held: true, reason: 'requester_key_pending', message: '' })
    const { container } = renderView()
    const editor = await type(container, 'Are you open?')
    send()
    expect(await screen.findByTestId('held-notice')).toBeTruthy()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(posts).toHaveLength(1)
    expect(posts[0].path).toBe('/projects/t1/chatrooms/user-communication/user-message')
    expect(editor.textContent).toBe('')
  })

  it('keeps the notice when the same text is later sent and delivered at once', async () => {
    sendAnswer = () => Promise.resolve({ held: true, reason: 'requester_key_pending', message: '' })
    const { container } = renderView()
    await type(container, 'ok')
    send()
    await screen.findByTestId('held-notice')
    sendAnswer = () => Promise.resolve(msg('m-direct', OWNER, 'ok'))
    messages = [...messages, msg('m-direct', OWNER, 'ok')]
    await type(container, 'ok')
    send()
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(posts).toHaveLength(2)
    expect(screen.getByTestId('held-notice')).toBeTruthy()
  })

  it('keeps the notice when the WebSocket echo of the same text beats the HTTP answer', async () => {
    sendAnswer = () => Promise.resolve({ held: true, reason: 'requester_key_pending', message: '' })
    const { container, qc } = renderView()
    await type(container, 'ok')
    send()
    await screen.findByTestId('held-notice')
    let answer!: (m: ChatMessage) => void
    sendAnswer = () => new Promise((res) => { answer = res })
    await type(container, 'ok')
    send()
    await waitFor(() => expect(posts).toHaveLength(2))
    // The echo lands while the POST is still open.
    messages = [...messages, msg('m-echo', OWNER, 'ok')]
    await act(async () => { await qc.invalidateQueries({ queryKey: ['messages', 't1', 'user-communication'] }) })
    await waitFor(() => expect(screen.getAllByText('ok').length).toBeGreaterThan(1))
    expect(screen.getByTestId('held-notice')).toBeTruthy()
    await act(async () => { answer(msg('m-echo', OWNER, 'ok')); await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByTestId('held-notice')).toBeTruthy()
  })
})

describe('a post the server refuses (409 room_flow_stopped) in the DM view', () => {
  beforeEach(() => {
    room = { ...room, flow: roomFlow({ inbound_flow: 'stopped', stopped_by: 'owner' }) }
    sendAnswer = () => Promise.reject(new ApiError(409, 'Conflict', {
      detail: { code: 'room_flow_stopped', message: 'stopped' },
    }))
  })

  it('keeps the draft, says why in the agent-access copy, and shows the stopped strip', async () => {
    const { container } = renderView()
    expect(await screen.findByTestId('room-flow-strip')).toBeTruthy()
    const editor = await type(container, 'Still there?')
    send()
    const error = await screen.findByTestId('dm-send-error')
    expect(error.textContent).toContain('Outside messages are stopped in this room. Resume them to send.')
    expect(editor.textContent).toBe('Still there?')
    expect(posts).toHaveLength(1)
  })

  it('offers the owner Resume, which reopens the room and clears the error', async () => {
    const { container } = renderView()
    await type(container, 'Still there?')
    send()
    fireEvent.click(await screen.findByTestId('dm-resume-flow'))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].path).toBe('/projects/t1/chatrooms/user-communication/flow')
    await waitFor(() => expect(screen.queryByTestId('dm-send-error')).toBeNull())
  })

  it('offers no Resume to a viewer who does not own the thread', async () => {
    thread = { ...thread, created_by: 'someone-else' }
    const { container } = renderView()
    await type(container, 'Still there?')
    send()
    await screen.findByTestId('dm-send-error')
    expect(screen.queryByTestId('dm-resume-flow')).toBeNull()
  })
})

describe('the DM Files sidebar', () => {
  URL.createObjectURL ??= () => 'blob:http://localhost/x'
  URL.revokeObjectURL ??= () => {}
  const fileEvent = (filename: string, from: string): ChatFileEvent =>
    ({ entry_type: 'file_created', ts: '2026-10-11T10:00:01Z', from_participant_id: from, from_participant_name: from, filename })
  const sidebarFile = async (name: string) => {
    const aside = await waitFor(() => {
      const el = [...document.querySelectorAll('aside')].find((a) => a.textContent?.includes(name))
      if (!el) throw new Error('no sidebar row yet')
      return el as HTMLElement
    })
    return [...aside.querySelectorAll('span')].find((s) => s.textContent === name) as HTMLElement
  }

  it("opens another account's agent's HTML file untrusted: no Open in new tab, no Save to agent", async () => {
    room = { ...room, participant_info: [participantInfo('a-theirs', { outside: true })] }
    messages = [msg('m1', 'a-theirs', 'see attached'), fileEvent('report.html', 'a-theirs')]
    fileNames = ['report.html']
    renderView()
    const row = await sidebarFile('report.html')
    expect(row.parentElement?.querySelector('[data-testid="outside-badge"]')).toBeTruthy()
    fireEvent.click(row)
    await screen.findByRole('heading', { name: 'report.html' })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByLabelText('Open in new tab')).toBeNull()
    expect(screen.queryByLabelText('Save to agent')).toBeNull()
  })

  it("the owner's own agent's HTML file still opens trusted", async () => {
    messages = [msg('m1', AGENT.id, 'see attached'), fileEvent('report.html', AGENT.id)]
    fileNames = ['report.html']
    renderView()
    const row = await sidebarFile('report.html')
    expect(row.parentElement?.querySelector('[data-testid="outside-badge"]')).toBeNull()
    fireEvent.click(row)
    expect(await screen.findByLabelText('Open in new tab')).toBeTruthy()
  })
})

describe('a refusal stays with the thread it came from', () => {
  it('switching threads clears the send error and its Resume', async () => {
    room = { ...room, flow: roomFlow({ inbound_flow: 'stopped', stopped_by: 'owner' }) }
    sendAnswer = () => Promise.reject(new ApiError(409, 'Conflict', {
      detail: { code: 'room_flow_stopped', message: 'stopped' },
    }))
    const { container } = renderView()
    await type(container, 'Still there?')
    send()
    await screen.findByTestId('dm-resume-flow')
    fireEvent.click(screen.getByTestId('go-t2'))
    await waitFor(() => expect(screen.queryByTestId('dm-send-error')).toBeNull())
    expect(screen.queryByTestId('dm-resume-flow')).toBeNull()
    expect(puts).toHaveLength(0)
  })
})

describe('a send still in flight when the user switches threads', () => {
  // The reviewer's probe: before the fix, the switch reset the pending send,
  // so t2's composer re-enabled holding t1's text (one click posted it to t2
  // too), and t1's late success then wiped whatever was typed in t2.
  let land: (v: unknown) => void
  let fail: (e: unknown) => void
  beforeEach(() => {
    sendAnswer = () => new Promise((resolve, reject) => { land = resolve; fail = reject })
  })

  it('posts nothing to t2, keeps the composer disabled until it lands, and leaves t2 drafts alone', async () => {
    const { container } = renderView()
    await type(container, 'For t1 only')
    send()
    await waitFor(() => expect(posts).toHaveLength(1))
    fireEvent.click(screen.getByTestId('go-t2'))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    // Still pending: Send stays disabled, so t1's text cannot be posted to t2.
    const sendButton = screen.getAllByRole('button').find((b) => b.title === 'Command (⌘/Ctrl+Enter)')!
    expect((sendButton as HTMLButtonElement).disabled).toBe(true)
    send()
    expect(posts).toHaveLength(1)

    await act(async () => { land(msg('m-new', OWNER, 'For t1 only')) })
    const editor = await type(container, 'A new note for t2')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(editor.textContent).toBe('A new note for t2')
    expect(posts.map((p) => p.path)).toEqual(['/projects/t1/chatrooms/user-communication/user-message'])
  })

  it("shows t1's late refusal neither as an error nor as a Resume in t2", async () => {
    const { container } = renderView()
    await type(container, 'Still there?')
    send()
    await waitFor(() => expect(posts).toHaveLength(1))
    fireEvent.click(screen.getByTestId('go-t2'))
    await act(async () => {
      fail(new ApiError(409, 'Conflict', { detail: { code: 'room_flow_stopped', message: 'stopped' } }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByTestId('dm-send-error')).toBeNull()
    expect(screen.queryByTestId('dm-resume-flow')).toBeNull()
    expect(puts).toHaveLength(0)
  })
})

describe('Personalize while a send is still in flight', () => {
  // The reviewer's case: in the assistant's DM, a send from t1 is still
  // running (its staged files still in the composer) when the user switches to
  // t2 and picks Personalize. Before the gate, that posted to t2 with t1's files.
  beforeEach(() => {
    AGENT.name = 'owner-assistant'
    sendAnswer = () => new Promise(() => {})
  })
  const personalizeButton = () => screen.getByRole('button', { name: 'Personalize' }) as HTMLButtonElement

  it('disables Personalize until the send lands, so nothing posts to t2', async () => {
    const { container } = renderView()
    await type(container, 'For t1 only')
    send()
    await waitFor(() => expect(posts).toHaveLength(1))
    fireEvent.click(screen.getByTestId('go-t2'))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(personalizeButton().disabled).toBe(true)
    fireEvent.click(personalizeButton())
    expect(screen.queryByText('Answer a few questions')).toBeNull()
    expect(posts).toHaveLength(1)
  })

  it('a Personalize dialog left open does not send while the send is pending', async () => {
    const { container } = renderView()
    await waitFor(() => expect(personalizeButton().disabled).toBe(false))
    fireEvent.click(personalizeButton())
    fireEvent.click(await screen.findByText('Answer a few questions'))
    await type(container, 'For t1 only')
    send()
    await waitFor(() => expect(posts).toHaveLength(1))
    fireEvent.click(screen.getByTestId('go-t2'))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    fireEvent.click(screen.getByRole('button', { name: 'Start Q&A' }))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(posts.map((p) => p.path)).toEqual(['/projects/t1/chatrooms/user-communication/user-message'])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { participantInfo, roomFlow, standIn } from '../../test/hubFixtures'
import type { ChatMessage, Chatroom, Project } from '../../types'
import { useHeldPostsStore } from '../../stores/heldPostsStore'
import ChatroomView from './ChatroomView'

/**
 * Room flow in a room: who sees "Stop outside messages", what the PUT sends,
 * the resume-after-monitor ask, the strip every member sees, and a post the
 * server holds (202): the draft clears, nothing is resent, the notice shows
 * until the message itself arrives.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const OWNER = 'u1'
let room: Chatroom
let project: Project
let messages: ChatMessage[]
let viewer = false
let sendAnswer: () => Promise<unknown>
const puts: Array<{ path: string; body: unknown }> = []
const posts: unknown[] = []

vi.mock('../../hooks/useSharing', () => ({ useIsProjectViewer: () => viewer }))
vi.mock('../../hooks/useAgents', () => ({ useAllParticipants: () => ({ data: [] }), useAgents: () => ({ data: [] }) }))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    get: (path: string) => {
      if (path === '/projects/p1') return Promise.resolve(project)
      if (path === `/projects/p1/chatrooms/${room.name}`) return Promise.resolve(room)
      if (path === `/projects/p1/chatrooms/${room.name}/messages`) return Promise.resolve(messages)
      return Promise.reject(new actual.ApiError(404, 'unmocked'))
    },
    put: (path: string, body: unknown) => {
      puts.push({ path, body })
      return Promise.resolve(roomFlow({ inbound_flow: (body as { state: string }).state === 'stopped' ? 'stopped' : 'open', stopped_by: 'owner' }))
    },
    post: (path: string, body: unknown) => {
      posts.push({ path, body })
      return sendAnswer()
    },
  }
})

let qc: QueryClient
function renderView(name = 'work') {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/p1/chatrooms/${name}`]}>
        <Routes>
          <Route path="/projects/:projectId/chatrooms/:chatroomName" element={<ChatroomView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const mkRoom = (o: Partial<Chatroom> = {}): Chatroom => ({
  id: 'r', name: 'work', project_id: 'p1', participants: ['a-own'], version: 1, created_at: '',
  participant_info: [participantInfo('a-own'), standIn()], flow: roomFlow(), ...o,
})

beforeEach(() => {
  seedSessions([makeSession({ id: OWNER, username: 'owner' })], OWNER)
  room = mkRoom()
  project = { id: 'p1', name: 'proj', created_by: OWNER, coordinator_id: 'a-own', status: 'active', created_at: '' } as Project
  messages = []
  viewer = false
  sendAnswer = () => Promise.resolve({ id: 'm-new' })
  puts.length = 0
  posts.length = 0
  useHeldPostsStore.getState().reset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const control = () => screen.queryByTestId('room-flow-control')

describe('who sees the switch', () => {
  it('the owner, in a room with an outside participant', async () => {
    renderView()
    expect((await screen.findByTestId('room-flow-control')).textContent).toBe('Stop outside messages')
  })

  it('not in a room with nobody outside', async () => {
    room = mkRoom({ participant_info: [participantInfo('a-own')] })
    renderView()
    await screen.findByText('work')
    await act(async () => {})
    expect(control()).toBeNull()
  })

  it('not for a read-only viewer, nor for someone who does not own the project', async () => {
    viewer = true
    renderView()
    await screen.findByText('work')
    await act(async () => {})
    expect(control()).toBeNull()
    cleanup()
    viewer = false
    project = { ...project, created_by: 'someone-else' }
    renderView()
    await screen.findByText('work')
    await act(async () => {})
    expect(control()).toBeNull()
  })

  it('a stopped room with nobody outside still offers Resume, and the strip shows', async () => {
    room = mkRoom({ participant_info: [], flow: roomFlow({ inbound_flow: 'stopped', stopped_by: 'owner', held_count: 2 }) })
    renderView()
    expect((await screen.findByTestId('room-flow-control')).textContent).toBe('Resume')
    expect(screen.getByTestId('room-flow-strip-text').textContent).toBe('Outside messages are stopped (by you) · 2 held')
  })

  it('a viewer sees the strip too, "by the owner"', async () => {
    viewer = true
    room = mkRoom({ flow: roomFlow({ inbound_flow: 'stopped', stopped_by: 'owner' }) })
    renderView()
    expect((await screen.findByTestId('room-flow-strip-text')).textContent).toBe('Outside messages are stopped (by the owner)')
  })
})

describe('the switch', () => {
  it('Stop PUTs {state: stopped}; the strip follows the server\'s answer', async () => {
    renderView()
    fireEvent.click(await screen.findByTestId('room-flow-control'))
    await waitFor(() => expect(puts).toEqual([{ path: '/projects/p1/chatrooms/work/flow', body: { state: 'stopped' } }]))
    expect((await screen.findByTestId('room-flow-strip-text')).textContent).toBe('Outside messages are stopped (by you)')
    expect(control()!.textContent).toBe('Resume')
  })

  it('Resume after the monitor stopped the room asks once', async () => {
    room = mkRoom({ flow: roomFlow({ inbound_flow: 'stopped', stopped_by: 'inspector' }) })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderView()
    fireEvent.click(await screen.findByTestId('room-flow-control'))
    expect(confirm).toHaveBeenCalledWith('The monitor stopped this room. Resume anyway?')
    expect(puts).toHaveLength(0)
    fireEvent.click(control()!)
    await waitFor(() => expect(puts[0]?.body).toEqual({ state: 'open' }))
  })
})

describe('a post the server holds (202)', () => {
  it('clears the draft, never resends, shows the notice, and drops it when the message arrives', async () => {
    room = mkRoom({ name: 'user-communication' })
    sendAnswer = () => Promise.resolve({ held: true, reason: 'flow_stopped', message: 'The host paused this.' })
    const { container } = renderView('user-communication')
    const editor = await waitFor(() => {
      const el = container.querySelector('.pe-input') as HTMLDivElement | null
      if (!el) throw new Error('no editor yet')
      return el
    })
    editor.textContent = 'Are you open?'
    fireEvent.input(editor)
    fireEvent.click(screen.getAllByRole('button').find((b) => b.title === 'Command (⌘/Ctrl+Enter)')!)
    const notice = await screen.findByTestId('held-notice')
    expect(notice.textContent).toContain('Held — delivered when the owner reopens the conversation.')
    expect(notice.textContent).toContain("Don't resend.")
    expect(screen.getByTestId('held-server-message').textContent).toBe('The host paused this.')
    expect(notice.querySelector('button')).toBeNull()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(posts).toHaveLength(1)
    expect(editor.textContent).toBe('')

    // Delivered on reopen: the viewer's message with that content arrives.
    messages = [{
      entry_type: 'message', id: 'm9', ts: '2026-10-11T10:00:00Z', from_participant_id: OWNER,
      from_participant_name: 'owner', content: 'Are you open?', expects_response_from: [],
    }]
    await act(async () => { await qc.invalidateQueries({ queryKey: ['messages', 'p1', 'user-communication'] }) })
    await waitFor(() => expect(screen.queryByTestId('held-notice')).toBeNull())
    expect(posts).toHaveLength(1)
  })
})

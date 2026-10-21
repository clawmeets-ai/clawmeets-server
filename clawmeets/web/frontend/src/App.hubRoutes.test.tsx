import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, useParams } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { hubThreadPath } from './utils/hubDisplay'

/**
 * The two hub routes in the real route table. The directory's Message button
 * (RemoteAgentSection) and the sidebar's hub rows (PublicPanel) both build
 * their links with hubThreadPath(), and their own suites check that; this
 * checks that what hubThreadPath() builds lands on HubChatView with the id
 * decoded once and whole, under the authenticated shell.
 */

vi.mock('./api/websocket', () => ({
  wsManager: {
    connectAsUser: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    onAny: vi.fn(() => () => {}),
    onConnect: vi.fn(() => () => {}),
  },
}))
vi.mock('./components/hub/HubChatView', () => ({
  default: function HubChatViewProbe() {
    const { hubAgentId, threadId } = useParams()
    return <p data-testid="hub-route">{JSON.stringify({ hubAgentId, threadId: threadId ?? null })}</p>
  },
}))

// The ordinary views, as probes: the guard must send a hub thread away before
// any of them mounts, so a remote body can never reach MessageItem through them.
const ordinaryMounts: string[] = []
vi.mock('./components/project/ProjectView', () => ({
  default: function ProjectViewProbe() { ordinaryMounts.push('ProjectView'); return <p data-testid="ordinary-view">ProjectView</p> },
}))
vi.mock('./components/chatroom/ChatroomView', () => ({
  default: function ChatroomViewProbe() { ordinaryMounts.push('ChatroomView'); return <p data-testid="ordinary-view">ChatroomView</p> },
}))
vi.mock('./components/dm/DMChatView', () => ({
  default: function DMChatViewProbe() { ordinaryMounts.push('DMChatView'); return <p data-testid="ordinary-view">DMChatView</p> },
}))
const messageItemCalls: unknown[] = []
vi.mock('./components/chatroom/MessageItem', () => ({
  default: function MessageItemProbe(props: unknown) { messageItemCalls.push(props); return null },
}))

import App from './App'
import { queryClient } from './queryClient'
import { makeSession, seedSessions } from './test/authFixtures'
import { installFetchHarness, settle, type FetchHarness, type PendingCall } from './test/fetchHarness'

async function mountAt(entry: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await act(async () => { await settle() })
}

const ID = '3f9a1c2e5b7d9f00~scout'

let h: FetchHarness

beforeEach(() => {
  ordinaryMounts.length = 0
  messageItemCalls.length = 0
  h = installFetchHarness()
  localStorage.clear()
  sessionStorage.clear()
  seedSessions([makeSession({ id: 'u1' })], 'u1')
})

afterEach(() => {
  cleanup()
  seedSessions([])
  queryClient.clear()
  vi.unstubAllGlobals()
})

describe('the hub routes', () => {
  it('the directory\'s Message link, /hub/{id}, opens a draft', async () => {
    await mountAt(hubThreadPath(ID))
    expect(JSON.parse((await screen.findByTestId('hub-route')).textContent!)).toEqual({ hubAgentId: ID, threadId: null })
  })

  it('the sidebar row link, /hub/{id}/{project}, opens the thread', async () => {
    await mountAt(hubThreadPath(ID, 'p-hub-1'))
    expect(JSON.parse((await screen.findByTestId('hub-route')).textContent!)).toEqual({ hubAgentId: ID, threadId: 'p-hub-1' })
  })

  it('an id with a slash or a space survives the round trip whole', async () => {
    const odd = '3f9a1c2e5b7d9f00~a/b c'
    await mountAt(hubThreadPath(odd, 'p 2'))
    expect(JSON.parse((await screen.findByTestId('hub-route')).textContent!)).toEqual({ hubAgentId: odd, threadId: 'p 2' })
  })
})

const HUB_PROJECT = {
  id: 'p-hub-1', name: 'p-hub-1', surface: 'frontdesk',
  hub_target: {
    hub_agent_id: ID, display: 'scout@acme.dev', name: 'scout', deployment_name: 'acme.dev',
    deployment_label: 'acme.dev', deployment_fingerprint: '3f9a1c2e5b7d9f00', deployment_url: null,
    deployment_url_verified: false, listed: true, closed_reason: null, closed_at: null,
  },
}

describe('a hub thread opened through an ordinary route goes to HubChatView', () => {
  it.each([
    ['the project view', '/projects/p-hub-1'],
    ['the chatroom view (a search hit\'s user-communication link)', '/projects/p-hub-1/chatrooms/user-communication'],
    ['the DM thread view (a search hit\'s /dm link)', '/dm/clawmeets-assistant/p-hub-1'],
  ])('%s redirects, and no ordinary view or MessageItem ever renders', async (_name, entry) => {
    await mountAt(entry)
    expect(screen.getByTestId('hub-thread-guard-loading')).toBeTruthy()
    expect(ordinaryMounts).toEqual([])
    ;(await h.awaitCall('/projects/p-hub-1')).ok(HUB_PROJECT)
    await act(async () => { await settle() })
    expect(JSON.parse((await screen.findByTestId('hub-route')).textContent!)).toEqual({ hubAgentId: ID, threadId: 'p-hub-1' })
    expect(ordinaryMounts).toEqual([])
    expect(messageItemCalls).toEqual([])
  })

  it('a thread already in the project list is decided from the list', async () => {
    await mountAt('/dm/clawmeets-assistant/p-hub-1')
    h.respondAll('/participants/u1/projects', 200, [HUB_PROJECT])
    await act(async () => { await settle() })
    expect(JSON.parse((await screen.findByTestId('hub-route')).textContent!)).toEqual({ hubAgentId: ID, threadId: 'p-hub-1' })
    expect(ordinaryMounts).toEqual([])
  })

  it('an ordinary project still opens its ordinary view', async () => {
    await mountAt('/projects/p-plain')
    ;(await h.awaitCall('/projects/p-plain')).ok({ id: 'p-plain', name: 'p-plain', hub_target: null })
    await act(async () => { await settle() })
    expect((await screen.findByTestId('ordinary-view')).textContent).toBe('ProjectView')
    expect(screen.queryByTestId('hub-route')).toBeNull()
  })

  it('a project the server cannot read falls through to the ordinary view and its own error', async () => {
    await mountAt('/dm/clawmeets-assistant/p-gone')
    // The app retries a failed query once, after about a second.
    for (let i = 0; i < 2; i++) {
      ;(await h.awaitCall('/projects/p-gone')).respond(404, { detail: 'Project not found' })
      await act(async () => { await new Promise((r) => setTimeout(r, i === 0 ? 1100 : 0)); await settle() })
    }
    expect((await screen.findByTestId('ordinary-view')).textContent).toBe('DMChatView')
  })

  it.each([
    ['a 500', (c: PendingCall) => c.respond(500, { detail: 'boom' })],
    ['a 503', (c: PendingCall) => c.respond(503, {})],
    ['a network error', (c: PendingCall) => c.networkError()],
  ])('%s on the project read never mounts the ordinary view or MessageItem; Try again reads it again', async (_name, fail) => {
    await mountAt('/projects/p-hub-1/chatrooms/user-communication')
    for (let i = 0; i < 2; i++) {
      fail(await h.awaitCall('/projects/p-hub-1'))
      await act(async () => { await new Promise((r) => setTimeout(r, i === 0 ? 1100 : 0)); await settle() })
    }
    expect(await screen.findByTestId('hub-thread-guard-error')).toBeTruthy()
    expect(ordinaryMounts).toEqual([])
    expect(messageItemCalls).toEqual([])
    act(() => { screen.getByRole('button', { name: 'Try again' }).click() })
    ;(await h.awaitCall('/projects/p-hub-1')).ok(HUB_PROJECT)
    await act(async () => { await settle() })
    expect(JSON.parse((await screen.findByTestId('hub-route')).textContent!)).toEqual({ hubAgentId: ID, threadId: 'p-hub-1' })
    expect(ordinaryMounts).toEqual([])
  })

  it('a 403 on the project read falls through to the ordinary view, as a 404 does', async () => {
    await mountAt('/projects/p-other/chatrooms/user-communication')
    for (let i = 0; i < 2; i++) {
      ;(await h.awaitCall('/projects/p-other')).respond(403, { detail: 'Forbidden' })
      await act(async () => { await new Promise((r) => setTimeout(r, i === 0 ? 1100 : 0)); await settle() })
    }
    expect((await screen.findByTestId('ordinary-view')).textContent).toBe('ChatroomView')
  })

  it('the agent view, /dm/{agent}, has no thread and is not held', async () => {
    await mountAt('/dm/clawmeets-assistant')
    expect((await screen.findByTestId('ordinary-view')).textContent).toBe('DMChatView')
    expect(h.pendingFor('/projects/').length).toBe(0)
  })
})

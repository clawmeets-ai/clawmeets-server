import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/**
 * The Hub tab's "Allowed. Open the thread" and ⌘K's Front Desk jump both open
 * a host-side Hub Request at /projects/{id}. HubThreadGuard lets the host side
 * through (no hub_target), so ProjectView's activity feed must draw the
 * requester's body as untrusted Markdown itself. Real route table, real
 * ProjectView and ActivityFeed; only Virtuoso is replaced, because jsdom has
 * no layout and would render no rows.
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= vi.fn()

vi.mock('./api/websocket', () => ({
  wsManager: {
    connectAsUser: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    onAny: vi.fn(() => () => {}),
    onConnect: vi.fn(() => () => {}),
  },
}))

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (i: number, d: unknown) => ReactNode }) => (
    <div>{data.map((d, i) => <div key={i}>{itemContent(i, d)}</div>)}</div>
  ),
}))

import App from './App'
import { queryClient } from './queryClient'
import { makeSession, seedSessions } from './test/authFixtures'
import { installFetchHarness, settle, type FetchHarness } from './test/fetchHarness'

const HOSTILE = 'Hello ![pixel](https://x.example/p.png?u=owner) and [click](javascript:alert(1))'
const AGENT = { id: 'a-support', name: 'owner-support', registered_by: 'u1', status: 'online', description: '', capabilities: [] }
const project = (over: Record<string, unknown>) => ({
  id: 'p-req', name: 'ch-hub-req', surface: 'frontdesk', created_by: 'u1', coordinator_id: 'a-support',
  status: 'active', created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), chatrooms: ['user-communication'], participating_agents: ['a-support'], request: '',
  hub_target: null, ...over,
})
const BODY = {
  entry_type: 'message', id: 'm1', ts: new Date(Date.now() - 60_000).toISOString(),
  from_participant_id: 'hub:3f9a1c2e5b7d9f00~scout', from_participant_name: 'scout@acme.dev',
  content: HOSTILE, expects_response_from: [], is_ack: false,
}
const ROOM = {
  id: 'r1', name: 'user-communication', project_id: 'p-req', participants: [], created_at: new Date(0).toISOString(),
  participant_info: [{ id: 'a-support', kind: 'agent', outside: false, hub: null }],
}
const HUB_ROW = {
  project_id: 'p-req', channel: 'hub', connection_id: 'c1', connection_enabled: true,
  connection_removed: false, contact_id: 'k1', contact_name: '', paused: false,
}

let h: FetchHarness

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

async function answerAll(p: Record<string, unknown>, threads: unknown[], body: Record<string, unknown> = BODY) {
  for (let round = 0; round < 12; round++) {
    const open = h.calls.filter((c) => !c.settled)
    if (open.length === 0) break
    for (const c of open) {
      const path = c.path.split('?')[0]
      if (path === '/participants/u1/projects') c.ok([p])
      else if (path === '/projects/p-req') c.ok(p)
      else if (path === '/agents') c.ok([AGENT])
      else if (path === '/me/chatrooms') c.ok({ results: { 'p-req': [ROOM] }, errors: {} })
      else if (path === '/projects/p-req/chatrooms/user-communication') c.ok(ROOM)
      else if (path === '/projects/p-req/chatrooms/user-communication/messages') c.ok([body])
      else if (path === '/me/channels/threads') c.ok(threads)
      else if (path.endsWith('/files') || path.endsWith('s')) c.ok([])
      else c.respond(404, { detail: 'Not Found' })
    }
    await act(async () => { await settle() })
  }
}

const imgs = () => document.querySelectorAll('img[src*="x.example"]')
const jsLinks = () =>
  [...document.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'))

beforeEach(() => {
  h = installFetchHarness()
  localStorage.clear()
  sessionStorage.clear()
  seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1')
})

afterEach(() => {
  cleanup()
  seedSessions([])
  queryClient.clear()
  vi.unstubAllGlobals()
})

describe('a host-side Hub Request opened at /projects/{id}', () => {
  it('draws no <img> and no javascript: anchor from the requester\'s body in the activity feed', async () => {
    await mountAt('/projects/p-req')
    await answerAll(project({}), [HUB_ROW])
    expect(await screen.findByText(/Hello/)).toBeTruthy()
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  it('an ordinary project\'s activity feed still draws its images', async () => {
    await mountAt('/projects/p-req')
    // The owner's own agent, listed inside.
    await answerAll(project({ surface: 'regular' }), [], { ...BODY, from_participant_id: 'a-support' })
    expect(await screen.findByText(/Hello/)).toBeTruthy()
    expect(imgs().length).toBe(1)
  })

  it('a stand-in\'s message in an ordinary project\'s activity feed loads no image', async () => {
    // The whole-room rule trusts a regular project; the author is outside.
    await mountAt('/projects/p-req')
    await answerAll(project({ surface: 'regular' }), [])
    expect(await screen.findByText(/Hello/)).toBeTruthy()
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
    expect(screen.getAllByTestId('outside-badge').length).toBeGreaterThan(0)
  })
})

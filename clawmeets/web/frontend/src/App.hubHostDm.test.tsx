import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'

/**
 * The host side of a Hub conversation is one of the owner's Front Desk
 * projects, and ⌘K search links its hits to /dm/{agent}/{project}. HubThreadGuard
 * cannot redirect it (hub_target is requester-side only), so DMChatView itself
 * must render the requester's bodies as untrusted Markdown. Real route table,
 * real DMChatView, real MessageItem.
 */

// jsdom has no layout engine: the header and the editor observe their size.
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

import App from './App'
import { queryClient } from './queryClient'
import { makeSession, seedSessions } from './test/authFixtures'
import { installFetchHarness, settle, type FetchHarness } from './test/fetchHarness'

const HOSTILE = 'Hello ![pixel](https://x.example/p.png?u=owner) and [click](javascript:alert(1))'
const AGENT = { id: 'a-support', name: 'owner-support', registered_by: 'u1', status: 'online', description: '', capabilities: [] }
const REQUEST = {
  id: 'p-req', name: 'ch-hub-req', surface: 'frontdesk', created_by: 'u1', coordinator_id: 'a-support',
  status: 'active', created_at: '', chatrooms: ['user-communication'], participating_agents: ['a-support'], request: '',
  hub_target: null,
}
const BODY = {
  entry_type: 'message', id: 'm1', ts: new Date(Date.now() - 60_000).toISOString(),
  from_participant_id: 'hub:3f9a1c2e5b7d9f00~scout', from_participant_name: 'scout@acme.dev',
  content: HOSTILE, expects_response_from: [], is_ack: false,
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

/** Answer every pending read: the lists the test is about, and an empty or
 *  404 answer for everything else the shell asks for. */
async function answerAll(threads: { status: number; body: unknown }) {
  for (let round = 0; round < 10; round++) {
    const open = h.calls.filter((c) => !c.settled)
    if (open.length === 0) break
    for (const c of open) {
      const path = c.path.split('?')[0]
      if (path === '/participants/u1/projects') c.ok([REQUEST])
      else if (path === '/agents') c.ok([AGENT])
      else if (path === '/projects/p-req/chatrooms/user-communication/messages') c.ok([BODY])
      else if (path === '/me/channels/threads') c.respond(threads.status, threads.body)
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

describe('a host-side Hub Request opened at /dm/{agent}/{project}', () => {
  it('renders no <img> and no javascript: anchor from the requester\'s body', async () => {
    await mountAt('/dm/support/p-req')
    await answerAll({ status: 200, body: [{
      project_id: 'p-req', channel: 'hub', connection_id: 'c1', connection_enabled: true,
      connection_removed: false, contact_id: 'k1', contact_name: '', paused: false,
    }] })
    expect(await screen.findByText(/Hello/)).toBeTruthy()
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  it('stays untrusted when the thread list has no row for it yet', async () => {
    await mountAt('/dm/support/p-req')
    await answerAll({ status: 200, body: [] })
    expect(await screen.findByText(/Hello/)).toBeTruthy()
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })
})

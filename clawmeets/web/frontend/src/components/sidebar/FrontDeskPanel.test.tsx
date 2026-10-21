import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { AgentCard, Project } from '../../types'
import FrontDeskPanel from './FrontDeskPanel'

/**
 * TODAY'S GROUPING OF ORDINARY FRONT DESK THREADS (agent-to-agent, opened
 * through `/me/front-desk/<agent>/ensure`). Written before the channel-thread
 * sidebar, and passing on the code before it, so the sidebar change can be
 * checked against it: desk (agent) → requester (read from the
 * `{requester}-fd-{agent}` room name) → thread.
 *
 * The channel endpoints are stubbed to "no connections, no channel threads":
 * these are the owner's ordinary threads only. Channel threads have their own
 * file, `FrontDeskPanel.channels.test.tsx`.
 */

let agents: AgentCard[] = []
let projects: Project[] = []

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../hooks/useProjects', () => ({ useUserProjects: () => ({ data: projects }) }))
vi.mock('../../api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/endpoints')>()),
  getChatrooms: () => Promise.resolve([{ id: 'r1', name: 'user-communication' }]),
}))
vi.mock('../../api/endpoints/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/endpoints/channels')>()),
  listConnections: () => Promise.resolve([]),
  listChannelThreads: () => Promise.resolve([]),
}))

const NOW = new Date().toISOString()
const LAST_MONTH = new Date(Date.now() - 40 * 864e5).toISOString()

function agent(id: string, name: string, owner = 'u1'): AgentCard {
  return {
    id, name, description: '', capabilities: [], status: 'online', registered_at: '',
    last_heartbeat: null, discoverable_through_registry: false, registered_by: owner, is_verified: true,
  } as AgentCard
}

function project(over: Partial<Project> & { id: string; name: string }): Project {
  return {
    status: 'active', coordinator_id: 'a-support', request: '', chatrooms: ['user-communication'],
    participating_agents: [], created_at: NOW, created_by: 'u1', surface: 'frontdesk', last_modified: NOW,
    ...over,
  } as Project
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FrontDeskPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The requester rows under the open desk, in display order: name and chip. */
function requesterRows() {
  return screen
    .getAllByRole('button')
    .filter((b) => /^(user|agent)$/.test(b.lastElementChild?.textContent ?? ''))
    .map((b) => ({ name: b.getAttribute('title'), chip: b.lastElementChild?.textContent }))
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1')
  agents = [agent('a-support', 'support'), agent('a-sales', 'sales'), agent('a-foreign', 'helper', 'u9')]
  projects = []
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('FrontDeskPanel — ordinary Front Desk threads (pinned before the channel sidebar)', () => {
  it('groups host ends by the requester in the room name: alice (2, user) before bob (1)', () => {
    projects = [
      project({ id: 'p1', name: 'alice-fd-support-1a2b3c4d', display_name: 'Order question' }),
      project({ id: 'p2', name: 'alice-fd-support-5e6f7a8b', display_name: 'Refund' }),
      project({ id: 'p3', name: 'bob-fd-support-9c0d1e2f', display_name: 'Hello' }),
    ]
    renderPanel()
    expect(requesterRows()).toEqual([
      { name: 'alice', chip: 'user' },
      { name: 'bob', chip: 'user' },
    ])
    expect(screen.getByText('2 senders')).toBeTruthy()
    expect(screen.getByText('Order question')).toBeTruthy()
    expect(screen.getByText('Refund')).toBeTruthy()
    expect(screen.getByText('Hello')).toBeTruthy()
  })

  it('a requester with a hyphen is an agent: chip "agent"', () => {
    projects = [project({ id: 'p1', name: 'alice-helper-fd-support-1a2b3c4d' })]
    renderPanel()
    expect(requesterRows()).toEqual([{ name: 'alice-helper', chip: 'agent' }])
    expect(screen.getByText('1 sender')).toBeTruthy()
  })

  it('a legacy shared -fd- row (surface dm) the owner created still shows', () => {
    projects = [project({ id: 'p1', name: 'carol-fd-support', surface: 'dm', display_name: 'Legacy thread' })]
    renderPanel()
    expect(requesterRows()).toEqual([{ name: 'carol', chip: 'user' }])
    expect(screen.getByText('Legacy thread')).toBeTruthy()
  })

  it('the requester end (the coordinator is a foreign agent) does not show', () => {
    projects = [project({ id: 'p1', name: 'owner-fd-helper-1a2b3c4d', coordinator_id: 'a-foreign', display_name: 'Mine as requester' })]
    renderPanel()
    expect(screen.queryByText('Mine as requester')).toBeNull()
    expect(screen.getByText(/^No Front Desk channels yet/)).toBeTruthy()
    // Publishing moved to Agent Settings → Channels → Hub: the panel has no add button.
    expect(screen.queryByRole('link', { name: 'Front Desk Settings' })).toBeNull()
  })

  it('busiest desk first within a recency bucket; a busier but older desk comes after', () => {
    agents.push(agent('a-ops', 'ops'))
    const old = { coordinator_id: 'a-ops', last_modified: LAST_MONTH, created_at: LAST_MONTH }
    projects = [
      project({ id: 'p1', name: 'alice-fd-sales-1a2b3c4d', coordinator_id: 'a-sales' }),
      project({ id: 'p2', name: 'alice-fd-support-1a2b3c4d' }),
      project({ id: 'p3', name: 'bob-fd-support-5e6f7a8b' }),
      project({ id: 'p4', name: 'dave-fd-ops-0a0b0c0d', ...old }),
      project({ id: 'p5', name: 'erin-fd-ops-0a0b0c0e', ...old }),
      project({ id: 'p6', name: 'fay-fd-ops-0a0b0c0f', ...old }),
    ]
    renderPanel()
    const deskNames = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('title'))
      .filter((t) => t === 'support' || t === 'sales' || t === 'ops')
    expect(deskNames).toEqual(['support', 'sales', 'ops'])
  })

  it('a host end whose name does not match the pattern falls into the "—" bucket as user', async () => {
    projects = [project({ id: 'p1', name: 'weird-name' })]
    renderPanel()
    // Once the channel list has said it isn't a channel thread. (Until then the
    // sidebar can't tell, so it holds such a row apart instead of filing it.)
    await waitFor(() => expect(requesterRows()).toEqual([{ name: '—', chip: 'user' }]))
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { ApiError } from '../../api/client'
import type { ChannelConnection, ChannelThreadRow } from '../../api/endpoints/channels'
import type { AgentCard, Project } from '../../types'
import { CONNECTIONS_KEY } from '../settings/agent/channelsShared'
import smokeRows from '../../test/fixtures/channelThreads.smoke.json'
import FrontDeskPanel from './FrontDeskPanel'

/**
 * THE FRONT DESK SIDEBAR WITH CHANNEL THREADS: one tab per channel with an
 * enabled connection plus All, a badge and the contact's name on each channel
 * thread, grouping by contact. The mock boundary is the HTTP client: every
 * request the sidebar makes is recorded, so "one request for the whole
 * sidebar" and "no identifier in a URL" are checked on the real paths.
 *
 * `channelThreads.smoke.json` is written by the cross-channel smoke test
 * (`tests/channels/test_cross_channel_smoke.py`) from the server's real
 * answer, so a field renamed on either side fails one of the two.
 */

let agents: AgentCard[] = []
let projects: Project[] = []
let connections: ChannelConnection[] | Error = []
let threadRows: ChannelThreadRow[] | Error | Promise<ChannelThreadRow[]> = []
const requested: string[] = []

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../hooks/useProjects', () => ({ useUserProjects: () => ({ data: projects }) }))
vi.mock('../../api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/endpoints')>()),
  getChatrooms: () => Promise.resolve([{ id: 'r', name: 'user-communication' }]),
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  const answer = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value))
  return {
    ...actual,
    get: (path: string) => {
      requested.push(path)
      if (path === '/me/channels/connections') return answer(connections)
      if (path === '/me/channels/threads') return threadRows instanceof Promise ? threadRows : answer(threadRows)
      return Promise.reject(new actual.ApiError(404, 'unmocked'))
    },
  }
})

const NOW = Date.now()
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

function agent(id: string, name: string): AgentCard {
  return { id, name, registered_by: 'u1', status: 'online' } as AgentCard
}

function project(id: string, over: Partial<Project> = {}): Project {
  return {
    id, name: `ch-1a2b3c4d-${id.slice(-8).padStart(8, '0')}`, status: 'active', coordinator_id: 'a-support',
    request: '', chatrooms: ['user-communication'], participating_agents: [], created_at: iso(5),
    created_by: 'u1', surface: 'frontdesk', last_modified: iso(5), display_name: `Thread ${id}`, ...over,
  } as Project
}

function row(projectId: string, over: Partial<ChannelThreadRow> = {}): ChannelThreadRow {
  return {
    project_id: projectId, channel: 'telegram', connection_id: 'conn-tg', connection_enabled: true,
    connection_removed: false, contact_id: `contact-${projectId}`, contact_name: `Person ${projectId}`,
    paused: false, ...over,
  }
}

function conn(channel: string, over: Partial<ChannelConnection> = {}): ChannelConnection {
  return { id: `conn-${channel}`, agent_id: 'a-support', channel, disabled: false, ...over } as ChannelConnection
}

const visited: string[] = []
function LocationProbe() {
  const loc = useLocation()
  useEffect(() => {
    visited.push(loc.pathname + loc.search)
  }, [loc])
  return null
}

let queryClient: QueryClient
function renderPanel() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<><FrontDeskPanel /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const tabNames = () => screen.queryAllByRole('tab').map((t) => t.textContent)
const groups = (kind: string) => screen.queryAllByTestId(`fd-group-${kind}`)
const groupNames = (kind: string) =>
  groups(kind).map((g) => within(g).getByTestId('fd-group-name').textContent)
async function settled() {
  await waitFor(() => expect(requested).toContain('/me/channels/threads'))
  await waitFor(() => expect(screen.queryByText('Loading conversations…')).toBeNull())
}
async function selectTab(name: string) {
  fireEvent.click(await screen.findByRole('tab', { name }))
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1')
  agents = [agent('a-support', 'support'), agent('a-sales', 'sales')]
  projects = []
  connections = []
  threadRows = []
  requested.length = 0
  visited.length = 0
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ── the smoke test's real answer ────────────────────────────────────────

describe('the four channels, from the smoke test fixture', () => {
  beforeEach(() => {
    threadRows = smokeRows as ChannelThreadRow[]
    projects = threadRows.map((r) => project(r.project_id))
    connections = ['telegram', 'email', 'line', 'whatsapp'].map((c) => conn(c))
  })

  it('tabs are All then each channel in a fixed order', async () => {
    renderPanel()
    await waitFor(() => expect(tabNames()).toEqual(['All', 'Telegram', 'Email', 'LINE', 'WhatsApp']))
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
  })

  it('each channel tab lists exactly its one thread, with its badge and contact', async () => {
    renderPanel()
    await settled()
    for (const r of smokeRows as ChannelThreadRow[]) {
      const name = { telegram: 'Telegram', email: 'Email', line: 'LINE', whatsapp: 'WhatsApp' }[r.channel]!
      await selectTab(name)
      const contacts = groups('contact')
      expect(contacts).toHaveLength(1)
      expect(within(contacts[0]).getByRole('img', { name }).getAttribute('aria-label')).toBe(name)
      expect(within(contacts[0]).getByTestId('fd-group-name').textContent).toBe(r.contact_name)
    }
    await selectTab('All')
    expect(groups('contact')).toHaveLength(4)
  })
})

// ── tabs ────────────────────────────────────────────────────────────────

describe('tabs come from enabled connections', () => {
  it('no connections: no tab strip at all', async () => {
    renderPanel()
    await settled()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('an enabled Telegram connection with no threads: All and Telegram, and an empty state', async () => {
    connections = [conn('telegram')]
    renderPanel()
    await waitFor(() => expect(tabNames()).toEqual(['All', 'Telegram']))
    await selectTab('Telegram')
    expect(screen.getByText('No Telegram conversations yet')).toBeTruthy()
  })

  it('two Telegram connections (two agents): one Telegram tab holding both agents\' threads', async () => {
    connections = [conn('telegram'), conn('telegram', { id: 'conn-tg-2', agent_id: 'a-sales' })]
    projects = [project('p1'), project('p2', { coordinator_id: 'a-sales' })]
    threadRows = [row('p1'), row('p2', { connection_id: 'conn-tg-2' })]
    renderPanel()
    await waitFor(() => expect(tabNames()).toEqual(['All', 'Telegram']))
    await selectTab('Telegram')
    expect(groups('contact')).toHaveLength(2)
  })

  it('one enabled and one disabled WhatsApp connection: the WhatsApp tab is shown', async () => {
    connections = [conn('whatsapp'), conn('whatsapp', { id: 'conn-wa-2', disabled: true })]
    renderPanel()
    await waitFor(() => expect(tabNames()).toEqual(['All', 'WhatsApp']))
  })

  it('only a disabled LINE connection: no LINE tab, its threads still in All, marked Disabled', async () => {
    connections = [conn('line', { disabled: true })]
    projects = [project('p1'), project('p2')]
    threadRows = [
      row('p1', { channel: 'line', connection_enabled: false }),
      row('p2', { channel: 'line', connection_enabled: false }),
    ]
    renderPanel()
    await settled()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(groups('contact')).toHaveLength(2)
    expect(screen.getAllByTestId('disabled-mark')).toHaveLength(2)
  })

  it('a removed connection: no tab; its threads in All under "No longer connected" with badge and name', async () => {
    projects = [project('p1'), project('p2')]
    threadRows = [
      row('p1', { channel: 'line', connection_id: null, connection_removed: true, contact_id: null, contact_name: 'Chen' }),
      row('p2', { channel: 'line', connection_id: null, connection_removed: true, contact_id: null, contact_name: 'Dee' }),
    ]
    renderPanel()
    await settled()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(groupNames('removed')).toEqual(['No longer connected'])
    expect(screen.getAllByRole('img', { name: 'LINE' })).toHaveLength(2)
    expect(screen.getByText('Chen')).toBeTruthy()
    expect(screen.getByText('Dee')).toBeTruthy()
    expect(screen.queryByText('—')).toBeNull()
    expect(groups('user')).toHaveLength(0)
  })

  it('a channel thread is in its tab; ordinary threads are in All only', async () => {
    connections = ['telegram', 'email', 'line', 'whatsapp'].map((c) => conn(c))
    projects = [...['telegram', 'email', 'line', 'whatsapp'].map((c) => project(`p-${c}`)),
      project('p-ord', { name: 'alice-fd-support-1a2b3c4d' })]
    threadRows = ['telegram', 'email', 'line', 'whatsapp'].map((c) => row(`p-${c}`, { channel: c }))
    renderPanel()
    await settled()
    expect(groups('contact')).toHaveLength(4)
    expect(groupNames('user')).toEqual(['alice'])
    await selectTab('Email')
    expect(groups('contact')).toHaveLength(1)
    expect(groups('user')).toHaveLength(0)
  })

  it('the selected tab falls back to All when its channel loses its last enabled connection', async () => {
    connections = [conn('line')]
    projects = [project('p1')]
    threadRows = [row('p1', { channel: 'line' })]
    renderPanel()
    await selectTab('LINE')
    expect(screen.getByRole('tab', { name: 'LINE' }).getAttribute('aria-selected')).toBe('true')
    connections = [conn('line', { disabled: true })]
    await act(() => queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'LINE' })).toBeNull())
    // No strip left (only All), and the thread is on screen: no blank panel.
    expect(groups('contact')).toHaveLength(1)
  })

  it('with another channel still enabled, the fallback selects All and lists that channel\'s thread too', async () => {
    connections = [conn('telegram'), conn('line')]
    projects = [project('p1'), project('p2')]
    threadRows = [row('p1', { channel: 'line', connection_id: 'conn-line' }), row('p2', { contact_name: 'Tess' })]
    renderPanel()
    await selectTab('LINE')
    expect(screen.queryByText('Tess')).toBeNull()
    connections = [conn('telegram'), conn('line', { disabled: true })]
    await act(() => queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY }))
    await waitFor(() => expect(tabNames()).toEqual(['All', 'Telegram']))
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Tess')).toBeTruthy()
    expect(groups('contact')).toHaveLength(2)
  })

  it('a removed thread stays out of its channel\'s tab while another connection on that channel is enabled', async () => {
    connections = [conn('telegram')]
    projects = [project('p1'), project('p2')]
    threadRows = [
      row('p1', { contact_name: 'Live' }),
      row('p2', { connection_id: null, connection_removed: true, contact_id: null, contact_name: 'Gone' }),
    ]
    renderPanel()
    await settled()
    expect(groupNames('removed')).toEqual(['No longer connected'])
    expect(screen.getByText('Gone')).toBeTruthy()
    await selectTab('Telegram')
    expect(groups('contact')).toHaveLength(1)
    expect(screen.getByText('Live')).toBeTruthy()
    expect(screen.queryByText('Gone')).toBeNull()
    expect(groups('removed')).toHaveLength(0)
  })

  it('the selected tab survives a remount in the same session', async () => {
    connections = [conn('telegram'), conn('line')]
    const first = renderPanel()
    await selectTab('LINE')
    first.unmount()
    renderPanel()
    await waitFor(() => expect(screen.getByRole('tab', { name: 'LINE' }).getAttribute('aria-selected')).toBe('true'))
  })

  it('arrow keys move the selection', async () => {
    connections = [conn('telegram'), conn('line')]
    renderPanel()
    const all = await screen.findByRole('tab', { name: 'All' })
    await waitFor(() => expect(tabNames()).toEqual(['All', 'Telegram', 'LINE']))
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Telegram' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Telegram' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
  })
})

// ── where the facts come from ───────────────────────────────────────────

describe('nothing about a channel thread comes from its room name', () => {
  it('a channel thread named like an ordinary one stays under its contact, with its badge', async () => {
    projects = [project('p1', { name: 'alice-fd-support' })]
    threadRows = [row('p1', { contact_name: 'Ana' })]
    renderPanel()
    await settled()
    expect(groupNames('contact')).toEqual(['Ana'])
    expect(groups('user')).toHaveLength(0)
    expect(screen.getByRole('img', { name: 'Telegram' })).toBeTruthy()
  })

  it('an ordinary thread named like a channel one (no row) is ordinary: no badge', async () => {
    projects = [project('p1', { name: 'ch-1234abcd-deadbeef' })]
    threadRows = []
    renderPanel()
    await settled()
    expect(groups('contact')).toHaveLength(0)
    expect(screen.queryByTestId('channel-badge')).toBeNull()
    expect(groupNames('user')).toEqual(['—'])
  })

  it('one request for the whole sidebar: 30 threads, one list call, no per-thread call', async () => {
    projects = Array.from({ length: 30 }, (_, i) => project(`p${i}`))
    threadRows = projects.map((p) => row(p.id))
    renderPanel()
    await settled()
    await waitFor(() => expect(groups('contact')).toHaveLength(30))
    expect(requested.filter((p) => p === '/me/channels/threads')).toHaveLength(1)
    expect(requested.filter((p) => p.startsWith('/me/channels/threads/'))).toHaveLength(0)
  })
})

// ── badge and name ──────────────────────────────────────────────────────

describe('the badge and the outside person', () => {
  it('a contact name renders as text, never markup or Markdown', async () => {
    projects = [project('p1'), project('p2')]
    threadRows = [
      row('p1', { contact_name: '<img src=x onerror=alert(1)>' }),
      row('p2', { contact_name: '**Bold** [link](http://x)' }),
    ]
    const { container } = renderPanel()
    await settled()
    expect(groupNames('contact').sort()).toEqual(['**Bold** [link](http://x)', '<img src=x onerror=alert(1)>'])
    for (const name of container.querySelectorAll('[data-testid="fd-group-name"]')) {
      expect(name.querySelector('img, a, strong')).toBeNull()
    }
    expect(container.querySelector('img')).toBeNull()
  })

  it('an empty name shows a fixed fallback with the channel, never the room name', async () => {
    projects = [project('p1')]
    threadRows = [row('p1', { contact_name: '', channel: 'whatsapp' })]
    renderPanel()
    await settled()
    expect(groupNames('contact')).toEqual(['Unnamed contact (WhatsApp)'])
    expect(screen.queryByText(projects[0].name)).toBeNull()
  })

  it('a long or right-to-left name is isolated (bdi) and keeps the badge on the row', async () => {
    projects = [project('p1'), project('p2')]
    threadRows = [row('p1', { contact_name: 'ي'.repeat(10) + ' محمد' }), row('p2', { contact_name: 'x'.repeat(64) })]
    renderPanel()
    await settled()
    for (const g of groups('contact')) {
      expect(within(g).getByTestId('fd-group-name').tagName).toBe('BDI')
      expect(within(g).getByTestId('channel-badge')).toBeTruthy()
    }
    expect(groups('contact').some((g) => g.getAttribute('title') === 'x'.repeat(64))).toBe(true)
  })

  it('ordinary Front Desk rows have no channel badge', async () => {
    projects = [project('p1', { name: 'alice-fd-support-1a2b3c4d' })]
    renderPanel()
    await settled()
    expect(screen.queryByTestId('channel-badge')).toBeNull()
  })
})

// ── grouping by contact ─────────────────────────────────────────────────

describe('grouping by contact', () => {
  it('two different contacts with the same name are two groups', async () => {
    projects = [project('p1'), project('p2'), project('p3')]
    threadRows = [
      row('p1', { contact_name: 'Alex', channel: 'telegram', contact_id: 'c1' }),
      row('p2', { contact_name: 'Alex', channel: 'whatsapp', contact_id: 'c2' }),
      row('p3', { contact_name: 'Alex', channel: 'telegram', contact_id: 'c3' }),
    ]
    renderPanel()
    await settled()
    expect(groupNames('contact')).toEqual(['Alex', 'Alex', 'Alex'])
  })

  it('one contact with two threads is one group, newest thread first', async () => {
    projects = [project('p-old', { last_modified: iso(60) }), project('p-new', { last_modified: iso(1) })]
    threadRows = [row('p-old', { contact_id: 'c1', contact_name: 'Mara' }), row('p-new', { contact_id: 'c1', contact_name: 'Mara' })]
    const { container } = renderPanel()
    await settled()
    expect(groupNames('contact')).toEqual(['Mara'])
    const titles = [...container.querySelectorAll('button[title^="Thread "]')].map((b) => b.getAttribute('title'))
    expect(titles).toEqual(['Thread p-new', 'Thread p-old'])
  })

  it('the same contact id under two agents is two groups, one per desk', async () => {
    projects = [project('p1'), project('p2', { coordinator_id: 'a-sales' })]
    threadRows = [row('p1', { contact_id: 'c1', contact_name: 'Mara' }), row('p2', { contact_id: 'c1', contact_name: 'Mara' })]
    renderPanel()
    await settled()
    expect(groupNames('contact')).toEqual(['Mara', 'Mara'])
  })

  it('busiest contact first, then by name; the desk subtitle counts contacts', async () => {
    projects = [project('p1'), project('p2'), project('p3')]
    threadRows = [
      row('p1', { contact_id: 'cz', contact_name: 'Zoe' }),
      row('p2', { contact_id: 'cz', contact_name: 'Zoe' }),
      row('p3', { contact_id: 'cb', contact_name: 'Bo' }),
    ]
    renderPanel()
    await settled()
    expect(groupNames('contact')).toEqual(['Zoe', 'Bo'])
    expect(screen.getByTestId('fd-desk-subtitle').textContent).toBe('2 contacts')
  })

  it('a desk with contacts and senders says both', async () => {
    projects = [project('p1'), project('p2', { name: 'alice-fd-support-1a2b3c4d' })]
    threadRows = [row('p1')]
    renderPanel()
    await settled()
    expect(screen.getByTestId('fd-desk-subtitle').textContent).toBe('1 contact · 1 sender')
  })

  it('a desk of channel threads is never "—" or "user"', async () => {
    projects = [project('p1'), project('p2')]
    threadRows = [row('p1'), row('p2')]
    renderPanel()
    await settled()
    expect(screen.queryByText('—')).toBeNull()
    expect(screen.queryByText('user')).toBeNull()
  })

  it('a paused thread shows a Paused mark on its contact and its row; a resumed one shows none', async () => {
    projects = [project('p1'), project('p2')]
    threadRows = [row('p1', { paused: true, contact_name: 'Mara' }), row('p2', { contact_name: 'Noor' })]
    renderPanel()
    await settled()
    const [mara] = groups('contact').filter((g) => g.textContent?.includes('Mara'))
    expect(within(mara).getByTestId('paused-mark')).toBeTruthy()
    fireEvent.click(mara) // collapse
    fireEvent.click(mara) // expand again: rows visible
    expect(screen.getAllByTestId('paused-mark')).toHaveLength(2)
    const [noor] = groups('contact').filter((g) => g.textContent?.includes('Noor'))
    expect(within(noor).queryByTestId('paused-mark')).toBeNull()
  })
})

// ── while the list is loading, failing, or channels are off ─────────────

describe('never misfiled while the channel list is unknown', () => {
  it('while the list is loading: a "Loading…" group, no "—" bucket', async () => {
    projects = [project('p1')]
    threadRows = new Promise(() => {}) // never answers
    renderPanel()
    await waitFor(() => expect(groupNames('pending')).toEqual(['Loading conversations…']))
    expect(screen.queryByText('—')).toBeNull()
  })

  it('channels off (both calls 404): one plain group, no tabs, no badge, no "—"', async () => {
    projects = [project('p1'), project('p2', { name: 'alice-fd-support-1a2b3c4d' })]
    connections = new ApiError(404, 'Not Found')
    threadRows = new ApiError(404, 'Not Found')
    renderPanel()
    await waitFor(() => expect(groupNames('pending')).toEqual(['Channel conversations (channels are off)']))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByTestId('channel-badge')).toBeNull()
    expect(screen.queryByText('—')).toBeNull()
    expect(groupNames('user')).toEqual(['alice'])
  })

  it('the list fails otherwise: "Couldn\'t load channel details", not "—"', async () => {
    projects = [project('p1')]
    threadRows = new ApiError(500, 'boom')
    renderPanel()
    await waitFor(() => expect(groupNames('pending')).toEqual(["Couldn't load channel details"]))
  })
})

// ── identifiers out of URLs ─────────────────────────────────────────────

describe('URLs hold only ids, room names and channel names', () => {
  it('clicking every tab and every thread navigates and fetches only safe paths', async () => {
    threadRows = smokeRows as ChannelThreadRow[]
    projects = threadRows.map((r) => project(r.project_id))
    connections = ['telegram', 'email', 'line', 'whatsapp'].map((c) => conn(c))
    renderPanel()
    await settled()
    for (const name of ['Telegram', 'Email', 'LINE', 'WhatsApp', 'All']) await selectTab(name)
    for (const r of smokeRows as ChannelThreadRow[]) {
      fireEvent.click(screen.getByTitle(`Thread ${r.project_id}`))
    }
    for (const button of await screen.findAllByTitle('user-communication')) fireEvent.click(button)
    await waitFor(() => expect(visited.length).toBeGreaterThan(1))
    const safe = /^[\w/?=&.-]*$/
    const contactIds = (smokeRows as ChannelThreadRow[]).map((r) => r.contact_id!)
    for (const url of [...visited, ...requested]) {
      expect(url).toMatch(safe)
      for (const id of contactIds) expect(url).not.toContain(id)
    }
  })
})

// ── Hub threads (host side) ─────────────────────────────────────────────

describe('Hub threads', () => {
  const FP = '3f9a1c2e5b7d9f00aa11bb22cc33dd44'
  const hubRow = (projectId: string, over: Partial<ChannelThreadRow> = {}) => row(projectId, {
    channel: 'hub', connection_id: 'conn-hub', contact_name: 'carol @ clawmeets.ai',
    remote_username: 'carol', deployment_name: 'clawmeets.ai', deployment_fingerprint: FP, ...over,
  })

  it('the Hub tab comes last, after every other channel', async () => {
    connections = [conn('hub'), conn('webchat'), conn('telegram')]
    renderPanel()
    await waitFor(() => expect(tabNames()).toEqual(['All', 'Telegram', 'Web chat', 'Hub']))
  })

  it('a Hub contact is drawn from the structured fields, with the Hub badge, never from contact_name', async () => {
    connections = [conn('hub')]
    projects = [project('p1')]
    threadRows = [hubRow('p1', { contact_name: 'carol @ trusted.example', remote_username: 'carol @ trusted.example' })]
    renderPanel()
    await settled()
    await selectTab('Hub')
    const [g] = groups('contact')
    expect(within(g).getByRole('img', { name: 'Hub' })).toBeTruthy()
    expect(within(g).getByTestId('hub-contact-user').textContent).toBe('carol @ trusted.example')
    expect(within(g).getByTestId('hub-contact-server').textContent).toBe('clawmeets.ai')
    expect(within(g).getByTestId('hub-contact-fp').textContent).toBe(`fp ${FP.slice(0, 8)}`)
    expect(g.getAttribute('title')).toBe(`carol @ trusted.example from clawmeets.ai · fp ${FP.slice(0, 8)}`)
  })

  it('a conversation an agent sent for its person reads "via their agent X"', async () => {
    connections = [conn('hub')]
    projects = [project('p1')]
    threadRows = [hubRow('p1', { via_agent: 'carol-scout' })]
    renderPanel()
    await settled()
    await selectTab('Hub')
    expect(within(groups('contact')[0]).getByTestId('hub-contact-via').textContent).toBe('via their agent carol-scout')
  })

  it('a requester known only by key reads "from server" with its fingerprint', async () => {
    connections = [conn('hub')]
    projects = [project('p1')]
    threadRows = [hubRow('p1', { deployment_name: null })]
    renderPanel()
    await settled()
    expect(within(groups('contact')[0]).getByTestId('hub-contact-server').textContent).toBe('server')
  })

  it('the same username on two servers is two groups', async () => {
    connections = [conn('hub')]
    projects = [project('p1'), project('p2')]
    threadRows = [
      hubRow('p1', { contact_id: 'c-acme' }),
      hubRow('p2', { contact_id: 'c-other', deployment_name: 'clawmeets.ai', deployment_fingerprint: 'ffff0000eeee1111' }),
    ]
    renderPanel()
    await settled()
    expect(groups('contact').map((g) => within(g).getByTestId('hub-contact-fp').textContent).sort())
      .toEqual([`fp ${FP.slice(0, 8)}`, 'fp ffff0000'])
  })
})

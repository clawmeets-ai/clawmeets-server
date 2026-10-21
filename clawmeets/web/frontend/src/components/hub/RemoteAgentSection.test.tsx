import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import type { HubAgent, HubAgentPage, HubConfig } from '../../api/endpoints/hub'
import { FP_ACME, FP_OTHER, NOW_S, OWN_FP, hubAgent, hubConfig, hubEnrollment, retainedAgent } from '../../test/hubFixtures'
import RemoteAgentSection, { DIRECTORY_COPY } from './RemoteAgentSection'

/**
 * The directory's "On other servers" section, one test per Public-tab state
 * of the approved table: hub off, not registered, suspended, untrusted, hub
 * down with and without a cached list, rate-limited, the two paging footers,
 * stale and new-to-you chips, the dedupe, and text-only remote fields.
 */

const api = vi.hoisted(() => ({
  getHubConfig: vi.fn(),
  searchHubAgents: vi.fn(),
  getHubAvatar: vi.fn(),
  reportHubAgent: vi.fn(),
  listRetained: vi.fn(),
  getHubEnrollment: vi.fn(),
}))
vi.mock('../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../api/endpoints/hub')>()
  return {
    ...real,
    getHubConfig: (...a: unknown[]) => api.getHubConfig(...a),
    searchHubAgents: (...a: unknown[]) => api.searchHubAgents(...a),
    getHubAvatar: (...a: unknown[]) => api.getHubAvatar(...a),
    reportHubAgent: (...a: unknown[]) => api.reportHubAgent(...a),
    listRetained: () => api.listRetained(),
    getHubEnrollment: () => api.getHubEnrollment(),
  }
})

const hubErr = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, code, { detail: { code, message: '', ...extra } })

function page(agents: HubAgent[], o: Partial<HubAgentPage> = {}): HubAgentPage {
  return { agents, next_cursor: null, served_from: 'live', cache_age_s: null, cached_at: null, ...o }
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderSection(cfg: Partial<HubConfig> = {}, props: { q?: string } = {}) {
  api.getHubConfig.mockResolvedValue(hubConfig(cfg))
  const onFocusSearch = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/agents/public']}>
        <Routes>
          <Route
            path="*"
            element={(
              <>
                <div data-testid="host">
                  <RemoteAgentSection q={props.q ?? ''} capabilities={[]} onlineOnly={false} onFocusSearch={onFocusSearch} />
                </div>
                <Where />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, onFocusSearch }
}

const section = () => screen.findByTestId('remote-agent-section')
const cards = () => screen.queryAllByTestId('remote-agent-card')
const messageButtons = () => screen.getAllByRole('button', { name: 'Message' })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 })
  api.getHubAvatar.mockRejectedValue(hubErr(404, 'avatar_not_set'))
  api.listRetained.mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('RemoteAgentSection: the hub and server states', () => {
  it('hub off: no section and no error, and the hub is never searched', async () => {
    renderSection({ mode: 'off' })
    await waitFor(() => expect(api.getHubConfig).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId('host').textContent).toBe('')
    expect(api.searchHubAgents).not.toHaveBeenCalled()
  })

  it('an older server without /api/hub/config: no section', async () => {
    api.getHubConfig.mockRejectedValue(new ApiError(404, 'Not Found'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <div data-testid="host"><RemoteAgentSection q="" capabilities={[]} onlineOnly={false} onFocusSearch={() => {}} /></div>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(api.getHubConfig).toHaveBeenCalled())
    expect(screen.getByTestId('host').textContent).toBe('')
  })

  it.each(['none', 'pending_email'])('not registered (%s): the sentence, and no search', async (registration) => {
    renderSection({ registration })
    await section()
    expect(screen.getByTestId('hub-banner').textContent).toBe(DIRECTORY_COPY.notRegistered)
    expect(api.searchHubAgents).not.toHaveBeenCalled()
  })

  it('a 409 hub_not_registered from search shows the same sentence', async () => {
    api.searchHubAgents.mockRejectedValue(hubErr(409, 'hub_not_registered'))
    renderSection()
    await waitFor(() => expect(screen.getByTestId('hub-banner').textContent).toBe(DIRECTORY_COPY.notRegistered))
  })

  it('mode auto, not registered: "Set up hub access" opens the dialog, then the search runs', async () => {
    renderSection({ mode: 'auto', registration: 'none' })
    await section()
    expect(screen.getByTestId('hub-banner').textContent).toContain(DIRECTORY_COPY.setupNeeded)
    expect(api.searchHubAgents).not.toHaveBeenCalled()
    // The owner turns out to be verified already and this click registered
    // nothing new: the config now says active, and the dialog is skipped.
    api.getHubEnrollment.mockResolvedValue(hubEnrollment({ owner: 'verified' }))
    api.getHubConfig.mockResolvedValue(hubConfig({ mode: 'auto' }))
    api.searchHubAgents.mockResolvedValue(page([hubAgent()]))
    fireEvent.click(screen.getByRole('button', { name: DIRECTORY_COPY.setup }))
    await waitFor(() => expect(api.searchHubAgents).toHaveBeenCalled())
    await waitFor(() => expect(cards()).toHaveLength(1))
  })

  it('mode auto, a 409 hub_not_registered from search offers the same action', async () => {
    api.searchHubAgents.mockRejectedValue(hubErr(409, 'hub_not_registered'))
    renderSection({ mode: 'auto' })
    await waitFor(() => expect(screen.getByRole('button', { name: DIRECTORY_COPY.setup })).toBeTruthy())
  })

  it('mode auto with the hub not there yet: no setup action', async () => {
    renderSection({ mode: 'auto', registration: 'none', hub_link: 'untrusted' })
    await section()
    expect(screen.getByTestId('hub-banner').textContent).toBe(DIRECTORY_COPY.notAvailable)
    expect(screen.queryByRole('button', { name: DIRECTORY_COPY.setup })).toBeNull()
  })

  it('suspended: the hub has suspended this server', async () => {
    renderSection({ registration: 'suspended' })
    await section()
    expect(screen.getByTestId('hub-banner').textContent).toBe('The hub has suspended this server. Ask its operator.')
  })

  it('untrusted, from the config before any call fails: only the banner', async () => {
    renderSection({ hub_link: 'untrusted' })
    await section()
    expect(screen.getByTestId('hub-banner').textContent).toContain("can't verify the hub's identity")
    expect(api.searchHubAgents).not.toHaveBeenCalled()
  })

  it('untrusted, from a 503 hub_untrusted on search', async () => {
    api.searchHubAgents.mockRejectedValue(hubErr(503, 'hub_untrusted'))
    renderSection()
    await waitFor(() => expect(screen.getByTestId('hub-banner').textContent).toContain("can't verify the hub's identity"))
  })

  it("hub down with nothing cached: \"Can't reach the hub\" and no cards", async () => {
    api.searchHubAgents.mockRejectedValue(hubErr(503, 'hub_unreachable'))
    renderSection()
    await waitFor(() => expect(screen.getByTestId('hub-banner').textContent).toBe("Can't reach the hub."))
    expect(cards()).toHaveLength(0)
  })

  it("hub down with a cached list: its age, the cached time as tooltip, status unknown, Message disabled", async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent()], {
      served_from: 'cache', cache_age_s: 12 * 60, cached_at: NOW_S - 12 * 60,
    }))
    renderSection({ deployment_connected: false, hub_link: 'unreachable' })
    const banner = await screen.findByTestId('hub-cached')
    expect(banner.textContent).toBe(
      "Can't reach the hub. Showing the list from 12 min ago. Sending to other servers is paused.",
    )
    expect(banner.getAttribute('title')).toMatch(/^Cached /)
    expect(screen.getByTestId('status-unknown')).toBeTruthy()
    expect(screen.queryByTestId('presence')).toBeNull()
    expect(messageButtons()[0]).toHaveProperty('disabled', true)
  })

  it('hub off on this server from search (config is stale): no section', async () => {
    api.searchHubAgents.mockRejectedValue(hubErr(503, 'hub_off_on_server'))
    renderSection()
    await waitFor(() => expect(api.searchHubAgents).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('host').textContent).toBe(''))
  })

  it('browse-only: the list shows, Message is disabled, and the sentence says why', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent()]))
    renderSection({ mode: 'discover_only' })
    await screen.findByTestId('hub-browse-only')
    expect(messageButtons()[0]).toHaveProperty('disabled', true)
  })
})

describe('RemoteAgentSection: mode auto, the socket opened on demand', () => {
  it('idle socket: Message stays enabled, no paused sentence', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent()]))
    renderSection({ mode: 'auto', hub_link: 'off', deployment_connected: false })
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(messageButtons()[0]).toHaveProperty('disabled', false)
    expect(screen.queryByTestId('hub-cached')).toBeNull()
  })

  it('the hub really unreachable (list served from cache): Message disabled with the paused sentence', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent()], {
      served_from: 'cache', cache_age_s: 12 * 60, cached_at: NOW_S - 12 * 60,
    }))
    renderSection({ mode: 'auto', hub_link: 'off', deployment_connected: false })
    const banner = await screen.findByTestId('hub-cached')
    expect(banner.textContent).toContain('Sending to other servers is paused.')
    expect(messageButtons()[0]).toHaveProperty('disabled', true)
  })

  it('untrusted: only the banner', async () => {
    renderSection({ mode: 'auto', hub_link: 'untrusted', deployment_connected: false })
    await section()
    expect(screen.getByTestId('hub-banner').textContent).toContain("can't verify the hub's identity")
    expect(cards()).toHaveLength(0)
  })

  it('mode full with the link down: Message disabled as before', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent()]))
    renderSection({ mode: 'full', hub_link: 'unreachable', deployment_connected: false })
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(messageButtons()[0]).toHaveProperty('disabled', true)
  })
})

describe('RemoteAgentSection: search answers and paging', () => {
  it('an empty q shows one page and ends with "Search to see more agents", which focuses the search box', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent(), hubAgent({ name: 'lex', deployment_name: 'lawbot' })]))
    const { onFocusSearch } = renderSection()
    await waitFor(() => expect(cards()).toHaveLength(2))
    const footer = screen.getByTestId('hub-footer')
    expect(footer.textContent).toBe(DIRECTORY_COPY.searchToSeeMore)
    fireEvent.click(footer)
    expect(onFocusSearch).toHaveBeenCalledTimes(1)
  })

  it('a typed q follows next_cursor with Load more', async () => {
    api.searchHubAgents
      .mockResolvedValueOnce(page([hubAgent()], { next_cursor: 'c2' }))
      .mockResolvedValueOnce(page([hubAgent({ name: 'lex' })]))
    renderSection({}, { q: 'research' })
    await waitFor(() => expect(cards()).toHaveLength(1), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(api.searchHubAgents.mock.calls[1][0]).toMatchObject({ q: 'research', cursor: 'c2' })
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(screen.queryByTestId('hub-footer')).toBeNull()
  })

  it('query_too_broad on a later page keeps the pages shown and ends with "Narrow your search"', async () => {
    api.searchHubAgents
      .mockResolvedValueOnce(page([hubAgent()], { next_cursor: 'c11' }))
      .mockRejectedValueOnce(hubErr(400, 'query_too_broad'))
    renderSection({}, { q: 'a' })
    await waitFor(() => expect(cards()).toHaveLength(1), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getByTestId('hub-footer').textContent).toBe(DIRECTORY_COPY.narrow))
    expect(cards()).toHaveLength(1)
    expect(screen.queryByTestId('hub-failed')).toBeNull()
  })

  it('query_too_broad on the first page reads as the narrow-your-search note, not an error', async () => {
    api.searchHubAgents.mockRejectedValue(hubErr(400, 'query_too_broad'))
    renderSection({}, { q: 'a' })
    await waitFor(() => expect(screen.getByTestId('hub-footer').textContent).toBe(DIRECTORY_COPY.narrow), { timeout: 2000 })
    expect(screen.queryByTestId('hub-failed')).toBeNull()
  })

  it('rate-limited: the last results stay and "Search is busy, try again in N s" shows', async () => {
    api.getHubConfig.mockResolvedValue(hubConfig())
    api.searchHubAgents
      .mockResolvedValueOnce(page([hubAgent()]))
      .mockRejectedValueOnce(hubErr(429, 'rate_limited', { retry_after: 17 }))
    function Harness() {
      const [q, setQ] = useState('')
      return (
        <>
          <button type="button" onClick={() => setQ('scout')}>type</button>
          <RemoteAgentSection q={q} capabilities={[]} onlineOnly={false} onFocusSearch={() => {}} />
        </>
      )
    }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><Harness /></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'type' }))
    await waitFor(() => expect(screen.getByTestId('hub-busy').textContent).toBe('Search is busy, try again in 17 s.'), { timeout: 2000 })
    expect(cards()).toHaveLength(1)
  })

  it('a 422 or network failure says the search failed, without a hub banner', async () => {
    api.searchHubAgents.mockRejectedValue(new ApiError(422, 'Unprocessable', { detail: 'bad query' }))
    renderSection()
    await waitFor(() => expect(screen.getByTestId('hub-failed').textContent).toBe(DIRECTORY_COPY.failed))
    expect(screen.queryByTestId('hub-banner')).toBeNull()
  })
})

describe('RemoteAgentSection: the cards', () => {
  it('is_local items go to "On this server"; this server\'s own fingerprint is hidden from other servers; duplicates by id collapse to the newest', async () => {
    api.searchHubAgents.mockResolvedValue(page([
      hubAgent({ name: 'mine', is_local: true }),
      hubAgent({ name: 'own', deployment_fingerprint: OWN_FP }),
      hubAgent({ name: 'scout', description: 'old', listing_refreshed_at: NOW_S - 5000 }),
      hubAgent({ name: 'scout', description: 'new', listing_refreshed_at: NOW_S - 100 }),
      hubAgent({ name: 'scout', deployment_fingerprint: FP_OTHER, deployment_name: 'acme.dev' }),
    ]))
    renderSection()
    const remote = await screen.findByTestId('hub-remote-group')
    await waitFor(() => expect(within(remote).queryAllByTestId('remote-agent-card')).toHaveLength(2))
    const names = within(remote).getAllByTestId('remote-name').map((n) => n.textContent)
    expect(names).toEqual(['scout', 'scout'])
    const local = screen.getByTestId('hub-local-group')
    expect(within(local).getAllByTestId('remote-name').map((n) => n.textContent)).toEqual(['mine'])
    expect(screen.getAllByTestId('remote-description').map((d) => d.textContent)).toContain('new')
    expect(screen.queryByText('old')).toBeNull()
    // Two servers that both call themselves acme.dev are told apart by fingerprint.
    expect(within(remote).getAllByTestId('remote-fp').map((f) => f.textContent).sort()).toEqual(
      [FP_ACME.slice(0, 8), FP_OTHER.slice(0, 8)].sort(),
    )
  })

  it('stale and new-to-you chips; a stale agent can still be messaged', async () => {
    api.searchHubAgents.mockResolvedValue(page([
      hubAgent({ name: 'oldbot', deployment_name: 'foo.io', first_contact: false, last_seen_at: NOW_S - 9 * 86400 }),
      hubAgent({ name: 'scout', first_contact: true, last_seen_at: NOW_S - 60 }),
    ]))
    renderSection()
    await waitFor(() => expect(cards()).toHaveLength(2))
    const [old, fresh] = cards()
    expect(within(old).getByTestId('chip-stale').textContent).toBe('last seen 9 days ago')
    expect(within(old).queryByTestId('chip-new')).toBeNull()
    expect(within(old).getByRole('button', { name: 'Message' })).toHaveProperty('disabled', false)
    expect(within(fresh).getByTestId('chip-new').textContent).toBe('new to you')
    expect(within(fresh).queryByTestId('chip-stale')).toBeNull()
  })

  it('Message on this server\'s own listed agent opens the ordinary DM, not a hub thread', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent({ name: 'alice-scout', is_local: true })]))
    renderSection()
    const local = await screen.findByTestId('hub-local-group')
    fireEvent.click(within(local).getByRole('button', { name: 'Message' }))
    expect(screen.getByTestId('where').textContent).toBe('/dm/alice-scout')
  })

  it('Message opens the hub thread draft at /hub/{id}', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent()]))
    renderSection()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(messageButtons()[0])
    expect(screen.getByTestId('where').textContent).toBe(`/hub/${FP_ACME.slice(0, 16)}~scout`)
  })

  it('an agent not taking messages: the chip, and Message disabled', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent({ accepting_messages: false })]))
    renderSection()
    await screen.findByTestId('chip-not-accepting')
    expect(messageButtons()[0]).toHaveProperty('disabled', true)
  })

  it('the ⋯ menu opens Report; after a 202 the item reads "Reported"', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent({ name: 'menu-bot' })]))
    api.reportHubAgent.mockResolvedValue(undefined)
    renderSection()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /More actions for menu-bot@acme.dev/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }))
    expect(screen.getByRole('dialog').textContent).toContain('Report menu-bot@acme.dev')
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    await screen.findByText(/Reported\. Thanks/)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: /More actions for menu-bot@acme.dev/ }))
    expect(screen.getByRole('menuitem', { name: 'Reported' })).toHaveProperty('disabled', true)
  })

  it('a hostile name, server, description and capability render as text only', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    api.searchHubAgents.mockResolvedValue(page([hubAgent({
      name: `ev‮il${evil}`,
      deployment_name: 'carol @ clawmeets.ai',
      description: `**bold** [link](javascript:alert(1)) ${evil}​`,
      capabilities: [`<b>cap</b>⁦`],
    })]))
    const { container } = renderSection()
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(screen.getByTestId('remote-name').textContent).toBe(`evil${evil}`.slice(0, 80))
    expect(screen.getByTestId('remote-server').textContent).toBe('carol @ clawmeets.ai')
    expect(screen.getByTestId('remote-description').textContent).toBe(`**bold** [link](javascript:alert(1)) ${evil}`)
    expect(screen.getByText('<b>cap</b>')).toBeTruthy()
  })
})

describe('the "Retained" filter', () => {
  it('swaps search results for the retained list, and back', async () => {
    const listed = hubAgent({ name: 'scout' })
    api.searchHubAgents.mockResolvedValue(page([listed, hubAgent({ name: 'other', retained: true })]))
    api.listRetained.mockResolvedValue([retainedAgent({ name: 'scout', state: 'unlisted' })])
    renderSection()
    await section()
    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(screen.getByTestId('retained-filter'))
    expect(screen.getByTestId('retained-filter').getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByTestId('retained-list')).toBeTruthy()
    expect(cards()).toHaveLength(0)
    // The directory shows scout listed and not retained: the row offers retain.
    expect(screen.getByTestId('retained-listed-again')).toBeTruthy()
    fireEvent.click(screen.getByTestId('retained-filter'))
    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(screen.queryByTestId('retained-list')).toBeNull()
  })

  it('a retained agent\'s card shows the badge instead of Retain', async () => {
    api.searchHubAgents.mockResolvedValue(page([hubAgent({ name: 'scout', retained: true }), hubAgent({ name: 'other' })]))
    renderSection()
    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(within(cards()[0]).getByTestId('retained-badge')).toBeTruthy()
    expect(within(cards()[1]).getByTestId('retain-button')).toBeTruthy()
  })
})


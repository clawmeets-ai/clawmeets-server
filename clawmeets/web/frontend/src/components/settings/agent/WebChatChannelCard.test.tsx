import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeSession, seedSessions } from '../../../test/authFixtures'
import type { ChannelConnection, WidgetGrant, WidgetInfo } from '../../../api/endpoints/channels'
import ChannelsSection from './ChannelsSection'
import { WEBCHAT_COPY, parseSites } from './WebChatChannelCard'

// Not about the hub: an older server without /api/hub/config.
vi.mock('../../../api/endpoints/hub', async (orig) =>
  (await import('../../../test/hubFixtures')).withoutHubConfig(await orig<object>()))

/**
 * Agent Settings → Channels → Web chat widget. The API is mocked the same way
 * as the other channel cards; the whole section is rendered so the card is
 * tested where it lives.
 */

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  listAllowlist: vi.fn(),
  listRequests: vi.fn(),
  connectWebChat: vi.fn(),
  getWidget: vi.fn(),
  createWidgetGrant: vi.fn(),
  updateWidgetGrant: vi.fn(),
  revokeWidgetGrant: vi.fn(),
  disableConnection: vi.fn(),
  enableConnection: vi.fn(),
  removeConnection: vi.fn(),
}))
vi.mock('../../../api/endpoints/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/endpoints/channels')>()
  const mocked: Record<string, unknown> = { WARNING_ANYONE: actual.WARNING_ANYONE }
  for (const name of Object.keys(api)) {
    mocked[name] = (...a: unknown[]) => (api as Record<string, (...x: unknown[]) => unknown>)[name](...a)
  }
  return mocked
})

const CHAT_PAGE = 'https://clawmeets.example/users/olivia/agents/concierge/chat'
const XSS = '<img src=x onerror=alert(1)>'

function webchat(over: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: 'c1', agent_id: 'a1', channel: 'webchat', label: '', secret_last4: '',
    webhook_url: '', mode: 'anyone', fixed_reply: '', warning: 'strangers_reach_full_tools',
    account_name: '', disabled: false, status: 'working', status_detail: null, status_count: null,
    status_at: null, last_inbound_at: null, ack_text: null, push_used: null, push_limit: null,
    push_as_of: null, unverified_calls: 0,
    ...over,
  }
}

function grant(over: Partial<WidgetGrant> = {}): WidgetGrant {
  const key = over.key ?? 'cmw_abcdefghijklmnop'
  return {
    id: 'g1', label: 'Main site', key, origins: ['https://acme.com'],
    snippet: `<script src="https://clawmeets.example/api/channels/widget.js" data-key="${key}" async></script>`,
    created_at: 1_760_000_000,
    ...over,
  }
}

function widget(over: Partial<WidgetInfo> = {}): WidgetInfo {
  return {
    script_url: 'https://clawmeets.example/api/channels/widget.js',
    chat_page_url: CHAT_PAGE, chat_page_public: true, grants: [],
    ...over,
  }
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/?channel=webchat']}>
        <ChannelsSection agentId="a1" agentName="olivia-concierge" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const section = () => screen.getByRole('tabpanel', { name: 'Web chat widget' })

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  api.listAllowlist.mockResolvedValue([])
  api.listRequests.mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Web chat widget', () => {
  it('offers to turn it on, with one click and no credential', async () => {
    api.listConnections.mockResolvedValue([])
    api.connectWebChat.mockResolvedValue(webchat())
    renderSection()
    const button = await within(await screen.findByRole('tabpanel', { name: 'Web chat widget' }))
      .findByRole('button', { name: WEBCHAT_COPY.turnOn })
    fireEvent.click(button)
    await waitFor(() => expect(api.connectWebChat).toHaveBeenCalledWith('olivia-concierge'))
  })

  it('shows the chat page link and each key with its snippet', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget({ grants: [grant()] }))
    renderSection()
    const link = await screen.findByTestId('chat-page-url')
    expect(link.getAttribute('href')).toBe(CHAT_PAGE)
    expect(screen.getByTestId('webchat-status').textContent).toBe('On')
    const snippet = screen.getByTestId('widget-snippet')
    expect(snippet.textContent).toBe(grant().snippet)
    expect(within(section()).getByText('https://acme.com')).toBeTruthy()
    // No allowlist or Requests for a channel whose visitors have no identity.
    expect(api.listAllowlist).not.toHaveBeenCalled()
    expect(api.listRequests).not.toHaveBeenCalled()
  })

  it('renders a key label as text, never as markup', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget({ grants: [grant({ label: XSS })] }))
    renderSection()
    expect(await screen.findByText(XSS)).toBeTruthy()
    expect(document.querySelector('img[src="x"]')).toBeNull()
  })

  it('adds a key with the sites typed one per line', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget())
    api.createWidgetGrant.mockResolvedValue(grant())
    renderSection()
    await screen.findByText(WEBCHAT_COPY.noKeys)
    fireEvent.change(within(section()).getByLabelText(WEBCHAT_COPY.labelLabel), { target: { value: ' Shop ' } })
    fireEvent.change(within(section()).getByLabelText(WEBCHAT_COPY.sitesLabel), {
      target: { value: 'https://acme.com\n\nhttps://shop.acme.com, ' },
    })
    fireEvent.click(within(section()).getByRole('button', { name: WEBCHAT_COPY.addKey }))
    await waitFor(() => expect(api.createWidgetGrant).toHaveBeenCalledWith(
      'c1', 'Shop', ['https://acme.com', 'https://shop.acme.com'],
    ))
  })

  it('shows the server reason when a site is refused', async () => {
    const { ApiError } = await import('../../../api/client')
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget())
    api.createWidgetGrant.mockRejectedValue(new ApiError(400, "'acme.com' must start with https://"))
    renderSection()
    await screen.findByText(WEBCHAT_COPY.noKeys)
    fireEvent.change(within(section()).getByLabelText(WEBCHAT_COPY.sitesLabel), { target: { value: 'acme.com' } })
    fireEvent.click(within(section()).getByRole('button', { name: WEBCHAT_COPY.addKey }))
    expect((await within(section()).findByRole('alert')).textContent).toContain('must start with https://')
  })

  it('revokes a key only after confirming', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget({ grants: [grant()] }))
    api.revokeWidgetGrant.mockResolvedValue({ revoked: 'g1' })
    renderSection()
    await screen.findByTestId('widget-snippet')
    fireEvent.click(within(section()).getByRole('button', { name: 'Revoke' }))
    expect(api.revokeWidgetGrant).not.toHaveBeenCalled()
    expect(within(section()).getByText(WEBCHAT_COPY.revokeConfirm)).toBeTruthy()
    fireEvent.click(within(section()).getByRole('button', { name: 'Yes, revoke' }))
    await waitFor(() => expect(api.revokeWidgetGrant).toHaveBeenCalledWith('c1', 'g1'))
  })

  it('edits a key’s sites', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget({ grants: [grant()] }))
    api.updateWidgetGrant.mockResolvedValue(grant({ origins: ['https://new.acme.com'] }))
    renderSection()
    await screen.findByTestId('widget-snippet')
    fireEvent.click(within(section()).getByRole('button', { name: 'Edit sites' }))
    fireEvent.change(within(section()).getByLabelText('Allowed sites for Main site'), {
      target: { value: 'https://new.acme.com' },
    })
    fireEvent.click(within(section()).getByRole('button', { name: 'Save sites' }))
    await waitFor(() => expect(api.updateWidgetGrant).toHaveBeenCalledWith(
      'c1', 'g1', { origins: ['https://new.acme.com'] },
    ))
  })

  it('labels the server among a key’s sites as the chat page', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget({
      grants: [grant({ label: 'Default', origins: ['https://clawmeets.example', 'https://acme.com'] })],
    }))
    renderSection()
    expect(await within(await screen.findByRole('tabpanel', { name: 'Web chat widget' }))
      .findByText(WEBCHAT_COPY.serverSite)).toBeTruthy()
    expect(within(section()).getByText('https://acme.com')).toBeTruthy()
  })

  it('says how to turn the chat page back on when no key lists the server', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget({ chat_page_public: false }))
    renderSection()
    expect(await screen.findByText(WEBCHAT_COPY.chatPageOff('https://clawmeets.example'))).toBeTruthy()
    expect(screen.queryByTestId('chat-page-url')).toBeNull()
  })

  it('removes the widget only after confirming', async () => {
    api.listConnections.mockResolvedValue([webchat()])
    api.getWidget.mockResolvedValue(widget())
    api.removeConnection.mockResolvedValue({ removed: 'c1' })
    renderSection()
    await screen.findByTestId('chat-page-url')
    fireEvent.click(within(section()).getByRole('button', { name: 'Remove' }))
    expect(api.removeConnection).not.toHaveBeenCalled()
    fireEvent.click(within(section()).getByRole('button', { name: 'Yes, remove' }))
    await waitFor(() => expect(api.removeConnection).toHaveBeenCalledWith('c1'))
  })

  it('shows Disabled with Enable', async () => {
    api.listConnections.mockResolvedValue([webchat({ disabled: true })])
    api.getWidget.mockResolvedValue(widget())
    api.enableConnection.mockResolvedValue(webchat())
    renderSection()
    expect((await screen.findByTestId('webchat-status')).textContent).toBe('Disabled')
    fireEvent.click(within(section()).getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(api.enableConnection).toHaveBeenCalledWith('c1'))
  })
})

describe('parseSites', () => {
  it('splits on lines and commas and drops blanks', () => {
    expect(parseSites(' https://a.com \n\nhttps://b.com,https://c.com, ')).toEqual([
      'https://a.com', 'https://b.com', 'https://c.com',
    ])
  })
})

describe('isolation on the web chat card', () => {
  it('sandboxed: the kept-apart line', async () => {
    api.listConnections.mockResolvedValue([webchat({ isolation: 'sandboxed' })])
    api.getWidget.mockResolvedValue(widget())
    renderSection()
    expect((await screen.findByTestId('channel-kept-apart')).textContent).toBe('Conversations are kept apart per requester')
  })

  it('unavailable: the host disclaimer slot', async () => {
    api.listConnections.mockResolvedValue([webchat({ isolation: 'unavailable', held_conversations: 1 })])
    api.getWidget.mockResolvedValue(widget())
    renderSection()
    expect((await screen.findByTestId('host-disclaimer-held')).textContent).toBe('1 conversation is waiting')
  })
})

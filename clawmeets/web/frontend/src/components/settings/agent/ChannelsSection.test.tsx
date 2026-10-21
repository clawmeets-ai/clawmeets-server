import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../../stores/authStore'
import { makeSession, seedSessions } from '../../../test/authFixtures'
import { ApiError } from '../../../api/client'
import type { ChannelConnection, ChannelRequest } from '../../../api/endpoints/channels'
import ChannelsSection, { COPY, EMAIL, HUB, statusView } from './ChannelsSection'
import { hubChannel, hubConfig } from '../../../test/hubFixtures'

/**
 * Agent Settings → Channels. The API is mocked; every claim the review
 * checklist makes about the page has a test here: the token is typed once and
 * kept nowhere, buttons guard against double clicks, every health code reads
 * distinctly, "anyone" needs a confirmation and its banner comes from the API,
 * and a stranger's text is rendered as text.
 */

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  connectTelegram: vi.fn(),
  connectEmail: vi.fn(),
  testConnection: vi.fn(),
  disableConnection: vi.fn(),
  enableConnection: vi.fn(),
  reconnectConnection: vi.fn(),
  removeConnection: vi.fn(),
  setConnectionMode: vi.fn(),
  setFixedReply: vi.fn(),
  listAllowlist: vi.fn(),
  addAllowlistEntry: vi.fn(),
  deleteAllowlistEntry: vi.fn(),
  listRequests: vi.fn(),
  allowRequest: vi.fn(),
  blockRequest: vi.fn(),
}))
vi.mock('../../../api/endpoints/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/endpoints/channels')>()
  const mocked: Record<string, unknown> = { WARNING_ANYONE: actual.WARNING_ANYONE }
  for (const name of Object.keys(api)) {
    mocked[name] = (...a: unknown[]) => (api as Record<string, (...x: unknown[]) => unknown>)[name](...a)
  }
  return mocked
})

const hubApi = vi.hoisted(() => ({
  getHubConfig: vi.fn(),
  getHubChannel: vi.fn(),
  listBlockedDeployments: vi.fn(),
  blockDeployment: vi.fn(),
}))
vi.mock('../../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../../api/endpoints/hub')>()
  return {
    ...real,
    getHubConfig: (...a: unknown[]) => hubApi.getHubConfig(...a),
    getHubChannel: (...a: unknown[]) => hubApi.getHubChannel(...a),
    listBlockedDeployments: (...a: unknown[]) => hubApi.listBlockedDeployments(...a),
    blockDeployment: (...a: unknown[]) => hubApi.blockDeployment(...a),
  }
})

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'

function connection(over: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: 'c1', agent_id: 'a1', channel: 'telegram', label: '', secret_last4: 'sawQ',
    webhook_url: 'https://x/api/channels/webhooks/telegram/c1', mode: 'allowlist',
    fixed_reply: '', warning: null, account_name: '@concierge_bot', disabled: false,
    status: 'working', status_detail: null, status_count: null, status_at: 1_760_000_000,
    last_inbound_at: null, ack_text: null, push_used: null, push_limit: null, push_as_of: null,
    unverified_calls: 0,
    ...over,
  }
}

function request(over: Partial<ChannelRequest> = {}): ChannelRequest {
  return {
    id: 'r1', state: 'pending', display_name: 'Sam', user_key: '222', handle: 'sam',
    first_message: 'can I book?', held_count: 1, dropped_count: 0, unverified_count: 0,
    fixed_reply_state: 'sent', allowed_by: null, project_ids: [], created_at: 1_760_000_000,
    ...over,
  }
}

function renderSection(channel?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[channel ? `/?channel=${channel}` : '/']}>
        <ChannelsSection agentId="a1" agentName="olivia-concierge" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  api.listAllowlist.mockResolvedValue([])
  api.listRequests.mockResolvedValue([])
  // An older server without /api/hub/config, unless a test says otherwise.
  hubApi.getHubConfig.mockRejectedValue(new ApiError(404, 'Not Found'))
  hubApi.getHubChannel.mockResolvedValue(hubChannel())
  hubApi.listBlockedDeployments.mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  useAuthStore.getState().logout()
})

describe('connect', () => {
  it('takes the token in a password field, clears it, and keeps it nowhere', async () => {
    api.listConnections.mockResolvedValueOnce([])
    api.listConnections.mockResolvedValue([connection()])
    api.connectTelegram.mockResolvedValue(connection())
    renderSection()
    const input = (await screen.findByLabelText('Bot token')) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    fireEvent.change(input, { target: { value: TOKEN } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    expect(api.connectTelegram).toHaveBeenCalledWith('olivia-concierge', TOKEN)
    expect(await screen.findByText('Token …sawQ')).toBeTruthy()
    expect(screen.getByText('@concierge_bot')).toBeTruthy()
    expect(document.body.innerHTML).not.toContain(TOKEN)
    expect(document.body.innerHTML).not.toContain(TOKEN.split(':')[1])
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN.split(':')[1])
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN.split(':')[1])
    expect(window.location.href).not.toContain(TOKEN)
  })

  it('shows the server reason and leaves the form usable', async () => {
    api.listConnections.mockResolvedValue([])
    api.connectTelegram.mockRejectedValue(
      new ApiError(409, 'This bot is already connected to an agent. Remove that connection first.'),
    )
    renderSection()
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: TOKEN } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    expect(screen.getByRole('alert').textContent).toContain('already connected')
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: TOKEN } })
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([
    [400, "That doesn't look like a bot token (it should look like 123456:ABC…)"],
    [502, 'The provider could not be reached. Try again in a minute.'],
  ])('shows a %s with its message', async (status, message) => {
    api.listConnections.mockResolvedValue([])
    api.connectTelegram.mockRejectedValue(new ApiError(status, message))
    renderSection()
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: 'x' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    expect(screen.getByRole('alert').textContent).toBe(message)
  })

  it('says channels are off when the server answers 404', async () => {
    api.listConnections.mockRejectedValue(new ApiError(404, 'Not Found'))
    renderSection()
    expect(await screen.findByText(COPY.off)).toBeTruthy()
    expect(api.listConnections).toHaveBeenCalledTimes(1)
  })
})

describe('manage', () => {
  it('Test calls its route once even on a double click', async () => {
    api.listConnections.mockResolvedValue([connection()])
    let resolve: (c: ChannelConnection) => void = () => {}
    api.testConnection.mockReturnValue(new Promise((r) => { resolve = r }))
    renderSection()
    const button = await screen.findByRole('button', { name: 'Test' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(api.testConnection).toHaveBeenCalledTimes(1)
    await act(async () => resolve(connection()))
  })

  it('Remove asks first, then calls the route', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.removeConnection.mockResolvedValue({ removed: 'c1' })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(api.removeConnection).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(COPY.removeBody)
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })
    expect(api.removeConnection).toHaveBeenCalledWith('c1')
  })

  it('Disable asks first (it drops messages); Enable does not', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.disableConnection.mockResolvedValue(connection({ disabled: true }))
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    expect(api.disableConnection).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))
    })
    expect(api.disableConnection).toHaveBeenCalledWith('c1')
    cleanup()
    api.listConnections.mockResolvedValue([connection({ disabled: true, status: 'disabled' })])
    api.enableConnection.mockResolvedValue(connection())
    renderSection()
    const target = await screen.findByRole('button', { name: 'Enable' })
    await act(async () => {
      fireEvent.click(target)
    })
    expect(api.enableConnection).toHaveBeenCalledWith('c1')
  })
})

describe('status', () => {
  const codes = ['working', 'token_rejected', 'webhook_missing', 'webhook_error',
    'pending_updates', 'disabled', 'key_rotation_pending']

  it('every code reads distinctly, and unknown codes fall back', () => {
    const labels = codes.map((c) => statusView(c).label)
    expect(new Set(labels).size).toBe(codes.length)
    expect(labels).not.toContain(statusView('something_new').label)
    expect(statusView('something_new').label).toBe('Status unknown')
    expect(statusView(null).label).toBe('Not checked yet')
  })

  it('key rotation shows its notice and the Reconnect action', async () => {
    api.listConnections.mockResolvedValue([connection({ status: 'key_rotation_pending' })])
    api.reconnectConnection.mockResolvedValue(connection())
    renderSection()
    expect((await screen.findByTestId('channel-status')).textContent).toBe('Reconnect to finish key rotation')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    })
    expect(api.reconnectConnection).toHaveBeenCalledWith('c1')
  })

  it("renders Telegram's error text as text", async () => {
    api.listConnections.mockResolvedValue([connection({
      status: 'webhook_error', status_detail: '<img src=x onerror=alert(1)> 502', status_count: 1_760_000_000,
    })])
    const { container } = renderSection()
    expect(await screen.findByText('<img src=x onerror=alert(1)> 502')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('"anyone" mode', () => {
  it('asks with both warnings and only switches after confirming', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.setConnectionMode.mockResolvedValue(connection({ mode: 'anyone', warning: 'strangers_reach_full_tools' }))
    renderSection()
    fireEvent.click(await screen.findByLabelText(/Anyone\./))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('full tools')
    expect(dialog.textContent).toContain('Rate limits apply')
    expect(api.setConnectionMode).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.setConnectionMode).not.toHaveBeenCalled()
    expect((screen.getByLabelText(/Only people on the allowlist/) as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByLabelText(/Anyone\./))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Let anyone in' }))
    })
    expect(api.setConnectionMode).toHaveBeenCalledWith('c1', 'anyone')
  })

  it('the banner comes from the API flag, so it survives a reload', async () => {
    api.listConnections.mockResolvedValue([connection({ mode: 'anyone', warning: 'strangers_reach_full_tools' })])
    renderSection()
    expect(await screen.findByText(COPY.anyoneBanner)).toBeTruthy()
    cleanup()
    api.listConnections.mockResolvedValue([connection({ mode: 'allowlist', warning: null })])
    renderSection()
    await screen.findByText('Token …sawQ')
    expect(screen.queryByText(COPY.anyoneBanner)).toBeNull()
  })
})

describe('allowlist', () => {
  it('adds an entry, shows a 400 reason inline, and shows a pin', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.listAllowlist.mockResolvedValue([
      { id: 'e1', kind: 'username', value: 'alice', pinned_to: '111' },
    ])
    api.addAllowlistEntry.mockRejectedValueOnce(new ApiError(400, 'Not a Telegram user id or @username'))
    renderSection()
    expect(await screen.findByText('pinned to id …111')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Add to allowlist'), { target: { value: 'bob smith' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    expect(screen.getByRole('alert').textContent).toBe('Not a Telegram user id or @username')
    api.addAllowlistEntry.mockResolvedValue({ id: 'e2', kind: 'user_id', value: '555', pinned_to: null })
    fireEvent.change(screen.getByLabelText('Add to allowlist'), { target: { value: '555' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    expect(api.addAllowlistEntry).toHaveBeenLastCalledWith('c1', '555')
  })

  it('removes an entry', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.listAllowlist.mockResolvedValue([{ id: 'e1', kind: 'user_id', value: '111', pinned_to: null }])
    api.deleteAllowlistEntry.mockResolvedValue({ deleted: 'e1' })
    renderSection()
    const target = await screen.findByRole('button', { name: 'Remove 111' })
    await act(async () => {
      fireEvent.click(target)
    })
    expect(api.deleteAllowlistEntry).toHaveBeenCalledWith('c1', 'e1')
  })
})

describe('requests', () => {
  it('shows who, what, when and the counts, with Allow and Block', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.listRequests.mockResolvedValue([request({ held_count: 3, dropped_count: 2 })])
    renderSection()
    const item = await screen.findByTestId('channel-request')
    expect(item.textContent).toContain('Sam')
    expect(item.textContent).toContain('can I book?')
    expect(item.textContent).toContain('3 held, 2 dropped')
    expect(item.textContent).toContain('Reply sent')
    expect(within(item).getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(within(item).getByRole('button', { name: 'Block' })).toBeTruthy()
  })

  it('renders the first message and the name as text, never markup', async () => {
    api.listConnections.mockResolvedValue([connection()])
    const evil = '<img src=x onerror=alert(1)> [click](javascript:alert(1))'
    api.listRequests.mockResolvedValue([request({ first_message: evil, display_name: '<b>Sam</b>' })])
    const { container } = renderSection()
    const message = await screen.findByTestId('request-first-message')
    expect(message.textContent).toBe(evil)
    expect(container.querySelector('[data-testid="channel-request"] img')).toBeNull()
    expect(container.querySelector('[data-testid="channel-request"] a')).toBeNull()
    expect(container.querySelector('[data-testid="channel-request"] b')).toBeNull()
    expect(screen.getByText('<b>Sam</b>')).toBeTruthy()
  })

  it('Allow is guarded, links to the new thread, and the entry leaves the list', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.listRequests.mockResolvedValueOnce([request()])
    api.listRequests.mockResolvedValue([request({ state: 'allowed', project_ids: ['p9'] })])
    let resolve: (r: ChannelRequest) => void = () => {}
    api.allowRequest.mockReturnValue(new Promise((r) => { resolve = r }))
    renderSection()
    const allow = await screen.findByRole('button', { name: 'Allow' })
    fireEvent.click(allow)
    fireEvent.click(allow)
    expect(api.allowRequest).toHaveBeenCalledTimes(1)
    await act(async () => resolve(request({ state: 'allowed', project_ids: ['p9'] })))
    expect((await screen.findByRole('link', { name: 'Open the thread' })).getAttribute('href')).toBe('/projects/p9')
    expect(screen.queryByTestId('channel-request')).toBeNull()
  })

  it('a 409 shows its message and refreshes the list', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.listRequests.mockResolvedValue([request()])
    api.blockRequest.mockRejectedValue(new ApiError(409, 'This sender has already been allowed'))
    renderSection()
    const target = await screen.findByRole('button', { name: 'Block' })
    await act(async () => {
      fireEvent.click(target)
    })
    expect(screen.getByRole('alert').textContent).toBe('This sender has already been allowed')
    expect(api.listRequests.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

// ── email ────────────────────────────────────────────────────────────────

const ADDRESS = 'olivia.concierge@agents.clawmeets.ai'
const INBOUND_SECRET = 's'.repeat(40)
const API_KEY = 'SG.fakeKeyId_abcdef.fakeSecretPart_0123456789abcdefghij'

function emailConnection(over: Partial<ChannelConnection> = {}): ChannelConnection {
  return connection({
    id: 'e1', channel: 'email', secret_last4: '', account_name: ADDRESS,
    webhook_url: 'https://x/api/channels/webhooks/email', status: null, status_at: null,
    ...over,
  })
}

function emailSection(): HTMLElement {
  return screen.getByRole('tabpanel', { name: 'Email' })
}

describe('email', () => {
  it('connects with no credential field and shows the address with a copy button', async () => {
    api.listConnections.mockResolvedValueOnce([])
    api.listConnections.mockResolvedValue([emailConnection()])
    api.connectEmail.mockResolvedValue(emailConnection())
    renderSection('email')
    await screen.findByText(COPY.emailConnectTitle)
    const section = emailSection()
    expect(within(section).queryByLabelText('Bot token')).toBeNull()
    expect(section.querySelector('input[type="password"]')).toBeNull()
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Create email address' }))
    })
    expect(api.connectEmail).toHaveBeenCalledWith('olivia-concierge')
    expect(await screen.findByTestId('email-address')).toHaveProperty('textContent', ADDRESS)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Copy ${ADDRESS}` }))
    })
    expect(writeText).toHaveBeenCalledWith(ADDRESS)
    expect(screen.getByTestId('last-mail').textContent).toBe('No mail received yet')
  })

  it('a double click creates the address once', async () => {
    api.listConnections.mockResolvedValue([])
    let resolve: (c: ChannelConnection) => void = () => {}
    api.connectEmail.mockImplementation(() => new Promise((r) => { resolve = r }))
    renderSection('email')
    await screen.findByText(COPY.emailConnectTitle)
    const button = within(emailSection()).getByRole('button', { name: 'Create email address' })
    fireEvent.click(button)
    fireEvent.click(button)
    await act(async () => resolve(emailConnection()))
    expect(api.connectEmail).toHaveBeenCalledTimes(1)
  })

  it('shows last mail received, status, Test, Disable and Remove against the email copy', async () => {
    api.listConnections.mockResolvedValue([
      emailConnection({ last_inbound_at: 1_760_000_100, status: 'working' }),
    ])
    api.testConnection.mockResolvedValue(emailConnection({ status: 'working' }))
    api.removeConnection.mockResolvedValue({ removed: 'e1' })
    api.disableConnection.mockResolvedValue(emailConnection({ disabled: true, status: 'disabled' }))
    renderSection()
    await screen.findByTestId('email-address')
    const section = emailSection()
    expect(within(section).getByTestId('last-mail').textContent).toContain('Last mail received')
    expect(within(section).getByTestId('channel-status').textContent).toBe('Working')
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Test' }))
    })
    expect(api.testConnection).toHaveBeenCalledWith('e1')
    fireEvent.click(within(section).getByRole('button', { name: 'Disable' }))
    expect(screen.getByRole('dialog').textContent).toContain(COPY.emailDisableTitle)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))
    })
    expect(api.disableConnection).toHaveBeenCalledWith('e1')
    fireEvent.click(within(section).getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('dialog').textContent).toContain(COPY.emailRemoveTitle)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    })
    expect(api.removeConnection).toHaveBeenCalledWith('e1')
    // Email has no webhook of its own: never a Reconnect button.
    expect(within(section).queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })

  it('shows the automatic mail it ignored, with the last one\'s domain and why', async () => {
    api.listConnections.mockResolvedValue([emailConnection({
      automatic_dropped: 3, automatic_dropped_at: 1_760_000_100,
      automatic_dropped_domain: 'sendgrid.net', automatic_dropped_reason: 'system_sender',
    })])
    renderSection()
    const note = await screen.findByTestId('email-automatic-dropped')
    expect(note.textContent).toBe(
      'Ignored 3 automatic emails (bounces, no-reply senders, provider notices).' +
      ` Last: from sendgrid.net, ${new Date(1_760_000_100_000).toLocaleString()} — a no-reply sender.`,
    )
  })

  it('reads one, 1,000+ and an unknown reason; shows nothing at zero', async () => {
    expect(COPY.automaticDropped(1)).toBe('Ignored 1 automatic email (bounces, no-reply senders, provider notices).')
    expect(COPY.automaticDropped(1000)).toContain('Ignored 1,000+ automatic emails')
    api.listConnections.mockResolvedValue([emailConnection({
      automatic_dropped: 1, automatic_dropped_at: 1_760_000_100,
      automatic_dropped_domain: 'example.com', automatic_dropped_reason: 'from_the_future',
    })])
    renderSection()
    const note = await screen.findByTestId('email-automatic-dropped')
    expect(note.textContent).toMatch(/Last: from example\.com, [^—]+\.$/)
    cleanup()
    api.listConnections.mockResolvedValue([emailConnection({ automatic_dropped: 0 })])
    renderSection()
    await screen.findByTestId('email-address')
    expect(screen.queryByTestId('email-automatic-dropped')).toBeNull()
  })

  it('reads the email health codes', () => {
    expect(statusView('token_rejected', EMAIL).label).toContain('SendGrid key')
    expect(statusView('token_rejected').label).toContain('new token')
    expect(statusView('sender_not_authorized', EMAIL).label).toContain("sending domain isn't set up")
    expect(statusView('key_rotation_pending', EMAIL).reconnect).toBe(false)
  })

  it('never shows the Inbound Parse secret or the API key', async () => {
    api.listConnections.mockResolvedValue([emailConnection()])
    renderSection()
    await screen.findByTestId('email-address')
    expect(document.body.innerHTML).not.toContain(INBOUND_SECRET)
    expect(document.body.innerHTML).not.toContain(API_KEY)
    expect(document.body.innerHTML).not.toContain('SG.')
  })

  it('takes address and *@domain entries and shows a domain entry as *@domain', async () => {
    api.listConnections.mockResolvedValue([emailConnection()])
    api.listAllowlist.mockResolvedValue([
      { id: 'x1', kind: 'email', value: 'bob@allowed.com', pinned_to: null },
      { id: 'x2', kind: 'domain', value: 'example.org', pinned_to: null },
    ])
    renderSection()
    await screen.findByText('*@example.org')
    expect(screen.getByText('bob@allowed.com')).toBeTruthy()
    expect(screen.getByPlaceholderText('name@example.com or *@example.com')).toBeTruthy()
  })

  it("marks a held mail whose sender couldn't be confirmed", async () => {
    api.listConnections.mockResolvedValue([emailConnection()])
    api.listRequests.mockResolvedValue([
      request({ user_key: 'ceo@bigcorp.com', handle: null, unverified_count: 1 }),
      request({ id: 'r2', user_key: 'carol@else.org', handle: null, display_name: 'Carol' }),
    ])
    renderSection()
    const [first, second] = await screen.findAllByTestId('channel-request')
    expect(within(first).getByTestId('request-unverified').textContent).toContain(COPY.unverified)
    expect(within(first).getByTestId('request-sender').textContent).toBe('ceo@bigcorp.com')
    expect(within(second).queryByTestId('request-unverified')).toBeNull()
  })

  it('renders the subject, name, attachment names and first message as text', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">'
    api.listConnections.mockResolvedValue([emailConnection()])
    api.listRequests.mockResolvedValue([
      request({
        handle: null, user_key: 'x@else.org', display_name: hostile,
        first_message: `Subject: ${hostile}\n\nhello\n[attachment: ${hostile}.pdf, application/pdf, 1 KB]`,
      }),
    ])
    renderSection()
    const [item] = await screen.findAllByTestId('channel-request')
    expect(item.querySelector('img')).toBeNull()
    expect(within(item).getByTestId('request-first-message').textContent).toContain(`[attachment: ${hostile}.pdf`)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it("renders a held mail's sender line as text, never markup", async () => {
    const hostile = '<img src=x onerror=alert(1)>@evil.example'
    api.listConnections.mockResolvedValue([emailConnection()])
    api.listRequests.mockResolvedValue([request({ handle: null, user_key: hostile })])
    renderSection()
    const [item] = await screen.findAllByTestId('channel-request')
    expect(within(item).getByTestId('request-sender').textContent).toBe(hostile)
    expect(item.querySelector('img')).toBeNull()
  })

  it('connecting email sends exactly {agent_name, channel} — no token field', async () => {
    const real = await vi.importActual<typeof import('../../../api/endpoints/channels')>(
      '../../../api/endpoints/channels',
    )
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(emailConnection()), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      await real.connectEmail('olivia-concierge')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/me\/channels\/connections$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toStrictEqual({ agent_name: 'olivia-concierge', channel: 'email' })
  })

  it('shows Telegram and email each on its own tab, opening on the first connected', async () => {
    api.listConnections.mockResolvedValue([connection(), emailConnection()])
    renderSection()
    expect(await screen.findByText('@concierge_bot')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Telegram (connected)' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('email-address')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Email (connected)' }))
    expect(within(emailSection()).getByText(ADDRESS)).toBeTruthy()
    expect(screen.queryByText('@concierge_bot')).toBeNull()
  })
})


// ── tabs ─────────────────────────────────────────────────────────────────

describe('channel tabs', () => {
  const tab = (name: RegExp) => screen.getByRole('tab', { name })

  it('opens on Telegram when nothing is connected, and marks no tab connected', async () => {
    api.listConnections.mockResolvedValue([])
    renderSection()
    await screen.findByLabelText('Bot token')
    expect(tab(/^Telegram/).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Telegram', 'Email', 'LINE', 'WhatsApp', 'Web chat'])
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  })

  it('opens on the first connected channel and dots each connected tab', async () => {
    api.listConnections.mockResolvedValue([
      emailConnection(), connection({ id: 'w1', channel: 'whatsapp', disabled: true }),
    ])
    renderSection()
    await screen.findByTestId('email-address')
    expect(tab(/^Email/).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('channel-tab-dot-email').className).toContain('bg-emerald-500')
    expect(screen.getByTestId('channel-tab-dot-whatsapp').className).toContain('bg-gray-400')
    expect(tab(/^WhatsApp/).textContent).toContain('(connected, disabled)')
    expect(screen.queryByTestId('channel-tab-dot-telegram')).toBeNull()
  })

  it('honours ?channel= and ignores an unknown value', async () => {
    api.listConnections.mockResolvedValue([])
    renderSection('line')
    await screen.findByLabelText('Channel secret')
    expect(tab(/^LINE/).getAttribute('aria-selected')).toBe('true')
    cleanup()
    renderSection('fax')
    await screen.findByLabelText('Bot token')
    expect(tab(/^Telegram/).getAttribute('aria-selected')).toBe('true')
  })

  it('moves with the arrow keys and Home/End, with only the selected tab focusable', async () => {
    api.listConnections.mockResolvedValue([])
    renderSection()
    await screen.findByLabelText('Bot token')
    const list = screen.getByRole('tablist', { name: 'Channels' })
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(tab(/^Email/).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab(/^Email/))
    expect(tab(/^Email/).tabIndex).toBe(0)
    expect(tab(/^Telegram/).tabIndex).toBe(-1)
    fireEvent.keyDown(list, { key: 'End' })
    expect(tab(/^Web chat/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(tab(/^Web chat/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(tab(/^Telegram/).getAttribute('aria-selected')).toBe('true')
  })

  it('stays on the open tab when its channel is removed', async () => {
    api.listConnections.mockResolvedValue([emailConnection()])
    const { queryClient } = renderSection()
    await screen.findByTestId('email-address')
    api.listConnections.mockResolvedValue([])
    await act(async () => { await queryClient.invalidateQueries() })
    expect(await within(emailSection()).findByRole('button', { name: 'Create email address' })).toBeTruthy()
    expect(tab(/^Email/).getAttribute('aria-selected')).toBe('true')
  })
})


// ── the Hub tab ──────────────────────────────────────────────────────────

describe('the Hub tab', () => {
  const tab = (name: RegExp) => screen.getByRole('tab', { name })
  const hubRow = (over: Partial<ChannelConnection> = {}) => connection({
    id: 'h1', channel: 'hub', label: 'olivia-concierge@clawmeets.ai', secret_last4: '9f2c', webhook_url: '',
    account_name: 'olivia-concierge@clawmeets.ai', status: 'connected', status_at: null, ...over,
  })

  it('is absent when the hub is off on this server and the agent has no Hub row', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig({ mode: 'off' }))
    api.listConnections.mockResolvedValue([])
    renderSection()
    await screen.findByLabelText('Bot token')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Telegram', 'Email', 'LINE', 'WhatsApp', 'Web chat'])
    expect(hubApi.getHubChannel).not.toHaveBeenCalled()
  })

  it('stays while the hub is off but the agent still has a Hub row to turn off', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig({ mode: 'off' }))
    hubApi.getHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'hub_off_on_server' }))
    api.listConnections.mockResolvedValue([hubRow()])
    renderSection('hub')
    expect(await screen.findByText('Sharing is turned off on this server.')).toBeTruthy()
    expect(tab(/^Hub/).getAttribute('aria-selected')).toBe('true')
  })

  it('appears last with the hub on, and shows the card, the shared cards on the Hub row and Blocked servers', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig())
    hubApi.getHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'connected', key_last4: '9f2c' }))
    api.listConnections.mockResolvedValue([hubRow()])
    renderSection('hub')
    await screen.findByTestId('hub-channel-card')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
      ['Telegram', 'Email', 'LINE', 'WhatsApp', 'Web chat', 'Hub(connected)'])
    const panel = screen.getByRole('tabpanel', { name: 'ClawMeets Hub' })
    expect(within(panel).getByRole('radiogroup', { name: 'Who can message this agent' })).toBeTruthy()
    expect(within(panel).getByText('Allowlist')).toBeTruthy()
    expect(within(panel).getByText('Requests')).toBeTruthy()
    expect(within(panel).getByRole('heading', { name: 'Reply to people waiting' })).toBeTruthy()
    expect(await within(panel).findByText('Blocked servers')).toBeTruthy()
    // The Hub row never offers a free-text allowlist entry (entries come from Requests).
    expect(within(panel).queryByRole('textbox', { name: 'Add to allowlist' })).toBeNull()
  })

  it('counts waiting requests on the tab and says so above the Hub card', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig())
    hubApi.getHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'connected' }))
    api.listConnections.mockResolvedValue([hubRow()])
    api.listRequests.mockResolvedValue([
      request(), request({ id: 'r2', state: 'allowing' }), request({ id: 'r3', state: 'allowed' })])
    renderSection('hub')
    const badge = await screen.findByTestId('channel-tab-waiting')
    expect(badge.textContent).toBe('2 requests waiting')
    expect(tab(/^Hub/).contains(badge)).toBe(true)
    const banner = await screen.findByText(/2 people are waiting/)
    expect(banner.closest('[role="status"]')?.textContent).toContain('held until you allow them')
    expect(screen.getByRole('button', { name: 'Review requests' })).toBeTruthy()
  })

  it('shows no count and no banner when nobody is waiting', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig())
    hubApi.getHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'connected' }))
    api.listConnections.mockResolvedValue([hubRow()])
    api.listRequests.mockResolvedValue([request({ state: 'blocked' })])
    renderSection('hub')
    await screen.findByText('No one is waiting.')
    expect(screen.queryByTestId('channel-tab-waiting')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review requests' })).toBeNull()
  })

  it("the Allowlist's help text does not promise a fingerprint its rows cannot show", async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig())
    hubApi.getHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'connected' }))
    api.listConnections.mockResolvedValue([hubRow()])
    renderSection('hub')
    await screen.findByTestId('hub-channel-card')
    const panel = screen.getByRole('tabpanel', { name: 'ClawMeets Hub' })
    expect(within(panel).getByText('People on other servers you allowed from Requests. Each is one person on one server.')).toBeTruthy()
    expect(HUB.allowlistHelp).not.toMatch(/fingerprint/i)
  })

  it('never shows Test, Reconnect, Enable, Disable or Remove on the Hub row', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig())
    hubApi.getHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'key_rotation_pending' }))
    api.listConnections.mockResolvedValue([hubRow({ status: 'key_rotation_pending', disabled: true })])
    renderSection('hub')
    await screen.findByTestId('hub-channel-card')
    for (const name of ['Test', 'Enable', 'Disable', 'Remove']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    // The only Reconnect is the Hub card's own (enable again), never the generic route.
    expect(screen.getAllByRole('button', { name: 'Reconnect' })).toHaveLength(1)
    expect(api.reconnectConnection).not.toHaveBeenCalled()
  })

  it('on a hub-only server, opens on Hub and the other tabs read "Channels are turned off"', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig({ channels_enabled: false }))
    api.listConnections.mockResolvedValue([])
    renderSection()
    await screen.findByTestId('hub-channel-card')
    expect(tab(/^Hub/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(tab(/^Telegram/))
    expect(screen.getByText(COPY.off)).toBeTruthy()
    expect(screen.queryByLabelText('Bot token')).toBeNull()
    fireEvent.click(tab(/^Hub/))
    expect(await screen.findByTestId('hub-channel-card')).toBeTruthy()
  })

  it('keeps a stray non-Hub row out of a hub-only server\'s tabs', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig({ channels_enabled: false }))
    api.listConnections.mockResolvedValue([connection(), hubRow()])
    renderSection()
    await screen.findByTestId('hub-channel-card')
    expect(screen.queryByTestId('channel-tab-dot-telegram')).toBeNull()
    expect(screen.getByTestId('channel-tab-dot-hub')).toBeTruthy()
  })

  it('works when the connection list answers 404 but the hub is on', async () => {
    hubApi.getHubConfig.mockResolvedValue(hubConfig({ channels_enabled: false }))
    api.listConnections.mockRejectedValue(new ApiError(404, 'Not Found'))
    renderSection()
    expect(await screen.findByTestId('hub-channel-card')).toBeTruthy()
  })
})


// ── Hub requests (host side) ─────────────────────────────────────────────

describe('Hub requests', () => {
  const FP = '3f9a1c2e5b7d9f00aa11bb22cc33dd44'
  const hubRow = () => connection({
    id: 'h1', channel: 'hub', label: 'olivia-concierge@clawmeets.ai', webhook_url: '', status: 'connected',
  })
  const hubRequest = (over: Partial<ChannelRequest> = {}) => request({
    id: 'hr1', display_name: 'carol @ evil.dev', user_key: 'key:abc', handle: null,
    remote_username: 'carol @ evil.dev', deployment_name: 'acme.dev', deployment_fingerprint: FP, ...over,
  })
  async function openHub(requests: ChannelRequest[]) {
    hubApi.getHubConfig.mockResolvedValue(hubConfig())
    hubApi.getHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'connected' }))
    api.listConnections.mockResolvedValue([hubRow()])
    api.listRequests.mockResolvedValue(requests)
    renderSection('hub')
    return screen.findAllByTestId('channel-request')
  }

  it('draws the requester with HubContactLabel: the username stays in its span, the real server follows', async () => {
    const [row] = await openHub([hubRequest()])
    expect(within(row).getByTestId('hub-contact-user').textContent).toBe('carol @ evil.dev')
    expect(within(row).getByTestId('hub-contact-server').textContent).toBe('acme.dev')
    expect(within(row).getByTestId('hub-contact-fp').textContent).toBe(`fp ${FP.slice(0, 8)}`)
    expect(within(row).getByRole('button', { name: 'Block this person' })).toBeTruthy()
  })

  it('"Block everyone from X" confirms with the server and its fingerprint, then blocks the genesis fingerprint', async () => {
    hubApi.blockDeployment.mockResolvedValue([{ deployment_fingerprint: FP, deployment_name: 'acme.dev', created_at: 1 }])
    const [row] = await openHub([hubRequest()])
    fireEvent.click(within(row).getByRole('button', { name: 'Block everyone from acme.dev' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading').textContent).toBe('Block everyone from acme.dev?')
    expect(dialog.textContent).toContain(`server fp ${FP.slice(0, 8)}`)
    expect(hubApi.blockDeployment).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Block server' }))
    })
    expect(hubApi.blockDeployment).toHaveBeenCalledWith('olivia-concierge', FP)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.blockRequest).not.toHaveBeenCalled()
  })

  it('a requester known only by key: "Block everyone from server"', async () => {
    const [row] = await openHub([hubRequest({ deployment_name: null })])
    expect(within(row).getByRole('button', { name: 'Block everyone from server' })).toBeTruthy()
  })

  it('"Block this person" blocks only the request', async () => {
    api.blockRequest.mockResolvedValue(hubRequest({ state: 'blocked' }))
    const [row] = await openHub([hubRequest()])
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Block this person' }))
    })
    expect(api.blockRequest).toHaveBeenCalledWith('h1', 'hr1')
    expect(hubApi.blockDeployment).not.toHaveBeenCalled()
  })

  it('other channels keep their plain name and their one Block button', async () => {
    api.listConnections.mockResolvedValue([connection()])
    api.listRequests.mockResolvedValue([request()])
    renderSection()
    const [row] = await screen.findAllByTestId('channel-request')
    expect(within(row).queryByTestId('hub-contact')).toBeNull()
    expect(within(row).getByRole('button', { name: 'Block' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /Block everyone/ })).toBeNull()
  })
})

describe('isolation on every connected channel card', () => {
  it.each(['telegram', 'email', 'line', 'whatsapp'])('%s, sandboxed: the kept-apart line', async (channel) => {
    api.listConnections.mockResolvedValue([connection({ channel, isolation: 'sandboxed' })])
    renderSection(channel)
    expect((await screen.findByTestId('channel-kept-apart')).textContent).toBe('Conversations are kept apart per requester')
  })

  it.each(['telegram', 'email', 'line', 'whatsapp'])('%s, unavailable: the host disclaimer slot with the held count', async (channel) => {
    api.listConnections.mockResolvedValue([connection({ channel, isolation: 'unavailable', held_conversations: 2 })])
    renderSection(channel)
    expect((await screen.findByTestId('host-disclaimer-held')).textContent).toBe('2 conversations are waiting')
    expect(screen.queryByTestId('channel-kept-apart')).toBeNull()
  })
})

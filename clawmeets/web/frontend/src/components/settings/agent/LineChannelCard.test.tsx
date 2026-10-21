import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../../stores/authStore'
import { makeSession, seedSessions } from '../../../test/authFixtures'
import { ApiError } from '../../../api/client'
import type { ChannelConnection, ChannelRequest } from '../../../api/endpoints/channels'
import ChannelsSection, { COPY, statusView } from './ChannelsSection'
import { LINE, LINE_COPY, PUSH_WARN_PERCENT, UNVERIFIED_CALLS_CAP, pushMeter } from './LineChannelCard'

// Not about the hub: an older server without /api/hub/config.
vi.mock('../../../api/endpoints/hub', async (orig) =>
  (await import('../../../test/hubFixtures')).withoutHubConfig(await orig<object>()))

/**
 * Agent Settings → Channels → LINE. The API is mocked the same way as in
 * ChannelsSection.test.tsx; the whole section is rendered so the LINE card is
 * tested where it lives, beside Telegram and email.
 */

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  connectTelegram: vi.fn(),
  connectEmail: vi.fn(),
  connectLine: vi.fn(),
  testConnection: vi.fn(),
  disableConnection: vi.fn(),
  enableConnection: vi.fn(),
  reconnectConnection: vi.fn(),
  removeConnection: vi.fn(),
  setConnectionMode: vi.fn(),
  setFixedReply: vi.fn(),
  setAckText: vi.fn(),
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

const SECRET = '8c1f0e2d9b7a6c5d4e3f2a1b0c9d8e7f'
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + 'Q'.repeat(140) + '/abcd='
const DEFAULT_ACK = "Got it — I'll reply shortly."
const AS_OF = 1_760_000_000
const XSS = '<img src=x onerror=alert(1)>'

function line(over: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: 'l1', agent_id: 'a1', channel: 'line', label: '', secret_last4: 'abcd',
    webhook_url: 'https://x/api/channels/webhooks/line/l1', mode: 'allowlist',
    fixed_reply: '', warning: null, account_name: 'Olivia Concierge', disabled: false,
    status: 'working', status_detail: null, status_count: null, status_at: AS_OF,
    last_inbound_at: null, ack_text: DEFAULT_ACK, push_used: 12, push_limit: 200, push_as_of: AS_OF,
    unverified_calls: 0,
    ...over,
  }
}

function request(over: Partial<ChannelRequest> = {}): ChannelRequest {
  return {
    id: 'r1', state: 'pending', display_name: 'Sam', user_key: 'U' + 'a'.repeat(32), handle: null,
    first_message: 'can I book?', held_count: 1, dropped_count: 0, unverified_count: 0,
    fixed_reply_state: 'sent', allowed_by: null, project_ids: [], created_at: AS_OF,
    ...over,
  }
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/?channel=line']}>
        <ChannelsSection agentId="a1" agentName="olivia-concierge" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const lineSection = () => screen.getByRole('tabpanel', { name: 'LINE' })

/** Render with one LINE connection and wait for its card. */
async function renderLine(over: Partial<ChannelConnection> = {}) {
  api.listConnections.mockResolvedValue([line(over)])
  const view = renderSection()
  await screen.findByTestId('line-bot-name')
  return { ...view, section: lineSection() }
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  api.listAllowlist.mockResolvedValue([])
  api.listRequests.mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  useAuthStore.getState().logout()
})

describe('LINE connect', () => {
  it('takes both values in password fields, clears them, keeps them nowhere, then shows name, ···last4 and status', async () => {
    api.listConnections.mockResolvedValueOnce([])
    api.listConnections.mockResolvedValue([line()])
    api.connectLine.mockResolvedValue(line())
    renderSection()
    await screen.findByText(LINE_COPY.connectTitle)
    const section = lineSection()
    const secret = within(section).getByLabelText('Channel secret') as HTMLInputElement
    const token = within(section).getByLabelText('Channel access token') as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(token.type).toBe('password')
    expect(secret.getAttribute('autocomplete')).toBe('off')
    expect(token.getAttribute('autocomplete')).toBe('off')
    expect(within(section).getByText(LINE_COPY.tokenHint)).toBeTruthy()
    const connect = within(section).getByRole('button', { name: 'Connect LINE' }) as HTMLButtonElement
    fireEvent.change(secret, { target: { value: SECRET } })
    expect(connect.disabled).toBe(true)
    fireEvent.change(token, { target: { value: ACCESS_TOKEN } })
    await act(async () => {
      fireEvent.click(connect)
    })
    expect(api.connectLine).toHaveBeenCalledWith('olivia-concierge', SECRET, ACCESS_TOKEN)
    expect(await screen.findByText('Access token ···abcd')).toBeTruthy()
    expect(screen.getByTestId('line-bot-name').textContent).toBe('Olivia Concierge')
    expect(within(lineSection()).getByTestId('channel-status').textContent).toBe('Working')
    for (const value of [SECRET, ACCESS_TOKEN, ACCESS_TOKEN.slice(0, 30)]) {
      expect(document.body.innerHTML).not.toContain(value)
      expect(JSON.stringify({ ...localStorage })).not.toContain(value)
      expect(JSON.stringify({ ...sessionStorage })).not.toContain(value)
      expect(window.location.href).not.toContain(value)
    }
    // The channel secret is never shown, not even its last four.
    expect(document.body.innerHTML).not.toContain(SECRET.slice(-4))
  })

  it('shows the server reason, with both fields cleared', async () => {
    api.listConnections.mockResolvedValue([])
    api.connectLine.mockRejectedValue(new ApiError(400, 'LINE rejected the channel access token.'))
    renderSection()
    await screen.findByText(LINE_COPY.connectTitle)
    const section = lineSection()
    fireEvent.change(within(section).getByLabelText('Channel secret'), { target: { value: SECRET } })
    fireEvent.change(within(section).getByLabelText('Channel access token'), { target: { value: ACCESS_TOKEN } })
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Connect LINE' }))
    })
    expect(within(section).getByRole('alert').textContent).toBe('LINE rejected the channel access token.')
    expect((within(section).getByLabelText('Channel secret') as HTMLInputElement).value).toBe('')
    expect((within(section).getByLabelText('Channel access token') as HTMLInputElement).value).toBe('')
  })
})

describe('LINE manage', () => {
  it('Test, Disable and Remove call their routes; Remove explains the webhook keeps being called', async () => {
    const { section } = await renderLine()
    api.testConnection.mockResolvedValue(line())
    api.disableConnection.mockResolvedValue(line({ disabled: true, status: 'disabled' }))
    api.removeConnection.mockResolvedValue({ removed: 'l1' })
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Test' }))
    })
    expect(api.testConnection).toHaveBeenCalledWith('l1')

    fireEvent.click(within(section).getByRole('button', { name: 'Disable' }))
    expect(api.disableConnection).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toContain(LINE_COPY.disableTitle)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))
    })
    expect(api.disableConnection).toHaveBeenCalledWith('l1')

    fireEvent.click(within(section).getByRole('button', { name: 'Remove' }))
    expect(api.removeConnection).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(LINE_COPY.removeTitle)
    expect(dialog.textContent).toContain('LINE keeps calling the old webhook URL until you turn off "Use webhook"')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })
    expect(api.removeConnection).toHaveBeenCalledWith('l1')
    expect(within(section).queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })
})

describe('LINE status', () => {
  it.each([
    ['token_rejected', 'LINE rejected the channel access token — issue a new long-lived token in the LINE Developers console'],
    ['webhook_missing', 'turn on "Use webhook" in the LINE Developers console (Messaging API tab), then press Test'],
    ['signature_mismatch', "The channel secret doesn't match — LINE's calls fail the signature check. Remove this connection and connect again with the right channel secret"],
    ['quota_exhausted', "This month's push-message limit is reached — answers can't be sent until next month or until the plan is raised"],
    ['push_not_allowed', "LINE doesn't allow this channel to send push messages"],
    ['webhook_error', "LINE's test call to this server's webhook got an error"],
    ['disabled', 'Disabled'],
    ['working', 'Working'],
  ])('%s reads its own sentence', async (code, sentence) => {
    const { section } = await renderLine({ status: code, status_count: code === 'webhook_error' ? 502 : null })
    expect(within(section).getByTestId('channel-status').textContent).toContain(sentence)
  })

  it('webhook_error says which HTTP status this server answered', async () => {
    const { section } = await renderLine({ status: 'webhook_error', status_count: 502 })
    expect(within(section).getByTestId('line-webhook-error').textContent).toBe(LINE_COPY.webhookErrorHttp(502))
    expect(within(section).getByTestId('line-webhook-error').textContent).toContain('HTTP 502')
  })

  it('every LINE code reads distinctly, and differently from Telegram where the remedy differs', () => {
    const codes = ['working', 'token_rejected', 'webhook_missing', 'webhook_error', 'signature_mismatch',
      'quota_exhausted', 'push_not_allowed', 'disabled', 'key_rotation_pending']
    const labels = codes.map((c) => statusView(c, LINE).label)
    expect(new Set(labels).size).toBe(codes.length)
    for (const c of ['token_rejected', 'webhook_missing', 'webhook_error']) {
      expect(statusView(c, LINE).label).not.toBe(statusView(c).label)
    }
    // Reconnect points LINE's webhook at this server again; LINE's own test
    // call failing is this server's answer, which reconnecting doesn't change.
    expect(statusView('webhook_error', LINE).reconnect).toBe(false)
    expect(statusView('signature_mismatch', LINE).reconnect).toBe(false)
  })

  it.each(['key_rotation_pending', 'webhook_missing'])('%s offers Reconnect', async (code) => {
    api.reconnectConnection.mockResolvedValue(line())
    const { section } = await renderLine({ status: code })
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Reconnect' }))
    })
    expect(api.reconnectConnection).toHaveBeenCalledWith('l1')
  })
})

describe('LINE signature check', () => {
  it('says every call failed when none was ever verified', async () => {
    const { section } = await renderLine({ unverified_calls: 4, last_inbound_at: null })
    expect(within(section).getByTestId('line-unverified').textContent).toBe(LINE_COPY.allFailedSignature)
  })

  it('counts the failed calls since the last good one otherwise, and says nothing at 0', async () => {
    const { section } = await renderLine({ unverified_calls: 2, last_inbound_at: AS_OF })
    expect(within(section).getByTestId('line-unverified').textContent).toBe(LINE_COPY.someFailedSignature(2))
    cleanup()
    const again = await renderLine({ unverified_calls: 0, last_inbound_at: null })
    expect(within(again.section).queryByTestId('line-unverified')).toBeNull()
  })

  it('shows 1,000+ once the server stops counting', async () => {
    expect(UNVERIFIED_CALLS_CAP).toBe(1000)
    const { section } = await renderLine({ unverified_calls: 1000, last_inbound_at: AS_OF })
    expect(within(section).getByTestId('line-unverified').textContent).toBe(
      "1,000+ calls from LINE since the last good one failed the signature check.",
    )
    expect(LINE_COPY.someFailedSignature(999)).toBe(
      '999 calls from LINE since the last good one failed the signature check.',
    )
  })
})

describe('push meter', () => {
  it(`warns from ${PUSH_WARN_PERCENT}% inclusive and is reached at the limit (159 / 160 / 200 of 200)`, () => {
    expect(PUSH_WARN_PERCENT).toBe(80)
    const at = (used: number) => pushMeter({ push_used: used, push_limit: 200, push_as_of: AS_OF, status: 'working' })
    expect(at(159).level).toBe('ok')
    expect(at(159).percent).toBe(79)
    expect(at(160).level).toBe('warn')
    expect(at(160).percent).toBe(80)
    expect(at(200).level).toBe('reached')
    expect(pushMeter({ push_used: 50, push_limit: 200, push_as_of: AS_OF, status: 'quota_exhausted' }).level).toBe('reached')
    expect(pushMeter({ push_used: 50, push_limit: null, push_as_of: AS_OF, status: 'working' }).level).toBe('no_limit')
    expect(pushMeter({ push_used: null, push_limit: null, push_as_of: null, status: 'working' }).level).toBe('unchecked')
  })

  it('79%: shows the figures and no banner', async () => {
    const { section } = await renderLine({ push_used: 158, push_limit: 200 })
    expect(within(section).getByTestId('push-line').textContent).toMatch(
      /^158 of 200 push messages used this month \(as of .+\)$/,
    )
    expect(within(section).getByTestId('push-meter').textContent).toContain('79%')
    expect(within(section).queryByTestId('push-banner')).toBeNull()
    expect(within(section).queryByTestId('push-reached')).toBeNull()
  })

  it('80% (160 of 200): shows the banner', async () => {
    const { section } = await renderLine({ push_used: 160, push_limit: 200 })
    expect(within(section).getByTestId('push-banner').textContent).toBe(LINE_COPY.pushBanner(80))
    expect(within(section).getByTestId('push-line').textContent).toContain('160 of 200 push messages used this month')
    expect(within(section).queryByTestId('push-reached')).toBeNull()
  })

  it('100%: shows the limit-reached state instead of the banner', async () => {
    const { section } = await renderLine({ push_used: 200, push_limit: 200 })
    expect(within(section).getByTestId('push-reached').textContent).toBe(LINE_COPY.pushReached)
    expect(within(section).queryByTestId('push-banner')).toBeNull()
  })

  it("LINE's monthly-limit flag shows the reached state whatever the health status says", async () => {
    const { section } = await renderLine({
      push_used: 100, push_limit: 200, status: 'webhook_missing', push_limit_reached: true,
    })
    expect(within(section).getByTestId('push-reached')).toBeTruthy()
    expect(within(section).queryByTestId('push-banner')).toBeNull()
  })

  it('quota_exhausted shows the reached state even when the figures say 50%', async () => {
    const { section } = await renderLine({ push_used: 100, push_limit: 200, status: 'quota_exhausted' })
    expect(within(section).getByTestId('push-reached')).toBeTruthy()
    expect(within(section).queryByTestId('push-banner')).toBeNull()
  })

  it('no limit set: says so, with no percentage and no banner', async () => {
    const { section } = await renderLine({ push_used: 1234, push_limit: null })
    const meter = within(section).getByTestId('push-meter')
    expect(meter.textContent).toContain(LINE_COPY.pushNoLimit)
    expect(meter.textContent).toContain('1234 push messages used this month (as of ')
    expect(meter.textContent).not.toContain('%')
    expect(within(section).queryByRole('meter')).toBeNull()
    expect(within(section).queryByTestId('push-banner')).toBeNull()
    expect(within(section).queryByTestId('push-reached')).toBeNull()
  })

  it('never fetched: "Not checked yet — press Test", no banner', async () => {
    const { section } = await renderLine({ push_used: null, push_limit: null, push_as_of: null })
    expect(within(section).getByTestId('push-line').textContent).toBe(LINE_COPY.pushUnchecked)
    expect(within(section).getByTestId('push-meter').textContent).not.toContain('%')
    expect(within(section).queryByTestId('push-banner')).toBeNull()
    expect(within(section).queryByTestId('push-reached')).toBeNull()
  })
})

describe('LINE replies', () => {
  it('edits the acknowledgement and saves it, including empty for none', async () => {
    api.setAckText.mockResolvedValue(line({ ack_text: '' }))
    const { section } = await renderLine()
    const field = within(section).getByLabelText(LINE_COPY.ackTitle) as HTMLTextAreaElement
    expect(field.value).toBe(DEFAULT_ACK)
    expect(field.maxLength).toBe(1000)
    const save = within(section).getByRole('button', { name: 'Save acknowledgement' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'Thanks — on it.' } })
    await act(async () => {
      fireEvent.click(save)
    })
    expect(api.setAckText).toHaveBeenLastCalledWith('l1', 'Thanks — on it.')
    fireEvent.change(field, { target: { value: '' } })
    await act(async () => {
      fireEvent.click(save)
    })
    expect(api.setAckText).toHaveBeenLastCalledWith('l1', '')
  })

  it('the reply to people waiting notes that each new request uses a push message', async () => {
    const { section } = await renderLine()
    expect(within(section).getByLabelText('Reply to people waiting')).toBeTruthy()
    expect(within(section).getByText(LINE_COPY.fixedReplyNote)).toBeTruthy()
    // Telegram's card doesn't carry the note.
    cleanup()
    api.listConnections.mockResolvedValue([line({ channel: 'telegram', id: 'c1', account_name: '@bot' })])
    renderSection()
    fireEvent.click(await screen.findByRole('tab', { name: /^Telegram/ }))
    await screen.findByText('@bot')
    expect(screen.queryByText(LINE_COPY.fixedReplyNote)).toBeNull()
  })
})

describe('LINE allowlist, requests and "anyone"', () => {
  it('has no free-text allowlist input; admission is through Requests', async () => {
    api.listAllowlist.mockResolvedValue([{ id: 'e1', kind: 'user_id', value: 'U' + 'b'.repeat(32), pinned_to: null }])
    api.listRequests.mockResolvedValue([request()])
    api.allowRequest.mockResolvedValue(request({ state: 'allowed', project_ids: ['p9'] }))
    const { section } = await renderLine()
    expect(within(section).getByText(LINE_COPY.allowlistHelp)).toBeTruthy()
    expect(within(section).queryByLabelText('Add to allowlist')).toBeNull()
    expect(within(section).queryByRole('button', { name: 'Add' })).toBeNull()
    expect(await within(section).findByText('U' + 'b'.repeat(32))).toBeTruthy()
    expect(within(section).getByRole('button', { name: `Remove ${'U' + 'b'.repeat(32)}` })).toBeTruthy()
    const item = await within(section).findByTestId('channel-request')
    await act(async () => {
      fireEvent.click(within(item).getByRole('button', { name: 'Allow' }))
    })
    expect(api.allowRequest).toHaveBeenCalledWith('l1', 'r1')
  })

  it('the "anyone" banner and confirmation add that strangers use push quota', async () => {
    api.setConnectionMode.mockResolvedValue(line({ mode: 'anyone', warning: 'strangers_reach_full_tools' }))
    const { section } = await renderLine()
    fireEvent.click(within(section).getByLabelText(/Anyone\./))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(COPY.anyoneBody)
    expect(dialog.textContent).toContain(LINE_COPY.anyoneExtra)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    cleanup()
    const again = await renderLine({ mode: 'anyone', warning: 'strangers_reach_full_tools' })
    expect(within(again.section).getByText(`${COPY.anyoneBanner} ${LINE_COPY.anyoneExtra}`)).toBeTruthy()
  })
})

describe('LINE setup notes', () => {
  it('tells the owner to turn off auto-reply/greeting and group chats', async () => {
    const { section } = await renderLine()
    const notes = within(section).getByTestId('line-setup-notes')
    expect(notes.textContent).toContain(LINE_COPY.setupAutoReply)
    expect(notes.textContent).toContain('turn OFF auto-reply messages and greeting messages')
    expect(notes.textContent).toContain(LINE_COPY.setupGroups)
    expect(notes.textContent).toContain('Allow bot to join group chats')
  })
})

describe('LINE text from outside is text', () => {
  it('bot name, a contact display name and request text never become markup', async () => {
    api.listRequests.mockResolvedValue([request({ display_name: XSS, first_message: XSS })])
    const { container, section } = await renderLine({ account_name: XSS })
    const item = await within(section).findByTestId('channel-request')
    expect(screen.getByTestId('line-bot-name').textContent).toBe(XSS)
    expect(within(item).getByText(XSS, { selector: 'p.font-bold' })).toBeTruthy()
    expect(within(item).getByTestId('request-first-message').textContent).toBe(XSS)
    expect(container.querySelector('img')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../../stores/authStore'
import { makeSession, seedSessions } from '../../../test/authFixtures'
import { ApiError } from '../../../api/client'
import type { ChannelConnection, ChannelRequest } from '../../../api/endpoints/channels'
import ChannelsSection, { COPY, statusView } from './ChannelsSection'
import { VERIFY_TOKEN_MIN, WHATSAPP, WHATSAPP_COPY } from './WhatsAppChannelCard'

// Not about the hub: an older server without /api/hub/config.
vi.mock('../../../api/endpoints/hub', async (orig) =>
  (await import('../../../test/hubFixtures')).withoutHubConfig(await orig<object>()))

/**
 * Agent Settings → Channels → WhatsApp. The API is mocked the same way as in
 * ChannelsSection.test.tsx; the whole section is rendered so the WhatsApp card
 * is tested where it lives, beside Telegram, email and LINE.
 */

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  connectTelegram: vi.fn(),
  connectEmail: vi.fn(),
  connectLine: vi.fn(),
  connectWhatsApp: vi.fn(),
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
// Only the real connectWhatsApp (above, via importActual) reaches `post`.
const client = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/client')>()),
  post: (...a: unknown[]) => client.post(...a),
}))

const PHONE_NUMBER_ID = '106540352242922'
const ACCESS_TOKEN = 'EAAG' + 'Z'.repeat(180) + 'wxyz'
const APP_SECRET = '3f9b2c71e8d04a65b1c7d2e9f0a8b6c4'
const VERIFY_TOKEN = 'olive-tree-harbor-7741'
const AS_OF = 1_760_000_000
const XSS = '<img src=x onerror=alert(1)>'

function whatsapp(over: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    id: 'w1', agent_id: 'a1', channel: 'whatsapp', label: '', secret_last4: 'wxyz',
    webhook_url: 'https://x/api/channels/webhooks/whatsapp/w1', mode: 'allowlist',
    fixed_reply: '', warning: null, account_name: 'Olivia Concierge (+1 415-555-0100)', disabled: false,
    status: 'working', status_detail: null, status_count: null, status_at: AS_OF,
    last_inbound_at: null, ack_text: null, push_used: null, push_limit: null, push_as_of: null,
    unverified_calls: 0, phone_number_id: PHONE_NUMBER_ID, verify_token_last4: '7741',
    handshake_ok_at: null, held_window_7d: 0,
    ...over,
  }
}

function request(over: Partial<ChannelRequest> = {}): ChannelRequest {
  return {
    id: 'r1', state: 'pending', display_name: 'Sam', user_key: '14155550123', handle: null,
    first_message: 'can I book?', held_count: 1, dropped_count: 0, unverified_count: 0,
    fixed_reply_state: 'sent', allowed_by: null, project_ids: [], created_at: AS_OF,
    ...over,
  }
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/?channel=whatsapp']}>
        <ChannelsSection agentId="a1" agentName="olivia-concierge" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const waSection = () => screen.getByRole('tabpanel', { name: 'WhatsApp' })

/** Render with one WhatsApp connection and wait for its card. */
async function renderWhatsApp(over: Partial<ChannelConnection> = {}) {
  api.listConnections.mockResolvedValue([whatsapp(over)])
  const view = renderSection()
  await screen.findByTestId('whatsapp-account-name')
  return { ...view, section: waSection() }
}

/** Type all four connect values into the form inside `section`. */
function fillConnect(section: HTMLElement) {
  fireEvent.change(within(section).getByLabelText('Phone number ID'), { target: { value: PHONE_NUMBER_ID } })
  fireEvent.change(within(section).getByLabelText('Access token'), { target: { value: ACCESS_TOKEN } })
  fireEvent.change(within(section).getByLabelText('App secret'), { target: { value: APP_SECRET } })
  fireEvent.change(within(section).getByLabelText('Verify token'), { target: { value: VERIFY_TOKEN } })
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

describe('WhatsApp connect', () => {
  it('takes the three secrets in password fields, sends the exact body, keeps them nowhere, then shows who the number is', async () => {
    api.listConnections.mockResolvedValueOnce([])
    api.listConnections.mockResolvedValue([whatsapp()])
    api.connectWhatsApp.mockResolvedValue(whatsapp())
    renderSection()
    await screen.findByText(WHATSAPP_COPY.connectTitle)
    const section = waSection()
    const phone = within(section).getByLabelText('Phone number ID') as HTMLInputElement
    expect(phone.type).toBe('text')
    expect(phone.inputMode).toBe('numeric')
    for (const label of ['Access token', 'App secret', 'Verify token']) {
      const input = within(section).getByLabelText(label) as HTMLInputElement
      expect(input.type).toBe('password')
      expect(input.getAttribute('autocomplete')).toBe('off')
    }
    expect(within(section).getByText(WHATSAPP_COPY.tokenHint)).toBeTruthy()
    const connect = within(section).getByRole('button', { name: 'Connect WhatsApp' }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    fillConnect(section)
    expect(connect.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(connect)
    })
    expect(api.connectWhatsApp).toHaveBeenCalledWith(
      'olivia-concierge', PHONE_NUMBER_ID, ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN,
    )
    expect(await screen.findByText('Access token …wxyz')).toBeTruthy()
    expect(screen.getByText('Verify token …7741')).toBeTruthy()
    expect(screen.getByTestId('whatsapp-account-name').textContent).toBe('Olivia Concierge (+1 415-555-0100)')
    expect(screen.getByTestId('whatsapp-phone-number-id').textContent).toBe(`Phone number ID ${PHONE_NUMBER_ID}`)
    expect(within(waSection()).getByTestId('channel-status').textContent).toBe('Working')
    for (const value of [APP_SECRET, ACCESS_TOKEN, VERIFY_TOKEN, ACCESS_TOKEN.slice(0, 30)]) {
      expect(document.body.innerHTML).not.toContain(value)
      expect(JSON.stringify({ ...localStorage })).not.toContain(value)
      expect(JSON.stringify({ ...sessionStorage })).not.toContain(value)
      expect(window.location.href).not.toContain(value)
    }
    // The app secret is never shown, not even its last four.
    expect(document.body.innerHTML).not.toContain(APP_SECRET.slice(-4))
  })

  it('connectWhatsApp posts exactly the contract body', async () => {
    const actual = await vi.importActual<typeof import('../../../api/endpoints/channels')>(
      '../../../api/endpoints/channels',
    )
    client.post.mockResolvedValue(whatsapp())
    await actual.connectWhatsApp('olivia-concierge', PHONE_NUMBER_ID, ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN)
    expect(client.post).toHaveBeenCalledWith('/me/channels/connections', {
      agent_name: 'olivia-concierge',
      channel: 'whatsapp',
      phone_number_id: PHONE_NUMBER_ID,
      access_token: ACCESS_TOKEN,
      app_secret: APP_SECRET,
      verify_token: VERIFY_TOKEN,
    })
  })

  it('clears the typed secrets from the inputs after a successful connect', async () => {
    api.listConnections.mockResolvedValue([])
    api.connectWhatsApp.mockResolvedValue(whatsapp())
    renderSection()
    await screen.findByText(WHATSAPP_COPY.connectTitle)
    const section = waSection()
    fillConnect(section)
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Connect WhatsApp' }))
    })
    expect(api.connectWhatsApp).toHaveBeenCalledTimes(1)
    for (const label of ['Phone number ID', 'Access token', 'App secret', 'Verify token']) {
      expect((within(section).getByLabelText(label) as HTMLInputElement).value).toBe('')
    }
    expect(document.body.innerHTML).not.toContain(APP_SECRET)
  })

  it('shows the server reason as text, with the secrets cleared', async () => {
    api.listConnections.mockResolvedValue([])
    api.connectWhatsApp.mockRejectedValue(new ApiError(400, 'Meta rejected the access token.'))
    renderSection()
    await screen.findByText(WHATSAPP_COPY.connectTitle)
    const section = waSection()
    fillConnect(section)
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Connect WhatsApp' }))
    })
    expect(within(section).getByRole('alert').textContent).toBe('Meta rejected the access token.')
    expect((within(section).getByLabelText('Access token') as HTMLInputElement).value).toBe('')
    expect((within(section).getByLabelText('App secret') as HTMLInputElement).value).toBe('')
    expect((within(section).getByLabelText('Verify token') as HTMLInputElement).value).toBe('')
  })

  it(`hints at ${VERIFY_TOKEN_MIN}+ characters for the verify token but lets the server decide`, async () => {
    api.listConnections.mockResolvedValue([])
    api.connectWhatsApp.mockRejectedValue(new ApiError(400, 'The verify token must be at least 16 characters.'))
    renderSection()
    await screen.findByText(WHATSAPP_COPY.connectTitle)
    const section = waSection()
    const hint = within(section).getByTestId('whatsapp-verify-hint')
    expect(hint.textContent).toBe(WHATSAPP_COPY.verifyTokenHint)
    expect(hint.textContent).toContain('At least 16 characters')
    fillConnect(section)
    fireEvent.change(within(section).getByLabelText('Verify token'), { target: { value: 'short' } })
    expect(hint.className).toContain('text-amber-700')
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Connect WhatsApp' }))
    })
    expect(api.connectWhatsApp).toHaveBeenCalledWith(
      'olivia-concierge', PHONE_NUMBER_ID, ACCESS_TOKEN, APP_SECRET, 'short',
    )
    expect(within(section).getByRole('alert').textContent).toBe('The verify token must be at least 16 characters.')
  })
})

describe('WhatsApp connected', () => {
  it('never shows the app secret: no field for it, only the two tokens\' last four', async () => {
    const { section } = await renderWhatsApp()
    expect(within(section).queryByText(/app secret …/i)).toBeNull()
    expect(within(section).queryByLabelText('App secret')).toBeNull()
    expect(within(section).getByText('Access token …wxyz')).toBeTruthy()
    expect(within(section).getByText('Verify token …7741')).toBeTruthy()
  })

  it('shows the callback URL with a copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { section } = await renderWhatsApp()
    expect(within(section).getByTestId('whatsapp-callback-url').textContent).toBe(
      'https://x/api/channels/webhooks/whatsapp/w1',
    )
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Copy https://x/api/channels/webhooks/whatsapp/w1' }))
    })
    expect(writeText).toHaveBeenCalledWith('https://x/api/channels/webhooks/whatsapp/w1')
  })

  it('shows the last message received and the last successful subscription check', async () => {
    const { section } = await renderWhatsApp()
    expect(within(section).getByTestId('whatsapp-last-inbound').textContent).toBe(WHATSAPP_COPY.noInbound)
    expect(within(section).getByTestId('whatsapp-handshake').textContent).toBe(WHATSAPP_COPY.noHandshake)
    cleanup()
    const again = await renderWhatsApp({ last_inbound_at: AS_OF, handshake_ok_at: AS_OF })
    expect(within(again.section).getByTestId('whatsapp-last-inbound').textContent).toBe(WHATSAPP_COPY.lastInbound(AS_OF))
    expect(within(again.section).getByTestId('whatsapp-handshake').textContent).toBe(WHATSAPP_COPY.handshakeOk(AS_OF))
  })
})

describe('WhatsApp manage', () => {
  it('Test, Disable, Enable and Remove call their routes; Remove says to remove the callback URL too', async () => {
    const { section } = await renderWhatsApp()
    api.testConnection.mockResolvedValue(whatsapp())
    api.disableConnection.mockResolvedValue(whatsapp({ disabled: true, status: 'disabled' }))
    api.removeConnection.mockResolvedValue({ removed: 'w1' })
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Test' }))
    })
    expect(api.testConnection).toHaveBeenCalledWith('w1')

    fireEvent.click(within(section).getByRole('button', { name: 'Disable' }))
    expect(api.disableConnection).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').textContent).toContain(WHATSAPP_COPY.disableTitle)
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))
    })
    expect(api.disableConnection).toHaveBeenCalledWith('w1')

    fireEvent.click(within(section).getByRole('button', { name: 'Remove' }))
    expect(api.removeConnection).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(WHATSAPP_COPY.removeTitle)
    expect(dialog.textContent).toContain("we can't remove it for you")
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    })
    expect(api.removeConnection).toHaveBeenCalledWith('w1')
    expect(within(section).queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })

  it('a disabled connection offers Enable', async () => {
    api.enableConnection.mockResolvedValue(whatsapp())
    const { section } = await renderWhatsApp({ disabled: true, status: 'disabled' })
    expect(within(section).getByTestId('channel-status').textContent).toBe('Disabled')
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Enable' }))
    })
    expect(api.enableConnection).toHaveBeenCalledWith('w1')
  })
})

describe('WhatsApp status', () => {
  it.each([
    ['working', 'Working'],
    ['disabled', 'Disabled'],
    ['token_rejected', 'Meta rejected the access token'],
    ['permission_denied', 'whatsapp_business_messaging permission and assign it to this phone number'],
    ['number_not_registered', "This phone number isn't registered with the WhatsApp Cloud API"],
    ['number_unreachable', "This access token can't reach the phone number ID — check the number is still in your WhatsApp Business Account"],
    ['payment_issue', "There's a problem with the payment method on the WhatsApp Business Account"],
    ['account_restricted', 'Meta has restricted this WhatsApp Business Account (a policy or spam limit)'],
    ['signature_mismatch', "Webhook calls don't match your app secret"],
    ['no_webhook_yet', 'No webhook received from Meta yet — paste the callback URL and verify token in your Meta app and subscribe the messages field'],
    ['key_rotation_pending', "This server's callback URL changed — paste the callback URL above into your Meta app again"],
  ])('%s reads its own sentence', async (code, sentence) => {
    const { section } = await renderWhatsApp({ status: code })
    const status = within(section).getByTestId('channel-status').textContent ?? ''
    expect(status).toContain(sentence)
    expect(status).toBe(statusView(code, WHATSAPP).label)
  })

  it('an unknown code reads "Status unknown", as on the other cards', async () => {
    const { section } = await renderWhatsApp({ status: 'something_new' })
    expect(within(section).getByTestId('channel-status').textContent).toBe('Status unknown')
  })

  it('every WhatsApp code reads distinctly, and none offers Reconnect', () => {
    const codes = ['working', 'disabled', 'token_rejected', 'permission_denied', 'number_not_registered',
      'number_unreachable', 'payment_issue', 'account_restricted', 'signature_mismatch', 'no_webhook_yet', 'key_rotation_pending']
    const labels = codes.map((c) => statusView(c, WHATSAPP).label)
    expect(new Set(labels).size).toBe(codes.length)
    for (const c of codes) expect(statusView(c, WHATSAPP).reconnect).toBe(false)
  })
})

describe('WhatsApp signature check', () => {
  it('says the calls don\'t match the app secret when none was ever verified', async () => {
    const { section } = await renderWhatsApp({ unverified_calls: 3, last_inbound_at: null })
    expect(within(section).getByTestId('whatsapp-unverified').textContent).toBe(WHATSAPP_COPY.allFailedSignature)
    expect(within(section).getByTestId('whatsapp-unverified').textContent).toContain("didn't match your app secret")
  })

  it('counts the failed calls since the last good one otherwise, and says nothing at 0', async () => {
    const { section } = await renderWhatsApp({ unverified_calls: 2, last_inbound_at: AS_OF })
    expect(within(section).getByTestId('whatsapp-unverified').textContent).toBe(
      "2 calls from Meta since the last good one didn't match your app secret.",
    )
    cleanup()
    const again = await renderWhatsApp({ unverified_calls: 0 })
    expect(within(again.section).queryByTestId('whatsapp-unverified')).toBeNull()
  })
})

describe('WhatsApp 24-hour window', () => {
  it('is hidden at 0 and when absent', async () => {
    const { section } = await renderWhatsApp({ held_window_7d: 0 })
    expect(within(section).queryByTestId('whatsapp-held-window')).toBeNull()
    cleanup()
    const again = await renderWhatsApp({ held_window_7d: null })
    expect(within(again.section).queryByTestId('whatsapp-held-window')).toBeNull()
  })

  it('reads singular at 1', async () => {
    const { section } = await renderWhatsApp({ held_window_7d: 1 })
    expect(within(section).getByTestId('whatsapp-held-window').textContent).toBe(
      '1 reply held in the last 7 days because the 24-hour window had closed',
    )
  })

  it('reads plural at N, with no names or numbers', async () => {
    const { section } = await renderWhatsApp({ held_window_7d: 7 })
    const line = within(section).getByTestId('whatsapp-held-window').textContent
    expect(line).toBe('7 replies held in the last 7 days because the 24-hour window had closed')
    expect(line).not.toContain('Olivia')
    expect(line).not.toContain('415')
  })
})

describe('WhatsApp allowlist, requests and "anyone"', () => {
  it('takes a phone number with country code; the hint points at Requests', async () => {
    api.addAllowlistEntry.mockResolvedValue({ id: 'e1', kind: 'phone', value: '+14155550100', pinned_to: null })
    const { section } = await renderWhatsApp()
    const input = within(section).getByLabelText('phone number with country code') as HTMLInputElement
    expect(input.placeholder).toBe('+1 415 555 0100')
    expect(within(section).getByText(WHATSAPP_COPY.allowlistHelp)).toBeTruthy()
    expect(WHATSAPP_COPY.allowlistHelp).toContain("If someone you added doesn't get through, Allow them from Requests.")
    fireEvent.change(input, { target: { value: '+1 415 555 0100' } })
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Add' }))
    })
    expect(api.addAllowlistEntry).toHaveBeenCalledWith('w1', '+1 415 555 0100')
  })

  it('Allow on a request calls its route', async () => {
    api.listRequests.mockResolvedValue([request()])
    api.allowRequest.mockResolvedValue(request({ state: 'allowed', project_ids: ['p9'] }))
    const { section } = await renderWhatsApp()
    const item = await within(section).findByTestId('channel-request')
    await act(async () => {
      fireEvent.click(within(item).getByRole('button', { name: 'Allow' }))
    })
    expect(api.allowRequest).toHaveBeenCalledWith('w1', 'r1')
  })

  it("the \"anyone\" banner and confirmation add that every stranger's message reaches the agent", async () => {
    const { section } = await renderWhatsApp()
    fireEvent.click(within(section).getByLabelText(/Anyone\./))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(COPY.anyoneBody)
    expect(dialog.textContent).toContain(WHATSAPP_COPY.anyoneExtra)
    expect(WHATSAPP_COPY.anyoneExtra).toContain("every stranger's message reaches the agent")
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    cleanup()
    const again = await renderWhatsApp({ mode: 'anyone', warning: 'strangers_reach_full_tools' })
    expect(within(again.section).getByText(`${COPY.anyoneBanner} ${WHATSAPP_COPY.anyoneExtra}`)).toBeTruthy()
  })
})

describe('WhatsApp setup notes', () => {
  it('names the permanent token, the Meta webhook steps, the test-number limit, the 24-hour window and removing the callback URL', async () => {
    const { section } = await renderWhatsApp()
    const notes = within(section).getByTestId('whatsapp-setup-notes').textContent
    expect(notes).toContain('System User permanent access token')
    expect(notes).toContain('temporary token expires in 24 hours')
    expect(notes).toContain('App Dashboard → WhatsApp → Configuration')
    expect(notes).toContain('paste the callback URL and your verify token')
    expect(notes).toContain('subscribe the messages field')
    expect(notes).toContain('up to 5 recipient numbers you registered')
    expect(notes).toContain('messages to anyone else fail')
    expect(notes).toContain("only reply within 24 hours of the customer's last message")
    expect(notes).toContain('After Remove, also remove the callback URL in the App Dashboard')
    expect(notes).toContain("we can't remove it for you")
  })
})

describe('WhatsApp text from outside is text', () => {
  it('verified name, a contact display name and request text never become markup', async () => {
    api.listRequests.mockResolvedValue([request({ display_name: XSS, first_message: XSS })])
    const { container, section } = await renderWhatsApp({ account_name: XSS })
    const item = await within(section).findByTestId('channel-request')
    expect(screen.getByTestId('whatsapp-account-name').textContent).toBe(XSS)
    expect(within(item).getByText(XSS, { selector: 'p.font-bold' })).toBeTruthy()
    expect(within(item).getByTestId('request-first-message').textContent).toBe(XSS)
    expect(container.querySelector('img')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
})

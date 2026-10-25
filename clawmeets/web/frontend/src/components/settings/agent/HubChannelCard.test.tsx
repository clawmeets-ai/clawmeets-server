import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../../api/client'
import type { HubChannel, HubConfig } from '../../../api/endpoints/hub'
import { NOW_S, hubChannel, hubConfig, hubEnrollment } from '../../../test/hubFixtures'
import { replaceHubChannel } from '../../../hooks/useHub'
import HubChannelCard, { ENABLING_PATIENCE_MS } from './HubChannelCard'

/**
 * Settings → Channels → Hub: one render per channel status from the approved
 * state table, the switch rule, the turn-off dialog and its "stop now", and
 * the push replacing the card. The API is mocked at the hub endpoint module.
 */

const api = vi.hoisted(() => ({
  getHubConfig: vi.fn(),
  getHubChannel: vi.fn(),
  enableHubChannel: vi.fn(),
  disableHubChannel: vi.fn(),
  getHubEnrollment: vi.fn(),
  startHubEnrollment: vi.fn(),
  confirmHubEnrollment: vi.fn(),
}))
const agentsApi = vi.hoisted(() => ({ updateAgent: vi.fn() }))
vi.mock('../../../api/endpoints/agents', async (orig) => {
  const real = await orig<typeof import('../../../api/endpoints/agents')>()
  return { ...real, updateAgent: (...a: unknown[]) => agentsApi.updateAgent(...a) }
})
vi.mock('../../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../../api/endpoints/hub')>()
  return {
    ...real,
    getHubConfig: (...a: unknown[]) => api.getHubConfig(...a),
    getHubChannel: (...a: unknown[]) => api.getHubChannel(...a),
    enableHubChannel: (...a: unknown[]) => api.enableHubChannel(...a),
    disableHubChannel: (...a: unknown[]) => api.disableHubChannel(...a),
    getHubEnrollment: (...a: unknown[]) => api.getHubEnrollment(...a),
    startHubEnrollment: (...a: unknown[]) => api.startHubEnrollment(...a),
    confirmHubEnrollment: (...a: unknown[]) => api.confirmHubEnrollment(...a),
  }
})

const AGENT = 'alice-researcher'
const AGENT_ID = 'agent-1'
const hubErr = (status: number, code: string, message = '') =>
  new ApiError(status, code, { detail: { code, message } })

function renderCard(ch: Partial<HubChannel> = {}, cfg: Partial<HubConfig> = {}) {
  api.getHubChannel.mockResolvedValue(hubChannel(ch))
  api.getHubConfig.mockResolvedValue(hubConfig(cfg))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HubChannelCard agentId={AGENT_ID} agentFullName={AGENT} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

const card = () => screen.findByTestId('hub-channel-card')
const status = () => screen.getByTestId('hub-status')
const toggle = () => screen.getByRole('switch', { name: 'List this agent on the ClawMeets Hub' })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW_S * 1000 })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

// ── every status in the design's toggle table ─────────────────────────────

describe('HubChannelCard: one render per status', () => {
  it('off: the offer, the hub URL, and a clickable switch', async () => {
    renderCard({}, { deployment_name: 'acme.dev' })
    await card()
    expect(status().textContent).toContain(`Turning this on shares ${AGENT}@acme.dev`)
    expect(screen.getByTestId('hub-url').textContent).toBe('Hub: https://hub.clawmeets.ai')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(toggle().getAttribute('aria-disabled')).toBe('false')
  })

  it('enabling: asks the hub, then offers Check again after two minutes', async () => {
    renderCard({ enabled: true, status: 'enabling' })
    await card()
    expect(status().textContent).toContain('Asking the hub to list this agent…')
    expect(screen.queryByText('Still waiting for the hub')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(ENABLING_PATIENCE_MS + 10_000) })
    expect(screen.getByText('Still waiting for the hub')).toBeTruthy()
    const calls = api.getHubChannel.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(api.getHubChannel.mock.calls.length).toBeGreaterThan(calls))
  })

  it('connected: listed as, last contact, only the key\'s last four, and the read-only run line', async () => {
    renderCard({
      enabled: true, status: 'connected', listed_as: `${AGENT}@acme.dev`, key_last4: '9f2c',
      last_success_at: NOW_S - 120, runs_today: 37,
    })
    await card()
    expect(status().textContent).toContain(`Listed as ${AGENT}@acme.dev`)
    expect(status().textContent).toContain('Last contact 2 min ago · Key ····9f2c')
    expect(status().textContent).toContain('Runs started by hub messages today: 37 / 200 (read-only)')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    // The run cap is read-only; the one number input is the dispatch cap.
    expect(screen.queryAllByRole('spinbutton').map((el) => el.id)).toEqual(['hub-dispatch-cap'])
  })

  it('connected at the daily cap: the chip and when it resets', async () => {
    renderCard({ enabled: true, status: 'connected', runs_today: 200, runs_reset_at: NOW_S + 3600 })
    await card()
    expect(status().textContent).toContain('Daily limit reached. New hub messages are refused until ')
    expect(within(status()).getAllByText('Daily limit reached')).toHaveLength(1)
  })

  it('hub unreachable: last success and next try', async () => {
    renderCard({ enabled: true, status: 'hub_unreachable', last_success_at: NOW_S - 600, next_retry_at: NOW_S + 60 })
    await card()
    expect(status().textContent).toContain("Can't reach the hub — retrying")
    expect(status().textContent).toMatch(/Last success .* · next try /)
  })

  it('key revoked: Turn off and on again turns off, then on', async () => {
    renderCard({ enabled: true, status: 'key_revoked' })
    api.disableHubChannel.mockResolvedValue(hubChannel())
    api.enableHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'enabling' }))
    await card()
    expect(status().textContent).toContain("This agent's hub key was revoked")
    fireEvent.click(screen.getByRole('button', { name: 'Turn off and on again' }))
    await waitFor(() => expect(api.enableHubChannel).toHaveBeenCalledTimes(1))
    expect(api.disableHubChannel).toHaveBeenCalledWith(AGENT, false)
    expect(api.disableHubChannel.mock.invocationCallOrder[0]).toBeLessThan(api.enableHubChannel.mock.invocationCallOrder[0])
  })

  it('key rotation pending: Reconnect calls enable with a fresh request id', async () => {
    renderCard({ enabled: true, status: 'key_rotation_pending', rotate_by: NOW_S + 86400, key_last4: '9f2c' })
    api.enableHubChannel.mockResolvedValue(hubChannel({ enabled: true, status: 'enabling' }))
    await card()
    expect(status().textContent).toContain('Automatic key renewal failed — reconnect')
    expect(status().textContent).toMatch(/Current key expires .* · Key ····9f2c/)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(api.enableHubChannel).toHaveBeenCalledTimes(1))
    expect(api.enableHubChannel.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('hub cannot reach this deployment: the hub\'s words quoted as text, never markup', async () => {
    renderCard({ enabled: true, status: 'hub_cannot_reach_deployment', status_detail: '<img src=x onerror=alert(1)> bad sig' })
    await card()
    expect(status().textContent).toContain("The hub couldn't confirm this server")
    expect(screen.getByTestId('hub-said').textContent).toBe('Hub said: <img src=x onerror=alert(1)> bad sig')
    expect(document.querySelector('img')).toBeNull()
  })

  it.each([
    ['name_conflict', 'Another agent already uses this name on the hub', true],
    ['deployment_suspended', 'The hub has suspended this server', false],
    ['over_quota', 'This server has listed as many agents as the hub allows', true],
    ['client_too_old', 'This server is too old for the hub', false],
    ['invalid_listing', "The hub refused this agent's listing details", true],
    ['invalid_name', "This agent's name can't be used on the hub", true],
    ['delisted_by_hub', "The hub's moderators removed this listing", false],
    ['something_new', 'The hub refused this listing', false],
  ])('rejected (%s): its sentence, the quoted reason, and Turn off and on again only when it can help',
    async (reason, title, retry) => {
      renderCard({ enabled: true, status: 'rejected', reject_reason: reason, status_detail: 'description too long' })
      await card()
      expect(status().textContent).toContain(title)
      expect(screen.getByTestId('hub-said').textContent).toBe('Hub said: description too long')
      expect(screen.queryByRole('button', { name: 'Turn off and on again' }) !== null).toBe(retry)
      expect(toggle().getAttribute('aria-disabled')).toBe('false')
    })

  it('hub off on this server: turning on is disabled', async () => {
    renderCard({ status: 'hub_off_on_server' }, { mode: 'off' })
    await card()
    expect(status().textContent).toContain('Sharing is turned off on this server.')
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(toggle())
    expect(api.enableHubChannel).not.toHaveBeenCalled()
  })

  it('hub off but the channel still on: the switch opens the turn-off dialog', async () => {
    renderCard({ enabled: true, status: 'hub_off_on_server' }, { mode: 'off', registration: 'none' })
    await card()
    fireEvent.click(toggle())
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
  })

  it('agent not public: the reason, Make public, and a disabled switch', async () => {
    renderCard({ status: 'agent_not_public', eligible: false, ineligible_reason: 'agent_not_public' })
    await card()
    expect(status().textContent).toContain('Only public agents can be listed. Make this agent public, then turn on the switch.')
    expect(status().textContent).not.toContain('agent_not_public')
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(toggle())
    expect(api.enableHubChannel).not.toHaveBeenCalled()
    agentsApi.updateAgent.mockResolvedValue({})
    fireEvent.click(screen.getByRole('button', { name: 'Make public' }))
    await waitFor(() =>
      expect(agentsApi.updateAgent).toHaveBeenCalledWith(AGENT_ID, { discoverable_through_registry: true }),
    )
  })

  it('off and public (shared on this server, not listed): says so and offers Make private', async () => {
    renderCard({ status: 'off', public: true })
    await card()
    expect(status().textContent).toContain('Shared on this server but not listed')
    expect(toggle().getAttribute('aria-disabled')).toBe('false')
    agentsApi.updateAgent.mockResolvedValue({})
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }))
    await waitFor(() =>
      expect(agentsApi.updateAgent).toHaveBeenCalledWith(AGENT_ID, { discoverable_through_registry: false }),
    )
  })

  it('agent not public, with the server\'s own reason', async () => {
    renderCard({ eligible: false, ineligible_reason: 'Private agents are never listed.' })
    await card()
    expect(status().textContent).toContain('Private agents are never listed.')
  })

  it('hub untrusted', async () => {
    renderCard({ status: 'hub_untrusted' }, { hub_link: 'untrusted' })
    await card()
    expect(status().textContent).toContain("The hub's identity doesn't match the one saved for this URL")
  })

  it('not registered, and waiting for the email code', async () => {
    renderCard({ status: 'hub_not_registered' }, { registration: 'pending_email' })
    await card()
    expect(status().textContent).toContain("This server isn't registered with the hub yet. Ask its operator.")
    expect(status().textContent).toContain('Registration is waiting for the operator to confirm an email code.')
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
  })

  it('browse-only (discover_only) while listed: the chip, and the switch still turns off', async () => {
    renderCard({ enabled: true, status: 'connected' }, { mode: 'discover_only' })
    await card()
    expect(status().textContent).toContain('Browse-only: not accepting messages')
    expect(within(status()).getByText('browse-only: not accepting messages')).toBeTruthy()
    fireEvent.click(toggle())
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
  })

  it('an unknown status reads "Status unknown" and draws the switch from enabled', async () => {
    renderCard({ enabled: true, status: 'from_the_future' })
    await card()
    expect(status().textContent).toContain('Status unknown')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('a non-default hub carries the warning', async () => {
    renderCard({ hub_url: 'https://hub.example.net', hub_url_is_default: false })
    await card()
    expect(screen.getByTestId('hub-url').textContent).toBe('Hub: https://hub.example.net')
    expect(screen.getByTestId('hub-url-warning').textContent).toContain('other than hub.clawmeets.ai')
  })
})

// ── turning on ────────────────────────────────────────────────────────────

describe('HubChannelCard: turning on', () => {
  it('a double click enables once', async () => {
    let resolve: (c: HubChannel) => void = () => {}
    api.enableHubChannel.mockReturnValue(new Promise<HubChannel>((r) => { resolve = r }))
    renderCard()
    await card()
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    await act(async () => { resolve(hubChannel({ enabled: true, status: 'enabling' })) })
    await waitFor(() => expect(status().textContent).toContain('Asking the hub to list this agent…'))
    expect(api.enableHubChannel).toHaveBeenCalledTimes(1)
  })

  it('a 409 hub_not_registered on enable shows the not-registered card, not an error', async () => {
    api.enableHubChannel.mockRejectedValue(hubErr(409, 'hub_not_registered', 'register first'))
    renderCard()
    await card()
    fireEvent.click(toggle())
    await waitFor(() => expect(status().textContent).toContain("This server isn't registered with the hub yet."))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a refused enable stops standing in for the server once a push says the server has moved on', async () => {
    api.enableHubChannel.mockRejectedValue(hubErr(503, 'hub_untrusted', 'untrusted'))
    // The refetch the refusal triggers still says untrusted; the operator fixes it after.
    const { queryClient } = renderCard({}, { hub_link: 'untrusted' })
    await card()
    fireEvent.click(toggle())
    await waitFor(() => expect(status().textContent).toContain("The hub's identity doesn't match the one saved for this URL"))
    // The operator fixes the hub: the config now says connected, and the push reports off.
    api.getHubConfig.mockResolvedValue(hubConfig())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5)
      await queryClient.invalidateQueries({ queryKey: ['hub-config'] })
      replaceHubChannel(queryClient, AGENT, hubChannel())
    })
    await waitFor(() => expect(status().textContent).toContain('Turning this on shares'))
    expect(status().textContent).not.toContain("identity doesn't match")
  })

  it('a 503 hub_unreachable on enable shows the hub\'s message as text', async () => {
    api.enableHubChannel.mockRejectedValue(hubErr(503, 'hub_unreachable', "Can't reach the hub"))
    renderCard()
    await card()
    fireEvent.click(toggle())
    expect((await screen.findByRole('alert')).textContent).toBe("Can't reach the hub")
  })
})

// ── enrollment ────────────────────────────────────────────────────────────

describe('HubChannelCard: enrollment', () => {
  it('enable -> hub_owner_unverified opens the dialog; once verified the enable is retried with the same request id', async () => {
    api.enableHubChannel
      .mockRejectedValueOnce(hubErr(409, 'hub_owner_unverified', 'verify first'))
      .mockResolvedValueOnce(hubChannel({ enabled: true, status: 'enabling' }))
    api.getHubEnrollment.mockResolvedValue(hubEnrollment({ server: 'none', becomes_contact: true }))
    api.startHubEnrollment.mockResolvedValue(hubEnrollment({ server: 'pending', owner: 'code_sent' }))
    api.confirmHubEnrollment.mockResolvedValue(hubEnrollment({ owner: 'verified' }))
    renderCard({}, { mode: 'auto', registration: 'none' })
    await card()
    fireEvent.click(toggle())

    const dialog = await screen.findByRole('dialog', { name: 'Set up hub access' })
    // The refusal is the dialog, not an error line.
    expect(screen.queryByText('verify first')).toBeNull()
    fireEvent.click(await within(dialog).findByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send code' }))
    fireEvent.change(await within(dialog).findByLabelText('Code'), { target: { value: '123456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(api.enableHubChannel).toHaveBeenCalledTimes(2))
    const [first, second] = api.enableHubChannel.mock.calls
    expect(second[1]).toBe(first[1])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(status().textContent).toContain('Asking the hub to list this agent…'))
  })

  it('mode auto, not registered yet: the plain offer and a clickable switch', async () => {
    renderCard({}, { mode: 'auto', registration: 'none', deployment_name: null })
    await card()
    expect(status().textContent).toContain('Turning this on shares')
    expect(toggle().getAttribute('aria-disabled')).toBe('false')
  })

  it('cancelling the dialog leaves the switch off and shows no error', async () => {
    api.enableHubChannel.mockRejectedValue(hubErr(409, 'hub_owner_unverified', 'verify first'))
    api.getHubEnrollment.mockResolvedValue(hubEnrollment())
    renderCard()
    await card()
    fireEvent.click(toggle())
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.enableHubChannel).toHaveBeenCalledTimes(1)
  })
})

// ── turning off ───────────────────────────────────────────────────────────

describe('HubTurnOffDialog', () => {
  it('names the counts, starts on Cancel, and "Stop sharing" drains', async () => {
    renderCard({ enabled: true, status: 'connected', open_conversations: 3, in_flight_messages: 2 })
    api.disableHubChannel.mockResolvedValue(hubChannel())
    await card()
    fireEvent.click(toggle())
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('heading').textContent).toBe(`Stop sharing ${AGENT}?`)
    expect(dialog.textContent).toContain('Your 3 open conversations with other servers stay in Front Desk as history.')
    expect(dialog.textContent).toContain('2 replies are still on their way')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop sharing' }))
    await waitFor(() => expect(api.disableHubChannel).toHaveBeenCalledWith(AGENT, false))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('"stop now" is offered only with replies in flight, and sends stop_now', async () => {
    renderCard({ enabled: true, status: 'connected', in_flight_messages: 1 })
    api.disableHubChannel.mockResolvedValue(hubChannel())
    await card()
    fireEvent.click(toggle())
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: "Stop sharing and don't send pending replies" }))
    await waitFor(() => expect(api.disableHubChannel).toHaveBeenCalledWith(AGENT, true))
  })

  it('leaves out every sentence with a 0 count, and the stop-now button', async () => {
    renderCard({ enabled: true, status: 'connected', open_conversations: 0, in_flight_messages: 0 })
    await card()
    fireEvent.click(toggle())
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).not.toContain('open conversation')
    expect(dialog.textContent).not.toContain('on their way')
    expect(within(dialog).queryByRole('button', { name: /don't send pending replies/ })).toBeNull()
  })

  it('Cancel and Escape close it without a call', async () => {
    renderCard({ enabled: true, status: 'connected' })
    await card()
    fireEvent.click(toggle())
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(toggle())
    await screen.findByRole('alertdialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.disableHubChannel).not.toHaveBeenCalled()
  })
})

// ── the push ──────────────────────────────────────────────────────────────

describe('HubChannelCard: the hub_channel_status push', () => {
  it('replaces the whole card', async () => {
    const { queryClient } = renderCard({ enabled: true, status: 'enabling' })
    await card()
    act(() => {
      replaceHubChannel(queryClient, AGENT, hubChannel({
        enabled: true, status: 'connected', listed_as: `${AGENT}@acme.dev`, key_last4: 'beef',
      }))
    })
    await waitFor(() => expect(status().textContent).toContain(`Listed as ${AGENT}@acme.dev`))
    expect(status().textContent).not.toContain('Asking the hub')
    expect(status().textContent).toContain('Key ····beef')
  })
})

describe('isolation on the Hub card', () => {
  it('sandboxed: "Conversations are kept apart per requester"', async () => {
    renderCard({ isolation: 'sandboxed' })
    await card()
    expect(screen.getByTestId('channel-kept-apart').textContent).toBe('Conversations are kept apart per requester')
  })

  it('unavailable: the host disclaimer slot instead', async () => {
    renderCard({ isolation: 'unavailable', held_conversations: 0 })
    await card()
    expect(screen.queryByTestId('channel-kept-apart')).toBeNull()
    expect(screen.getByTestId('host-disclaimer')).toBeTruthy()
    expect(screen.queryByTestId('host-disclaimer-held')).toBeNull()
  })
})

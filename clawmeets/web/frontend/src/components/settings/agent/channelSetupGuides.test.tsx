import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../../stores/authStore'
import { makeSession, seedSessions } from '../../../test/authFixtures'
import type { ChannelConnection } from '../../../api/endpoints/channels'
import ChannelsSection from './ChannelsSection'
import { SETUP_GUIDES, SetupGuide } from './channelSetupGuides'
import type { SetupChannel } from './channelSetupGuides'

// Not about the hub: an older server without /api/hub/config.
vi.mock('../../../api/endpoints/hub', async (orig) =>
  (await import('../../../test/hubFixtures')).withoutHubConfig(await orig<object>()))

/**
 * Agent Settings → Channels → "How to set up <channel>": closed until asked
 * for, on every card, and naming only fields the card's form really has.
 */

const api = vi.hoisted(() => ({
  listConnections: vi.fn(),
  listAllowlist: vi.fn(),
  listRequests: vi.fn(),
}))
vi.mock('../../../api/endpoints/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/endpoints/channels')>()
  return {
    ...actual,
    listConnections: () => api.listConnections(),
    listAllowlist: () => api.listAllowlist(),
    listRequests: () => api.listRequests(),
  }
})

function connection(channel: SetupChannel): ChannelConnection {
  return {
    id: `c-${channel}`, agent_id: 'a1', channel, label: '', secret_last4: 'abcd',
    webhook_url: `https://x/api/channels/webhooks/${channel}/c`, mode: 'allowlist',
    fixed_reply: '', warning: null, account_name: channel === 'email' ? 'me.agent@agents.example' : 'Bot',
    disabled: false, status: 'working', status_detail: null, status_count: null, status_at: 1_760_000_000,
    last_inbound_at: null, ack_text: null, push_used: null, push_limit: null, push_as_of: null,
    unverified_calls: 0,
  }
}

function renderSection(channel?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[channel ? `/?channel=${channel}` : '/']}>
        <ChannelsSection agentId="a1" agentName="olivia-concierge" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const SECTION: Record<SetupChannel, string> = {
  telegram: 'Telegram', email: 'Email', line: 'LINE', whatsapp: 'WhatsApp',
}
const CHANNELS = Object.keys(SECTION) as SetupChannel[]

/** What each connect form shows; every guide must name exactly these. */
const FORM: Record<SetupChannel, { fields: string[]; button: string }> = {
  telegram: { fields: ['Bot token'], button: 'Connect' },
  email: { fields: [], button: 'Create email address' },
  line: { fields: ['Channel secret', 'Channel access token'], button: 'Connect LINE' },
  whatsapp: { fields: ['Phone number ID', 'Access token', 'App secret', 'Verify token'], button: 'Connect WhatsApp' },
}

const openTab = (channel: SetupChannel) =>
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${SECTION[channel]}`) }))

const guideIn = (channel: SetupChannel) =>
  within(screen.getByRole('tabpanel', { name: SECTION[channel] })).getByTestId(`setup-guide-${channel}`) as HTMLDetailsElement

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

describe('SetupGuide', () => {
  it('is collapsed by default and opens from its summary', () => {
    render(<SetupGuide title="How to set up Thing" steps={['First', 'Second']} testId="g" />)
    const details = screen.getByTestId('g') as HTMLDetailsElement
    expect(details.tagName).toBe('DETAILS')
    expect(details.open).toBe(false)
    expect(details.hasAttribute('open')).toBe(false)

    fireEvent.click(screen.getByText('How to set up Thing'))
    expect(details.open).toBe(true)
    const steps = within(details).getAllByRole('listitem')
    expect(steps.map((li) => li.textContent)).toEqual(['First', 'Second'])
    expect(steps[0].closest('ol')).not.toBeNull()

    fireEvent.click(screen.getByText('How to set up Thing'))
    expect(details.open).toBe(false)
  })
})

describe('on the Channels page', () => {
  it('every connect card has its own guide, collapsed, naming the fields the form has', async () => {
    api.listConnections.mockResolvedValue([])
    renderSection()
    await screen.findByLabelText('Bot token')
    for (const channel of CHANNELS) {
      openTab(channel)
      const guide = guideIn(channel)
      expect(guide.open).toBe(false)
      expect(within(guide).getByText(SETUP_GUIDES[channel].title).tagName).toBe('SUMMARY')
      expect(SETUP_GUIDES[channel].title).toBe(`How to set up ${SECTION[channel]}`)
      expect(SETUP_GUIDES[channel].steps.length).toBeGreaterThanOrEqual(5)
      expect(SETUP_GUIDES[channel].steps.length).toBeLessThanOrEqual(9)

      const section = screen.getByRole('tabpanel', { name: SECTION[channel] })
      const text = guide.textContent ?? ''
      for (const field of FORM[channel].fields) {
        expect(within(section).getByLabelText(field)).toBeTruthy()
        expect(text).toContain(field)
      }
      expect(within(section).getByRole('button', { name: FORM[channel].button })).toBeTruthy()
      expect(text).toContain(FORM[channel].button)
    }
  })

  it('expands on click and opens outside links in a new tab', async () => {
    api.listConnections.mockResolvedValue([])
    renderSection()
    await screen.findByLabelText('Bot token')
    const guide = guideIn('telegram')
    fireEvent.click(within(guide).getByText('How to set up Telegram'))
    expect(guide.open).toBe(true)
    openTab('line')
    expect(guideIn('line').open).toBe(false)
    const links = within(guide).getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('stays on each card once connected', async () => {
    api.listConnections.mockResolvedValue(CHANNELS.map(connection))
    renderSection()
    await screen.findByTestId('channel-tab-dot-telegram')
    for (const channel of CHANNELS) {
      openTab(channel)
      const guide = guideIn(channel)
      expect(guide.open).toBe(false)
      expect(within(guide).getByText(SETUP_GUIDES[channel].title)).toBeTruthy()
    }
  })
})

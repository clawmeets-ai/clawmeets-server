import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../../api/client'
import type { AgentUsage } from '../../../api/endpoints/hub'
import { NOW_S } from '../../../test/hubFixtures'
import { USAGE_COPY } from '../../../utils/agentAccessCopy'
import { formatHubTime } from '../../../utils/hubDisplay'
import HubSendUsageCard from './HubSendUsageCard'

let answer: () => Promise<AgentUsage>
vi.mock('../../../api/endpoints/hub', async (orig) => ({
  ...(await orig<typeof import('../../../api/endpoints/hub')>()),
  getAgentHubUsage: () => answer(),
}))

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubSendUsageCard agentId="a1" />
    </QueryClientProvider>,
  )
}

afterEach(() => cleanup())

describe('the hub send usage card', () => {
  it('one read-only row per window, with the reset time', async () => {
    answer = () => Promise.resolve({ windows: [
      { name: 'hour', used: 3, limit: 20, resets_at: NOW_S + 600 },
      { name: 'new_conversations_day', used: 1, limit: 5, resets_at: NOW_S + 3600 },
    ] })
    renderCard()
    const rows = await screen.findAllByTestId('hub-send-usage-row')
    expect(rows[0].textContent).toBe(`Messages this hour3 / 20· resets ${formatHubTime(NOW_S + 600)}`)
    expect(rows[1].textContent).toContain('New conversations today')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('an unknown window name is shown as sent, as text', async () => {
    answer = () => Promise.resolve({ windows: [{ name: '<b>per_room</b>', used: 0, limit: 9, resets_at: NOW_S }] })
    renderCard()
    const row = await screen.findByTestId('hub-send-usage-row')
    expect(row.textContent).toContain('<b>per_room</b>')
    expect(row.querySelector('b')).toBeNull()
  })

  it('no windows: "No hub sends yet"', async () => {
    answer = () => Promise.resolve({ windows: [] })
    renderCard()
    expect(await screen.findByText(USAGE_COPY.empty)).toBeTruthy()
  })

  it('hidden for a viewer who does not own the agent', async () => {
    answer = () => Promise.reject(new ApiError(403, 'x', { detail: { code: 'not_owner', message: '' } }))
    const { container } = renderCard()
    await vi.waitFor(() => expect(container.querySelector('[data-testid="hub-send-usage"]')).toBeNull())
    expect(container.textContent).toBe('')
  })

  it('another error: a quiet line', async () => {
    answer = () => Promise.reject(new ApiError(500, 'x'))
    renderCard()
    expect(await screen.findByText(USAGE_COPY.failed)).toBeTruthy()
  })
})

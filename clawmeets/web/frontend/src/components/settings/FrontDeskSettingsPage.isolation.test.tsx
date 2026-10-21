import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { ApiError } from '../../api/client'
import type { ChannelConnection } from '../../api/endpoints/channels'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { hubChannel } from '../../test/hubFixtures'
import type { AgentCard } from '../../types'
import FrontDeskSettingsPage from './FrontDeskSettingsPage'

/** The public listing's host disclaimer slot: from the agent's Hub channel,
 *  else from one of its channel connections, else no slot. */

const api = vi.hoisted(() => ({ getHubChannel: vi.fn(), listConnections: vi.fn() }))
vi.mock('../../api/endpoints/hub', async (orig) => ({
  ...(await orig<typeof import('../../api/endpoints/hub')>()),
  getHubChannel: (...a: unknown[]) => api.getHubChannel(...a),
}))
vi.mock('../../api/endpoints/channels', async (orig) => ({
  ...(await orig<typeof import('../../api/endpoints/channels')>()),
  listConnections: () => api.listConnections(),
}))
const agent = { id: 'a1', name: 'owner-concierge', registered_by: 'u1', discoverable_through_registry: true, description: '' } as AgentCard
vi.mock('../../hooks/useMyAgents', () => ({ useMyAgents: () => ({ data: [agent], isLoading: false }) }))

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><MemoryRouter><FrontDeskSettingsPage /></MemoryRouter></QueryClientProvider>)
}
const conn = (o: Partial<ChannelConnection>) => ({ id: 'c1', agent_id: 'a1', channel: 'telegram', ...o }) as ChannelConnection

beforeEach(() => seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1'))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the public listing\'s host disclaimer slot', () => {
  it('from the Hub channel', async () => {
    api.getHubChannel.mockResolvedValue(hubChannel({ isolation: 'unavailable', held_conversations: 3 }))
    api.listConnections.mockResolvedValue([])
    renderPage()
    expect((await screen.findByTestId('host-disclaimer-held')).textContent).toBe('3 conversations are waiting')
    expect(api.getHubChannel).toHaveBeenCalledWith('owner-concierge')
  })

  it('from a channel connection when the Hub channel is not there', async () => {
    api.getHubChannel.mockRejectedValue(new ApiError(404, 'x'))
    api.listConnections.mockResolvedValue([conn({ agent_id: 'other' }), conn({ isolation: 'unavailable', held_conversations: 0 })])
    renderPage()
    expect(await screen.findByTestId('host-disclaimer')).toBeTruthy()
  })

  it('absent with no source, and absent when sandboxed', async () => {
    api.getHubChannel.mockRejectedValue(new ApiError(404, 'x'))
    api.listConnections.mockResolvedValue([])
    renderPage()
    await waitFor(() => expect(api.listConnections).toHaveBeenCalled())
    await screen.findByText('Public agents')
    expect(screen.queryByTestId('host-disclaimer')).toBeNull()
    cleanup()
    api.getHubChannel.mockResolvedValue(hubChannel({ isolation: 'sandboxed' }))
    renderPage()
    await waitFor(() => expect(api.getHubChannel).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByTestId('host-disclaimer')).toBeNull()
  })
})

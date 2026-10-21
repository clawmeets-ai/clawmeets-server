import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { makeSession, seedSessions } from '../../../test/authFixtures'
import { hubChannel } from '../../../test/hubFixtures'
import type { AgentCard } from '../../../types'
import HubInvitableAgentsCard, { HUB_INVITE_COPY } from './HubInvitableAgentsCard'

/** Agent Settings → Channels → Hub → "Agents it may bring in": loads the
 *  card's saved list, saves ids + teams with a plain card update, and shows
 *  the reason instead of the picker for an owner-isolated agent. */

const api = vi.hoisted(() => ({ getHubChannel: vi.fn(), updateAgent: vi.fn() }))
vi.mock('../../../api/endpoints/hub', async (orig) => ({
  ...(await orig<typeof import('../../../api/endpoints/hub')>()),
  getHubChannel: (...a: unknown[]) => api.getHubChannel(...a),
}))
vi.mock('../../../api/endpoints/agents', async (orig) => ({
  ...(await orig<typeof import('../../../api/endpoints/agents')>()),
  updateAgent: (...a: unknown[]) => api.updateAgent(...a),
}))
const agents = vi.hoisted(() => ({ list: [] as AgentCard[] }))
vi.mock('../../../hooks/useMyAgents', () => ({ useMyAgents: () => ({ data: agents.list, isLoading: false }) }))

const concierge = {
  id: 'a1', name: 'owner-concierge', registered_by: 'u1', discoverable_through_registry: true, description: '',
  default_invitable_agents: ['a2', 'gone'], default_invitable_teams: ['Research'],
} as AgentCard
const helper = { id: 'a2', name: 'owner-helper', registered_by: 'u1', description: '', user_teams: ['Research'] } as AgentCard
const writer = { id: 'a3', name: 'owner-writer', registered_by: 'u1', description: '' } as AgentCard

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><HubInvitableAgentsCard agentId="a1" agentFullName="owner-concierge" /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1')
  agents.list = [concierge, helper, writer]
  api.updateAgent.mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Hub tab: agents it may bring in', () => {
  it('shows the saved list, dropping ids that are gone, and saves ids and teams', async () => {
    api.getHubChannel.mockResolvedValue(hubChannel({}))
    renderCard()
    expect(await screen.findByText(HUB_INVITE_COPY.title)).toBeTruthy()
    expect(screen.getByText('helper')).toBeTruthy()
    expect(screen.getByText('Research')).toBeTruthy()
    const save = screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    const input = document.getElementById('hub-invitable-agents-a1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'writer' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(save)
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledWith('a1', {
      default_invitable_agents: ['a2', 'a3'],
      default_invitable_teams: ['Research'],
    }))
  })

  it('an owner-isolated agent gets the reason, not the picker', async () => {
    api.getHubChannel.mockResolvedValue(hubChannel({ owner_isolated: true }))
    renderCard()
    expect(await screen.findByText(HUB_INVITE_COPY.ownerIsolated)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
  })

  it('hidden for an agent the viewer does not own', async () => {
    api.getHubChannel.mockResolvedValue(hubChannel({}))
    agents.list = [helper]
    renderCard()
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByTestId('hub-invitable-agents')).toBeNull()
  })
})

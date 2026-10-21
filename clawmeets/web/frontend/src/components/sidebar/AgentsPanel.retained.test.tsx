import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { RetainedAgent } from '../../api/endpoints/hub'
import type { AgentCard } from '../../types'
import AgentsPanel from './AgentsPanel'

/**
 * The Agents panel's Retained section: the agents the user retained, the
 * same set Cmd-K lists (utils/reachableAgents). Another account's agent of
 * this server opens its ordinary DM; an agent of another server opens its hub
 * thread. Unshared agents drop out, and with nothing retained there is no
 * section at all.
 */

let agents: AgentCard[] = []
let retained: RetainedAgent[] | undefined = []
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../hooks/useAgentAccess', () => ({ useRetainedAgents: () => ({ data: retained }) }))
vi.mock('../../hooks/useAssistantAgent', () => ({ useAssistantAgent: () => undefined }))
vi.mock('../../hooks/useRecentAgents', () => ({ useRecentAgents: () => [] }))
vi.mock('../../hooks/useDmThreads', () => ({ useDmThreads: () => ({ mostRecentByAgentId: new Map() }) }))
vi.mock('../../hooks/useTeamGroups', () => ({
  useTeamGroups: () => ({
    sortedTeamNames: [],
    teamBuckets: new Map(),
    untemmedAgents: agents.filter((a) => a.registered_by === 'u1'),
    myAgents: agents.filter((a) => a.registered_by === 'u1'),
    isLoading: false,
  }),
}))

const card = (id: string, name: string, registered_by: string): AgentCard =>
  ({ id, name, registered_by, description: '', status: 'online', user_teams: [] }) as unknown as AgentCard

const retain = (over: Partial<RetainedAgent>): RetainedAgent => ({
  hub_agent_id: 'fp~far-scout',
  name: 'far-scout',
  deployment_name: 'acme.dev',
  deployment_fingerprint: 'fp',
  description: 'scouts far',
  capabilities: [],
  retained_at: 0,
  state: 'active',
  live_rooms: 0,
  ...over,
})

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<><AgentsPanel /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'carol' })], 'u1')
  agents = [card('a1', 'carol-analyst', 'u1'), card('b1', 'bo-scout', 'u2'), card('b2', 'bo-other', 'u2')]
  retained = []
})
afterEach(cleanup)

describe('AgentsPanel: Retained section', () => {
  it('is absent when nothing is retained', () => {
    renderPanel()
    expect(screen.queryByText('Retained')).toBeNull()
  })

  it('lists retained agents of this server and of other servers, not unretained public ones', () => {
    retained = [
      retain({ hub_agent_id: 'b1', name: 'bo-scout', is_local: true, agent_id: 'b1' }),
      retain({}),
    ]
    renderPanel()
    expect(screen.getByText('Retained')).toBeTruthy()
    expect(screen.getByText('· 2')).toBeTruthy()
    expect(screen.getByText('far-scout@acme.dev')).toBeTruthy()
    expect(screen.queryByText(/bo-other/)).toBeNull()
  })

  it("drops an agent that is no longer shared", () => {
    retained = [retain({ state: 'unlisted' })]
    renderPanel()
    expect(screen.queryByText('Retained')).toBeNull()
  })

  it('a retained agent of this server opens its DM; one of another server opens its hub thread', () => {
    retained = [
      retain({ hub_agent_id: 'b1', name: 'bo-scout', is_local: true, agent_id: 'b1' }),
      retain({}),
    ]
    renderPanel()
    fireEvent.click(screen.getByText('far-scout@acme.dev'))
    expect(screen.getByTestId('where').textContent).toBe('/hub/fp~far-scout')
    fireEvent.click(screen.getByTitle(/bo-scout/))
    expect(screen.getByTestId('where').textContent).toBe('/dm/bo-scout')
  })
})

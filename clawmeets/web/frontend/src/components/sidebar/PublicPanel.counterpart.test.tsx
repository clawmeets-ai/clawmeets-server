import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { AgentCard, Project } from '../../types'
import { useDmThreads } from '../../hooks/useDmThreads'
import { counterpartOf, frontDeskSide } from '../../utils/frontDesk'
import PublicPanel from './PublicPanel'

/**
 * Owner isolation made the requesting user the coordinator of their own
 * requester end and moved the other account's agent to `counterpart_id`.
 * Every thread list groups by `counterpart_id ?? coordinator_id`, so a
 * new-shape end and an old-shape end (agent still the coordinator) both land
 * under their agent, and the owner's host end stays a host end.
 */

const ME = 'u1'
const agent = (id: string, name: string, registered_by: string) =>
  ({ id, name, registered_by, status: 'online', description: '', capabilities: [] }) as unknown as AgentCard
const BOB_SCOUT = agent('a-scout', 'bob-scout', 'u2')
const DAN_LEX = agent('a-lex', 'dan-lex', 'u3')
const MY_DESK = agent('a-desk', 'carol-desk', ME)

const fd = (id: string, o: Partial<Project>): Project => ({
  id, name: `carol-fd-x-${id}`, surface: 'frontdesk', created_by: ME, status: 'active',
  request: '', chatrooms: [], participating_agents: [], created_at: '2026-10-10T00:00:00Z',
  last_modified: '2026-10-10T00:00:00Z', display_name: `Thread ${id}`, coordinator_id: '', ...o,
}) as Project

// New shape: I coordinate my own end; bob's agent is the counterpart.
const NEW_SHAPE = fd('p-new', { coordinator_id: ME, counterpart_id: BOB_SCOUT.id, counterpart_name: BOB_SCOUT.name })
// Old shape (before the migration, or an older server): the agent coordinates.
const OLD_SHAPE = fd('p-old', { coordinator_id: DAN_LEX.id })
// My own host end: my public agent fields a stranger's thread.
const HOST_END = fd('p-host', { coordinator_id: MY_DESK.id })

let agents: AgentCard[] = []
let projects: Project[] = []
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents, isLoading: false }) }))
vi.mock('../../hooks/useProjects', () => ({ useUserProjects: () => ({ data: projects, isLoading: false }) }))
vi.mock('../../hooks/usePublicRequests', () => ({ usePublicRequests: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentAccess', () => ({ useRetainedAgents: () => ({ data: [] }) }))

beforeEach(() => {
  seedSessions([makeSession({ id: ME, username: 'carol' })], ME)
  agents = [BOB_SCOUT, DAN_LEX, MY_DESK]
  projects = [NEW_SHAPE, OLD_SHAPE, HOST_END]
})
afterEach(cleanup)

describe('counterpartOf / frontDeskSide', () => {
  it('reads counterpart_id first and falls back to coordinator_id', () => {
    expect(counterpartOf(NEW_SHAPE)).toBe(BOB_SCOUT.id)
    expect(counterpartOf(OLD_SHAPE)).toBe(DAN_LEX.id)
    expect(counterpartOf({ coordinator_id: 'c', counterpart_id: null })).toBe('c')
  })

  it('classifies both requester shapes as local and the owner-fielded end as host', () => {
    const byId = new Map(agents.map((a) => [a.id, a]))
    expect(frontDeskSide(NEW_SHAPE, byId, ME)).toBe('local')
    expect(frontDeskSide(OLD_SHAPE, byId, ME)).toBe('local')
    expect(frontDeskSide(HOST_END, byId, ME)).toBe('host')
  })
})

describe('the Public panel', () => {
  it('lists the agent of a new-shape end and of an old-shape end, under their owners, and not my own desk', () => {
    render(<MemoryRouter><PublicPanel /></MemoryRouter>)
    expect(screen.getByText('bob')).toBeTruthy()
    expect(screen.getByText('dan')).toBeTruthy()
    expect(screen.getByText('scout')).toBeTruthy()
    expect(screen.getByText('lex')).toBeTruthy()
    expect(screen.queryByText('carol')).toBeNull()
    expect(screen.queryByText('desk')).toBeNull()
  })
})

describe('the DM thread list', () => {
  it('groups each requester end under its counterpart agent, whichever shape it has', () => {
    const { result } = renderHook(() => useDmThreads())
    const byAgent = Object.fromEntries(result.current.groups.map((g) => [g.agent.id, g.threads.map((t) => t.projectId)]))
    expect(byAgent).toEqual({ [BOB_SCOUT.id]: ['p-new'], [DAN_LEX.id]: ['p-old'] })
  })
})

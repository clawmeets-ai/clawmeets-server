import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { AgentCard, Project } from '../types'
import type { ChannelThreadRow } from '../api/endpoints/channels'
import type { ChannelThreadsState } from './useChannelThreads'
import { makeSession, seedSessions } from '../test/authFixtures'

/** The trust rule on its own: every branch that is not a Hub thread by name. */

let projects: Project[] | undefined
let thread: { row: ChannelThreadRow | null; state: ChannelThreadsState }
let agents: AgentCard[]

vi.mock('./useProjects', () => ({ useUserProjects: () => ({ data: projects }) }))
vi.mock('./useChannelThreads', () => ({ useChannelThread: () => thread }))
vi.mock('./useAgents', () => ({ useAllParticipants: () => ({ data: agents }) }))

import { useUntrustedBodies } from './useUntrustedBodies'

const fd = (over: Partial<Project> = {}) =>
  ({ id: 'p1', name: 'p1', surface: 'frontdesk', created_by: 'u1', coordinator_id: 'a-own', ...over }) as Project
const row = (channel: string) => ({ project_id: 'p1', channel }) as ChannelThreadRow
const untrusted = (room = 'user-communication') => renderHook(() => useUntrustedBodies('p1', room)).result.current

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  agents = [
    { id: 'a-own', registered_by: 'u1' } as AgentCard,
    { id: 'a-foreign', registered_by: 'u2' } as AgentCard,
  ]
  thread = { row: null, state: 'loading' }
  projects = [fd()]
})

afterEach(() => {
  cleanup()
  seedSessions([])
})

describe('useUntrustedBodies', () => {
  it('trusts an owned Front Desk room only once its loaded row names a channel other than Hub', () => {
    thread = { row: row('telegram'), state: 'ready' }
    expect(untrusted()).toBe(false)
    thread = { row: row('hub'), state: 'ready' }
    expect(untrusted()).toBe(true)
    for (const state of ['loading', 'error', 'off'] as const) {
      thread = { row: null, state }
      expect(untrusted()).toBe(true)
    }
  })

  it('a requester-side thread with another account\'s agent is trusted; an unknown coordinator is not', () => {
    projects = [fd({ coordinator_id: 'a-foreign' })]
    expect(untrusted()).toBe(false)
    projects = [fd({ coordinator_id: 'a-unknown' })]
    expect(untrusted()).toBe(true)
  })

  it('a Front Desk project the user only views is untrusted; an ordinary project is trusted', () => {
    projects = [fd({ is_viewer: true, created_by: 'u2' })]
    expect(untrusted()).toBe(true)
    projects = [fd({ surface: 'regular' })]
    expect(untrusted()).toBe(false)
  })

  it('a viewer of a shared host-side Hub Request, whose coordinator the owner registered, is untrusted', () => {
    agents = [{ id: 'a-owners', registered_by: 'u2' } as AgentCard]
    projects = [fd({ is_viewer: true, created_by: 'u2', coordinator_id: 'a-owners' })]
    expect(untrusted()).toBe(true)
    // The same room for a user who is not a viewer but did not create it either.
    projects = [fd({ created_by: 'u2', coordinator_id: 'a-owners' })]
    expect(untrusted()).toBe(true)
  })

  it('an owner\'s own cross-account Front Desk thread stays trusted', () => {
    projects = [fd({ created_by: 'u1', coordinator_id: 'a-foreign' })]
    expect(untrusted()).toBe(false)
  })

  it('a hub_target, or no project list yet, is untrusted; rooms other than user-communication are not', () => {
    projects = [fd({ surface: 'regular', hub_target: { hub_agent_id: 'x' } as Project['hub_target'] })]
    expect(untrusted()).toBe(true)
    projects = undefined
    expect(untrusted()).toBe(true)
    expect(untrusted('shared-context')).toBe(false)
  })
})

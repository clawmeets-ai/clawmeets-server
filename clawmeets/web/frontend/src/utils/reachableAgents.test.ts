import { describe, expect, it } from 'vitest'
import type { RetainedAgent } from '../api/endpoints/hub'
import type { AgentCard } from '../types'
import { reachableAgents } from './reachableAgents'

const card = (id: string, owner: string) => ({ id, name: id, registered_by: owner }) as AgentCard
const kept = (over: Partial<RetainedAgent>): RetainedAgent => ({
  hub_agent_id: 'fp~x', name: 'x', deployment_name: 'dep', deployment_fingerprint: 'fp', description: '',
  capabilities: [], retained_at: 1, state: 'active', live_rooms: 0, ...over,
})

describe('reachableAgents', () => {
  const agents = [card('mine', 'me'), card('kept-here', 'bob'), card('public-only', 'carol')]

  it('lists own agents and retained ones, never a public agent alone', () => {
    const { local, hub } = reachableAgents(agents, 'me', [
      kept({ is_local: true, agent_id: 'kept-here' }),
      kept({ hub_agent_id: 'fp~far', name: 'far' }),
    ])
    expect(local.map((a) => a.id)).toEqual(['mine', 'kept-here'])
    expect(hub.map((r) => r.name)).toEqual(['far'])
  })

  it('drops retained agents that are no longer active', () => {
    const { local, hub } = reachableAgents(agents, 'me', [
      kept({ is_local: true, agent_id: 'kept-here', state: 'unlisted' }),
      kept({ hub_agent_id: 'fp~far', state: 'identity_changed' }),
    ])
    expect(local.map((a) => a.id)).toEqual(['mine'])
    expect(hub).toEqual([])
  })

  it('own agents only while the retained list is unknown', () => {
    expect(reachableAgents(agents, 'me', undefined).local.map((a) => a.id)).toEqual(['mine'])
  })
})

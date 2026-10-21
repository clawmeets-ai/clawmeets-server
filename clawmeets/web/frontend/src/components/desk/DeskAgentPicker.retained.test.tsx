import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { RetainedAgent } from '../../api/endpoints/hub'
import type { AgentCard } from '../../types'
import DeskAgentPicker from './DeskAgentPicker'

/**
 * The desk recipient list: the user's assistant, then their own agents, then
 * the other-account agents of this server they retained, then the retained
 * agents of other servers as `name@server` (a send to one starts a hub
 * thread). A public agent they did not retain is not offered, nor is a
 * retained agent that is no longer listed.
 */

let agents: AgentCard[] = []
let retained: RetainedAgent[] = []
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../hooks/useAgentAccess', () => ({ useRetainedAgents: () => ({ data: retained }) }))

const card = (id: string, name: string, registered_by: string): AgentCard =>
  ({ id, name, registered_by, description: 'does things', status: 'online' }) as unknown as AgentCard

const retain = (over: Partial<RetainedAgent>): RetainedAgent => ({
  hub_agent_id: 'fp~far-scout',
  name: 'far-scout',
  deployment_name: 'acme.dev',
  deployment_fingerprint: 'fp',
  description: '',
  capabilities: [],
  retained_at: 0,
  state: 'active',
  live_rooms: 0,
  ...over,
})

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'carol' })], 'u1')
  agents = [
    card('a0', 'carol-assistant', 'u1'),
    card('b1', 'bo-scout', 'u2'),
    card('a1', 'carol-writer', 'u1'),
    card('b2', 'bo-other', 'u2'),
  ]
  retained = [
    retain({ hub_agent_id: 'b1', name: 'bo-scout', is_local: true, agent_id: 'b1' }),
    retain({}),
    retain({ hub_agent_id: 'fp~gone', name: 'gone-scout', state: 'unlisted' }),
  ]
})
// jsdom has no layout: the picker scrolls its highlighted row into view.
Element.prototype.scrollIntoView = () => {}

afterEach(cleanup)

describe('DeskAgentPicker: retained agents', () => {
  it('offers assistant, own agents, retained agents of this server, then of other servers', () => {
    render(<DeskAgentPicker onPick={() => {}} onClose={() => {}} />)
    const rows = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('coordinator')
    expect(rows[1]).toContain('writer')
    expect(rows[2]).toContain('bo-scout')
    expect(rows[2]).toContain('retained')
    expect(rows[3]).toContain('far-scout@acme.dev')
    expect(rows.join()).not.toContain('bo-other')
    expect(rows.join()).not.toContain('gone-scout')
  })

  it('hands back the retained row itself for an agent of another server', () => {
    const onPick = vi.fn()
    render(<DeskAgentPicker onPick={onPick} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Send to which agent…'), { target: { value: 'acme' } })
    const rows = screen.getAllByRole('button')
    expect(rows).toHaveLength(1)
    fireEvent.click(rows[0])
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ hub_agent_id: 'fp~far-scout' }))
  })
})

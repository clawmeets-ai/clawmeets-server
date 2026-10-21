import { describe, it, expect } from 'vitest'
import {
  draftRecipientResolves,
  resolveTodoRecipient,
} from './todoDraft'
import type { AgentCard } from '../types'
import type { DeskTodo } from '../api/endpoints/deskTodos'

const USER = { id: 'u1', username: 'ann' }

function agent(id: string, name: string, ownedByUser = true): AgentCard {
  return {
    id,
    name,
    description: '',
    capabilities: [],
    status: 'offline',
    registered_at: '2026-01-01T00:00:00Z',
    last_heartbeat: null,
    discoverable_through_registry: true,
    registered_by: ownedByUser ? USER.id : 'u2',
    is_verified: false,
  } as AgentCard
}

function todo(over: Partial<DeskTodo> = {}): DeskTodo {
  return {
    id: 't1',
    owner_user_id: USER.id,
    text: 'Follow up on churn',
    // `status` is gone from the wire; these four replace it and are all
    // typed REQUIRED, which is why every to-do fixture in the suite
    // moved at once rather than one at a time.
    state: 'new',
    archived: false,
    association_count: 0,
    project_ids: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    attachments: [],
    ...over,
  }
}

const ROSTER = [
  agent('a-draft', 'ann-analyst'),
  agent('a-suggest', 'ann-researcher'),
  agent('a-asst', 'ann-assistant'),
]

describe('resolveTodoRecipient', () => {
  it('honors the recipient saved on the draft (user pick or agent suggestion)', () => {
    const t = todo({ draft_recipient_id: 'a-suggest', draft_recipient_name: 'ann-researcher' })
    expect(resolveTodoRecipient(t, ROSTER, USER)?.id).toBe('a-suggest')
  })

  it('matches the saved recipient by name when the id has churned', () => {
    const t = todo({ draft_recipient_id: 'stale-id', draft_recipient_name: 'ann-analyst' })
    expect(resolveTodoRecipient(t, ROSTER, USER)?.id).toBe('a-draft')
  })

  it('falls back to the assistant when no draft recipient is stored', () => {
    expect(resolveTodoRecipient(todo(), ROSTER, USER)?.name).toBe('ann-assistant')
  })

  it('returns null with an empty roster so the caller can defer to the take-over', () => {
    expect(resolveTodoRecipient(todo(), [], USER)).toBeNull()
    expect(resolveTodoRecipient(todo(), undefined, USER)).toBeNull()
  })
})

describe('draftRecipientResolves', () => {
  it('is false when the saved recipient has left the roster (send must not redirect)', () => {
    const t = todo({ draft_recipient_id: 'gone', draft_recipient_name: 'ann-departed' })
    expect(draftRecipientResolves(t, ROSTER)).toBe(false)
    // …and the plain resolver would otherwise silently pick the assistant.
    expect(resolveTodoRecipient(t, ROSTER, USER)?.name).toBe('ann-assistant')
  })

  it('is true for a live saved recipient, false when none was saved', () => {
    expect(draftRecipientResolves(todo({ draft_recipient_id: 'a-draft' }), ROSTER)).toBe(true)
    expect(draftRecipientResolves(todo(), ROSTER)).toBe(false)
  })
})

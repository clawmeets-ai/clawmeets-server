import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PublicRequest, RequestMatch } from '../../api/endpoints/publicRequests'
import type { ChatLogEntry } from '../../types'
import RequestRoom from './RequestRoom'
import ProgressBoard from './ProgressBoard'
import { rowState } from './requestCopy'

/**
 * The request room: the ranked list keeps server order, the first agent to
 * answer is shown first, arrows move between agents, "load more" and "send
 * my request" go to the send route, and the answer is the agent's first
 * message on its thread.
 */

const send = vi.fn()
const dismiss = vi.fn()
let messagesByProject: Record<string, ChatLogEntry[]> = {}
let retainedRefs: string[] = []

vi.mock('../../hooks/usePublicRequests', () => ({
  useSendPublicRequest: () => ({ mutate: send, isPending: false }),
  useSetMatchDismissed: () => ({ mutate: dismiss, isPending: false }),
  useReplyToMatch: () => ({ mutateAsync: vi.fn(() => Promise.resolve()), isPending: false, isError: false }),
}))
vi.mock('../../hooks/useAgentAccess', () => ({
  useRetainedAgents: () => ({ data: retainedRefs.map((r) => ({ hub_agent_id: r, state: 'active', live_rooms: 0 })) }),
  useRetainAgent: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
  useUnretainAgent: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useProjects', () => ({
  useMessages: (pid: string) => ({ data: messagesByProject[pid] ?? [] }),
}))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { user: { id: 'me' } }
    return sel ? sel(state) : state
  },
}))

function match(ref: string, over: Partial<RequestMatch> = {}): RequestMatch {
  return {
    agent_ref: ref, kind: 'local', agent_id: `id-${ref}`, name: ref, display_name: ref, owner: 'seller',
    deployment_name: null, description: `${ref} does things`, expertise: ['valuation'], teams: [],
    retained_count: 3, online: true, fit: 60, rep: 7, score: 49.4, why: { Expertise: ['valuation'] },
    project_id: `p-${ref}`, sent_at: 1, send_error: null, dismissed: false, status: 'working', responded_at: null,
    ...over,
  }
}

function request(matches: RequestMatch[]): PublicRequest {
  const sent = matches.filter((m) => m.status !== 'not_sent').length
  return {
    id: 'r1', text: 'Value NVDA', created_at: Date.now() / 1000, matched: matches.length, sent,
    responded: matches.filter((m) => m.status === 'responded').length, matches,
  }
}

const msg = (id: string, from: string, content: string): ChatLogEntry => ({
  entry_type: 'message', id, ts: new Date().toISOString(), from_participant_id: from,
  from_participant_name: from, content, expects_response_from: [], is_ack: false,
}) as ChatLogEntry

const rows = () => screen.getAllByTestId('rank-row')
const activeName = () => within(screen.getByTestId('agent-panel')).getByRole('heading').textContent

beforeEach(() => {
  send.mockReset()
  dismiss.mockReset()
  messagesByProject = {}
  retainedRefs = []
})
afterEach(cleanup)

describe('RequestRoom', () => {
  it('keeps server rank order and opens on the first agent to respond', () => {
    render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([
      match('alpha'),
      match('beta', { status: 'responded', responded_at: 200 }),
      match('gamma', { status: 'responded', responded_at: 100 }),
    ])} />)
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('alpha'), expect.stringContaining('beta'), expect.stringContaining('gamma'),
    ])
    expect(activeName()).toBe('gamma')
    expect(screen.getByText('2 of 3 responded')).toBeTruthy()
  })

  it('arrow keys move between agents, but not while typing a reply', () => {
    render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([match('alpha'), match('beta')])} />)
    expect(activeName()).toBe('alpha')
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(activeName()).toBe('beta')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(activeName()).toBe('alpha')
    fireEvent.keyDown(screen.getByTestId('reply-input'), { key: 'ArrowRight' })
    expect(activeName()).toBe('alpha')
  })

  it('load more sends to the next three; send my request names the agent', () => {
    render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([
      match('alpha'),
      match('beta', { status: 'not_sent', project_id: null, sent_at: null }),
    ])} />)
    fireEvent.click(screen.getByTestId('load-more'))
    expect(send).toHaveBeenCalledWith({ count: 3 })
    fireEvent.click(rows()[1])
    fireEvent.click(screen.getByTestId('send-to-agent'))
    expect(send).toHaveBeenLastCalledWith({ agent_refs: ['beta'] })
  })

  it('no load-more row once every match was sent', () => {
    render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([match('alpha')])} />)
    expect(screen.queryByTestId('load-more')).toBeNull()
  })

  it('the answer is the agent’s first message; later ones form the thread, then typing', () => {
    messagesByProject['p-alpha'] = [
      msg('m1', 'me', 'Value NVDA'),
      msg('m2', 'id-alpha', '## Priced for 30% growth'),
      msg('m3', 'me', 'What breaks it?'),
    ]
    render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([
      match('alpha', { status: 'responded', responded_at: 5 }),
    ])} />)
    expect(screen.getByTestId('agent-answer').textContent).toContain('Priced for 30% growth')
    const thread = screen.getByTestId('agent-thread')
    expect(thread.textContent).toContain('What breaks it?')
    expect(thread.textContent).toContain('alpha is typing…')
  })

  it('dismiss and show it again', () => {
    const { rerender } = render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([
      match('alpha', { status: 'responded', responded_at: 5 }),
    ])} />)
    fireEvent.click(screen.getByTestId('dismiss'))
    expect(dismiss).toHaveBeenCalledWith({ agentRef: 'alpha', dismissed: true })
    rerender(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([
      match('alpha', { status: 'responded', responded_at: 5, dismissed: true }),
    ])} />)
    fireEvent.click(screen.getByTestId('show-again'))
    expect(dismiss).toHaveBeenLastCalledWith({ agentRef: 'alpha', dismissed: false })
  })
})

describe('row status', () => {
  it('dismissed wins, then the thread state; retained shows only once answered', () => {
    expect(rowState(match('a', { dismissed: true }), true).tone).toBe('dismissed')
    expect(rowState(match('a', { status: 'not_sent' }), false)).toEqual({ tone: 'not_sent', label: 'Not sent' })
    expect(rowState(match('a', { status: 'not_sent', send_error: 'x' }), false).label).toBe('Couldn’t send')
    expect(rowState(match('a'), true).tone).toBe('working')
    expect(rowState(match('a', { status: 'responded' }), true).tone).toBe('retained')
    expect(rowState(match('a', { status: 'responded' }), false).tone).toBe('responded')
  })
})

describe('ProgressBoard', () => {
  const states = () => [...document.querySelectorAll('.pr-step')].map((s) => s.getAttribute('data-state'))

  it('searching shows the searching block and the first step on', () => {
    render(<ProgressBoard searching matched={0} sent={0} working={0} responded={0} />)
    expect(screen.getByRole('status').textContent).toContain('Finding the best agents')
    expect(states()).toEqual(['on', 'pending', 'pending'])
  })

  it('all in: every step done', () => {
    render(<ProgressBoard searching={false} matched={5} sent={3} working={0} responded={3} />)
    expect(states()).toEqual(['done', 'done', 'done'])
    expect(screen.getByText('3 of 3 in')).toBeTruthy()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ApiError } from '../../api/client'
import type { PublicRequest, RequestMatch } from '../../api/endpoints/publicRequests'
import type { ChatLogEntry } from '../../types'
import { MemoryRouter } from 'react-router-dom'
import RequestRoom from './RequestRoom'
import RequestHome from './RequestHome'
import ProgressBoard from './ProgressBoard'
import { askErrorMessage, COPY, fitLabel, rowState } from './requestCopy'

/**
 * The request room: the ranked list keeps the hub's order, the first agent
 * to answer is shown first, arrows move between agents, "ask for more" goes
 * to the send route, the answer is the agent's first message on its thread,
 * and a request the hub could not take says why.
 */

const send = vi.fn()
const dismiss = vi.fn()
const markUsed = vi.fn()
let messagesByProject: Record<string, ChatLogEntry[]> = {}
let retainedRefs: string[] = []
let sendError: unknown = null
let createError: unknown = null

vi.mock('../../hooks/usePublicRequests', () => ({
  useSendPublicRequest: () => ({ mutate: send, isPending: false, isError: sendError !== null, error: sendError }),
  useSetMatchDismissed: () => ({ mutate: dismiss, isPending: false }),
  useMarkAnswerUsed: () => ({ mutate: markUsed, isPending: false }),
  useCreatePublicRequest: () => ({ mutate: vi.fn(), isPending: false, isError: createError !== null, error: createError }),
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
    retained_count: 3, online: true, fit: 60, score: 0.49,
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
  markUsed.mockReset()
  messagesByProject = {}
  retainedRefs = []
  sendError = null
  createError = null
})

const hubFailure = (status: number, code: string) =>
  new ApiError(status, '[object Object]', { detail: { code, message: 'from the server' } })
afterEach(cleanup)

describe('RequestRoom', () => {
  it('keeps the hub\'s rank order and opens on the first agent to respond', () => {
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

  it('ask for more is a new ask for three; an agent it could not reach has no send button', () => {
    render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([
      match('alpha'),
      match('beta', { status: 'not_sent', project_id: null, sent_at: null, send_error: 'send_failed' }),
    ])} />)
    fireEvent.click(screen.getByTestId('ask-more'))
    expect(send).toHaveBeenCalledWith({ count: 3 })
    fireEvent.click(rows()[1])
    expect(screen.getByTestId('not-sent').textContent).toContain(COPY.sendFailed)
    expect(screen.queryByRole('button', { name: /send my request/i })).toBeNull()
  })

  it('ask for more that the hub could not take says why', () => {
    sendError = hubFailure(503, 'hub_unavailable')
    render(<RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={request([match('alpha')])} />)
    expect(screen.getByTestId('ask-error').textContent).toBe(COPY.hubUnavailable)
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

describe('hub-ranked dispatch', () => {
  const room = (r: PublicRequest) => render(
    <MemoryRouter><RequestRoom drawerOpen={false} onOpenAgent={() => {}} request={r} /></MemoryRouter>,
  )

  it('use this answer on a responded match, then shows it is used', () => {
    const { unmount } = room(request([match('alpha', { status: 'responded', responded_at: 5 })]))
    fireEvent.click(screen.getByTestId('use-answer'))
    expect(markUsed).toHaveBeenCalledWith('alpha')
    unmount()
    room(request([match('alpha', { status: 'responded', responded_at: 5, used: true })]))
    expect(screen.queryByTestId('use-answer')).toBeNull()
    expect(screen.getByTestId('used-answer').textContent).toBe(COPY.usedAnswer)
  })

  it('no use-this-answer before the agent answered', () => {
    room(request([match('alpha')]))
    expect(screen.queryByTestId('use-answer')).toBeNull()
  })

  it('nobody fits: the assistant answered, with a link to its thread, and no "no match" line', () => {
    room({ ...request([]), answer_yourself: true, fallback_project_id: 'p-dm',
      fallback_agent_name: 'olivia-assistant' })
    expect(screen.getByTestId('assistant-answered').textContent).toContain(COPY.assistantAnswered)
    expect(screen.getByTestId('open-assistant').getAttribute('href')).toBe('/dm/olivia-assistant/p-dm')
    expect(screen.queryByText(COPY.noMatches)).toBeNull()
  })

  it('the hub fit shows in words, nothing without one', () => {
    room(request([match('alpha', { p_fit: 0.82 }), match('beta', { p_fit: 0.3 }), match('gamma')]))
    expect(screen.getAllByTestId('rank-fit').map((e) => e.textContent)).toEqual([COPY.fitLikely, COPY.fitPossible])
    expect(fitLabel(match('x', { p_fit: null }))).toBeNull()
  })

  it('the request box says who sees the request', () => {
    render(<MemoryRouter><RequestHome /></MemoryRouter>)
    expect(screen.getByTestId('request-disclosure').textContent).toBe(
      'Your request is shown to the hub and OpenAI to pick who can help.')
  })
})

describe('when the hub cannot take a request', () => {
  it('names the two causes in words, and never shows the raw detail', () => {
    expect(askErrorMessage(hubFailure(409, 'hub_required'))).toBe(
      'Public requests need this server to be on the ClawMeets Hub')
    expect(askErrorMessage(hubFailure(503, 'hub_unavailable'))).toBe(
      'Couldn’t reach the hub. Try again in a minute.')
    expect(askErrorMessage(hubFailure(429, 'rate_limited'))).toBe(COPY.rateLimited)
    expect(askErrorMessage(new Error('network'))).toBe(COPY.askFailed)
  })

  it('the request box shows hub_required', () => {
    createError = hubFailure(409, 'hub_required')
    render(<MemoryRouter><RequestHome /></MemoryRouter>)
    expect(screen.getByTestId('ask-error').textContent).toBe(COPY.hubRequired)
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

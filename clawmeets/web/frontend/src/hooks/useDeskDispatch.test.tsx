import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import type { RetainedAgent } from '../api/endpoints/hub'
import type { AgentCard } from '../types'

/**
 * The two things this hook owns that a to-do's link depends on: the
 * idempotency token reaching `createDMThread`, and the sentence the owner reads
 * when the message went out and the link did not.
 *
 * The sentence is tested as COPY, not as a format string. Three of its
 * properties are load-bearing and each is a separate assertion, because each
 * one fails differently: claiming the message failed invites a duplicate send;
 * omitting the verb leaves an owner who can see the problem and cannot fix it;
 * and naming a to-do id in the wrong argument position produces a command that
 * runs and does the wrong thing.
 */

const createDMThread = vi.fn()
const createFDThread = vi.fn()
const sendDMMessage = vi.fn()
vi.mock('../api/endpoints/dm', () => ({
  createDMThread: (...a: unknown[]) => createDMThread(...a),
  createFDThread: (...a: unknown[]) => createFDThread(...a),
  sendDMMessage: (...a: unknown[]) => sendDMMessage(...a),
}))
const startHubConversation = vi.fn()
vi.mock('../api/endpoints/hub', () => ({
  startHubConversation: (...a: unknown[]) => startHubConversation(...a),
}))
const sendHubDraft = vi.fn()
vi.mock('./useHub', () => ({
  sendHubDraft: (...a: unknown[]) => sendHubDraft(...a),
}))
vi.mock('../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))

const { useDeskDispatch } = await import('./useDeskDispatch')

const RECIPIENT = { id: 'a1', name: 'ana-analyst', registered_by: 'u1' } as AgentCard
// Another account's agent of this server the user retained.
const RETAINED = { id: 'b1', name: 'bo-scout', registered_by: 'u2' } as AgentCard
// A retained agent of another server: no agent card, only its retained row.
const HUB = {
  hub_agent_id: 'fp~far-scout', name: 'far-scout', deployment_name: 'acme.dev', deployment_fingerprint: 'fp',
  description: '', capabilities: [], retained_at: 0, state: 'active', live_rooms: 0,
} as RetainedAgent

let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  createDMThread.mockReset().mockResolvedValue({ id: 'p-thread1', name: 'ana-dm-analyst-1' })
  createFDThread.mockReset().mockResolvedValue({ id: 'p-fd1', name: 'ana-fd-scout-1' })
  sendDMMessage.mockReset().mockResolvedValue({})
  startHubConversation.mockReset().mockResolvedValue({ id: 'p-hub1', name: 'ana-hub-1' })
  sendHubDraft.mockReset().mockResolvedValue({ message_id: 'm1', delivery: {} })
})
afterEach(cleanup)

const hook = () => renderHook(() => useDeskDispatch(), { wrapper }).result

describe('dispatchToAgent', () => {
  it('starts a hub thread for a retained agent of another server and sends through the hub', async () => {
    // A hub thread is written only through the hub send route; the DM routes
    // would answer use_hub_send. The draft key dedupes the start like a DM's.
    const file = new File(['x'], 'notes.txt')
    const r = hook()
    const thread = await r.current.dispatchToAgent(HUB, 'hello', [file], 'key-hub')
    expect(startHubConversation).toHaveBeenCalledWith('fp~far-scout', 'key-hub')
    expect(sendHubDraft).toHaveBeenCalledWith(queryClient, 'p-hub1', 'hello', [file])
    expect(createDMThread).not.toHaveBeenCalled()
    expect(createFDThread).not.toHaveBeenCalled()
    expect(sendDMMessage).not.toHaveBeenCalled()
    expect(thread.id).toBe('p-hub1')
  })

  it('confirms a hub send with name@server', () => {
    const r = hook()
    expect(r.current.confirmText(HUB, 0)).toContain('@far-scout@acme.dev')
  })

  it('forwards the client thread key to createDMThread', async () => {
    // The token was ACCEPTED by `createDMThread` from the day threads existed
    // and this hook simply never passed one. That omission is what made a
    // double-press mint two threads — and, now that a thread is linked to the
    // to-do that spawned it, would have made it two associations too.
    const r = hook()
    await r.current.dispatchToAgent(RECIPIENT, 'hello', [], 'key-abc')
    expect(createDMThread).toHaveBeenCalledWith('ana-analyst', 'key-abc')
  })

  it("opens a Front Desk thread for another account's agent, never an own DM", async () => {
    // `/me/dms/{agent}/threads` refuses an agent the caller does not own; the
    // DM view makes the same split (DMChatView's createThreadMutation).
    const r = hook()
    const thread = await r.current.dispatchToAgent(RETAINED, 'hello', [], 'key-fd')
    expect(createFDThread).toHaveBeenCalledWith('bo-scout', 'key-fd')
    expect(createDMThread).not.toHaveBeenCalled()
    expect(thread.id).toBe('p-fd1')
  })

  it("sends no model override to another account's agent", async () => {
    // It runs on its owner's models; a cached or picked config name is ours.
    queryClient.setQueryData(['model-configs', 'b1'], { configs: [], default: 'fast' })
    const r = hook()
    await r.current.dispatchToAgent(RETAINED, 'hello', [], 'k')
    expect(sendDMMessage).toHaveBeenCalledWith('p-fd1', 'user-communication', 'hello', undefined, undefined)
  })

  it('resolves with the thread — the project the to-do gets linked to', async () => {
    const r = hook()
    const thread = await r.current.dispatchToAgent(RECIPIENT, 'hello', [], 'k')
    expect(thread.id).toBe('p-thread1')
  })
})

describe('linkFailedText', () => {
  const say = (err: unknown) =>
    hook().current.linkFailedText(RECIPIENT, 't-9a3f21', 'p-thread1', err)

  it('says the message WENT OUT — it must never read as a send failure', () => {
    const s = say(new ApiError(500, 'Internal Server Error'))
    expect(s).toContain('Sent to @analyst') // own agent: the short name
    expect(s).toContain('the message went out')
    expect(s).not.toMatch(/message (failed|did ?n.t send|was not sent)/i)
  })

  it('names the repair verb with the real ids, TO-DO FIRST', () => {
    // This milestone ships no browser affordance for linking by hand, so the
    // terminal is the only way back. The argument order is the contract's and
    // reversing it produces a command that runs and links the wrong way round.
    expect(say(new ApiError(404, 'nope'))).toContain(
      'clawmeets todo associate t-9a3f21 p-thread1',
    )
  })

  it('renders a BARE association refusal verbatim', () => {
    // No `labels.` prefix on this surface: `detail` is the whole sentence,
    // already written for the owner, and there is nothing for a code to
    // dispatch on. It is carried through untouched.
    const detail =
      "No project or thread with id 'p-123' — check the id, or it may have been deleted."
    expect(say(new ApiError(404, detail))).toContain(detail)
  })

  it('does not branch on 404 vs 403 — both sentences arrive intact', () => {
    const forbidden =
      "'Q3 pricing review' belongs to someone else — you can only link to-dos to projects and threads you created."
    const s = say(new ApiError(403, forbidden))
    expect(s).toContain(forbidden)
    expect(s).toContain('clawmeets todo associate t-9a3f21 p-thread1')
  })

  it('survives a throw with no body at all', () => {
    // A network failure is not an ApiError and carries no `detail`. The parse
    // falls through to its own generic line rather than interpolating
    // "undefined" into a sentence the owner is being asked to act on.
    const s = say(new Error(''))
    expect(s).toContain('the message went out')
    expect(s).not.toContain('undefined')
    expect(s).toContain('clawmeets todo associate')
  })
})

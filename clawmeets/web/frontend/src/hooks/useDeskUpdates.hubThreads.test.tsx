import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { makeSession, seedSessions } from '../test/authFixtures'
import type { AgentCard, ChatMessage, Project } from '../types'

/**
 * HUB THREADS REACH MY DESK. A desk send to a retained agent of another server
 * starts a hub thread, and the desk promises "their reply lands on your desk".
 * Its partner has no agent card here, so useDmThreads skips it; the feed reads
 * it by its hub_target instead: named `name@server`, opened at the hub thread
 * route, and flagged so Send Back uses the hub send route.
 */

let agents: AgentCard[] = []
let projects: Project[] = []
const latest = vi.fn()

vi.mock('./useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('./useProjects', () => ({ useUserProjects: () => ({ data: projects, isLoading: false }) }))
vi.mock('./useDeskReadState', () => ({ useDeskReadState: () => ({ hydrated: true }) }))
vi.mock('../api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/endpoints')>()),
  getChatrooms: () => Promise.resolve([]),
}))
vi.mock('../api/endpoints/deskLatestMessages', () => ({
  getDeskLatestMessages: (ids: string[]) => latest(ids),
}))

const { useDeskUpdates } = await import('./useDeskUpdates')

const NOW = new Date().toISOString()

function message(id: string, from: string, content: string): ChatMessage {
  return {
    entry_type: 'message', id, ts: NOW, from_participant_id: from, from_participant_name: from,
    content, expects_response_from: [], is_ack: false,
  } as unknown as ChatMessage
}

function project(over: Partial<Project> & { id: string; name: string }): Project {
  return {
    status: 'active', coordinator_id: 'a-support', request: '', chatrooms: ['user-communication'],
    participating_agents: [], created_at: NOW, created_by: 'u1', last_modified: NOW, ...over,
  } as Project
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1')
  agents = [{ id: 'a-support', name: 'support', registered_by: 'u1' } as AgentCard]
  projects = [
    project({
      id: 'p-hub', name: 'owner-hub-1', surface: 'frontdesk', coordinator_id: 'u1',
      display_name: 'Ask far-scout',
      hub_target: {
        hub_agent_id: 'fp~far-scout', display: 'far-scout@acme.dev', name: 'far-scout',
        deployment_name: 'acme.dev', deployment_label: 'acme.dev', deployment_fingerprint: 'fp',
        deployment_url: null, deployment_url_verified: false, listed: true, closed_reason: null, closed_at: null,
      },
    }),
    // Someone else's hub thread is not this user's desk.
    project({ id: 'p-other', name: 'x', surface: 'frontdesk', created_by: 'u9', hub_target: { hub_agent_id: 'fp~x', display: 'x@y' } as Project['hub_target'] }),
  ]
  latest.mockImplementation((ids: string[]) =>
    Promise.resolve({ ids, entries: { 'p-hub': [message('m-h', 'fp~far-scout', 'Here is what I found.')] } }),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useDeskUpdates — hub threads', () => {
  it('shows the reply as a card that names and opens the hub thread', async () => {
    const { result } = renderHook(() => useDeskUpdates(), { wrapper })
    await waitFor(() => expect(result.current.updates).toHaveLength(1))
    const card = result.current.updates[0]
    expect(card.projectId).toBe('p-hub')
    expect(card.lane).toBe('reply')
    expect(card.agent).toBeNull()
    expect(card.agentName).toBe('far-scout@acme.dev')
    expect(card.navTo).toBe('/hub/fp~far-scout/p-hub')
    expect(card.hubThread).toBe(true)
    for (const call of latest.mock.calls) expect(call[0]).not.toContain('p-other')
  })
})

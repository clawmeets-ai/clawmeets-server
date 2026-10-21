import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { makeSession, seedSessions } from '../test/authFixtures'
import type { AgentCard, ChatMessage, Project } from '../types'

/**
 * CHANNEL THREADS STAY OFF MY DESK (decided 2026-10-07). A channel thread is a
 * Front Desk HOST end the owner created, with the owner's own agent as
 * coordinator. My Desk's candidates are own-DM threads, Front Desk requester
 * ends and regular projects, so a channel thread is already not one — this
 * pins it, on the code before the channel sidebar and after it.
 *
 * The contact's fresh message must neither become a card nor count toward the
 * reply lane, and the channel thread's id must never be asked for.
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
    // The channel thread: a Telegram contact just wrote.
    project({ id: 'p-chan', name: 'ch-1a2b3c4d-deadbeef', surface: 'frontdesk', display_name: 'Booking' }),
    project({ id: 'p-dm', name: 'owner-dm-support-12345678', surface: 'dm', display_name: 'My DM' }),
    project({ id: 'p-proj', name: 'launch', surface: 'regular' }),
  ]
  latest.mockImplementation((ids: string[]) =>
    Promise.resolve({
      ids,
      entries: {
        'p-chan': [message('m-c', 'contact:7f3e', 'Hi, is the table free?')],
        'p-dm': [message('m-d', 'a-support', 'Done.')],
        'p-proj': [message('m-p', 'a-support', 'Shipped.')],
      },
    }),
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

describe('useDeskUpdates — channel threads stay off My Desk', () => {
  it('candidates are the DM and the project; the channel thread is never requested or counted', async () => {
    const { result } = renderHook(() => useDeskUpdates(), { wrapper })
    await waitFor(() => expect(result.current.updates).toHaveLength(2))
    expect(result.current.updates.map((u) => u.projectId).sort()).toEqual(['p-dm', 'p-proj'])
    expect(result.current.counts.reply).toBe(2)
    for (const call of latest.mock.calls) expect(call[0]).not.toContain('p-chan')
  })
})

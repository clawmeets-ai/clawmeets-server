import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { settle } from '../../test/fetchHarness'
import { ISOLATION_COPY } from '../../utils/agentAccessCopy'
import ChatroomView from './ChatroomView'

/**
 * A room of an isolated project whose reads answer 409 isolation_unavailable:
 * the panel says the work is waiting, and the reads are not repeated (the
 * app's single retry is skipped for this code).
 */

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const requested: string[] = []

vi.mock('../../hooks/useSharing', () => ({ useIsProjectViewer: () => false }))
vi.mock('../../hooks/useAgents', () => ({
  useAllParticipants: () => ({ data: [] }),
  useAgents: () => ({ data: [] }),
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    get: (path: string) => {
      requested.push(path)
      if (path.startsWith('/projects/p1/chatrooms/')) {
        return Promise.reject(new actual.ApiError(409, 'isolated', {
          detail: { code: 'isolation_unavailable', message: 'held' },
        }))
      }
      return Promise.reject(new actual.ApiError(404, 'unmocked'))
    },
  }
})

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1')
  requested.length = 0
})
afterEach(() => cleanup())

describe('a room that is waiting for isolation', () => {
  it('shows the waiting panel and reads each route once', async () => {
    // The app default retries once; this code must not be.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/projects/p1/chatrooms/work-room']}>
          <Routes>
            <Route path="/projects/:projectId/chatrooms/:chatroomName" element={<ChatroomView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect((await screen.findByTestId('isolation-unavailable')).textContent).toContain(ISOLATION_COPY.waiting)
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
    await settle(40)
    expect(requested.filter((p) => p === '/projects/p1/chatrooms/work-room')).toHaveLength(1)
    expect(requested.filter((p) => p === '/projects/p1/chatrooms/work-room/messages')).toHaveLength(1)
  })
})

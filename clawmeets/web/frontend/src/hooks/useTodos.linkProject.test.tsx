import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * `linkProject` — the one verb on this hook that is async AND throwing, and
 * both halves are the point.
 *
 * It THROWS because the caller has to know: a link that fails quietly leaves
 * the owner believing a to-do is wired to a thread it will read New beside
 * forever. It does NOT patch optimistically because there is nothing to patch —
 * `state` is derived from the association the server is only now being told
 * about, so the browser would be guessing `working` and would be wrong for a
 * project that is already complete or failed.
 */

const associateTodoProject = vi.fn()
vi.mock('../api/endpoints/deskTodoProjects', () => ({
  associateTodoProject: (...a: unknown[]) => associateTodoProject(...a),
}))

const getDeskTodos = vi.fn()
vi.mock('../api/endpoints/deskTodos', async () => {
  const actual =
    await vi.importActual<typeof import('../api/endpoints/deskTodos')>(
      '../api/endpoints/deskTodos',
    )
  return { ...actual, getDeskTodos: () => getDeskTodos() }
})
vi.mock('../stores/authStore', () => ({
  useAuthStore: (sel: (s: { user?: { id: string } }) => unknown) => sel({ user: { id: 'u1' } }),
}))

const { useTodos } = await import('./useTodos')

const todo = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't-9a3f21',
  owner_user_id: 'u1',
  text: 'Chase the Northwind renewal',
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  attachments: [],
  ...over,
})

let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  associateTodoProject.mockReset()
  getDeskTodos.mockReset().mockResolvedValue([todo()])
})
afterEach(cleanup)

describe('useTodos.linkProject', () => {
  it('POSTs the association and resolves with the server-derived to-do', async () => {
    // The response carries the freshly derived `state`, which is the only place
    // the browser can learn what its own write produced — a to-do linked to an
    // already-completed project reads `completed`, not `working`.
    associateTodoProject.mockResolvedValue(
      todo({ state: 'completed', association_count: 1, project_ids: ['p-1'] }),
    )
    const { result } = renderHook(() => useTodos(), { wrapper })
    const saved = await result.current.linkProject('t-9a3f21', 'p-1')
    expect(associateTodoProject).toHaveBeenCalledWith('t-9a3f21', 'p-1')
    expect(saved.state).toBe('completed')
    expect(saved.association_count).toBe(1)
  })

  it('never fabricates a state in the cache before the server answers', async () => {
    // The `archive` verb next door stopped mirroring for this exact reason.
    // Linking is the other half of it: the browser cannot compute the row it is
    // about to create, so it does not try.
    let release: (v: DeskTodo) => void = () => {}
    associateTodoProject.mockImplementation(
      () => new Promise<DeskTodo>((r) => { release = r }),
    )
    const { result } = renderHook(() => useTodos(), { wrapper })
    await waitFor(() => expect(result.current.todos).toHaveLength(1))

    const pending = result.current.linkProject('t-9a3f21', 'p-1')
    expect(queryClient.getQueryData<DeskTodo[]>(['desk-todos'])![0].state).toBe('new')
    release(todo({ state: 'working', association_count: 1, project_ids: ['p-1'] }))
    await pending
  })

  it('lets a refusal out, with the server sentence intact', async () => {
    const detail =
      "No project or thread with id 'p-123' — check the id, or it may have been deleted."
    associateTodoProject.mockRejectedValue(new ApiError(404, detail))
    const { result } = renderHook(() => useTodos(), { wrapper })
    await expect(result.current.linkProject('t-9a3f21', 'p-123')).rejects.toThrow(detail)
  })

  it('refetches the plate even when the link was refused', async () => {
    // `finally`, not `then`. A refused link can still have moved the plate —
    // the composer's send created a thread, and the sync fan-out that follows
    // is not the browser's to predict. Leaving the cache un-invalidated on the
    // one path the owner is already confused by is the wrong trade.
    associateTodoProject.mockRejectedValue(new ApiError(404, 'nope'))
    const { result } = renderHook(() => useTodos(), { wrapper })
    await waitFor(() => expect(getDeskTodos).toHaveBeenCalledTimes(1))
    await result.current.linkProject('t-9a3f21', 'p-123').catch(() => {})
    await waitFor(() => expect(getDeskTodos).toHaveBeenCalledTimes(2))
  })
})

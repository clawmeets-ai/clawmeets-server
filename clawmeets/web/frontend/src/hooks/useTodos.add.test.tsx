import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * `add` — the capture behind the plate's search box.
 *
 * The new row must appear as soon as the POST answers, not after the follow-up
 * `GET` that re-derives `state` for the whole plate; while the POST is out the
 * hook says so (`adding` / `addingText`); and a refusal reaches the caller
 * instead of vanishing.
 */

const captureTodo = vi.fn()
const getDeskTodos = vi.fn()
vi.mock('../api/endpoints/deskTodos', async () => {
  const actual =
    await vi.importActual<typeof import('../api/endpoints/deskTodos')>(
      '../api/endpoints/deskTodos',
    )
  return {
    ...actual,
    captureTodo: (...a: unknown[]) => captureTodo(...a),
    getDeskTodos: () => getDeskTodos(),
  }
})
vi.mock('../stores/authStore', () => ({
  useAuthStore: (sel: (s: { user?: { id: string } }) => unknown) => sel({ user: { id: 'u1' } }),
}))

const { useTodos } = await import('./useTodos')

const todo = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't-old',
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
  captureTodo.mockReset()
  getDeskTodos.mockReset().mockResolvedValue([todo()])
})
afterEach(cleanup)

describe('useTodos.add', () => {
  it('shows the row from the POST response without waiting on the refetch', async () => {
    let resolvePost: (t: DeskTodo) => void = () => {}
    captureTodo.mockReturnValue(new Promise<DeskTodo>((r) => (resolvePost = r)))
    const { result } = renderHook(() => useTodos(), { wrapper })
    await waitFor(() => expect(result.current.todos).toHaveLength(1))

    // The refetch that follows the capture never answers — the row must
    // arrive anyway.
    getDeskTodos.mockReturnValue(new Promise(() => {}))
    act(() => result.current.add('Chase the PO'))
    await waitFor(() => expect(result.current.adding).toBe(true))
    expect(result.current.addingText).toBe('Chase the PO')

    act(() => resolvePost(todo({ id: 't-new', text: 'Chase the PO' })))
    await waitFor(() => expect(result.current.adding).toBe(false))
    expect(result.current.todos.map((t) => t.id)).toEqual(['t-new', 't-old'])
  })

  it('hands a refusal to the caller', async () => {
    captureTodo.mockRejectedValue(new Error('Server unavailable'))
    const onError = vi.fn()
    const { result } = renderHook(() => useTodos(), { wrapper })
    await waitFor(() => expect(result.current.todos).toHaveLength(1))
    act(() => result.current.add('Chase the PO', { onError }))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect((onError.mock.calls[0][0] as Error).message).toBe('Server unavailable')
    expect(result.current.todos.map((t) => t.id)).toEqual(['t-old'])
  })
})

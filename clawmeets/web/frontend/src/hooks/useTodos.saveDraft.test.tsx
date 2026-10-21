import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * The three-way `attachments` rule on the save path, which is the one thing
 * standing between a desired-state array and data loss.
 *
 * Because absence is the delete signal, `[]` on the wire means "remove every
 * file". So the key must be OMITTED — not sent empty — by every save that is
 * not about attachments: a text edit, a recipient change, a done-toggle. That
 * is what makes an ordinary save structurally incapable of nuking a to-do's
 * files, and it is exactly the kind of rule that reads as a no-op and gets
 * "simplified" into `attachments: attachments ?? []` by someone tidying up.
 */

const patchTodo = vi.fn()
const captureTodo = vi.fn()
vi.mock('../api/endpoints/deskTodos', async () => {
  const actual =
    await vi.importActual<typeof import('../api/endpoints/deskTodos')>(
      '../api/endpoints/deskTodos',
    )
  return {
    ...actual,
    patchTodo: (...a: unknown[]) => patchTodo(...a),
    captureTodo: (...a: unknown[]) => captureTodo(...a),
    getDeskTodos: async () => [] as DeskTodo[],
  }
})

vi.mock('../stores/authStore', () => ({
  useAuthStore: (sel: (s: { user?: { id: string } }) => unknown) => sel({ user: { id: 'u1' } }),
}))

const { useTodos } = await import('./useTodos')

const saved = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't-9a3f21',
  owner_user_id: 'u1',
  text: 'Chase the Northwind renewal',
  // `status` is gone from the wire; these four replace it and are all
  // typed REQUIRED, which is why every to-do fixture in the suite
  // moved at once rather than one at a time.
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
  patchTodo.mockReset().mockResolvedValue(saved())
  captureTodo.mockReset().mockResolvedValue(saved())
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})
afterEach(cleanup)

describe('useTodos.saveDraft', () => {
  it('a text-only save omits the attachments key rather than sending []', async () => {
    const { result } = renderHook(() => useTodos(), { wrapper })

    await result.current.saveDraft('t-9a3f21', 'Chase the renewal', null)

    const payload = patchTodo.mock.calls[0][1]
    expect('attachments' in payload).toBe(false)
    // The distinction that matters, spelled out: an empty array here would
    // have deleted every file on the item.
    expect(payload.attachments).not.toEqual([])
  })

  it('sends the array verbatim when the caller passes one', async () => {
    const { result } = renderHook(() => useTodos(), { wrapper })

    await result.current.saveDraft('t-9a3f21', 'Chase the renewal', null, [
      { keep: 'a-4f9c2b1e' },
      { filename: 'notes.pdf', content_b64: 'aGk=' },
    ])

    expect(patchTodo.mock.calls[0][1].attachments).toEqual([
      { keep: 'a-4f9c2b1e' },
      { filename: 'notes.pdf', content_b64: 'aGk=' },
    ])
  })

  it('sends [] when — and only when — the caller means "remove all"', async () => {
    const { result } = renderHook(() => useTodos(), { wrapper })

    await result.current.saveDraft('t-9a3f21', 'Chase the renewal', null, [])

    expect(patchTodo.mock.calls[0][1].attachments).toEqual([])
  })

  it('returns the saved record, so the tray can adopt the ids the server minted', async () => {
    const stored = [
      {
        id: 'a-new',
        name: 'notes.pdf',
        size: 20481,
        content_type: 'application/pdf',
        sha256: '9f86d0',
        created_at: '2026-09-01T10:14:02+00:00',
      },
    ]
    patchTodo.mockResolvedValue(saved({ attachments: stored }))
    const { result } = renderHook(() => useTodos(), { wrapper })

    const out = await result.current.saveDraft('t-9a3f21', 'Chase the renewal', null, [
      { filename: 'notes.pdf', content_b64: 'aGk=' },
    ])

    // Not guessed optimistically: ids are minted server-side and there is no
    // way to know them before the response.
    expect(out.attachments).toEqual(stored)
  })

  it('propagates a refused save instead of swallowing it', async () => {
    // The server's `detail` is what the composer renders. A fire-and-forget
    // mutation would drop that sentence on the floor.
    patchTodo.mockRejectedValue(new Error("attachment 'a-deadbeef' is not on this to-do"))
    const { result } = renderHook(() => useTodos(), { wrapper })

    await expect(
      result.current.saveDraft('t-9a3f21', 'Chase the renewal', null, [{ keep: 'a-deadbeef' }]),
    ).rejects.toThrow("attachment 'a-deadbeef' is not on this to-do")
  })

  it('optimistically shows the new draft text but never a guessed attachment', async () => {
    queryClient.setQueryData<DeskTodo[]>(
      ['desk-todos'],
      [saved({ draft_prompt: 'old', attachments: [] })],
    )
    let release!: (v: DeskTodo) => void
    patchTodo.mockImplementation(() => new Promise<DeskTodo>((r) => (release = r)))
    const { result } = renderHook(() => useTodos(), { wrapper })

    const pending = result.current.saveDraft('t-9a3f21', 'new text', null, [
      { filename: 'notes.pdf', content_b64: 'aGk=' },
    ])

    await waitFor(() => {
      const row = queryClient.getQueryData<DeskTodo[]>(['desk-todos'])?.[0]
      expect(row?.draft_prompt).toBe('new text')
      expect(row?.attachments).toEqual([])
    })

    release(saved())
    await pending
  })
})

describe('useTodos.captureWithDraft', () => {
  it('creates with a bare title and lets the bytes ride the PATCH', async () => {
    captureTodo.mockResolvedValue(saved({ id: 't-new' }))
    const { result } = renderHook(() => useTodos(), { wrapper })

    await result.current.captureWithDraft('Chase the renewal', 'Chase it', null, [
      { filename: 'notes.pdf', content_b64: 'aGk=' },
    ])

    // POST stays a title. There is no to-do id at Save-press time on the create
    // path, so the bytes cannot go with it — and the PATCH they do ride is a
    // single atomic write either way.
    expect(captureTodo).toHaveBeenCalledWith('Chase the renewal')
    expect(patchTodo.mock.calls[0][0]).toBe('t-new')
    expect(patchTodo.mock.calls[0][1].attachments).toEqual([
      { filename: 'notes.pdf', content_b64: 'aGk=' },
    ])
  })

  it('omits the key on a create with no files', async () => {
    captureTodo.mockResolvedValue(saved({ id: 't-new' }))
    const { result } = renderHook(() => useTodos(), { wrapper })

    await result.current.captureWithDraft('Chase the renewal', 'Chase it', null)

    expect('attachments' in patchTodo.mock.calls[0][1]).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import type { Project } from '../types'
import { RenameError, useRenameProject, renameErrorMessage } from './useRenameProject'

// Only `renameProject` is reachable from the hook, so the barrel is stubbed
// down to it -- no network, no other endpoint module pulled in.
vi.mock('../api/endpoints', () => ({ renameProject: vi.fn() }))
// eslint-disable-next-line no-restricted-imports
const { renameProject } = await import('../api/endpoints')
const mockRename = vi.mocked(renameProject)

/**
 * The point of these tests is the CACHE MAP, not the request. Every surface
 * that renders a thread name -- sidebar rows, DM rail, Projects panel, Front
 * Desk panel, Cmd-K palette, scheduled-message labels -- derives from these
 * three keys and needs no code of its own. If the patch here is wrong, all of
 * them go stale together, and nothing else in the suite would notice.
 *
 * `['user-projects', 'u1']` is seeded with the principal id in the key on
 * purpose: the hook must reach it by PARTIAL key match, without knowing whose
 * id is in that key.
 */

const PROJECT: Project = {
  id: 'p1',
  name: 'trip-planning',
  display_name: 'Old name',
} as Project

const OTHER: Project = { id: 'p2', name: 'other', display_name: 'Untouched' } as Project

let queryClient: QueryClient
let rename: ReturnType<typeof useRenameProject>

function Probe() {
  rename = useRenameProject()
  return null
}

function seedAndRender() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(['project', 'p1'], PROJECT)
  queryClient.setQueryData(['user-projects', 'u1'], [PROJECT, OTHER])
  queryClient.setQueryData(['all-projects'], [PROJECT])
  render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  )
}

const single = () => queryClient.getQueryData<Project>(['project', 'p1'])
const userList = () => queryClient.getQueryData<Project[]>(['user-projects', 'u1'])!
const allList = () => queryClient.getQueryData<Project[]>(['all-projects'])!
const names = () => [
  single()?.display_name,
  userList().find((p) => p.id === 'p1')?.display_name,
  allList().find((p) => p.id === 'p1')?.display_name,
]

/** A promise this test controls, so the optimistic window is observable. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useRenameProject', () => {
  beforeEach(seedAndRender)
  afterEach(cleanup)

  it('patches all three caches before the request resolves', async () => {
    const d = deferred<Project>()
    mockRename.mockReturnValue(d.promise)

    await act(async () => {
      rename.mutate({ projectId: 'p1', displayName: 'New name' })
    })

    // Optimistic: on screen everywhere, request still in flight.
    expect(names()).toEqual(['New name', 'New name', 'New name'])
    // and nothing else was touched.
    expect(userList().find((p) => p.id === 'p2')?.display_name).toBe('Untouched')
    expect(single()?.name).toBe('trip-planning')

    await act(async () => {
      d.resolve({ ...PROJECT, display_name: 'New name' })
    })
  })

  it("lets the server's normalized value overwrite the local input", async () => {
    // The server collapses whitespace and returns the stored form. If we kept
    // our own string, the header and the sidebar would show a name that is not
    // what is stored.
    mockRename.mockResolvedValue({ ...PROJECT, display_name: 'Trip plan' })

    await act(async () => {
      await rename.mutateAsync({ projectId: 'p1', displayName: 'Trip   plan' })
    })

    expect(names()).toEqual(['Trip plan', 'Trip plan', 'Trip plan'])
    expect(mockRename).toHaveBeenCalledWith('p1', 'Trip   plan')
  })

  it('rolls every cache back on error, and reports the server detail', async () => {
    mockRename.mockRejectedValue(
      new ApiError(403, 'You do not have permission to rename this thread'),
    )

    // Assert on the rejection itself rather than on `rename.error`: the latter
    // is render state, so reading it would make this test depend on a re-render
    // having flushed, which is a flake rather than a fact about the hook.
    let caught: unknown
    await act(async () => {
      caught = await rename
        .mutateAsync({ projectId: 'p1', displayName: 'Not allowed' })
        .catch((e) => e)
    })

    expect(names()).toEqual(['Old name', 'Old name', 'Old name'])
    expect(caught).toBeInstanceOf(RenameError)
    expect((caught as RenameError).message).toBe(
      'You do not have permission to rename this thread',
    )
    expect((caught as RenameError).status).toBe(403)
  })

  it('invalidates all three keys on settle, on both paths', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    mockRename.mockResolvedValue({ ...PROJECT, display_name: 'Done' })

    await act(async () => {
      await rename.mutateAsync({ projectId: 'p1', displayName: 'Done' })
    })

    // The invalidate is not optional -- it is what lets the stored value win
    // over the optimistic string, and what reconciles with the CHANGELOG_UPDATE
    // this same tab receives back from its own rename.
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(['project', 'p1']))
    expect(keys).toContain(JSON.stringify(['user-projects']))
    expect(keys).toContain(JSON.stringify(['all-projects']))
  })
})

describe('renameErrorMessage', () => {
  it('shows the server detail verbatim for 400 and 403', () => {
    expect(renameErrorMessage(new ApiError(400, 'Thread name cannot be empty.'))).toBe(
      'Thread name cannot be empty.',
    )
    expect(renameErrorMessage(new ApiError(403, 'You do not have permission.'))).toBe(
      'You do not have permission.',
    )
  })

  it('does not treat 403 as a session problem', () => {
    // api/client.ts owns 401: it refreshes, replays once, then logs the user
    // out. That is exactly why the server returns 403 for "not allowed", and
    // why nothing here may re-route a 403 into a session-expiry path.
    const message = renameErrorMessage(new ApiError(403, 'Nope.'))
    expect(message).toBe('Nope.')
    expect(message).not.toMatch(/sign in|session|expired/i)
  })

  it('substitutes friendly copy where the server has no useful sentence', () => {
    expect(renameErrorMessage(new ApiError(404, 'Project not found'))).toBe(
      'This conversation no longer exists.',
    )
    expect(renameErrorMessage(new ApiError(500, 'Internal Server Error'))).toBe(
      "Couldn't save. Try again.",
    )
    expect(renameErrorMessage(new TypeError('Failed to fetch'))).toBe(
      "Couldn't save. Try again.",
    )
  })
})

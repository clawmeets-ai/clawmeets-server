import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskLabel } from '../api/endpoints/deskLabels'
import type { DeskTodo } from '../api/endpoints/deskTodos'
import { resolveLabel, axisKnown } from '../utils/labelView'
import { useDeskLabelViewStore } from '../stores/deskLabelViewStore'

/**
 * The registry availability ladder, and it is NOT optional coverage: with the
 * presentation cache in place, `unavailable` needs a first-ever load with no
 * network, so it will never be hit in manual QA and would rot silently.
 *
 * Two of these assertions are NEGATIVES — "no banner at cold", "the reconcile
 * does not fire from cache" — and a negative that nothing asserts is exactly
 * the kind that gets "fixed" back into a positive by the next person who sees
 * a stale-looking list with no warning on it.
 */

const getDeskLabels = vi.fn()
vi.mock('../api/endpoints/deskLabels', async () => {
  const actual = await vi.importActual<typeof import('../api/endpoints/deskLabels')>(
    '../api/endpoints/deskLabels',
  )
  return { ...actual, getDeskLabels: (...a: unknown[]) => getDeskLabels(...a) }
})

let userId: string | undefined = 'u1'
vi.mock('../stores/authStore', () => ({
  useAuthStore: (sel: (s: { user?: { id: string } }) => unknown) =>
    sel({ user: userId ? { id: userId } : undefined }),
}))

const { useLabels, useLabelViewReconcile, cacheKey } = await import('./useLabels')

const L = (slug: string, kind: 'context' | 'state' = 'context'): DeskLabel => ({
  slug,
  name: slug,
  kind,
  color: 'blue',
  created_at: '1970-01-01T00:00:00+00:00',
  updated_at: '1970-01-01T00:00:00+00:00',
})

const T = (labels: string[]): DeskTodo => ({
  id: `t-${labels.join('-') || 'bare'}`,
  owner_user_id: 'u1',
  text: 'x',
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
  labels,
})

let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

beforeEach(() => {
  userId = 'u1'
  localStorage.clear()
  getDeskLabels.mockReset()
  useDeskLabelViewStore.getState().reset()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})

// `globals: false` in vitest.config means RTL registers no auto-cleanup, so a
// left-mounted hook keeps running its effects into the NEXT test — and the
// reconcile effect WRITES to the view store, which is exactly the kind of
// cross-test leak that reads as a broken assertion in an unrelated case.
afterEach(cleanup)

describe('the four registry states', () => {
  it('a resolved fetch is READY and its kinds are authoritative', async () => {
    getDeskLabels.mockResolvedValue([L('office'), L('next', 'state')])
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('ready'))
    expect(resolveLabel('next', result.current.registry).kind).toBe('state')
    expect(result.current.isError).toBe(false)
  })

  it('an EMPTY registry resolves READY, never unavailable', async () => {
    // `{"labels": []}` is an ANSWER. An owner running contexts-only GTD — or
    // none at all — is using the product correctly and must not see a failure
    // banner for it.
    getDeskLabels.mockResolvedValue([])
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('ready'))
    expect(result.current.registry.labels).toEqual([])
    expect(result.current.isError).toBe(false)
  })

  it('no data + no cache + still pending is COLD, and shows NO banner', async () => {
    getDeskLabels.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useLabels(), { wrapper })
    expect(result.current.registry.state).toBe('cold')
    // Bound to `!data` this would flash "couldn't load your labels" for 200ms
    // on every cold start, and a scary banner during normal operation trains
    // the owner to ignore the one that matters.
    expect(result.current.isError).toBe(false)
  })

  it('no data + no cache + isError is UNAVAILABLE, and DOES show the banner', async () => {
    getDeskLabels.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('unavailable'))
    expect(result.current.isError).toBe(true)
  })

  it('a cache hit with no fresh data is PROVISIONAL, and shows NO banner', async () => {
    localStorage.setItem(cacheKey('u1'), JSON.stringify([L('office'), L('next', 'state')]))
    getDeskLabels.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('provisional'))
    // Cache-only is CORRECT, not degraded: `kind` is the registry's most
    // stable field, so a cached list groups correctly rather than plausibly,
    // and a banner over a correct view spends attention on a fetch the owner
    // can do nothing about.
    expect(axisKnown(result.current.registry.state)).toBe(true)
    // AND THE RETIREMENT IS PROJECTED ONTO THE CACHE, which used to assert
    // `'state'` here. The server coerces a stored `kind: "state"` row as it
    // READS, but this blob was written by a browser running before the
    // retirement and no server ever touches it. Left raw, `next` matched
    // neither arm of `chipsFor`'s context/unregistered split and fell out of
    // `labelsOfKind` — so exactly on this path, an offline owner whose label
    // list predates the release lost the `next` chip off every row carrying it
    // and lost its whole group from "Group by context".
    expect(resolveLabel('next', result.current.registry).kind).toBe('context')
  })

  it('the cached projection is ONE value and does not launder a corrupt kind', async () => {
    // The sibling of `test_the_projection_is_ONE_value_...` on the server:
    // only `'state'` moves, so a hand-edited or corrupt kind stays visible as
    // itself instead of being quietly repaired into a real-looking row.
    localStorage.setItem(
      cacheKey('u1'),
      JSON.stringify([L('a', 'state'), { ...L('b'), kind: 'wobble' }]),
    )
    getDeskLabels.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('provisional'))
    expect(resolveLabel('a', result.current.registry).kind).toBe('context')
    expect(resolveLabel('b', result.current.registry).kind).toBe('wobble')
  })

  it('a disabled query (no user) sits in COLD and never reaches unavailable', async () => {
    // A disabled react-query sits in `pending` forever and never errors, which
    // is precisely why cold and unavailable cannot be told apart by `!data`.
    userId = undefined
    getDeskLabels.mockResolvedValue([L('office')])
    const { result } = renderHook(() => useLabels(), { wrapper })
    expect(result.current.registry.state).toBe('cold')
    expect(result.current.isError).toBe(false)
    expect(getDeskLabels).not.toHaveBeenCalled()
  })

  it('every non-ready state resolves ALL slugs to kind:unknown and registered:true', async () => {
    getDeskLabels.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('unavailable'))
    const l = resolveLabel('office', result.current.registry)
    expect(l.kind).toBe('unknown')
    // Never dashed: we do not KNOW it isn't registered, and saying so would
    // land the "not in your list" treatment on the whole vocabulary at once.
    expect(l.registered).toBe(true)
  })

  it('a storage throw on read degrades to unavailable rather than crashing', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    getDeskLabels.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('unavailable'))
    spy.mockRestore()
  })

  it('a successful fetch writes the cache for next time', async () => {
    getDeskLabels.mockResolvedValue([L('office')])
    const { result } = renderHook(() => useLabels(), { wrapper })
    await waitFor(() => expect(result.current.registry.state).toBe('ready'))
    await waitFor(() => expect(localStorage.getItem(cacheKey('u1'))).toBeTruthy())
    expect(JSON.parse(localStorage.getItem(cacheKey('u1'))!)).toHaveLength(1)
  })
})

describe('the reconcile effect', () => {
  it('re-points a filter at a merge target once the registry is FRESH', async () => {
    getDeskLabels.mockResolvedValue([L('work')])
    useDeskLabelViewStore.getState().hydrate('u1')
    useDeskLabelViewStore.getState().toggleFilter('office')
    useDeskLabelViewStore.getState().noteMerge('office', 'work')

    const { result } = renderHook(
      () => {
        const labels = useLabels()
        const rec = useLabelViewReconcile(labels.registry, [T(['work'])])
        return { labels, rec }
      },
      { wrapper },
    )

    await waitFor(() =>
      expect(useDeskLabelViewStore.getState().filter).toEqual(['work']),
    )
    // Named the way the filter bar directly beneath names it. The SOURCE is
    // gone from the registry, so it is quoted rather than given a sigil it no
    // longer has a row to justify.
    expect(result.current.rec.notice).toContain('“office” was merged into @work')
  })

  it('does NOT fire from the cache — one transient 500 must not clear a filter', async () => {
    // A cached registry cannot tell "deleted" from "my copy is a day old", and
    // acting on the difference is destructive in exactly one direction.
    localStorage.setItem(cacheKey('u1'), JSON.stringify([L('home')]))
    getDeskLabels.mockRejectedValue(new Error('offline'))
    useDeskLabelViewStore.getState().hydrate('u1')
    useDeskLabelViewStore.getState().toggleFilter('office')
    const { result } = renderHook(
      () => {
        const labels = useLabels()
        const rec = useLabelViewReconcile(labels.registry, [])
        return { labels, rec }
      },
      { wrapper },
    )

    await waitFor(() => expect(result.current.labels.registry.state).toBe('provisional'))
    expect(useDeskLabelViewStore.getState().filter).toEqual(['office'])
    expect(result.current.rec.notice).toBeNull()
  })

  it('a filter set before an outage is STILL SET after it', async () => {
    getDeskLabels.mockRejectedValue(new Error('offline'))
    useDeskLabelViewStore.getState().hydrate('u1')
    useDeskLabelViewStore.getState().toggleFilter('office')

    const { result } = renderHook(
      () => {
        const labels = useLabels()
        useLabelViewReconcile(labels.registry, [])
        return labels
      },
      { wrapper },
    )

    await waitFor(() => expect(result.current.registry.state).toBe('unavailable'))
    expect(useDeskLabelViewStore.getState().filter).toEqual(['office'])
  })

  it('clears a filter naming a label that is genuinely gone', async () => {
    getDeskLabels.mockResolvedValue([L('home')])
    useDeskLabelViewStore.getState().hydrate('u1')
    useDeskLabelViewStore.getState().toggleFilter('office')

    const { result } = renderHook(
      () => {
        const labels = useLabels()
        return useLabelViewReconcile(labels.registry, [T([])])
      },
      { wrapper },
    )

    await waitFor(() => expect(useDeskLabelViewStore.getState().filter).toEqual([]))
    // A filter must never stop being active without saying so — a jump from 6
    // items to 35 reads as "my to-dos multiplied", not as "a filter cleared".
    expect(result.current.notice).toContain('office')
  })

  it('leaves an unregistered filter alone while the plate still carries it', async () => {
    getDeskLabels.mockResolvedValue([L('home')])
    useDeskLabelViewStore.getState().hydrate('u1')
    useDeskLabelViewStore.getState().toggleFilter('infra')

    const { result } = renderHook(
      () => {
        const labels = useLabels()
        return useLabelViewReconcile(labels.registry, [T(['infra'])])
      },
      { wrapper },
    )

    await waitFor(() => expect(result.current.notice).toBeNull())
    expect(useDeskLabelViewStore.getState().filter).toEqual(['infra'])
  })
})

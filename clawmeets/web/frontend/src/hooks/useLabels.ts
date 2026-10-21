import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
  createLabel,
  deleteLabel,
  getDeskLabels,
  mergeLabel,
  patchLabel,
  reorderLabels,
  type CreateLabelBody,
  type DeskLabel,
  type PaletteToken,
} from '../api/endpoints/deskLabels'
import type { DeskTodo } from '../api/endpoints/deskTodos'
import { useAuthStore } from '../stores/authStore'
import { useDeskLabelViewStore } from '../stores/deskLabelViewStore'
import {
  reconcileView,
  toRegistry,
  type RegistryState,
  type ResolvedRegistry,
} from '../utils/labelView'

/**
 * The registry client: `GET /me/desk/labels` behind `['desk-labels']`, a
 * guarded per-user presentation cache, the four availability states, and the
 * six mutations.
 *
 * ONE CONSEQUENCE THAT HAS TO BE WRITTEN DOWN, because it decides how the
 * banner is bound: the query is `enabled: !!userId`, mirroring
 * `useTodos.ts:33`, and A DISABLED REACT-QUERY SITS IN `pending` FOREVER AND
 * NEVER REACHES `error`. So `cold` and `unavailable` genuinely cannot be told
 * apart by `!data`. Bind the failure banner to `isError`. Never to `!data`.
 */

const LABELS_KEY = ['desk-labels'] as const
const TODOS_KEY = ['desk-todos'] as const

const CACHE_PREFIX = 'clawmeets-desk-labels-v1'

export function cacheKey(userId: string | null | undefined): string {
  return `${CACHE_PREFIX}:${userId || 'anon'}`
}

/**
 * The presentation cache, guarded in BOTH directions: Safari private mode
 * throws on `getItem` and a quota error throws on `setItem`. `TodoRail` is
 * mounted inside the desk shell, so an unguarded throw takes down the desk
 * rather than one banner — a throw degrades to `unavailable`, which is a
 * DESIGNED state rather than a crash.
 *
 * PRESENTATION-ONLY, NEVER AUTHORITATIVE. That one rule answers both staleness
 * bugs: the cache may colour a chip and may name an axis, but it may never
 * trigger the destructive reconcile, because it cannot tell "this label was
 * deleted" from "my copy is a day old".
 */
export function readCache(userId: string | null | undefined): DeskLabel[] | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(cacheKey(userId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    // A row missing `slug` is unusable; drop it rather than rendering a chip
    // with no identity. A cache that half-parses is still a better answer than
    // no cache — the same posture the server takes toward its own document.
    //
    // THE RETIREMENT IS PROJECTED HERE TOO, and this is the one client-side
    // read of the registry that would otherwise miss it. `models/desk_label.py`
    // coerces a stored `kind: "state"` row to `context` as the SERVER reads,
    // but this blob was written by a browser running before the retirement and
    // no server touches it. Left raw, a cached legacy row matches neither arm
    // of `chipsFor`'s context/unregistered split and is dropped from
    // `labelsOfKind` — so under `provisional` (a cache hit with the fetch still
    // out, or failing) an owner's `next` chip and its whole group vanish from a
    // rail that rendered them before this release. Same one-value projection as
    // the server's `_visible`: only `'state'` moves, so a genuinely corrupt
    // kind stays visible as itself.
    return parsed
      .filter(
        (r): r is DeskLabel =>
          !!r && typeof r === 'object' && typeof (r as DeskLabel).slug === 'string',
      )
      .map((r) =>
        (r.kind as unknown) === 'state' ? { ...r, kind: 'context' as const } : r,
      )
  } catch {
    return null
  }
}

export function writeCache(userId: string | null | undefined, labels: DeskLabel[]): void {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(labels))
  } catch {
    // Quota or disabled storage. The in-memory query still serves this
    // session, which is the useful half; there is nothing to recover here.
  }
}

/**
 * The four states of §9.2, decided in exactly one place.
 *
 *   isSuccess                       -> ready
 *   !data + cache hit               -> provisional
 *   !data + no cache + still pending-> cold
 *   !data + no cache + isError      -> unavailable
 */
export function deriveRegistryState(
  q: Pick<UseQueryResult, 'isSuccess' | 'isError'>,
  hasData: boolean,
  cacheHit: boolean,
): RegistryState {
  if (q.isSuccess && hasData) return 'ready'
  if (cacheHit) return 'provisional'
  return q.isError ? 'unavailable' : 'cold'
}

export interface UseLabelsResult {
  registry: ResolvedRegistry
  isLoading: boolean
  /** True only while the query has actually errored — what the banner binds
   *  to. Never `!data`: bound to that it flashes "couldn't load your labels"
   *  for 200ms on every cold start, and a scary banner during normal operation
   *  trains the owner to ignore the one that matters. */
  isError: boolean
  refetch: () => void
  create: (body: CreateLabelBody) => Promise<DeskLabel>
  rename: (slug: string, name: string) => Promise<DeskLabel>
  recolour: (slug: string, color: PaletteToken) => Promise<DeskLabel>
  reorder: (orderedSlugs: string[]) => Promise<DeskLabel[]>
  remove: (slug: string) => Promise<{ detached_from: number }>
  merge: (slug: string, into: string) => Promise<{ moved: number; into: string }>
}

export function useLabels(): UseLabelsResult {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id)
  const noteMerge = useDeskLabelViewStore((s) => s.noteMerge)

  // Read ONCE at mount. Re-reading on every render would let a write from
  // another tab silently become this tab's "provisional" answer mid-session,
  // which is precisely the authority the cache must not have.
  const [cached] = useState<DeskLabel[] | null>(() => readCache(userId))

  const query = useQuery<DeskLabel[]>({
    queryKey: LABELS_KEY,
    queryFn: getDeskLabels,
    enabled: !!userId,
    staleTime: 0,
  })

  const { data, isSuccess, isError } = query

  useEffect(() => {
    if (isSuccess && data) writeCache(userId, data)
  }, [isSuccess, data, userId])

  const state = deriveRegistryState({ isSuccess, isError }, !!data, !!cached)
  const labels = data ?? cached ?? []

  const registry = useMemo(() => toRegistry(labels, state), [labels, state])

  const invalidateLabels = useCallback(
    () => queryClient.invalidateQueries({ queryKey: LABELS_KEY }),
    [queryClient],
  )
  // delete and merge mutate BOTH documents. Refetching only the registry would
  // render correct groups over stale items; react-query dedupes concurrent
  // invalidations, so the extra line is free.
  const invalidateBoth = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: LABELS_KEY })
    queryClient.invalidateQueries({ queryKey: TODOS_KEY })
  }, [queryClient])

  const createM = useMutation({ mutationFn: createLabel, onSuccess: invalidateLabels })
  const patchM = useMutation({
    mutationFn: (v: { slug: string; fields: { name?: string; color?: PaletteToken } }) =>
      patchLabel(v.slug, v.fields),
    onSuccess: invalidateLabels,
  })
  const reorderM = useMutation({ mutationFn: reorderLabels, onSuccess: invalidateLabels })
  const deleteM = useMutation({ mutationFn: deleteLabel, onSuccess: invalidateBoth })
  const mergeM = useMutation({
    mutationFn: (v: { slug: string; into: string }) => mergeLabel(v.slug, v.into),
    onSuccess: invalidateBoth,
  })

  return {
    registry,
    isLoading: query.isPending && !!userId,
    isError,
    refetch: useCallback(() => void query.refetch(), [query]),
    create: useCallback((body) => createM.mutateAsync(body), [createM]),
    rename: useCallback(
      (slug, name) => patchM.mutateAsync({ slug, fields: { name } }),
      [patchM],
    ),
    // PATCH carries name/color ONLY. The server accepts an equal `kind` echo as
    // a no-op, but sending one would mean the sheet is PATCHing the whole row
    // back — which is a bug in the sheet, not a use of the route.
    recolour: useCallback(
      (slug, color) => patchM.mutateAsync({ slug, fields: { color } }),
      [patchM],
    ),
    reorder: useCallback((slugs) => reorderM.mutateAsync(slugs), [reorderM]),
    remove: useCallback((slug) => deleteM.mutateAsync(slug), [deleteM]),
    merge: useCallback(
      async (slug, into) => {
        const result = await mergeM.mutateAsync({ slug, into })
        // The tab that PERFORMED the merge learns `into` from the response;
        // every other tab learns it from the envelope. Both land here, so the
        // filter follows the merge everywhere.
        noteMerge(result.from, result.into)
        return result
      },
      [mergeM, noteMerge],
    ),
  }
}

/**
 * §1.1's reconcile, wired to the store.
 *
 * GATED ON A FRESH REGISTRY — `isSuccess`, not `data != null`. A cached
 * registry cannot tell "deleted" from "my copy is a day old", and acting on
 * the difference is destructive in one direction only: one transient 500 would
 * permanently clear a filter the owner set on purpose and pop a notice
 * claiming a label was deleted when it wasn't. A filter that shows nothing
 * while the network is down is strictly the better failure.
 *
 * Returns the notice to render, or null. The notice is a RETURN VALUE rather
 * than more store state because it is one-shot: it belongs to the render that
 * follows the reconcile, and persisting it would resurrect a week-old
 * "@office was deleted" on the next cold load.
 */
export function useLabelViewReconcile(
  registry: ResolvedRegistry,
  open: DeskTodo[],
): { notice: string | null; dismissNotice: () => void } {
  const [notice, setNotice] = useState<string | null>(null)
  const group = useDeskLabelViewStore((s) => s.group)
  const filter = useDeskLabelViewStore((s) => s.filter)
  const matchAll = useDeskLabelViewStore((s) => s.matchAll)
  // Read but never reconciled — `reconcileView` carries it through untouched.
  // It is here because `applyReconcile` writes the WHOLE persisted view back to
  // storage, so omitting the key would unpersist the owner's state filter on
  // the next registry refetch.
  const states = useDeskLabelViewStore((s) => s.states)
  const collapsed = useDeskLabelViewStore((s) => s.collapsed)
  const mergeHints = useDeskLabelViewStore((s) => s.mergeHints)
  const applyReconcile = useDeskLabelViewStore((s) => s.applyReconcile)

  // The plate is an INPUT, not a trigger: a slug absent from the registry is
  // not thereby dead — an agent can write one at any time and the owner can
  // filter on it. It is dead only when neither the registry nor the plate has
  // it. Held in a ref so a plate refetch does not re-run the reconcile on its
  // own; the registry is what says the vocabulary moved.
  const plateSlugs = useRef<Set<string>>(new Set())
  plateSlugs.current = new Set(open.flatMap((t) => t.labels ?? []))

  const fresh = registry.state === 'ready'
  const labels = registry.labels

  useEffect(() => {
    if (!fresh) return
    const result = reconcileView(
      { group, filter, matchAll, states, collapsed },
      labels,
      plateSlugs.current,
      mergeHints,
    )
    if (!result.changed) return
    applyReconcile(result.next)
    if (result.notice) setNotice(result.notice)
    // `collapsed` and `matchAll` are read but must not re-trigger: the reconcile
    // is a response to the REGISTRY moving, and re-running it on a fold would
    // re-announce a deletion every time the owner collapses a group.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, labels, mergeHints, applyReconcile])

  return { notice, dismissNotice: useCallback(() => setNotice(null), []) }
}

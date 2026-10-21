import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMatch, useNavigate } from 'react-router-dom'
import {
  deleteBriefTab,
  getBriefTab,
  getBriefTabs,
  SAMPLE_BRIEF_SLUG,
  type BriefTab,
  type BriefTabDocument,
} from '../api/endpoints/briefTabs'
import { useAuthStore } from '../stores/authStore'

/** Fetches the metadata for every briefing the current user owns. The list
 *  refreshes on BRIEF_TAB_SYNC envelopes (see `useWebSocketUpdates` in
 *  `hooks/useWebSocket.ts`) — no polling needed.
 *
 *  Server returns tabs sorted by `generated_at` desc (newest first),
 *  which is also the desk's default briefing order. */
export function useBriefTabs() {
  const userId = useAuthStore((s) => s.user?.id)
  return useQuery<BriefTab[]>({
    queryKey: ['brief-tabs', userId],
    queryFn: getBriefTabs,
    enabled: !!userId,
    staleTime: 0,
  })
}

/** One briefing's document, keyed separately from the metadata list because it
 *  is now its own request.
 *
 *  `slug === null` disables the query, which is how the sample slug is kept
 *  entirely off the network: its document is a local constant and no request
 *  for it would ever succeed.
 *
 *  `retry: false` because the interesting failure here is a 404 — a briefing
 *  deleted between the list render and the click, or a legacy artifact the
 *  server now skips. Both are ordinary answers, not flaky ones, and retrying
 *  only delays the page that says so. */
export function useBriefTabDocument(slug: string | null) {
  const userId = useAuthStore((s) => s.user?.id)
  return useQuery<BriefTabDocument>({
    queryKey: ['brief-tab', userId, slug],
    queryFn: () => getBriefTab(slug as string),
    enabled: !!userId && !!slug,
    staleTime: 0,
    retry: false,
  })
}

/** Warm `['brief-tab', userId, slug]` from a hover or focus on a rail row, so
 *  the round trip the metadata-list read path costs is usually already spent
 *  by the time the click lands. */
export function usePrefetchBriefTab() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id)
  return useCallback(
    (slug: string) => {
      if (!userId || !slug || slug === SAMPLE_BRIEF_SLUG) return
      void queryClient.prefetchQuery({
        queryKey: ['brief-tab', userId, slug],
        queryFn: () => getBriefTab(slug),
      })
    },
    [queryClient, userId],
  )
}

/** Delete one of the owner's own briefings, from the rail.
 *
 *  THE CACHE KEYS ARE MATCHED BY PREFIX, NOT REBUILT FROM `useAuthStore`. This
 *  is the house habit rather than a departure from it: `useWebSocketUpdates`
 *  has been invalidating `['brief-tabs']` by prefix all along, and that prefix
 *  addresses exactly one key shape in the app. Rebuilding `['brief-tabs',
 *  userId]` here would be byte-identical to the read's key, since both key
 *  on the same `useAuthStore` id this hook would have read. Prefix matching is
 *  simply the shorter way to say the same thing, and one less place to keep in
 *  step if the key gains an element. The document cannot go the same way:
 *  `['brief-tab', userId, slug]` has no prefix that excludes every OTHER
 *  briefing's document, so it is matched on its slug element instead.
 *
 *  The document is REMOVED rather than invalidated: the server would now 404
 *  it, so there is nothing to refetch and a stale entry would only give the
 *  briefing page something wrong to render on the way out.
 *
 *  Navigating away is part of the delete, not a caller's afterthought. If the
 *  owner is reading the briefing they just deleted, they go back to `/desk` —
 *  they asked for it to be gone, so leaving them on its page to watch it turn
 *  into "no longer published" is a worse answer than the desk. `replace` so
 *  Back does not return them to a URL that 404s now. This covers ONLY the tab
 *  that pressed delete; a delete arriving over the websocket in another of
 *  their tabs never reaches this hook, and that tab is deliberately left where
 *  it is with the existing "no longer published" frame rather than being
 *  navigated out from under someone who pressed nothing.
 *
 *  Failure is left to the caller. The rail says so in place and keeps the row
 *  — the one thing a delete must never do is drop the row and be wrong. */
export function useDeleteBriefTab() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const openSlug = useMatch('/desk/briefings/:slug')?.params.slug

  return useMutation({
    mutationFn: (slug: string) => deleteBriefTab(slug),
    onSuccess: (_data, slug) => {
      // `useMatch` hands back an ALREADY-DECODED param (react-router v6), so
      // this compares the decoded slug the mutation was called with against a
      // decoded param. Decoding twice here would throw on a lone `%` INSIDE
      // `onSuccess` and skip the cache writes below it, leaving a briefing the
      // server has already destroyed sitting on the rail.
      if (openSlug === slug) {
        navigate('/desk', { replace: true })
      }
      queryClient.invalidateQueries({ queryKey: ['brief-tabs'] })
      queryClient.removeQueries({
        queryKey: ['brief-tab'],
        predicate: (q) => q.queryKey[2] === slug,
      })
    },
  })
}

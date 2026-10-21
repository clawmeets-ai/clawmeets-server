import { useQuery } from '@tanstack/react-query'
import { searchMessages } from '../api/endpoints'
import { ApiError } from '../api/client'
import type { SearchHit } from '../types'
import { useDebouncedValue } from './useDebouncedValue'

/** SEARCH_API_CONTRACT.md §2.3 — normative client-side expectations. */
export const SEARCH_DEBOUNCE_MS = 150
export const SEARCH_MIN_CHARS = 2
const SEARCH_RETRY_DELAY_MS = 2000

export type MessageSearchState =
  | { kind: 'idle' } // < 2 chars — nothing in flight
  | { kind: 'loading' }
  | { kind: 'ready'; hits: SearchHit[]; indexing: boolean; hasMore: boolean }
  | { kind: 'unavailable' } // 503 — the index is down, after the one retry
  | { kind: 'error' } // anything else

/**
 * The whole of contract §2.3 lives here and nowhere else.
 *
 *   debounce       150 ms via useDebouncedValue.
 *   minimum        trimmed length < 2 -> 'idle', query disabled, NO request issued.
 *   abort          React Query's `signal` is forwarded to fetch, so superseding
 *                  the key aborts the previous request.
 *   stale discard  two independent layers, both cheap:
 *                  (1) the response is cached under ITS OWN debounced-query key,
 *                      so a late reply for an older key is never read as current;
 *                  (2) an explicit `data.query === debounced` guard before we
 *                      hand hits out — the echoed `query` (§3.1) is the discard
 *                      key, which is why no sequence number is needed.
 *   retry          the app-wide default is `retry: 1` (queryClient.ts), which
 *                  would re-issue a 422/401 the contract says never to retry.
 *                  Overridden here: 503 only, once, after ~2 s.
 *   closed         not expressible: the palette UNMOUNTS on close, taking this
 *                  hook — its debounce timer, its query observer and its idea
 *                  of the current query — with it. There is deliberately no
 *                  `enabled` flag any more. One held the "is it open?" fact
 *                  while the component kept its state alive across a close,
 *                  which is how a reopen could paint the previous search's
 *                  hits under an empty input for one debounce window.
 *
 * Never throws to the caller: every failure maps onto a state.
 */
export function useMessageSearch(rawQuery: string): MessageSearchState {
  const debounced = useDebouncedValue(rawQuery.trim(), SEARCH_DEBOUNCE_MS)
  const active = debounced.length >= SEARCH_MIN_CHARS

  const { data, isError, error, isPending } = useQuery({
    queryKey: ['message-search', debounced],
    queryFn: ({ signal }) => searchMessages({ q: debounced }, signal),
    enabled: active,
    // `failureCount` is 0 on the first failure (it is incremented after this
    // callback), so `< 1` is exactly one retry.
    retry: (failureCount, err) =>
      failureCount < 1 && err instanceof ApiError && err.status === 503,
    retryDelay: SEARCH_RETRY_DELAY_MS,
  })

  if (!active) return { kind: 'idle' }

  if (isError) {
    return error instanceof ApiError && error.status === 503
      ? { kind: 'unavailable' }
      : { kind: 'error' }
  }

  // A response for a superseded query is not a result — keep showing "searching"
  // rather than a stale answer under the current input.
  if (isPending || !data || data.query !== debounced) return { kind: 'loading' }

  return {
    kind: 'ready',
    hits: data.hits,
    indexing: data.indexing,
    hasMore: data.has_more,
  }
}

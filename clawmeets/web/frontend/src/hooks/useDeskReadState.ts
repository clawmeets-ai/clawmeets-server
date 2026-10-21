import { useCallback, useEffect, useState } from 'react'
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import {
  getDeskReadState,
  putDeskReadState,
  type DeskReadState,
} from '../api/endpoints/deskReadState'
import { useAuthStore } from '../stores/authStore'
import { useUnreadStore } from '../stores/unreadStore'
import { deskRoomKey, DISMISS_SENTINEL, type DeskUpdate } from './useDeskUpdates'

const READ_STATE_KEY = ['desk-read-state'] as const
// Prefix only — the real key is ['desk-sign-offs', limit] (owned by
// useDeskRecentlyDone). Invalidating the prefix matches every variant, so this
// works without knowing how many cards that section asks for.
const SIGN_OFFS_KEY_PREFIX = ['desk-sign-offs'] as const

/**
 * Hydration query for the owner's server-persisted desk read-state. Mounts with
 * the desk (called from `useDeskUpdates`, deduped by query key across every
 * consumer) and, on each successful fetch, merges every row into `unreadStore`
 * via `mergeServerReadState` (last-writer-wins on `updated_at`).
 *
 * This GET — on mount and on window focus — is the cross-device correctness
 * path: it converges every device regardless of whether the best-effort
 * DESK_READ_STATE_SYNC WS event reached this particular session. The hub does
 * fan a sync out to EVERY live session of the owner (`WSHub._conns` holds a set
 * of queues per participant, and `send_to` writes to all of them), so the live
 * path normally covers other devices on its own — but a device that was asleep,
 * offline, or mid-reconnect missed the envelope entirely, and only this GET
 * catches it up.
 *
 * Also reports `hydrated`: whether the server read-state has been folded into
 * the store yet. It flips true once the GET has *settled* (success OR error) and
 * any returned rows have been merged into `unreadStore` — or immediately when
 * there is no logged-in user (query disabled, nothing to wait for). Setting the
 * flag in the SAME effect that performs the merge guarantees the store is
 * advanced before `hydrated` becomes true, so a consumer gating the read/unread
 * decision on it never observes a pre-merge (stale-watermark) frame.
 */
export function useDeskReadState(): UseQueryResult<DeskReadState[]> & {
  hydrated: boolean
} {
  const userId = useAuthStore((s) => s.user?.id)
  const mergeServerReadState = useUnreadStore((s) => s.mergeServerReadState)
  const [hydrated, setHydrated] = useState(false)

  const query = useQuery<DeskReadState[]>({
    queryKey: READ_STATE_KEY,
    queryFn: getDeskReadState,
    enabled: !!userId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  // React Query v5 dropped `onSuccess` on useQuery, so merge in an effect keyed
  // on the fetched rows. mergeServerReadState is LWW, so re-merging the same
  // data (e.g. after a focus refetch) is a no-op. The merge runs before
  // `hydrated` flips, so gating consumers never see the pre-merge watermarks.
  const rows = query.data
  const enabled = !!userId
  const settled = query.isFetched
  useEffect(() => {
    if (!enabled) {
      // No user ⇒ the query is disabled; there is no server state to wait for.
      setHydrated(true)
      return
    }
    if (!settled) return // GET not yet resolved once — keep gating.
    if (rows) {
      for (const r of rows) {
        mergeServerReadState(
          deskRoomKey(r.project_id),
          r.last_seen_message_id,
          r.updated_at,
        )
      }
    }
    // Settled with no rows (empty result or GET error) ⇒ fall back to the local
    // watermarks; still mark hydrated so the desk stops gating.
    setHydrated(true)
  }, [enabled, settled, rows, mergeServerReadState])

  return Object.assign(query, { hydrated })
}

/**
 * Optimistic mark-read for one desk card. Writes the watermark to the store
 * immediately (the card animates out), PUTs it to the server, then reconciles
 * against the server response (LWW). On failure the store is rolled back to its
 * pre-optimistic snapshot so the card reappears, and `onError` is invoked with a
 * user-facing message.
 *
 * `markRead` is a plain closure over global singletons (the store + queryClient)
 * rather than a component-scoped `useMutation`, because the card unmounts the
 * instant the optimistic write drops it from the feed — a mutation observer
 * would be torn down before the network settles, so its onSuccess/onError would
 * never run.
 */
export function useMarkDeskRead(): {
  markRead: (u: DeskUpdate, onError?: (msg: string) => void) => void
} {
  const queryClient = useQueryClient()

  const markRead = useCallback(
    (u: DeskUpdate, onError?: (msg: string) => void) => {
      const key = deskRoomKey(u.projectId)
      const watermark = u.latestMessageId ?? DISMISS_SENTINEL
      // Snapshot BEFORE the optimistic write so a failed PUT can restore exactly.
      const { lastSeenMessages, deskReadUpdatedAt } = useUnreadStore.getState()
      const prevMessageId = lastSeenMessages[key]
      const prevUpdatedAt = deskReadUpdatedAt[key]

      // Optimistic: card drops from useDeskUpdates on the next render.
      useUnreadStore.getState().markAsSeen(key, watermark)

      putDeskReadState({
        project_id: u.projectId,
        chatroom_name: 'user-communication',
        last_seen_message_id: watermark,
      })
        .then((row) => {
          useUnreadStore
            .getState()
            .mergeServerReadState(key, row.last_seen_message_id, row.updated_at)
          queryClient.invalidateQueries({ queryKey: READ_STATE_KEY })
          // Land the card in "Recently done" without waiting on the WS echo.
          // The server does echo DESK_READ_STATE_SYNC back to the originating
          // session, but that path is best-effort — with the socket down or
          // mid-reconnect the card is already out of the live lane and would sit
          // in neither place until a remount or a focus refetch past staleTime,
          // which reads as data loss. Bare prefix: matches ['desk-sign-offs', iso].
          queryClient.invalidateQueries({ queryKey: SIGN_OFFS_KEY_PREFIX })
        })
        .catch(() => {
          useUnreadStore
            .getState()
            .rollbackDeskRead(key, prevMessageId, prevUpdatedAt)
          onError?.('Couldn’t sync ‘read’ — try again.')
        })
    },
    [queryClient],
  )

  return { markRead }
}

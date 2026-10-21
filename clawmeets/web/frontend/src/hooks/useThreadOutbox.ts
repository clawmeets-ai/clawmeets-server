import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getThreadOutbox, type OutboxItem } from '../api/endpoints/channels'
import { outboxInFlight } from '../utils/channelThreads'

/** How often the open thread asks again while a send may still change. */
export const OUTBOX_POLL_MS = 5_000

/** How long an outgoing message with no outbox rows yet counts as on its way. */
export const OUTBOX_FRESH_MS = 2 * 60_000

/** An outgoing message (the agent's reply or the owner's post) in the thread. */
export interface OutgoingMessage { id: string; ts: string }

/** Whether `m` has no rows yet and is still young enough to be waiting for them. */
export function awaitingRows(m: OutgoingMessage, rows: OutboxItem[], now: number): boolean {
  return now - new Date(m.ts).getTime() < OUTBOX_FRESH_MS && !rows.some((r) => r.message_id === m.id)
}

/**
 * The open channel thread's outbox rows, grouped by message id, for the line
 * under each outgoing message. One call for the thread
 * (`GET /me/channels/threads/{id}/outbox`). It asks again only while
 * something is pending or sending, or while one of `outgoing` is fresh and has
 * no rows yet; it stops on an error. Freshness is read from the clock when the
 * interval is decided, so the window closes without a re-render; when the last
 * waiting message turns stale the hook re-renders once, so its "on its way"
 * line goes too. The WebSocket refreshes it on every project update.
 */
export function useThreadOutbox(projectId: string, { enabled, outgoing = [] }: {
  enabled: boolean; outgoing?: OutgoingMessage[]
}): Map<string, OutboxItem[]> {
  const { data } = useQuery({
    queryKey: ['channel-outbox', projectId],
    queryFn: () => getThreadOutbox(projectId),
    enabled: enabled && !!projectId,
    retry: false,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false
      const rows = q.state.data ?? []
      const now = Date.now()
      return outboxInFlight(rows) || outgoing.some((m) => awaitingRows(m, rows, now)) ? OUTBOX_POLL_MS : false
    },
  })

  // Re-render when the soonest waiting message stops counting as fresh.
  const [, setExpired] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const now = Date.now()
    const waits = outgoing
      .filter((m) => awaitingRows(m, data ?? [], now))
      .map((m) => new Date(m.ts).getTime() + OUTBOX_FRESH_MS - now)
    if (waits.length === 0) return
    const timer = setTimeout(() => setExpired((n) => n + 1), Math.min(...waits) + 1)
    return () => clearTimeout(timer)
  })

  return useMemo(() => {
    const byMessage = new Map<string, OutboxItem[]>()
    for (const row of data ?? []) {
      const rows = byMessage.get(row.message_id) ?? []
      rows.push(row)
      byMessage.set(row.message_id, rows)
    }
    return byMessage
  }, [data])
}

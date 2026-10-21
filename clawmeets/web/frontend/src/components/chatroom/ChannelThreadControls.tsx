import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Hand, Undo2 } from 'lucide-react'
import { ApiError } from '../../api/client'
import { getChannelThread, setThreadPaused, type ChannelThreadRow } from '../../api/endpoints/channels'
import { CHANNEL_THREADS_KEY } from '../../hooks/useChannelThreads'
import { THREAD_COPY, contactLabel } from '../../utils/channelThreads'
import ChannelBadge from '../channels/ChannelBadge'

/**
 * Above a channel thread's messages, for its owner: which channel it came from
 * and who the person is, and the per-thread takeover. "Take over" pauses the
 * agent on this one thread (the person's messages still arrive, the agent
 * doesn't answer, what the owner types goes out on the channel); "Hand back to
 * the agent" un-pauses. The state shown is always the server's answer, never
 * a guess: after the PUT the list is updated from the response and refetched.
 *
 * A thread whose connection was removed has nothing to pause: no control.
 */
export function ChannelThreadBar({ row }: { row: ChannelThreadRow }) {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [resumed, setResumed] = useState(false)
  const contact = contactLabel(row.contact_name, row.channel)

  const pause = useMutation({
    mutationFn: (paused: boolean) => setThreadPaused(row.project_id, paused),
    onMutate: () => setError(null),
    onSuccess: (answer, asked) => {
      queryClient.setQueryData<ChannelThreadRow[]>(CHANNEL_THREADS_KEY, (rows) =>
        rows?.map((r) => (r.project_id === answer.project_id ? { ...r, paused: answer.paused } : r)),
      )
      void queryClient.invalidateQueries({ queryKey: CHANNEL_THREADS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['channel-thread', row.project_id] })
      setResumed(!asked && !answer.paused)
    },
    onError: (e) => {
      setError(
        e instanceof ApiError && e.status === 403 ? THREAD_COPY.forbidden
          : e instanceof ApiError && e.status === 404 ? THREAD_COPY.gone
          : THREAD_COPY.failed,
      )
    },
  })

  return (
    <div data-testid="channel-thread-bar" className="flex-shrink-0 border-b border-border px-6 py-2 text-xs space-y-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <ChannelBadge channel={row.channel} size={13} />
        <bdi className="min-w-0 truncate text-gray-600" title={contact} data-testid="channel-thread-via">
          {THREAD_COPY.via(row.channel, contact)}
        </bdi>
        {!row.connection_removed && (
          <>
            <span className="ml-auto shrink-0 text-gray-400" data-testid="channel-pause-state">
              {THREAD_COPY.pauseState(row.paused)}
            </span>
            <button
              type="button"
              disabled={pause.isPending}
              onClick={() => pause.mutate(!row.paused)}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {row.paused ? <Undo2 className="w-3.5 h-3.5" /> : <Hand className="w-3.5 h-3.5" />}
              {row.paused ? THREAD_COPY.resume : THREAD_COPY.pause}
            </button>
          </>
        )}
      </div>
      {!row.connection_removed && !row.paused && (
        <p className="text-gray-400">{THREAD_COPY.pauseNote}</p>
      )}
      {row.paused && (
        <p role="status" data-testid="channel-paused-banner" className="p-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800">
          {THREAD_COPY.pausedBanner(contact, row.channel)}
        </p>
      )}
      {resumed && !row.paused && (
        <p role="status" data-testid="channel-resume-note" className="text-gray-600">
          {THREAD_COPY.resumeNote(contact)}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="channel-pause-error" className="text-red-600">{error}</p>
      )}
    </div>
  )
}

/** What the composer of a channel thread says before the owner sends. */
export function channelComposer(row: ChannelThreadRow): { sendLabel?: string; placeholder?: string } {
  if (row.connection_removed) return {}
  return {
    sendLabel: THREAD_COPY.sendLabel(row.channel),
    placeholder: THREAD_COPY.placeholder(row.channel, contactLabel(row.contact_name, row.channel)),
  }
}

/**
 * Above the composer: where what the owner types will go, said BEFORE they
 * send. Removed: nowhere. Disabled: it waits for Enable. WhatsApp with the
 * window closed: it won't be delivered until the person writes again.
 * Un-paused: it goes out AND the agent reads it.
 */
export function ChannelComposerNote({ row, messageCount }: { row: ChannelThreadRow; messageCount: number }) {
  const { data: status } = useQuery({
    queryKey: ['channel-thread', row.project_id, messageCount],
    queryFn: () => getChannelThread(row.project_id),
    retry: false,
    enabled: row.channel === 'whatsapp' && !row.connection_removed,
  })
  const contact = contactLabel(row.contact_name, row.channel)
  const lines: string[] = []
  if (row.connection_removed) {
    lines.push(THREAD_COPY.removedNote(row.channel))
  } else {
    if (!row.connection_enabled) lines.push(THREAD_COPY.disabledNote(row.channel))
    if (status && status.window_closed_at !== null) lines.push(THREAD_COPY.windowClosed(contact))
    if (!row.paused) lines.push(THREAD_COPY.unpausedNote(row.channel))
  }
  if (lines.length === 0) return null
  return (
    <div data-testid="channel-composer-note" className="px-4 pt-2 text-xs text-gray-600 space-y-0.5">
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  )
}

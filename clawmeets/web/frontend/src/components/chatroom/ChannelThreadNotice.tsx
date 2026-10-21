import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { getChannelThread } from '../../api/endpoints/channels'

/**
 * Above a channel thread's messages: WhatsApp's 24-hour window has closed, so
 * the agent's replies since the contact last wrote are held and won't be sent.
 *
 * Asks `GET /me/channels/threads/{project_id}` and shows nothing at all when
 * that fails — a 404 (not a channel thread, or channels are off), a 403 (not
 * the owner) or anything else — or when the window is open. `messageCount`
 * is part of the query key, so a new message (the contact writing again)
 * refetches and the notice goes away; it also asks again every minute, since
 * a reply can be held later with no new message (a retry after the close,
 * Enable after the close). It polls only while the last answer was a thread:
 * an ordinary Front Desk room answers 404 forever, and a thread whose
 * connection was removed starts answering 404, so polling stops on the first
 * error and the notice goes away (react-query keeps the last good `data`
 * after an error, so `isError` decides, not `data`).
 *
 * The contact's name and the held replies came from outside or from the
 * agent; both render as text, never markup.
 */

export const THREAD_NOTICE_COPY = {
  closed: "WhatsApp's 24-hour window has closed.",
  held: (n: number) =>
    n === 1 ? "1 reply was held and won't be sent." : `${n} replies were held and won't be sent.`,
  writeAgain: (contact: string) => `${contact} has to write again before the agent can answer.`,
  notSent: 'Not sent',
  // An earlier attempt may have reached Meta (it timed out, or the server
  // stopped mid-send): don't tell the owner it wasn't delivered.
  maybeSent: 'May have been delivered — not sent again',
} as const

export default function ChannelThreadNotice({ projectId, messageCount }: {
  projectId: string; messageCount: number
}) {
  const { data, isError } = useQuery({
    queryKey: ['channel-thread', projectId, messageCount],
    queryFn: () => getChannelThread(projectId),
    retry: false,
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data && q.state.status !== 'error' ? 60_000 : false),
  })
  if (!data || isError || data.window_closed_at === null) return null
  // One reply sent as several parts is held as several rows: count replies.
  const replies = new Set(data.held.map((reply) => reply.message_id)).size
  return (
    <div
      role="status"
      data-testid="channel-thread-notice"
      className="flex-shrink-0 max-h-48 overflow-y-auto mx-4 mt-3 p-3 border rounded-lg text-xs bg-amber-50 border-amber-200 text-amber-800 space-y-2"
    >
      <p className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span data-testid="channel-thread-notice-text">
          {THREAD_NOTICE_COPY.closed}
          {replies > 0 && ` ${THREAD_NOTICE_COPY.held(replies)}`}
          {` ${THREAD_NOTICE_COPY.writeAgain(data.contact_name)}`}
        </span>
      </p>
      {data.held.length > 0 && (
        <ol className="space-y-1.5 pl-6">
          {data.held.map((reply) => (
            <li key={`${reply.message_id}:${reply.part_index}`} data-testid="channel-thread-held" className="text-gray-500">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {reply.reason === 'window_closed_maybe_sent' ? THREAD_NOTICE_COPY.maybeSent : THREAD_NOTICE_COPY.notSent}
              </span>
              {/* As the agent wrote it, as text: never markdown, never HTML. */}
              <span className="block whitespace-pre-wrap break-words" data-testid="channel-thread-held-text">
                {reply.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

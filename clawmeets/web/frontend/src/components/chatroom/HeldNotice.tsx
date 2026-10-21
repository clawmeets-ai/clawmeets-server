import { useEffect, useMemo, useRef } from 'react'
import { Clock } from 'lucide-react'
import type { HeldForReview } from '../../api/endpoints/hub'
import { sendingKey, useHeldPostsStore } from '../../stores/heldPostsStore'
import { isChatMessage, type ChatLogEntry } from '../../types'
import { HELD_COPY } from '../../utils/agentAccessCopy'

/** One held post: why it waits, the server's own words, and no retry. */
export function HeldNotice({ held, content }: { held: HeldForReview; content: string }) {
  return (
    <div
      role="status"
      className="ml-auto max-w-[80%] rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-sm"
      data-testid="held-notice"
    >
      <p className="whitespace-pre-wrap text-gray-500">{content}</p>
      <p className="mt-1 flex items-center gap-1 text-xs font-medium text-gray-700">
        <Clock className="h-3 w-3" aria-hidden />
        {HELD_COPY.line(held.reason)} {HELD_COPY.dontResend}
      </p>
      {held.message && <p className="mt-0.5 text-[11px] text-gray-500" data-testid="held-server-message">{held.message}</p>}
    </div>
  )
}

/**
 * The room's held posts, above its composer. A post leaves once a message of
 * the viewer's with the same content appears that was not in the room when
 * the post was first shown (the delivery on reopen).
 */
export function HeldNotices({ projectId, room, messages, viewerId }: {
  projectId: string
  room: string
  messages: readonly ChatLogEntry[] | undefined
  viewerId: string | undefined
}) {
  const all = useHeldPostsStore((s) => s.posts)
  const remove = useHeldPostsStore((s) => s.remove)
  const delivered = useHeldPostsStore((s) => s.delivered)
  const sending = useHeldPostsStore((s) => s.sending)
  const posts = useMemo(() => all.filter((p) => p.projectId === projectId && p.room === room), [all, projectId, room])
  // Message ids of the viewer's, by content; posts delivered at once are
  // never a held post's delivery.
  const mine = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of messages ?? []) {
      if (!isChatMessage(e) || e.from_participant_id !== viewerId || delivered.has(e.id)) continue
      const ids = m.get(e.content) ?? new Set<string>()
      ids.add(e.id)
      m.set(e.content, ids)
    }
    return m
  }, [messages, viewerId, delivered])
  // Per held post: the matching ids already there when it was first seen.
  const baseline = useRef(new Map<string, Set<string>>())
  useEffect(() => {
    for (const p of posts) {
      // A send of the same text is in flight: a new id may be its echo,
      // which `delivered` names only once the HTTP answer lands.
      if (sending.has(sendingKey(projectId, room, p.content))) continue
      const now = mine.get(p.content) ?? new Set<string>()
      const before = baseline.current.get(p.key)
      if (!before) baseline.current.set(p.key, new Set(now))
      else if ([...now].some((id) => !before.has(id))) {
        baseline.current.delete(p.key)
        remove(p.key)
      }
    }
  }, [posts, mine, remove, sending, projectId, room])

  if (posts.length === 0) return null
  return (
    <div className="space-y-2 px-4 pb-2" data-testid="held-notices">
      {posts.map((p) => <HeldNotice key={p.key} held={p.held} content={p.content} />)}
    </div>
  )
}

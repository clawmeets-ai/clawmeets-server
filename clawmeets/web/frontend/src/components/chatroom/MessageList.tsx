import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode, RefObject } from 'react'
import { X } from 'lucide-react'
import type { AgentCard, ChatFileEvent, ChatLogEntry, ChatMessage } from '../../types'
import { isChatFileEvent, isChatMessage } from '../../types'
import MessageItem from './MessageItem'
import SystemNote from './SystemNote'
import { isSystemAuthor } from '../../utils/roomTrust'
import type { RecipientStatusIndex } from './recipientStatus'

/**
 * How long to keep looking for a `?msg=` target before declaring it gone. The
 * whole room log arrives in one request and MessageList is non-virtualized, so
 * the node exists as soon as that query paints — this window only has to cover
 * the fetch, not any paging. Exceeding it means the message was deleted after
 * it was indexed (a cleared room, a deleted project).
 */
const TARGET_WINDOW_MS = 2000
/** How long the matched message stays tinted after we scroll to it. */
const FLASH_MS = 1600

interface MessageListProps {
  messages: ChatLogEntry[]
  agents: AgentCard[]
  projectId?: string
  chatroomName?: string
  statusIndex: RecipientStatusIndex
  /** Deep-link target from `?msg=`: expand it, scroll to it, flash it. */
  targetMessageId?: string | null
  /**
   * Called once — per target id — when the target is shown OR conclusively not
   * found. The view strips `?msg=` in response, so a refresh or back-nav
   * doesn't re-fire the jump.
   */
  onTargetResolved?: (found: boolean) => void
  /** Rendered under each message (a channel thread's delivery line). */
  messageFooter?: (message: ChatMessage) => ReactNode
  /** Render every body as untrusted Markdown (a Hub thread: text from another server). */
  untrustedBodies?: boolean
  /** Per sender: is this author outside (hooks/useRoomTrust)? Its bodies
   *  render untrusted with an "outside" badge, ORed with untrustedBodies.
   *  Required, so no caller can forget the per-author rule. */
  isOutsideAuthor: (participantId: string) => boolean
}

interface MessageGroup {
  /** from_participant_id of every message in the group. */
  senderId: string
  messages: ChatMessage[]
  fileEvents: ChatFileEvent[]
  timestamp: string
}

export default function MessageList({
  messages,
  agents,
  projectId,
  chatroomName,
  statusIndex,
  targetMessageId,
  onTargetResolved,
  messageFooter,
  untrustedBodies = false,
  isOutsideAuthor,
}: MessageListProps) {
  // Group consecutive messages from same sender (break after 1 minute gap).
  // Ack messages ("Message received, processing...", cancel confirmations)
  // are hidden — the inline recipient rows cover that signal in the UI.
  // File events get attached to the message group whose message.version
  // matches the file event's source_version (and same sender). Orphan
  // file events (no matching group yet) are parked until a match shows up
  // or dropped at end-of-stream.
  const messageGroups = useMemo<MessageGroup[]>(() => {
    const TIME_GAP_MS = 60 * 1000
    const groups: MessageGroup[] = []
    const fileEvents: ChatFileEvent[] = messages.filter(isChatFileEvent)
    const chatMessages: ChatMessage[] = messages.filter(isChatMessage)

    chatMessages
      .filter((msg) => !msg.is_ack)
      .forEach((msg) => {
        // Group by id, not name: two outside contacts (or a contact and a
        // user) can share a display name and must never merge into one bubble.
        const sender = msg.from_participant_id
        const lastGroup = groups[groups.length - 1]
        if (lastGroup && lastGroup.senderId === sender) {
          const lastMsg = lastGroup.messages[lastGroup.messages.length - 1]
          const timeDiff = new Date(msg.ts).getTime() - new Date(lastMsg.ts).getTime()
          if (timeDiff < TIME_GAP_MS) {
            lastGroup.messages.push(msg)
            return
          }
        }
        groups.push({ senderId: sender, messages: [msg], fileEvents: [], timestamp: msg.ts })
      })

    // Attach file events to their message group (same sender), matching on
    // source_version. Two cases:
    //  - Agent reply: the ActionBlock emits the reply message AND its
    //    update_file events with the SAME source_version (both point back to
    //    the triggering mention) -> match m.source_version === source_version.
    //  - User attachment: the file is appended atomically with the user's own
    //    message and points at it -> match m.version === source_version (the
    //    user message itself has source_version = null).
    // Ordering inside fileEvents follows the original ts order.
    for (const event of fileEvents) {
      if (event.source_version == null) continue
      const matchIdx = groups.findIndex((group) =>
        group.messages.some(
          (m) =>
            m.from_participant_id === event.from_participant_id &&
            ((m.source_version != null && m.source_version === event.source_version) ||
              (m.version != null && m.version === event.source_version)),
        ),
      )
      if (matchIdx >= 0) groups[matchIdx].fileEvents.push(event)
    }

    return groups
  }, [messages])

  // Expand/collapse state for "Show more" messages is lifted here so it
  // survives Virtuoso unmounting rows when they scroll off-screen. Keyed by
  // ChatMessage.id; messages whose id isn't in the set render collapsed
  // (default).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const onToggleExpand = useCallback((messageId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  // Non-virtualized scroll container. Every row lives in the DOM at its true
  // height, so the browser's native scroll anchoring (overflow-anchor: auto)
  // holds the viewport steady when content above changes — no estimate /
  // correction, hence none of react-virtuoso's variable-height scroll jump.
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true) // assume bottom on fresh mount

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  const { flashingId, notFoundId, pending: targetPending } = useScrollToTarget({
    containerRef: scrollRef,
    atBottomRef,
    targetMessageId,
    messageGroups,
    expandedIds,
    setExpandedIds,
    onTargetResolved,
  })
  // Keyed by target id so a second deep link gets its own note rather than
  // inheriting the first one's dismissal.
  const [dismissedNoteId, setDismissedNoteId] = useState<string | null>(null)

  // Pin to bottom on mount, and follow new output only while the user is
  // already near the bottom. When the user has scrolled up, do nothing —
  // overflow-anchor keeps their position. (A chatroom switch remounts this
  // whole component via the parent's loading ternary, so "on mount" covers it;
  // see the note on `key={chatroomName}` below, which does something narrower
  // than it used to claim.)
  // useLayoutEffect runs before paint, so the initial pin shows no flash.
  //
  // Suppressed while a `?msg=` target is unresolved: this effect and the
  // scroll-to-target both move the same scrollTop, and this one runs on every
  // messages change — untreated it wins the race and silently lands the user at
  // the bottom of the room instead of on the message they clicked.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current && !targetPending) el.scrollTop = el.scrollHeight
  }, [messageGroups, targetPending])

  const targetNote =
    notFoundId && dismissedNoteId !== notFoundId ? (
      <div className="mx-6 mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <span className="flex-1">That message is no longer in this room.</span>
        <button
          type="button"
          onClick={() => setDismissedNoteId(notFoundId)}
          className="p-0.5 rounded hover:bg-amber-100"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    ) : null

  if (messageGroups.length === 0) {
    const emptyCopy = chatroomName?.startsWith('user-communication')
      ? "I'm your coordinator for this project. Tell me what you need — I'll delegate and report back here. This room is just us; DM a specialist directly if you want to talk to them."
      : chatroomName?.startsWith('shared-context')
      ? 'Common ground for the team. PLAN.md and any files dropped here are visible to every agent on this project. Update PLAN.md to steer the work — everyone reads from here.'
      : 'Focused chatroom created by your coordinator and scoped to specific work. Other chatrooms handle other parts of the project.'
    // The note still belongs here: a deep link into a room whose history was
    // cleared lands on the empty state, and the user needs to know why.
    return (
      <div className="flex-1 flex flex-col overflow-y-auto">
        {targetNote}
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="max-w-md text-center text-sm text-gray-500 leading-relaxed">
            {emptyCopy}
          </p>
        </div>
      </div>
    )
  }

  // `key={chatroomName}` replaces the scroll CONTAINER on a chatroom switch, so
  // the new room starts at scrollTop 0 instead of inheriting the old offset. It
  // does NOT remount MessageList — the key sits on this component's own output,
  // so every ref above (atBottomRef, the scroll-to-target latch) would survive
  // it. Those reset because ChatroomView / DMChatView drop MessageList entirely
  // behind their `messagesLoading` ternary while the next room loads. Anything
  // that must be correct across a switch has to say so itself rather than lean
  // on a remount this key does not perform.
  return (
    <div
      key={chatroomName}
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto scrollbar-thin"
    >
      {targetNote}
      {messageGroups.map((group, index) => {
        // A row stamped outside_isolated stays outside whatever the live
        // participant rule says now; one such row fences its whole group.
        const outside = isOutsideAuthor(group.senderId) ||
          group.messages.some((m) => m.outside_isolated) || group.fileEvents.some((e) => e.outside_isolated)
        return (
        <div
          key={group.messages[0]?.id ?? index}
          className={`px-6 pt-4 ${index === messageGroups.length - 1 ? 'pb-4' : ''}`}
        >
          {isSystemAuthor(group.senderId) ? (
            <div className="space-y-1">
              {group.messages.map((m) => <SystemNote key={m.id} message={m} />)}
            </div>
          ) : (
          <MessageItem
            messages={group.messages}
            fileEvents={group.fileEvents}
            agents={agents}
            projectId={projectId}
            chatroomName={chatroomName}
            statusIndex={statusIndex}
            orphanProcessingAgentIds={
              index === messageGroups.length - 1 ? statusIndex.orphanProcessingAgentIds : undefined
            }
            expandedIds={expandedIds}
            onToggleExpand={onToggleExpand}
            highlightMessageId={flashingId}
            messageFooter={messageFooter}
            untrustedBodies={untrustedBodies || outside}
            outsideAuthor={outside}
          />
          )}
        </div>
        )
      })}
    </div>
  )
}

interface ScrollToTargetOptions {
  containerRef: RefObject<HTMLDivElement>
  /**
   * The pin-to-bottom effect's "is the user at the bottom?" flag. Landing on a
   * target means the user is deliberately NOT at the bottom any more; clearing
   * this is what keeps the pin from snapping them back the moment suppression
   * lifts. A browser would eventually say the same thing via a scroll event,
   * but not reliably before the next layout effect runs.
   */
  atBottomRef: MutableRefObject<boolean>
  targetMessageId?: string | null
  messageGroups: MessageGroup[]
  expandedIds: Set<string>
  setExpandedIds: (update: (prev: Set<string>) => Set<string>) => void
  onTargetResolved?: (found: boolean) => void
}

/**
 * Scroll a `?msg=` deep-link target into view and flash it.
 *
 * MessageList owns scroll for both the project-room and the DM surface, so it
 * owns scroll-to-target too — neither view learns anything about DOM anchors.
 *
 * The whole room log arrives in one request (`getMessages()` takes no cursor)
 * and every row is in the DOM at its true height, so this is "wait until the
 * node exists, then scroll" — a bounded retry, not a paging loop:
 *
 *  1. The target is expanded first. A long message is clamped to 240px with a
 *     fade, and the matched text can be below that line — scrolling to a
 *     collapsed row would land on a message whose match isn't visible.
 *  2. Then we look the anchor up and scroll it to the middle of the viewport.
 *  3. If it isn't there yet we retry on the next frame and on every messages
 *     change, until TARGET_WINDOW_MS is up — at which point the message really
 *     is gone (deleted after indexing) and we say so instead of hanging.
 *
 * Resolution is one-shot per target id, so a background refetch of the room
 * can't re-scroll a user who has since scrolled away.
 */
function useScrollToTarget({
  containerRef,
  atBottomRef,
  targetMessageId,
  messageGroups,
  expandedIds,
  setExpandedIds,
  onTargetResolved,
}: ScrollToTargetOptions): {
  flashingId: string | null
  notFoundId: string | null
  pending: boolean
} {
  const resolvedRef = useRef<string | null>(null)
  const deadlineRef = useRef<{ id: string; at: number } | null>(null)
  const [flashingId, setFlashingId] = useState<string | null>(null)
  // The id we gave up on, not a boolean — the note is per-target.
  const [notFoundId, setNotFoundId] = useState<string | null>(null)

  // Read during render so the pin-to-bottom layout effect in the SAME commit
  // already knows to stand down.
  const pending = !!targetMessageId && resolvedRef.current !== targetMessageId

  useEffect(() => {
    // No target means the previous jump is over: `onTargetResolved` stripped
    // `?msg=`, and that lands here as a null target. This is the one moment we
    // know the cycle is finished, so it is where the one-shot latch comes off.
    // Without it the latch is permanent — a same-room deep link only changes
    // the query string, so nothing remounts MessageList (see the note on
    // `key={chatroomName}` above) — and clicking the SAME hit a second time
    // would scroll nowhere, flash nothing, and leave `?msg=` in the URL.
    if (!targetMessageId) {
      resolvedRef.current = null
      deadlineRef.current = null
      return
    }
    if (resolvedRef.current === targetMessageId) return

    // Start the clock once per target — this effect re-runs on every messages
    // change, and re-stamping it here would extend the window indefinitely.
    if (deadlineRef.current?.id !== targetMessageId) {
      deadlineRef.current = { id: targetMessageId, at: Date.now() + TARGET_WINDOW_MS }
    }

    if (!expandedIds.has(targetMessageId)) {
      // Re-runs this effect with the target open, then falls through below.
      setExpandedIds((prev) =>
        prev.has(targetMessageId) ? prev : new Set(prev).add(targetMessageId),
      )
      return
    }

    let raf = 0
    const attempt = () => {
      // Scanned rather than matched with a selector string: the id comes off
      // the URL, so interpolating it into a selector would need escaping that
      // buys nothing here — the room holds a few hundred rows at most.
      const node = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [],
      ).find((el) => el.dataset.messageId === targetMessageId)
      if (node) {
        resolvedRef.current = targetMessageId
        atBottomRef.current = false
        node.scrollIntoView({ block: 'center' })
        setFlashingId(targetMessageId)
        onTargetResolved?.(true)
        return
      }
      if (Date.now() >= (deadlineRef.current?.at ?? 0)) {
        resolvedRef.current = targetMessageId
        setNotFoundId(targetMessageId)
        onTargetResolved?.(false)
        return
      }
      raf = requestAnimationFrame(attempt)
    }
    raf = requestAnimationFrame(attempt)
    return () => cancelAnimationFrame(raf)
  }, [
    targetMessageId,
    messageGroups,
    expandedIds,
    setExpandedIds,
    onTargetResolved,
    containerRef,
    atBottomRef,
  ])

  // Drop the tint once it has done its job. The transition itself is
  // `motion-safe:` in MessageItem, so a reduced-motion user gets the same hold
  // without the fade.
  useEffect(() => {
    if (!flashingId) return
    const id = setTimeout(() => setFlashingId(null), FLASH_MS)
    return () => clearTimeout(id)
  }, [flashingId])

  return { flashingId, notFoundId, pending }
}

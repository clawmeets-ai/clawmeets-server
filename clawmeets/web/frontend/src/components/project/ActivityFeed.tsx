import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { Virtuoso } from 'react-virtuoso'
import { getMessages } from '../../api/endpoints'
import type { Chatroom, ChatMessage, ActivityEvent, AgentCard, User } from '../../types'
import { isChatMessage } from '../../types'
import { useAllParticipants } from '../../hooks/useAgents'
import { useAuthStore } from '../../stores/authStore'
import { useRoomTrust } from '../../hooks/useRoomTrust'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import { storedSenderName } from '../../utils/messageSender'
import { getChatroomDisplayName } from '../../utils/chatroomDisplay'
import Avatar from '../common/Avatar'
import Timestamp from '../common/Timestamp'
import ExpandToggle from '../shared/ExpandToggle'
import MarkdownBody from '../shared/MarkdownBody'
import OutsideBadge from '../chatroom/OutsideBadge'
import SystemNote from '../chatroom/SystemNote'
import { isSystemAuthor } from '../../utils/roomTrust'
import Loading from '../common/Loading'

/**
 * Get list of agent names who are addressed in this message.
 * The expects_response_from field is server-populated from @mentions in the message content.
 */
function getAddressedAgents(
  message: ChatMessage,
  agents: AgentCard[],
  viewer: Pick<User, 'id' | 'username'> | null,
): string[] {
  const erf = message.expects_response_from
  if (!erf || erf.length === 0) return []

  // Resolve agent IDs/names to display names — short name for the viewer's own agents.
  const addressed: string[] = []
  for (const nameOrId of erf) {
    const agent = agents.find(a => a.id === nameOrId || a.name === nameOrId)
    addressed.push(agent ? agentDisplayName(agent, viewer) : nameOrId)
  }
  return addressed
}

interface ActivityFeedProps {
  projectId: string
  chatrooms: Chatroom[]
}

export default function ActivityFeed({ projectId, chatrooms }: ActivityFeedProps) {
  const navigate = useNavigate()
  const viewer = useAuthStore((state) => state.user) ?? null
  const { data: allParticipants } = useAllParticipants()

  // Fetch messages from all chatrooms
  const messageQueries = useQueries({
    queries: chatrooms.map((room) => ({
      queryKey: ['messages', projectId, room.name],
      queryFn: () => getMessages(projectId, room.name),
    })),
  })

  const isLoading = messageQueries.some((q) => q.isLoading)

  // Combine and sort message events (newest first)
  const events = useMemo(() => {
    const allEvents: ActivityEvent[] = []
    chatrooms.forEach((room, index) => {
      const entries = messageQueries[index]?.data || []
      entries.filter(isChatMessage).forEach((msg: ChatMessage) => {
        if (msg.is_ack) return
        allEvents.push({
          type: 'message',
          timestamp: msg.ts,
          projectId,
          chatroomName: room.name,
          data: msg,
        })
      })
    })
    return allEvents.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
  }, [chatrooms, messageQueries, projectId])

  // Per-row expand state lifted from ActivityItem so it survives Virtuoso
  // unmounting rows on scroll. Keyed by ChatMessage.id (server-issued UUID,
  // globally unique across chatrooms).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const onToggleExpand = useCallback((messageId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  if (isLoading) {
    return (
      <div className="flex-1 flex justify-center py-8">
        <Loading />
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="flex-1 text-center py-8 text-gray-500">
        No activity yet
      </div>
    )
  }

  return (
    <Virtuoso
      className="flex-1 scrollbar-thin"
      data={events}
      increaseViewportBy={{ top: 400, bottom: 400 }}
      itemContent={(_index, event) => {
        const message = event.data as ChatMessage
        return (
          <div className="px-6 pb-4">
            <ActivityItem
              event={event}
              agents={allParticipants || []}
              viewer={viewer}
              expanded={expandedIds.has(message.id)}
              onToggleExpand={() => onToggleExpand(message.id)}
              onChatroomClick={(chatroomName) =>
                navigate(`/projects/${projectId}/chatrooms/${chatroomName}`)
              }
            />
          </div>
        )
      }}
    />
  )
}

interface ActivityItemProps {
  event: ActivityEvent
  agents: AgentCard[]
  viewer: Pick<User, 'id' | 'username'> | null
  expanded: boolean
  onToggleExpand: () => void
  onChatroomClick: (chatroomName: string) => void
}

const MAX_COLLAPSED_LENGTH = 300

function ActivityItem({ event, agents, viewer, expanded, onToggleExpand, onChatroomClick }: ActivityItemProps) {
  // Same trust rule as the room: a Hub thread whole, and per author (a
  // stand-in in a workroom, another account's agent, a requester).
  const trust = useRoomTrust(event.projectId, event.chatroomName)
  if (event.type !== 'message') return null

  const message = event.data as ChatMessage
  // A row stamped outside_isolated stays outside for good.
  const outside = trust.isOutsideAuthor(message.from_participant_id) || !!message.outside_isolated
  const untrusted = trust.isUntrusted(message.from_participant_id) || outside
  const sender = agents.find((a) => a.id === message.from_participant_id)
  // Prefer namespace-aware short name when the viewer owns the sender; fall
  // back to the persisted name for human / unowned / outside-contact senders.
  const senderName = sender ? agentDisplayName(sender, viewer) : storedSenderName(message)
  const content = message.content
  const isLongMessage = content.length > MAX_COLLAPSED_LENGTH
  const displayContent = isLongMessage && !expanded
    ? content.slice(0, MAX_COLLAPSED_LENGTH)
    : content

  // Get agents who should respond to this message
  const addressedAgents = useMemo(
    () => getAddressedAgents(message, agents, viewer),
    [message, agents, viewer]
  )

  // Render @mentions prefix as accent pills (matches landing + MessageItem).
  const mentionsPrefix = addressedAgents.length > 0 ? (
    <span className="inline-flex flex-wrap items-center gap-1 mr-1.5 align-baseline">
      {addressedAgents.map((name) => (
        <span
          key={name}
          className="font-mono font-bold"
          style={{
            background: 'var(--accent-softer)',
            color: 'var(--accent-deep)',
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: '0.85em',
          }}
        >
          @{name}
        </span>
      ))}
    </span>
  ) : null

  // A server note is plain text, never Markdown, as in the room.
  if (isSystemAuthor(message.from_participant_id)) return <div className="p-3"><SystemNote message={message} /></div>

  return (
    <div className="flex gap-3 p-3 rounded-lg hover:bg-[color:var(--bg-card-hover)] transition-colors">
      {/* No dot for human senders — `sender` only resolves for agents. */}
      <Avatar name={senderName} status={sender?.status} size="md" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1 flex-wrap">
          <span className="font-extrabold font-mono text-sm text-ink-1">{senderName}</span>
          {outside && <OutsideBadge />}
          <button
            onClick={() => onChatroomClick(event.chatroomName)}
            className="text-xs font-mono font-bold"
            style={{
              background: 'var(--accent-softer)',
              color: 'var(--accent-deep)',
              padding: '1px 6px',
              borderRadius: 4,
            }}
          >
            #{getChatroomDisplayName(event.chatroomName)}
          </button>
          <span className="font-mono text-xs text-ink-4">
            <Timestamp date={event.timestamp} />
          </span>
        </div>

        {content && (
          <div className="text-gray-700 text-sm">
            {mentionsPrefix}
            <MarkdownBody
              content={displayContent}
              untrusted={untrusted}
              className="prose-p:text-gray-700 prose-li:text-gray-700"
            />
            {isLongMessage && !expanded && <span>...</span>}
            {isLongMessage && (
              <ExpandToggle
                expanded={expanded}
                onToggle={onToggleExpand}
                moreLabel={`Show more · ${content.length.toLocaleString()} chars`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

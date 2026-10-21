import { useMemo } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { PanelRightOpen, X } from 'lucide-react'
import { useChatroom, useMessages, useProject, useUserProjects } from '../../hooks/useProjects'
import { useIsProjectViewer } from '../../hooks/useSharing'
import { useAllParticipants } from '../../hooks/useAgents'
import AgentNameLink from '../agent/AgentNameLink'
import { useFiles } from '../../hooks/useFiles'
import { useMessageDeepLink } from '../../hooks/useMessageDeepLink'
import { useUIStore } from '../../stores/uiStore'
import { useActiveWorkStore, selectActiveParticipants } from '../../stores/activeWorkStore'
import { useAuthStore } from '../../stores/authStore'
import { AgentStatus, isChatFileEvent, isChatMessage } from '../../types'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import { getChatroomDisplayName } from '../../utils/chatroomDisplay'
import Loading from '../common/Loading'
import Avatar from '../common/Avatar'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import ChannelThreadNotice from './ChannelThreadNotice'
import { ChannelComposerNote, ChannelThreadBar, channelComposer } from './ChannelThreadControls'
import DeliveryStatusLine from './DeliveryStatusLine'
import { useChannelThread } from '../../hooks/useChannelThreads'
import { useRoomTrust } from '../../hooks/useRoomTrust'
import { awaitingRows, useThreadOutbox } from '../../hooks/useThreadOutbox'
import type { ChatMessage } from '../../types'
import FileList from '../files/FileList'
import Overlay from '../common/Overlay'
import ResizeHandle from '../common/ResizeHandle'
import ClearHistoryButton from '../common/ClearHistoryButton'
import CollapsibleHeader from '../common/CollapsibleHeader'
import { buildRecipientStatusIndex } from './recipientStatus'
import { useBridgeDeliveries } from '../../hooks/useAgentAccess'
import {
  addressedStandIns, outsideFileNames, roomTakesOutsideMessages, standIns,
} from '../../utils/roomTrust'
import RoomFlowControl from './RoomFlowControl'
import RoomFlowStrip from './RoomFlowStrip'
import { HeldNotices } from './HeldNotice'
import { REMOTE_TEXT_CAP, safeRemoteText } from '../../utils/hubDisplay'
import BridgeDeliveryLine from '../hub/BridgeDeliveryLine'
import StandInChip from '../hub/StandInChip'
import IsolationUnavailablePanel from '../common/IsolationUnavailablePanel'
import { isIsolationUnavailable } from '../../utils/agentAccessCopy'

export default function ChatroomView() {
  const { projectId = '', chatroomName = '' } = useParams<{
    projectId: string
    chatroomName: string
  }>()
  const { data: chatroom, isLoading: chatroomLoading, error: chatroomError } = useChatroom(projectId, chatroomName)
  const { data: messages, isLoading: messagesLoading, error: messagesError } = useMessages(projectId, chatroomName)
  const { data: files, isLoading: filesLoading } = useFiles(projectId, chatroomName)
  const { data: allParticipants } = useAllParticipants()
  const processingAgentIds = useActiveWorkStore(selectActiveParticipants(projectId, chatroomName))
  const { isMobileRightPanelOpen, openMobileRightPanel, closeMobileRightPanel, rightPanelWidth, setRightPanelWidth } = useUIStore()
  const isViewer = useIsProjectViewer(projectId)
  // The sidebar's own list (already cached), read to tell a Front Desk thread
  // the viewer owns from any other room without a request of its own.
  const { data: userProjects } = useUserProjects()
  // `?msg=` deep-link target from ⌘K message search. Note this view uses
  // useParams + useLocation only — the hook is where useSearchParams starts here.
  const { targetMessageId, clearTarget } = useMessageDeepLink()
  const viewer = useAuthStore((state) => state.user) ?? null
  // Set by project-selection navigation so the coordinator room's composer is
  // focused. Front Desk / plain room clicks don't set it, so they're unaffected.
  const focusComposer =
    (useLocation().state as { focusComposer?: boolean } | null)?.focusComposer === true

  // Check if this is a user-communication room
  const isUserCommRoom = chatroom?.name?.startsWith('user-communication') ?? false
  const isDMRoom = chatroom?.name?.startsWith('dm-') ?? false
  const isSharedContextRoom = chatroom?.name?.startsWith('shared-context') ?? false
  // Work rooms are everything else: per-chatroom coordinator/worker rooms
  // where the user has no addressable counterpart. Disable the composer
  // there and point the user back to #shared-context / #coordinator.
  const isWorkRoom = !!chatroom && !isUserCommRoom && !isDMRoom && !isSharedContextRoom
  // Channel threads (Telegram, email, LINE, WhatsApp) are owned Front Desk
  // projects; only their owner can ask about the conversation.
  const ownFrontDeskProject = isUserCommRoom && !isViewer
    ? userProjects?.find((p) => p.id === projectId && p.surface === 'frontdesk' && p.created_by === viewer?.id)
    : undefined
  const isOwnFrontDeskRoom = !!ownFrontDeskProject
  // A channel thread is a row in the owner's thread list — never inferred from
  // the room name. Only asked for on an owned Front Desk room.
  const { row: channelRow } = useChannelThread(projectId, { enabled: isOwnFrontDeskRoom })
  const channel = isOwnFrontDeskRoom ? channelRow : null
  // Whether bodies render as untrusted Markdown: the one shared rule, so a
  // Hub thread is never trusted whichever view opens it.
  const { untrustedBodies, isOutsideAuthor: isOutside } = useRoomTrust(projectId, chatroomName)
  const coordinatorId = ownFrontDeskProject?.coordinator_id
  // The outgoing messages (the agent's replies and the owner's posts): the
  // outbox is asked again while a fresh one has no rows yet. A removed
  // thread's later posts never get rows, so none of them is waited for.
  const isOutgoing = (m: ChatMessage) =>
    !m.is_ack && (m.from_participant_id === coordinatorId || m.from_participant_id === viewer?.id)
  const outgoing = channel && !channel.connection_removed
    ? (messages ?? []).filter((m): m is ChatMessage => m.entry_type === 'message' && isOutgoing(m as ChatMessage))
    : []
  const outbox = useThreadOutbox(projectId, { enabled: !!channel, outgoing })

  // ── outside content (utils/roomTrust) ──────────────────────────────────
  const { data: project } = useProject(projectId)
  const ownerId = project?.created_by
  const isOwner = !isViewer && !!viewer && ownerId === viewer.id
  const roomStandIns = useMemo(() => standIns(chatroom), [chatroom])
  // Stand-in or hub agent id → "name@server", safe remote text.
  const standInNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of roomStandIns) {
      const label = s.hub?.name
        ? `${safeRemoteText(s.hub.name, REMOTE_TEXT_CAP.name)}@${safeRemoteText(s.hub.deployment_name ?? '', REMOTE_TEXT_CAP.name)}`
        : s.id
      m.set(s.id, label)
      if (s.hub?.hub_agent_id) m.set(s.hub.hub_agent_id, label)
    }
    return m
  }, [roomStandIns])
  const chatMessages = useMemo(() => (messages ?? []).filter(isChatMessage), [messages])
  const addressing = useMemo(
    () => new Map(chatMessages.map((m) => [m.id, addressedStandIns(m, chatroom)] as const).filter(([, ids]) => ids.length > 0)),
    [chatMessages, chatroom],
  )
  const bridgeDeliveries = useBridgeDeliveries(projectId, chatroomName, [...addressing.keys()], isOwner)
  const bridgeFooter = (m: ChatMessage) => {
    const ids = addressing.get(m.id)
    if (!isOwner || !ids) return null
    const hubIds = ids.map((id) => roomStandIns.find((s) => s.id === id)?.hub?.hub_agent_id ?? id)
    return <BridgeDeliveryLine standInIds={hubIds} deliveries={bridgeDeliveries[m.id] ?? []} names={standInNames} />
  }
  const outsideFiles = useMemo(
    () => outsideFileNames(chatroom, ownerId, (files ?? []).map((f) => f.name), (messages ?? []).filter(isChatFileEvent)),
    [chatroom, ownerId, files, messages],
  )

  const channelFooter = channel
    ? (m: ChatMessage) => {
        if (!isOutgoing(m)) return null
        const rows = outbox.get(m.id) ?? []
        // No rows: still on its way only if it's fresh and the thread is
        // connected. A removed thread's later posts never get rows.
        if (rows.length === 0 && (channel.connection_removed || !awaitingRows(m, [], Date.now()))) {
          return null
        }
        return (
          <DeliveryStatusLine
            rows={rows}
            channel={channel.channel}
            connectionEnabled={channel.connection_enabled}
            ownText={m.from_participant_id === viewer?.id ? m.content : undefined}
          />
        )
      }
    : undefined
  const messageFooter = (m: ChatMessage) => (
    <>
      {channelFooter?.(m)}
      {bridgeFooter(m)}
    </>
  )

  // The "mark user-communication as seen" effect that used to live here is
  // gone with the sidebar unread badge. It wrote lastSeenMessages[chatroomName]
  // — a BARE room name, so every project shared the single global slot
  // 'user-communication' — and the only reader was ProjectItem's green dot.
  // My Desk is unaffected: it reads and writes lastSeenMessages under
  // deskRoomKey(pid) (`${pid}|user-communication`), a disjoint key namespace
  // fed by useDeskReadState / mergeServerReadState.

  // Derive per-message recipient statuses from the chat log + active work set.
  // Processing agents with no @mention anywhere in the room surface as
  // `orphanProcessingAgentIds` — MessageList attaches those to the latest
  // message so the whole typing signal lives inline.
  //
  // Pass the full ChatLogEntry stream — buildRecipientStatusIndex needs
  // batch_timeout rows in addition to messages so it can flip a recipient
  // from AWAITING to TIMED OUT.
  //
  // Computed before any early return so the hook order stays stable across
  // loading → loaded transitions.
  const statusIndex = useMemo(
    () =>
      buildRecipientStatusIndex(
        messages || [],
        allParticipants || [],
        processingAgentIds,
      ),
    [messages, allParticipants, processingAgentIds],
  )

  if (chatroomLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading size="lg" />
      </div>
    )
  }

  if (isIsolationUnavailable(chatroomError) || isIsolationUnavailable(messagesError)) {
    return <IsolationUnavailablePanel />
  }

  if (!chatroom) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Chatroom not found
      </div>
    )
  }

  // Get participant agent details (includes both workers and assistants)
  const participantAgents = chatroom.participants
    .map((id) => allParticipants?.find((a) => a.id === id))
    .filter(Boolean)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <CollapsibleHeader className="border-b border-border px-6 py-3 pl-14 lg:pl-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg flex items-center gap-2 text-channel-active min-w-0">
              <span className="text-channel shrink-0">#</span>
              <span className="truncate">{getChatroomDisplayName(chatroom.name)}</span>
            </h2>
            <p className="text-sm text-channel">
              {participantAgents.length + roomStandIns.length} participants
            </p>
            {roomStandIns.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1" data-testid="room-stand-ins">
                {roomStandIns.map((s) => <StandInChip key={s.id} info={s} />)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Avatar stack — tapping it opens the participants/files panel
                on mobile. On desktop the panel is always visible, so the
                click is a no-op visually. */}
            <button
              type="button"
              onClick={openMobileRightPanel}
              className="flex -space-x-2 lg:cursor-default"
              aria-label="Show participants and files"
            >
              {participantAgents.slice(0, 5).map((agent) => {
                const label = agentDisplayName(agent!, viewer)
                return (
                  <div
                    key={agent!.id}
                    title={label}
                    className="ring-2 ring-white rounded-full"
                  >
                    <Avatar
                      name={label}
                      status={agent!.status as AgentStatus}
                      size="md"
                    />
                  </div>
                )
              })}
              {participantAgents.length > 5 && (
                <div className="w-8 h-8 rounded-full bg-sidebar flex items-center justify-center text-xs font-semibold text-channel-active ring-2 ring-white">
                  +{participantAgents.length - 5}
                </div>
              )}
            </button>
            {/* Right-panel trigger — secondary affordance on mobile (the
                avatar stack is the primary trigger). */}
            <button
              onClick={openMobileRightPanel}
              className="p-2 rounded-md hover:bg-sidebar-hover transition-colors lg:hidden"
              aria-label="Open participants and files panel"
              title="Participants and files"
            >
              <PanelRightOpen className="w-5 h-5 text-channel" />
            </button>
            {isOwner && roomTakesOutsideMessages(chatroom, project) && (
              <RoomFlowControl projectId={projectId} room={chatroomName} flow={chatroom.flow} />
            )}
            {!isViewer && (
              <ClearHistoryButton
                projectId={projectId}
                chatroomName={chatroomName}
                confirmLabel={`#${getChatroomDisplayName(chatroom.name)}`}
              />
            )}
          </div>
        </div>
      </CollapsibleHeader>

      {channel && <ChannelThreadBar row={channel} />}

      {/* Content */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Messages */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {messagesLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loading />
            </div>
          ) : (
            <>
              {isOwnFrontDeskRoom && (
                <ChannelThreadNotice projectId={projectId} messageCount={messages?.length ?? 0} />
              )}
              <MessageList
                messages={messages || []}
                agents={allParticipants || []}
                projectId={projectId}
                chatroomName={chatroomName}
                statusIndex={statusIndex}
                targetMessageId={targetMessageId}
                onTargetResolved={clearTarget}
                messageFooter={messageFooter}
                untrustedBodies={untrustedBodies}
                isOutsideAuthor={isOutside}
              />
            </>
          )}

          <RoomFlowStrip flow={chatroom.flow} viewerIsOwner={isOwner} />
          <HeldNotices projectId={projectId} room={chatroomName} messages={messages} viewerId={viewer?.id} />

          {/* Message input or read-only banner */}
          {isViewer ? (
            <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 text-center text-sm text-gray-500">
              You are viewing this project in read-only mode
            </div>
          ) : isWorkRoom ? (
            <div className="px-4 py-4 border-t border-gray-200 bg-gray-50 text-sm text-gray-600 space-y-1.5">
              <div className="font-medium text-gray-700">
                Agents handle this room — your messages here are ignored.
              </div>
              <div>
                Knowledge everyone needs? Post in{' '}
                <Link
                  to={`/projects/${projectId}/chatrooms/shared-context`}
                  className="font-mono text-accent hover:underline"
                >
                  #shared-context
                </Link>
                .
              </div>
              <div>
                Want to redirect the coordinator? Message{' '}
                <Link
                  to={`/projects/${projectId}/chatrooms/user-communication`}
                  className="font-mono text-accent hover:underline"
                >
                  #coordinator
                </Link>
                .
              </div>
            </div>
          ) : (
            <>
              {channel && <ChannelComposerNote row={channel} messageCount={messages?.length ?? 0} />}
              <MessageInput
                projectId={projectId}
                chatroomName={chatroomName}
                participants={participantAgents.filter((a): a is NonNullable<typeof a> => a !== undefined)}
                autoFocus={focusComposer}
                {...(channel ? channelComposer(channel) : {})}
              />
            </>
          )}
        </div>

        {/* Backdrop overlay for mobile right panel */}
        <Overlay isOpen={isMobileRightPanelOpen} onClose={closeMobileRightPanel} />

        <ResizeHandle side="right" onResize={setRightPanelWidth} />

        {/* Participants and Files sidebar - slide-in on mobile, static on desktop */}
        <aside
          className={`
            fixed inset-y-0 right-0 z-50 bg-sidebar border-l border-border flex flex-col overflow-y-auto scrollbar-thin flex-shrink-0
            transform transition-transform duration-300 ease-in-out
            lg:relative lg:translate-x-0 lg:transform-none lg:transition-none lg:z-auto
            ${isMobileRightPanelOpen ? 'translate-x-0' : 'translate-x-full'}
          `}
          style={{ width: rightPanelWidth }}
        >
          {/* Close button - visible only on mobile */}
          <button
            onClick={closeMobileRightPanel}
            className="absolute top-3 right-3 p-1 rounded-md hover:bg-sidebar-hover transition-colors lg:hidden z-10"
            aria-label="Close panel"
          >
            <X className="w-5 h-5 text-channel" />
          </button>

          {/* Participants */}
          <div className="p-4 border-b border-border mt-8 lg:mt-0">
            <h3 className="text-xs font-extrabold text-channel uppercase tracking-wider mb-3">
              Participants ({participantAgents.length + roomStandIns.length})
            </h3>
            <div className="space-y-2">
              {participantAgents.map((agent) => {
                const label = agentDisplayName(agent!, viewer)
                return (
                  <div key={agent!.id} className="flex items-center gap-2.5">
                    <Avatar
                      name={label}
                      status={agent!.status as AgentStatus}
                      size="md"
                    />
                    <div className="min-w-0">
                      <AgentNameLink agentName={agent!.name} className="block text-sm text-channel-active truncate">
                        {label}
                      </AgentNameLink>
                    </div>
                  </div>
                )
              })}
              {roomStandIns.map((s) => (
                <div key={s.id} className="flex items-center gap-2.5 min-w-0">
                  <StandInChip info={s} />
                </div>
              ))}
            </div>
          </div>

          {/* Files */}
          <div className="flex flex-col flex-1 min-h-0">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-xs font-extrabold text-channel uppercase tracking-wider">
                Files ({files?.length || 0})
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
              {filesLoading ? (
                <div className="flex justify-center py-4">
                  <Loading size="sm" />
                </div>
              ) : (
                <FileList
                  files={files || []}
                  projectId={projectId}
                  chatroomName={chatroomName}
                  isOutsideFile={(name) => outsideFiles.has(name)}
                />
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

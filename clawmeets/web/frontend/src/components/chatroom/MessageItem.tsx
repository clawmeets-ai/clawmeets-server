import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CornerUpRight, FileText, Package } from 'lucide-react'
import type { AgentCard, ChatFileEvent, ChatMessage } from '../../types'
import { AgentStatus } from '../../types'
import { useAuthStore } from '../../stores/authStore'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import { storedSenderName } from '../../utils/messageSender'
import Avatar from '../common/Avatar'
import Timestamp from '../common/Timestamp'
import OutsideBadge from './OutsideBadge'
import { useCancelInvocation } from '../../hooks/useProjects'
import FileViewerModal from '../files/FileViewerModal'
import MarkdownBody from '../shared/MarkdownBody'
import type { RecipientStatusIndex } from './recipientStatus'
import DelegationRow from './DelegationRow'
import OfflineRemedyNote, { type OfflineRecipient } from './OfflineRemedyNote'
import SaveToPackModal from './SaveToPackModal'
import ForwardModal from './ForwardModal'

// Collapsed height cap for long messages. The full markdown is always
// rendered; MarkdownBody clips to this height with a gradient fade so
// truncation never cuts mid-word or mid-token.
const MAX_COLLAPSED_HEIGHT_PX = 240

interface MessageItemProps {
  messages: ChatMessage[]
  fileEvents?: ChatFileEvent[]
  agents: AgentCard[]
  projectId?: string
  chatroomName?: string
  statusIndex: RecipientStatusIndex
  /**
   * Agent-ids whose processing state has no @mention anywhere in the
   * room (coordinator self-batches, etc.). Only the latest message in
   * the chatroom receives these — semantically it is the message that
   * triggered their work — so the UI renders a single continuous set
   * of recipient rows without a separate typing bar.
   */
  orphanProcessingAgentIds?: string[]
  /**
   * Expand/collapse state owned by the parent. Lifted out of MessageContent
   * so it survives virtualizer unmount as rows scroll off-screen.
   */
  expandedIds: Set<string>
  onToggleExpand: (messageId: string) => void
  /**
   * Id of the message in this group to tint, after a `?msg=` deep link scrolled
   * to it. null for none. The anchor itself (`data-message-id`) is always
   * emitted — MessageList queries it to find the scroll target.
   */
  highlightMessageId?: string | null
  /** Rendered under each message (a channel thread's delivery line). */
  messageFooter?: (message: ChatMessage) => ReactNode
  /** Render the bodies as untrusted Markdown: no images, safe links only. */
  untrustedBodies?: boolean
  /** The sender is outside the owner's account: an "outside" badge. */
  outsideAuthor?: boolean
}

// Deep-link flash. `motion-safe:` keeps the tint instant for a reduced-motion
// user instead of animating it in and out.
const FLASH_CLASS =
  'rounded-md ring-2 ring-amber-300 bg-amber-50 motion-safe:transition-colors motion-safe:duration-500'

export default function MessageItem({
  messages,
  fileEvents = [],
  agents,
  projectId,
  chatroomName,
  statusIndex,
  orphanProcessingAgentIds,
  expandedIds,
  onToggleExpand,
  highlightMessageId,
  messageFooter,
  untrustedBodies = false,
  outsideAuthor = false,
}: MessageItemProps) {
  const viewer = useAuthStore((state) => state.user) ?? null
  const firstMsg = messages[0]
  const sender = agents.find((a) => a.id === firstMsg.from_participant_id)
  // Prefer the namespace-aware short name when the viewer owns the sender;
  // fall back to the persisted ``from_participant_name`` (the full registry
  // name, or an outside contact's display name).
  const senderName = sender ? agentDisplayName(sender, viewer) : storedSenderName(firstMsg)

  // Small uppercase labels next to the agent name. Prefer user_teams (the
  // owner-facing team labels), fall back to a single capability so most agents
  // show *something*. Human-sender messages have no AgentCard match → no labels.
  const roleLabels = useMemo<string[]>(() => {
    if (!sender) return []
    if (sender.user_teams && sender.user_teams.length > 0) {
      return sender.user_teams.slice(0, 2)
    }
    if (sender.capabilities && sender.capabilities.length > 0) {
      return sender.capabilities.slice(0, 1)
    }
    return []
  }, [sender])

  const cancelMutation = useCancelInvocation(projectId, chatroomName)

  const recipientEntries = useMemo(() => {
    const latestByKey = new Map<string, ChatMessage>()
    for (const m of messages) {
      for (const key of m.expects_response_from ?? []) {
        latestByKey.set(key, m)
      }
    }
    const fromMentions = Array.from(latestByKey.entries()).map(([key, triggeringMessage]) => {
      const agent = agents.find((a) => a.id === key || a.name === key)
      return {
        key,
        agent,
        displayName: agent ? agentDisplayName(agent, viewer) : key,
        agentId: statusIndex.resolveAgentId(key),
        status: statusIndex.resolve(triggeringMessage, key),
        offlineAtTimeout: statusIndex.isOfflineAtTimeout(triggeringMessage, key),
      }
    })

    // Append orphan processing agents (only set on the latest message in the
    // room). Skip any already covered by an inline @mention row.
    const alreadyCovered = new Set(fromMentions.map((r) => r.agentId))
    const fromOrphans = (orphanProcessingAgentIds ?? [])
      .filter((id) => !alreadyCovered.has(id))
      .map((id) => {
        const agent = agents.find((a) => a.id === id)
        return {
          key: `orphan:${id}`,
          agent,
          displayName: agent ? agentDisplayName(agent, viewer) : id,
          agentId: id,
          status: 'processing' as const,
          offlineAtTimeout: false,
        }
      })

    return [...fromMentions, ...fromOrphans]
  }, [messages, agents, statusIndex, orphanProcessingAgentIds, viewer])

  // AC-3.6, advisory only. An agent whose row is 'processing' while the live
  // roster reports it offline most likely dropped after its batch had already
  // opened — the server has no signal for that and the 1800s timeout is the
  // only backstop. Roster status is up to 60s stale (useAgents `staleTime`),
  // so this may never become a status: it is passed alongside one, and
  // DelegationRow consults it only to de-emphasize the processing chip.
  const advisoryOfflineIds = useMemo(() => {
    const out = new Set<string>()
    for (const r of recipientEntries) {
      if (r.status === 'processing' && r.agent?.status === AgentStatus.OFFLINE) {
        out.add(r.agentId)
      }
    }
    return out
  }, [recipientEntries])

  // AC-3.3 / AC-3.5 / AC-3.7 tier two: the message-level remedy, a filter over
  // rows already in hand. Deduplicated by agent id — one entry per agent, not
  // per mention — and rendered as ONE note below, never one per agent.
  //
  // Split into the two groups the note gives opposite advice to: never
  // received it (still queued, do not resend) vs. received it and lost the
  // reply when the runner died (do resend).
  const { neverReceived, offlineAtTimeout, hasWorkingRecipients } = useMemo(() => {
    const seen = new Set<string>()
    const missed: OfflineRecipient[] = []
    const lost: OfflineRecipient[] = []
    let working = false
    for (const r of recipientEntries) {
      const isMissed = r.status === 'offline'
      const isLost = r.status === 'timed_out' && r.offlineAtTimeout
      if (!isMissed && !isLost) {
        // AC-3.4: "the other recipients are unaffected" must only be said when
        // there really are recipients that are fine. An agent that plainly
        // timed out is not offline, but it is not unaffected either.
        if (r.status !== 'timed_out' && r.status !== 'canceled') working = true
        continue
      }
      if (seen.has(r.agentId)) continue
      seen.add(r.agentId)
      ;(isMissed ? missed : lost).push({
        agentId: r.agentId,
        displayName: r.displayName,
      })
    }
    return {
      neverReceived: missed,
      offlineAtTimeout: lost,
      hasWorkingRecipients: working,
    }
  }, [recipientEntries])

  // Deduplicate file chips by filename — multiple updates to the same file
  // in one batch should show as one chip. Keep the earliest event's type.
  const fileChips = useMemo(() => {
    const seen = new Set<string>()
    const out: ChatFileEvent[] = []
    for (const event of fileEvents) {
      if (seen.has(event.filename)) continue
      seen.add(event.filename)
      out.push(event)
    }
    return out
  }, [fileEvents])

  // Concatenate every message body in the group as the candidate pack content.
  // Multi-message groups (sequential replies coalesced) get a thin separator
  // so the pack content keeps each message intact. File-only groups have an
  // empty packDraft — the modal opens with a blank textarea the user can fill
  // in.
  const packDraft = useMemo(
    () => messages.map((m) => (m.content ?? '').trim()).filter(Boolean).join('\n\n---\n\n'),
    [messages],
  )
  const [packModalOpen, setPackModalOpen] = useState(false)
  const [forwardOpen, setForwardOpen] = useState(false)
  // Index into fileChips of the file open in the viewer; null = closed. Owned
  // here (not per pill) so ← / → can step across the message's files.
  const [openFileIdx, setOpenFileIdx] = useState<number | null>(null)
  const canOpenFiles = !!projectId && !!chatroomName
  // Forward and Save to knowledge pack copy the body out word for word into
  // places that draw it trusted (the owner's DM, a pack), so a remote body
  // never gets them.
  const canCopyOut = !untrustedBodies
  const openFile = openFileIdx !== null ? fileChips[openFileIdx] : undefined

  return (
    <div className="group relative flex gap-3">
      {/* No dot for human senders — `sender` only resolves for agents. */}
      <Avatar name={senderName} status={sender?.status} size="md" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
          <span className="font-bold text-gray-900 text-sm">{senderName}</span>
          {outsideAuthor && <OutsideBadge />}
          {roleLabels.map((label, i) => (
            <span key={label} className="inline-flex items-baseline gap-2">
              {i > 0 && <span className="text-gray-300">·</span>}
              <span className="text-[10px] font-semibold tracking-wider text-gray-400 uppercase">
                {label}
              </span>
            </span>
          ))}
          <span className="text-xs text-gray-400">
            <Timestamp date={firstMsg.ts} format="time" />
          </span>
        </div>
        <div className="absolute right-0 top-0 flex items-center gap-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          {canOpenFiles && canCopyOut && (
            <button
              type="button"
              onClick={() => setForwardOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold text-gray-500 bg-white/90 border border-gray-200 rounded-full shadow-sm hover:text-accent hover:border-accent/40 hover:bg-accent/5"
              title="Forward this message to another of your agents"
            >
              <CornerUpRight className="w-3 h-3" />
              Forward
            </button>
          )}
          {canCopyOut && (
            <button
              type="button"
              onClick={() => setPackModalOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold text-gray-500 bg-white/90 border border-gray-200 rounded-full shadow-sm hover:text-purple-700 hover:border-purple-300 hover:bg-purple-50"
              title="Save this message into a knowledge pack"
            >
              <Package className="w-3 h-3" />
              Save to knowledge pack
            </button>
          )}
        </div>
        {forwardOpen && canOpenFiles && canCopyOut && (
          <ForwardModal
            target={{
              projectId: projectId!,
              chatroomName: chatroomName!,
              messageIds: messages.map((m) => m.id),
              senderName,
              senderId: sender?.id,
              content: packDraft,
              files: fileChips.map((f) => f.filename),
              untrusted: untrustedBodies,
            }}
            onClose={() => setForwardOpen(false)}
          />
        )}
        {packModalOpen && canCopyOut && (
          <SaveToPackModal
            initialContent={packDraft}
            onClose={() => setPackModalOpen(false)}
          />
        )}

        {fileChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {fileChips.map((event, i) => (
              <FilePill
                key={event.filename}
                filename={event.filename}
                entryType={event.entry_type}
                canOpen={canOpenFiles}
                onOpen={() => setOpenFileIdx(i)}
              />
            ))}
          </div>
        )}
        {openFile && openFileIdx !== null && canOpenFiles && createPortal(
          <FileViewerModal
            projectId={projectId!}
            chatroomName={chatroomName!}
            untrusted={untrustedBodies}
            filename={openFile.filename}
            onClose={() => setOpenFileIdx(null)}
            nav={{
              index: openFileIdx,
              total: fileChips.length,
              onPrev: () => setOpenFileIdx(openFileIdx - 1),
              onNext: () => setOpenFileIdx(openFileIdx + 1),
            }}
          />,
          document.body,
        )}

        <div className="space-y-1">
          {messages.map((msg) => (
            // `data-message-id` is the anchor MessageList queries to scroll a
            // `?msg=` deep link into view. Always emitted, highlight or not.
            <div
              key={msg.id}
              data-message-id={msg.id}
              className={msg.id === highlightMessageId ? FLASH_CLASS : undefined}
            >
              <MessageContent
                message={msg}
                expanded={expandedIds.has(msg.id)}
                onToggleExpand={() => onToggleExpand(msg.id)}
                untrusted={untrustedBodies}
              />
              {messageFooter?.(msg)}
            </div>
          ))}
        </div>

        {recipientEntries.length > 0 && (
          <div className="grid gap-1.5 mt-2.5">
            {recipientEntries.map((r) => (
              <DelegationRow
                key={r.key}
                displayName={r.displayName}
                agent={r.agent}
                status={r.status}
                isCancelling={cancelMutation.isPending && cancelMutation.variables === r.agentId}
                canCancel={!!projectId && !!chatroomName}
                onCancel={() => cancelMutation.mutate(r.agentId)}
                advisoryOffline={advisoryOfflineIds.has(r.agentId)}
                offlineAtTimeout={r.offlineAtTimeout}
              />
            ))}
            {/* AC-3.5: rendered ONCE for the whole message, outside the map
                over recipients. Eleven offline agents produce eleven chips
                above and exactly one explanation here. */}
            <OfflineRemedyNote
              neverReceived={neverReceived}
              offlineAtTimeout={offlineAtTimeout}
              hasWorkingRecipients={hasWorkingRecipients}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function FilePill({
  filename,
  entryType,
  canOpen,
  onOpen,
}: {
  filename: string
  entryType: ChatFileEvent['entry_type']
  canOpen: boolean
  onOpen: () => void
}) {
  const action = entryType === 'file_created' ? 'created' : 'updated'

  return (
    <button
      type="button"
      onClick={() => canOpen && onOpen()}
      disabled={!canOpen}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-blue-200 bg-blue-50 text-xs font-mono text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition-colors disabled:cursor-default disabled:opacity-60"
      title={canOpen ? `${action}: ${filename} — click to view` : filename}
    >
      <FileText className="w-3.5 h-3.5 text-blue-500" />
      <span className="truncate">{filename}</span>
    </button>
  )
}

interface MessageContentProps {
  message: ChatMessage
  expanded: boolean
  onToggleExpand: () => void
  untrusted: boolean
}

function MessageContent({ message, expanded, onToggleExpand, untrusted }: MessageContentProps) {
  // Clamp purely off expansion state so a collapsed message paints at
  // min(intrinsic, MAX) on its FIRST commit — inside Virtuoso a post-mount
  // shrink forces a scrollTop correction that visibly jumps the viewport
  // when older rows mount during an upward scroll.
  return (
    <MarkdownBody
      content={message.content}
      clampable
      collapsed={!expanded}
      onToggle={onToggleExpand}
      collapsedHeightPx={MAX_COLLAPSED_HEIGHT_PX}
      untrusted={untrusted}
    />
  )
}

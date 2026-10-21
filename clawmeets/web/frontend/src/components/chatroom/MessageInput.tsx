import { useEffect, useState, useRef, KeyboardEvent, ChangeEvent } from 'react'
import { Paperclip, Clock, Loader2, Send } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sendUserMessage } from '../../api/endpoints/messages'
import { hubError } from '../../api/endpoints/hub'
import { accessErrorText } from '../../utils/agentAccessCopy'
import { useHeldPostsStore } from '../../stores/heldPostsStore'
import { useAuthStore } from '../../stores/authStore'
import { useUnsavedGuard } from '../../stores/unsavedGuard'
import { useMessageAttachments } from '../../hooks/useMessageAttachments'
import { useFileDropzone } from '../../hooks/useFileDropzone'
import { useMentionDetection } from '../../hooks/useMentionDetection'
import DropOverlay from '../common/DropOverlay'
import PromptEditor, { type PromptEditorHandle } from '../composer/PromptEditor'
import type { AgentCard } from '../../types'
import { displayName, matchesQuery, mentionInsertText } from '../../utils/agentDisplay'
import { getChatroomDisplayName } from '../../utils/chatroomDisplay'
import Avatar from '../common/Avatar'
import MentionDropdown from './MentionDropdown'
import StagedAttachments from './StagedAttachments'
import ScheduleMessageModal from '../scheduled/ScheduleMessageModal'

interface MessageInputProps {
  projectId: string
  chatroomName: string
  participants: AgentCard[]
  /** Focus the composer on mount / room change (set when the room is opened via selection). */
  autoFocus?: boolean
  /** Replaces "command" on the send button (a channel thread: "Send on Telegram"). */
  sendLabel?: string
  /** Replaces the room's default placeholder. */
  placeholder?: string
}

export default function MessageInput({
  projectId,
  chatroomName,
  participants,
  autoFocus = false,
  sendLabel,
  placeholder: placeholderOverride,
}: MessageInputProps) {
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)
  const [message, setMessage] = useState('')
  const [mentionedAgents, setMentionedAgents] = useState<AgentCard[]>([])
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const editorRef = useRef<PromptEditorHandle>(null)
  // The editable element itself — useMentionDetection measures it to place
  // the dropdown above the box.
  const editorElRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const setGuardDirty = useUnsavedGuard((s) => s.setDirty)

  // Focus the composer when the room is opened via a selection (autoFocus set by
  // the caller). Re-fires on room change so switching rooms re-focuses.
  useEffect(() => {
    if (autoFocus) editorRef.current?.focusEnd()
  }, [autoFocus, projectId, chatroomName])
  const {
    stagedFiles,
    files,
    addFiles,
    removeStagedFile,
    clearStagedFiles,
    attachmentError,
  } = useMessageAttachments()

  // All agents are mentionable (no need to filter out current user's agent)
  const mentionableAgents = participants

  // Non-user-communication/non-DM rooms accept user messages as context only.
  // The backend does not resolve @mentions in these rooms, so nothing the user
  // posts will address an agent — surface this as inline copy under the input.
  const isDMRoom = chatroomName.startsWith('dm-')
  const isUserCommRoom = chatroomName.startsWith('user-communication')
  const isContextOnlyRoom = !isDMRoom && !isUserCommRoom

  // @mention widget is disabled in context-only and user-communication rooms.
  // Kept around so it can be reactivated later without reintroducing the UI code.
  const {
    mention,
    detect: detectMention,
    close: closeMention,
    moveSelection: moveMentionSelection,
  } = useMentionDetection(editorElRef, isContextOnlyRoom || isUserCommRoom)

  // Send message mutation
  // Note: Addressing is now done via @mentions in content - server parses them
  const recordSend = useHeldPostsStore((s) => s.record)
  const beginSend = useHeldPostsStore((s) => s.begin)
  const endSend = useHeldPostsStore((s) => s.end)
  const sendMutation = useMutation({
    onMutate: (content: string) => beginSend(projectId, chatroomName, content),
    onSettled: (_r, _e, content) => endSend(projectId, chatroomName, content),
    mutationFn: async (content: string) => {
      if (!user) throw new Error('Not authenticated')

      return sendUserMessage(projectId, chatroomName, {
        content,
        files,
      })
    },
    onSuccess: (result, content) => {
      // 202: stored and delivered later. Shown as held; never resent.
      recordSend(projectId, chatroomName, content, result)
      setMessage('')
      editorRef.current?.clear()
      setMentionedAgents([])
      clearStagedFiles()
      // Invalidate messages + files queries to refetch
      queryClient.invalidateQueries({
        queryKey: ['messages', projectId, chatroomName],
      })
      queryClient.invalidateQueries({
        queryKey: ['files', projectId, chatroomName],
      })
    },
  })

  const dmAgentName = isDMRoom ? chatroomName.slice('dm-'.length) : ''
  const dmAgent = isDMRoom ? participants.find((a) => a.name === dmAgentName) : undefined
  const dmAgentLabel = dmAgent ? displayName(dmAgent, user) : dmAgentName
  const placeholder = placeholderOverride ?? (isDMRoom
    ? `Message @${dmAgentLabel} directly...`
    : isUserCommRoom
    ? "Message your coordinator — they'll route work to the team..."
    : 'Notes only — agents read silently. For replies, use #coordinator.')

  const handleSelectMention = (selectedAgent: AgentCard) => {
    // Insert by short name when the viewer owns the agent; the server's
    // namespace resolver (resolve_mention) maps the short name back to the
    // stored full name. Public / other-owner agents still insert the full
    // name because mentionInsertText falls through to it.
    const insertName = mentionInsertText(selectedAgent, user ?? null)
    // `mention.startIndex` / `mention.query` are offsets into the editor's
    // plain-text serialization — the exact space `replaceRange` consumes, so
    // the two line up by construction. execCommand keeps the caret after the
    // insertion and preserves undo; the resulting `input` event re-runs
    // detection, which sees the trailing space and closes the dropdown.
    editorRef.current?.replaceRange(
      mention.startIndex,
      mention.startIndex + 1 + mention.query.length,
      `@${insertName} `,
    )
    closeMention()

    // Track mentioned agent (avoid duplicates)
    if (!mentionedAgents.find((a) => a.id === selectedAgent.id)) {
      setMentionedAgents((prev) => [...prev, selectedAgent])
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (mention.isOpen) {
      const filteredAgents = mentionableAgents.filter((a) =>
        matchesQuery(a, mention.query, user ?? null)
      )

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveMentionSelection(1, filteredAgents.length)
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveMentionSelection(-1, filteredAgents.length)
        return
      }

      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && filteredAgents.length > 0) {
        e.preventDefault()
        handleSelectMention(filteredAgents[mention.selectedIndex])
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        closeMention()
        return
      }
    }

    // Escape-blur and Cmd/Ctrl+Enter are handled by PromptEditor. Everything
    // above preventDefault()s, which is how the editor knows to stand down.
  }

  const handleSend = () => {
    const trimmed = message.trim()
    if ((!trimmed && stagedFiles.length === 0) || sendMutation.isPending || !user) return
    // Never ship a half-filled template to the room.
    if (editorRef.current?.nudgeEmpty()) return

    // Re-scan for @mentions in final message for UI display
    // Note: Server will parse @mentions for routing, this is just for UI
    const mentionPattern = /@(\S+)/g
    const finalMentionedAgents: AgentCard[] = []
    let match
    while ((match = mentionPattern.exec(trimmed)) !== null) {
      const mentionName = match[1].toLowerCase()
      // Try full name first, then the viewer's namespace-stripped short name.
      const agent = mentionableAgents.find((a) => {
        if (a.name.toLowerCase() === mentionName) return true
        const short = mentionInsertText(a, user ?? null)
        return short.toLowerCase() === mentionName
      })
      if (agent && !finalMentionedAgents.find((a) => a.id === agent.id)) {
        finalMentionedAgents.push(agent)
      }
    }

    // Update mentioned agents list for UI
    setMentionedAgents(finalMentionedAgents)

    // Send message - server parses @mentions from content for routing
    sendMutation.mutate(trimmed)
  }

  const handleFileSelect = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files)
    }
    // Reset input so the same file can be selected again
    e.target.value = ''
  }

  const isLoading = sendMutation.isPending

  // Drag files onto the composer card → same staging path as the paperclip.
  const { isDragging, dragHandlers } = useFileDropzone({
    onFiles: addFiles,
    disabled: isLoading,
  })

  // Guard against navigating away with an unsent draft or staged attachments.
  const isDirty = message.trim().length > 0 || stagedFiles.length > 0
  useEffect(() => {
    setGuardDirty(isDirty, 'Discard your unsent message and attachments?')
    return () => setGuardDirty(false)
  }, [isDirty, setGuardDirty])
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  return (
    <div className="relative px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] border-t border-border bg-transparent">
      {/* Composer card */}
      <div
        className="relative rounded-2xl border border-gray-200 bg-white shadow-sm focus-within:border-purple-300 focus-within:shadow-[0_0_0_3px_rgba(168,85,247,0.10)] transition-all"
        {...dragHandlers}
      >
        <DropOverlay visible={isDragging} />
        {/* Header: avatar + you → #channel. Hidden on mobile (the chatroom
            header already names the room); shows at sm+ where the extra
            context is welcome. */}
        <div className="hidden sm:flex items-center gap-2 px-4 pt-3 pb-1">
          {user && <Avatar name={user.username} size="xs" />}
          <span className="text-xs">
            <span className="font-medium text-gray-700">you</span>
            <span className="text-gray-300 mx-1.5">→</span>
            <span className="font-mono text-gray-500">#{getChatroomDisplayName(chatroomName)}</span>
          </span>
        </div>

        {/* Mention dropdown */}
        {mention.isOpen && (
          <MentionDropdown
            agents={mentionableAgents}
            viewer={user ?? null}
            query={mention.query}
            position={mention.position}
            selectedIndex={mention.selectedIndex}
            onSelect={handleSelectMention}
            onClose={closeMention}
          />
        )}

        {/* Message — rich: an SOP's {{blanks}} become fillable chips. The
            room's participants (not the whole roster) back an `agent` blank. */}
        <PromptEditor
          ref={editorRef}
          innerRef={editorElRef}
          wrapClassName="px-4 pt-1 pb-2"
          className="text-gray-900 text-sm"
          minHeight={52}
          maxHeight={200}
          placeholder={placeholder}
          disabled={isLoading}
          agents={mentionableAgents}
          viewer={user ?? null}
          onChange={(t) => setMessage(t)}
          onCaretChange={(t, caret) => detectMention(t, caret)}
          onKeyDown={handleKeyDown}
          onSubmit={handleSend}
        />

        {/* Staged attachments (client-side; uploaded on send) */}
        <StagedAttachments files={stagedFiles} onRemove={removeStagedFile} disabled={isLoading} />

        {/* Footer: mentions on the left, actions on the right */}
        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {!isContextOnlyRoom && mentionedAgents.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-gray-500 min-w-0">
                {mentionedAgents.map((a, i) => {
                  const label = mentionInsertText(a, user ?? null)
                  return (
                    <span key={a.id} className="font-mono inline-flex items-center gap-1 truncate">
                      {i > 0 && <span className="text-gray-300">·</span>}
                      @{label}
                      <button
                        onClick={() =>
                          setMentionedAgents((prev) =>
                            prev.filter((agent) => agent.id !== a.id)
                          )
                        }
                        className="text-gray-300 hover:text-red-500"
                        title={`Remove @${label}`}
                      >
                        &times;
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            {/* File upload */}
            <button
              onClick={handleFileSelect}
              disabled={isLoading}
              className="p-1.5 text-gray-400 hover:text-gray-700 rounded transition-colors disabled:opacity-50"
              title="Upload file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Schedule message */}
            <button
              onClick={() => setShowScheduleModal(true)}
              disabled={isLoading}
              className="p-1.5 text-gray-400 hover:text-gray-700 rounded transition-colors disabled:opacity-50"
              title="Schedule message"
            >
              <Clock className="w-4 h-4" />
            </button>

            {/* Send */}
            <button
              onClick={handleSend}
              disabled={(!message.trim() && stagedFiles.length === 0) || isLoading}
              title="Command (⌘/Ctrl+Enter)"
              className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-white bg-accent hover:bg-accent-deep disabled:bg-accent-soft disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>{sendLabel ?? 'command'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Send error */}
      {sendMutation.isError && (
        <p className="mt-2 px-1 text-sm text-red-600">
          {accessErrorText(hubError(sendMutation.error)) ?? (sendMutation.error?.message || 'An error occurred')}
        </p>
      )}

      {/* Attachment error (e.g. over the size limit) */}
      {attachmentError && (
        <p className="mt-2 px-1 text-sm text-red-600">{attachmentError}</p>
      )}

      {/* Schedule message modal */}
      {showScheduleModal && (
        <ScheduleMessageModal
          projectId={projectId}
          chatroomName={chatroomName}
          onClose={() => setShowScheduleModal(false)}
        />
      )}
    </div>
  )
}

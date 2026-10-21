import { useEffect, useMemo, useRef, useState, ChangeEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { FileText, Paperclip, Clock, GraduationCap, X, Send, Loader2, Trash2 } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useUIStore } from '../../stores/uiStore'
import { useAuthStore } from '../../stores/authStore'
import { useUnsavedGuard } from '../../stores/unsavedGuard'
import { useAgents } from '../../hooks/useAgents'
import { useChatroom, useUserProjects } from '../../hooks/useProjects'
import { useRoomTrust } from '../../hooks/useRoomTrust'
import { useSetRoomFlow } from '../../hooks/useAgentAccess'
import { useRenameProject } from '../../hooks/useRenameProject'
import { useDeleteProject } from '../../hooks/useDeleteProject'
import { useActiveWorkStore, selectActiveParticipants } from '../../stores/activeWorkStore'
import { useModelSelectionStore } from '../../stores/modelSelectionStore'
import { useModelConfigs } from '../../hooks/useModelConfigs'
import { getMessages } from '../../api/endpoints'
import { sendDMMessage, createDMThread, createFDThread } from '../../api/endpoints/dm'
import { hubError } from '../../api/endpoints/hub'
import { accessErrorText, FLOW_COPY } from '../../utils/agentAccessCopy'
import { outsideFileNames } from '../../utils/roomTrust'
import RoomFlowStrip from '../chatroom/RoomFlowStrip'
import { useHeldPostsStore } from '../../stores/heldPostsStore'
import { HeldNotices } from '../chatroom/HeldNotice'
import { useFiles } from '../../hooks/useFiles'
import { useMessageDeepLink } from '../../hooks/useMessageDeepLink'
import PromptEditor, { type PromptEditorHandle } from '../composer/PromptEditor'
import { useMessageAttachments } from '../../hooks/useMessageAttachments'
import { useFileDropzone } from '../../hooks/useFileDropzone'
import { AgentStatus, isChatFileEvent, isScheduledDMProject } from '../../types'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import { buildPersonalizeMessage, isAssistantAgent } from '../../utils/personalize'
import Loading from '../common/Loading'
import Avatar from '../common/Avatar'
import ModelSelector from '../common/ModelSelector'
import MessageList from '../chatroom/MessageList'
import StagedAttachments from '../chatroom/StagedAttachments'
import DMZeroState from './DMZeroState'
import PersonalizeModal, { type PersonalizeResult } from './PersonalizeModal'
import { buildRecipientStatusIndex } from '../chatroom/recipientStatus'
import FileList from '../files/FileList'
import Overlay from '../common/Overlay'
import DropOverlay from '../common/DropOverlay'
import ResizeHandle from '../common/ResizeHandle'
import ScheduleMessageModal from '../scheduled/ScheduleMessageModal'
import ClearHistoryButton from '../common/ClearHistoryButton'
import CollapsibleHeader from '../common/CollapsibleHeader'
import InlineEditableTitle from '../common/InlineEditableTitle'
import HomeFolderBrowser from '../homefs/HomeFolderBrowser'
import AgentViewActions from '../agent/AgentViewActions'
import AgentNameLink from '../agent/AgentNameLink'

// DM chat view — ChatGPT/Claude thread model, N threads per agent for BOTH own
// and foreign (Front Desk) agents. Routes:
//   /dm/:agentName            → a fresh, ephemeral "New chat" draft (nothing
//                               created until the first send), for own OR
//                               foreign agents.
//   /dm/:agentName/:threadId  → an existing thread project bound directly to
//                               `threadId` (own-agent DM thread or foreign FD
//                               thread — both requester-owned).
// Either way the `user-communication` chatroom IS the DM thread. The first send
// from a draft mints an own-DM thread (createDMThread) for own agents or an FD
// thread (createFDThread, tunnel-wired) for foreign agents.
export default function DMChatView() {
  const { agentName = '', threadId } = useParams<{ agentName: string; threadId?: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const {
    isMobileRightPanelOpen,
    openMobileRightPanel,
    closeMobileRightPanel,
    rightPanelWidth,
    setRightPanelWidth,
    setRailContext,
  } = useUIStore()
  const user = useAuthStore((state) => state.user)
  const { data: allAgents, isLoading: agentsLoading } = useAgents()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [showPersonalizeModal, setShowPersonalizeModal] = useState(false)

  const agent = useMemo(
    () => allAgents?.find((a) => a.name === agentName),
    [allAgents, agentName]
  )
  const agentLabel = agent ? agentDisplayName(agent, user ?? null) : agentName

  const isOwnAgent = !!user && !!agent && agent.registered_by === user.id
  // The user's own assistant gets the method-picker modal; every other agent
  // keeps today's role-anchored deep-research prefill (buildPersonalizeMessage).
  const isAssistant = isAssistantAgent(agent, user)
  // No thread in the URL = a fresh ephemeral "New chat" draft (own OR foreign
  // agent): the draft lives in local state only; NO project row is created
  // until the first message is sent. Abandon it → no trace.
  const isNewChatDraft = !!user && !!agent && !threadId

  // Threads (own DM or foreign FD) bind directly to the `threadId` in the URL;
  // a new-chat draft resolves to no project yet.
  const dmProjectId = threadId ?? ''
  const chatroomName = dmProjectId ? 'user-communication' : ''
  // A draft renders immediately; a bound thread comes straight from the URL.
  const projectLoading = agentsLoading || (!isNewChatDraft && !dmProjectId)

  // Header title = the thread project's display_name (item e). Read from the
  // SAME user-projects cache the sidebar row reads, so the auto-title flips
  // header + row together on one list refetch. Drafts/foreign fall back.
  const { data: userProjects } = useUserProjects()
  // A search hit links a host-side Hub Request (a Front Desk project) here,
  // so its bodies follow the same trust rule as ChatroomView: the whole room,
  // and per author (another account's agent, a requester).
  const trust = useRoomTrust(dmProjectId, chatroomName)
  const threadProject = useMemo(
    () => (threadId ? userProjects?.find((p) => p.id === threadId) : undefined),
    [userProjects, threadId],
  )
  // The header title is always the agent; the thread's own name (once it has
  // one) sits on the line under it and stays click-to-rename.
  const threadName = isNewChatDraft ? '' : threadProject?.display_name || ''
  // Same mutation as the project page: a DM thread IS a Project, so the header
  // rename is one hook and one endpoint on both surfaces.
  const renameThread = useRenameProject()
  // A DM thread dedicated to scheduled messages ({username}-dm-{short}-schedule).
  const isScheduledThread = !!threadProject && isScheduledDMProject(threadProject)

  // Settings/Delete agent live on the agent view (/dm/:agentName, no thread),
  // not inside a conversation. Owner-only; the assistant is never deletable.
  const showAgentActions = isOwnAgent && !!agent && !threadId
  // The home-folder navigator replaces the transcript on the agent view
  // (`?view=home`), so the settings page can link straight to it.
  const homeFolderOpen = showAgentActions && agent.home_folder_browsable === true && searchParams.get('view') === 'home'

  // Conversation delete moved here from the DMs rail row. useDeleteProject
  // drops back to the agent's new-chat draft when the open thread goes.
  const deleteThreadMutation = useDeleteProject()
  const canDeleteThread = !!threadProject && !threadProject.is_viewer
  // The thread's owner may stop and resume outside messages, as in the room.
  const isThreadOwner = canDeleteThread && !!user && threadProject.created_by === user.id
  const { data: chatroom } = useChatroom(dmProjectId, chatroomName)
  const resumeFlow = useSetRoomFlow(dmProjectId, chatroomName)
  const handleDeleteThread = () => {
    const title = threadName || `chat with ${agentLabel}`
    if (!window.confirm(`Delete conversation "${title}"? This cannot be undone.`)) return
    deleteThreadMutation.mutate(dmProjectId)
  }

  // Fetch messages
  const { data: messages, isLoading: messagesLoading } = useQuery({
    queryKey: ['messages', dmProjectId, chatroomName],
    queryFn: () => getMessages(dmProjectId, chatroomName),
    enabled: !!dmProjectId,
    refetchInterval: 5000,
  })

  // Processing-agent ids come from the activeWorkStore, driven by the
  // ACTIVE_WORK_CHANGE WebSocket envelope (bootstrapped via /me/active-work).
  const processingAgentIds = useActiveWorkStore(selectActiveParticipants(dmProjectId, chatroomName))

  // Fetch files
  const { data: files, isLoading: filesLoading } = useFiles(dmProjectId, chatroomName)
  // The Files sidebar follows the per-author rule, as in ChatroomView: a file
  // another account's agent posted opens untrusted (no "Open in new tab").
  const outsideFiles = useMemo(
    () => outsideFileNames(chatroom, trust.ownerId, (files ?? []).map((f) => f.name), (messages ?? []).filter(isChatFileEvent)),
    [chatroom, trust.ownerId, files, messages],
  )
  // `?msg=` deep-link target from ⌘K message search, consumed and cleared the
  // same way this view already handles `?draft=`.
  const { targetMessageId, clearTarget } = useMessageDeepLink()

  const {
    stagedFiles,
    files: attachmentFiles,
    addFiles,
    removeStagedFile,
    clearStagedFiles,
    attachmentError,
  } = useMessageAttachments()

  // Per-request model override (spec #3): the resolved active config for this
  // DM's target agent — the transient selector pick, else the agent's backend
  // default — sent as `model_config_name` so the override is explicit and
  // verifiable. Fetched only for OWN agents (foreign FD agents 403 on the
  // configs route + get no selector), so a foreign DM sends nothing ⇒ the
  // server silently uses that agent's own default.
  const { data: modelConfigData } = useModelConfigs(isOwnAgent ? agent?.id : undefined)
  const selectedConfigName = useModelSelectionStore((s) => (agent ? s.byAgent[agent.id] : undefined))
  const modelConfigName = selectedConfigName ?? modelConfigData?.default ?? undefined

  // Send into an existing thread / FD project.
  const recordSend = useHeldPostsStore((s) => s.record)
  const beginSend = useHeldPostsStore((s) => s.begin)
  const endSend = useHeldPostsStore((s) => s.end)
  // The send carries its own thread: the view stays mounted across threads, so
  // a send that settles after the user switched must record, refetch and report
  // against the thread it was posted to, never the one now open.
  type SendVars = { projectId: string; room: string; content: string; files: File[] }
  const sendMessageMutation = useMutation({
    onMutate: (vars: SendVars) => beginSend(vars.projectId, vars.room, vars.content),
    onSettled: (_r, _e, vars) => endSend(vars.projectId, vars.room, vars.content),
    mutationFn: (vars: SendVars) =>
      sendDMMessage(vars.projectId, vars.room, vars.content, vars.files, modelConfigName),
    onSuccess: (result, vars) => {
      // 202: stored and delivered later. Shown as held; never resent.
      recordSend(vars.projectId, vars.room, vars.content, result)
      // The composer stayed disabled while this send was pending (in any
      // thread), so what it holds is still this send's text and files.
      clearComposer()
      clearStagedFiles()
      queryClient.invalidateQueries({ queryKey: ['messages', vars.projectId, vars.room] })
      queryClient.invalidateQueries({ queryKey: ['files', vars.projectId, vars.room] })
    },
  })

  // (item d) First send from a "New chat" draft materializes a NEW thread
  // project, then posts the message into it, then binds the view to the real
  // thread and surfaces the row at the top of DM / Chats. A per-draft
  // idempotency key guards the double-send race (two creates → one thread).
  const draftKeyRef = useRef<string>()
  if (!draftKeyRef.current) draftKeyRef.current = crypto.randomUUID()
  // Regenerate the key whenever a FRESH draft begins (no threadId), so a 2nd
  // "New chat" with the same agent can't reuse the prior draft's key. Without
  // this, RRv6 renders the sibling `/dm/:agentName` and `/dm/:agentName/:threadId`
  // routes at the same tree position and PRESERVES this instance across
  // navigation — leaving `draftKeyRef` holding the stale key, which the
  // backend's (user.id, key) idempotency cache would HIT and silently merge the
  // new message into the prior thread (breaking the N-per-agent model).
  // Correctness must NOT depend on remount behavior, so we reset explicitly.
  useEffect(() => {
    if (!threadId) draftKeyRef.current = crypto.randomUUID()
  }, [threadId, agentName])
  const createThreadMutation = useMutation({
    mutationFn: async (vars: { content: string; files: File[] }): Promise<string> => {
      // Own agents mint an own-DM thread; foreign agents mint a tunnel-wired
      // Front Desk thread. Both are requester-owned, N-per-agent. Staged files
      // ride the first message into the freshly-minted thread.
      const thread = isOwnAgent
        ? await createDMThread(agentName, draftKeyRef.current)
        : await createFDThread(agentName, draftKeyRef.current)
      const sent = await sendDMMessage(thread.id, 'user-communication', vars.content, vars.files, modelConfigName)
      recordSend(thread.id, 'user-communication', vars.content, sent)
      return thread.id
    },
    onSuccess: (newThreadId) => {
      clearComposer()
      clearStagedFiles()
      queryClient.invalidateQueries({ queryKey: ['user-projects'] })
      queryClient.invalidateQueries({ queryKey: ['all-projects'] })
      // Surface the freshly-created thread in the rail: switch to the DMs
      // context so the user sees DMs › agent › (new thread) instead of staying
      // on whatever context they launched the draft from (usually Agents).
      setRailContext('dms')
      navigate(`/dm/${encodeURIComponent(agentName)}/${newThreadId}`, { replace: true })
    },
  })

  const isSending = sendMessageMutation.isPending || createThreadMutation.isPending
  // A refused send keeps the draft (the composer clears only on success) and
  // says why in the agent-access copy; a stopped room offers its owner Resume.
  // Only this thread's refusal is shown: a send posted from another thread
  // keeps its error to itself, and so does its Resume.
  const sendError =
    (sendMessageMutation.variables?.projectId === dmProjectId ? sendMessageMutation.error : null) ??
    (isNewChatDraft ? createThreadMutation.error : null)
  const sendErrorBody = sendError ? hubError(sendError) : null
  const sendErrorText = sendError ? accessErrorText(sendErrorBody) ?? sendError.message : null
  const canResume = sendErrorBody?.code === 'room_flow_stopped' && isThreadOwner
  // The view stays mounted across threads (see the draft key above), so a
  // settled refusal is cleared on a switch. A send still in flight is NOT
  // reset: reset() only detaches the observer, so the composer would re-enable
  // while the old send keeps running and its onSuccess later wipes whatever
  // was typed in the new thread. It keeps the composer disabled until it
  // settles; the per-thread gate on `sendError` above hides its outcome here.
  const sendStateRef = useRef({ send: sendMessageMutation, create: createThreadMutation })
  sendStateRef.current = { send: sendMessageMutation, create: createThreadMutation }
  useEffect(() => {
    const { send, create } = sendStateRef.current
    if (!send.isPending) send.reset()
    if (!create.isPending) create.reset()
  }, [threadId, agentName])

  // Drag files onto the composer card → same staging path as the paperclip.
  const { isDragging, dragHandlers } = useFileDropzone({
    onFiles: addFiles,
    disabled: isSending,
  })

  const setGuardDirty = useUnsavedGuard((s) => s.setDirty)

  // Starts empty: the `?draft=` deep-link is applied solely by the effect
  // below, which routes through prefillComposer (and so keeps the
  // don't-clobber confirm). Seeding here too would double-apply it.
  const [dmMessage, setDmMessage] = useState('')
  const dmEditorRef = useRef<PromptEditorHandle>(null)
  // Mirror for the prefill guard, which must read the live draft.
  const dmMessageRef = useRef('')

  // Focus the composer on selection (agent DM or a specific thread) so the user
  // can type immediately. Re-fires when switching agents/threads; the
  // projectLoading dep ensures it runs once the composer has mounted.
  useEffect(() => {
    if (!projectLoading) dmEditorRef.current?.focusEnd()
  }, [agentName, dmProjectId, projectLoading])

  // Route the send: a draft creates-then-sends (item d); a bound thread/FD
  // project sends directly. The pending gate blocks a double-submit either way.
  const submitMessage = () => {
    const content = dmMessage.trim()
    if ((!content && stagedFiles.length === 0) || isSending) return
    // Never ship a half-filled template to an agent.
    if (dmEditorRef.current?.nudgeEmpty()) return
    const vars = { content, files: attachmentFiles }
    // The draft stays until the send succeeds (the editor is disabled while
    // it is pending), so a refused post is never lost.
    if (isNewChatDraft) {
      createThreadMutation.mutate(vars)
    } else if (dmProjectId) {
      sendMessageMutation.mutate({ ...vars, projectId: dmProjectId, room: chatroomName })
    }
  }

  function clearComposer() {
    setDmMessage('')
    dmMessageRef.current = ''
    dmEditorRef.current?.clear()
  }

  const handleSendMessage = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submitMessage()
  }

  const handleFileSelect = () => {
    fileInputRef.current?.click()
  }

  // Single source of truth for "write the composer": sets the draft and focuses
  // the textarea. If a different non-empty draft already exists, confirm before
  // replacing so we never silently clobber what the user was typing. Shared by
  // the zero-state sample cards and the personalize CTA.
  const prefillComposer = (text: string) => {
    const current = dmMessageRef.current.trim()
    if (
      current &&
      current !== text.trim() &&
      !window.confirm('Replace your current draft?')
    ) {
      return
    }
    dmEditorRef.current?.setPlain(text, true)
  }

  // Hover/focus counterpart to prefillComposer, for the zero-state idea rows.
  // Pure decoration: no draft write, and so no replace-your-draft confirm —
  // the ghost is gated on `data-blank='1'` in CSS, so a draft simply hides it.
  const previewInComposer = (text: string | null) => {
    dmEditorRef.current?.setGhost(text)
  }

  // Apply a `?draft=...` deep-link into the composer, then strip the param so
  // back-nav / refresh doesn't re-prefill. Applying here (not only in the
  // useState initializer) also covers SPA navigations that DON'T remount this
  // view — clicking a sidebar `+` while already on the assistant DM, or
  // switching into a draft URL from another agent. prefillComposer confirms
  // before overwriting a draft you've already started typing.
  useEffect(() => {
    const draft = searchParams.get('draft')
    if (!draft) return
    prefillComposer(draft)
    const next = new URLSearchParams(searchParams)
    next.delete('draft')
    setSearchParams(next, { replace: true })
    // prefillComposer is recreated each render; the `draft` guard makes re-runs
    // a no-op, so it's intentionally omitted from the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams])

  // Personalize sends (or prefills) through the same composer, so it waits for
  // a pending send like Send does: after a thread switch that send still holds
  // its staged files, and a send here would carry them into this thread.
  const handlePersonalize = () => {
    if (!user || !agent || isSending) return
    // Assistant → open the method-picker modal; workers → today's prefill.
    if (isAssistant) {
      setShowPersonalizeModal(true)
      return
    }
    prefillComposer(buildPersonalizeMessage(agent, agentLabel, isAssistant))
  }

  // Route a confirmed personalize method to a send. 'upload' needs a file
  // (staged via the composer paperclip), so it prefills the composer body and
  // opens the native file picker instead of sending; 'export'/'questions' send
  // the templated DM straight away, reusing the existing send path (create the
  // thread first if this is a fresh "New chat" draft, else send into the open one).
  const handlePersonalizeConfirm = (r: PersonalizeResult) => {
    setShowPersonalizeModal(false)
    if (isSending) return
    if (r.method === 'upload') {
      prefillComposer(r.body)
      fileInputRef.current?.click()
      return
    }
    const vars = { content: r.body, files: attachmentFiles }
    if (isNewChatDraft) {
      createThreadMutation.mutate(vars)
    } else if (dmProjectId) {
      sendMessageMutation.mutate({ ...vars, projectId: dmProjectId, room: chatroomName })
    }
  }

  // Personalize button tooltip. The control is icon-only in the toolbar, so the
  // tooltip carries the label AND the payoff — it is the only place the words
  // appear once the DM has messages in it (the zero state still shows the full
  // gradient CTA).
  const personalizeHint = isAssistant
    ? 'Personalize — teach it who you are and how you work'
    : `Train as expert — deep-research @${agentLabel} into your field`

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files)
    }
    e.target.value = ''
  }

  // Guard against navigating away with an unsent draft or staged attachments.
  const isDirty = dmMessage.trim().length > 0 || stagedFiles.length > 0
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

  // `isMobileRightPanelOpen` is global UI state, so a panel left open on a
  // thread would silently re-open when the user navigates back to one after
  // visiting the agent page. Reset it whenever the panel isn't available.
  useEffect(() => {
    if (!dmProjectId) closeMobileRightPanel()
  }, [dmProjectId, closeMobileRightPanel])

  // Pass the full ChatLogEntry stream — buildRecipientStatusIndex needs
  // batch_timeout rows in addition to messages so it can flip a recipient
  // from AWAITING to TIMED OUT. Filtering to messages here (as this did
  // before batch-timeout support landed) leaves the chip stuck on AWAITING
  // forever. ChatroomView passes the same unfiltered stream.
  const statusIndex = useMemo(
    () =>
      buildRecipientStatusIndex(
        messages || [],
        allAgents || [],
        processingAgentIds,
      ),
    [messages, allAgents, processingAgentIds],
  )

  // The Files panel only has anything to show once a thread exists. On the
  // agent page (`/dm/:agentName`, a draft) there is no project yet, so the
  // files query is disabled and the panel would render a permanently-empty
  // "Files (0)" column — hide the whole right rail (and its mobile toggle /
  // resize handle) there instead. Gated on `dmProjectId`, NOT on "zero state
  // showing": DMZeroState also renders for a real-but-empty thread, where
  // Files is still live.
  const showFilesPanel = !!dmProjectId

  // Onboarding launchpad instead of a transcript: either a draft thread with no
  // project yet, or a real thread nobody has written in. Also drives the taller
  // resting composer, so a hovered idea's 3-line ghost preview fits without the
  // box ever changing size.
  const showZeroState = !dmProjectId || (messages?.length ?? 0) === 0

  if (projectLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading size="lg" />
      </div>
    )
  }

  const fileCount = files?.length || 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <CollapsibleHeader className="border-b border-border px-6 py-3 pl-14 lg:pl-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              {agent && (
                <Avatar
                  name={agentLabel}
                  status={agent.status as AgentStatus}
                  size="md"
                />
              )}
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-lg text-channel-active min-w-0">
                  {agent ? (
                    <AgentNameLink agentName={agent.name} className="truncate">
                      {agentLabel}
                    </AgentNameLink>
                  ) : (
                    <span className="truncate">{agentLabel}</span>
                  )}
                  {isScheduledThread && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-deep"
                      title="Scheduled messages thread"
                    >
                      <Clock className="w-3 h-3" />
                      Scheduled
                    </span>
                  )}
                </h2>
                {threadName ? (
                  <p className="text-sm text-channel min-w-0">
                    <InlineEditableTitle
                      value={threadName}
                      label="Conversation name"
                      editable={!!threadProject && !threadProject.is_viewer}
                      onSave={(next) =>
                        renameThread.mutateAsync({ projectId: dmProjectId, displayName: next })
                      }
                    />
                  </p>
                ) : (
                  !isOwnAgent && agent?.description && (
                    <p className="text-sm text-channel truncate">{agent.description}</p>
                  )
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Files toggle button - visible only on mobile */}
            {showFilesPanel && (
              <button
                onClick={openMobileRightPanel}
                className="p-2 rounded-md hover:bg-sidebar-hover transition-colors relative lg:hidden"
                aria-label="Show files panel"
                title="Files"
              >
                <FileText className="w-5 h-5 text-channel" />
                {fileCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-accent text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">
                    {fileCount > 9 ? '9+' : fileCount}
                  </span>
                )}
              </button>
            )}
            {dmProjectId && chatroomName && (
              <ClearHistoryButton
                projectId={dmProjectId}
                chatroomName={chatroomName}
                confirmLabel={`@${agentLabel}`}
              />
            )}
            {showAgentActions && (
              <AgentViewActions agent={agent} agentLabel={agentLabel} active={homeFolderOpen ? 'home' : 'start'} />
            )}
            {canDeleteThread && (
              <button
                type="button"
                onClick={handleDeleteThread}
                disabled={deleteThreadMutation.isPending}
                className="p-2 rounded-md hover:bg-red-100 transition-colors text-channel hover:text-red-600 disabled:opacity-50"
                aria-label="Delete conversation"
                title="Delete conversation"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </CollapsibleHeader>

      {/* Content */}
      {homeFolderOpen ? (
        <HomeFolderBrowser
          key={`${agent.id}:${searchParams.get('path') ?? ''}`}
          agentId={agent.id}
          agentLabel={agentLabel}
          initialPath={searchParams.get('path') ?? ''}
        />
      ) : (
      <div className="flex-1 flex overflow-hidden relative">
        {/* Main message area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Messages */}
          {messagesLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loading />
            </div>
          ) : showZeroState ? (
            <DMZeroState
              agent={agent}
              onUseSample={prefillComposer}
              onPreviewSample={previewInComposer}
              onPersonalize={handlePersonalize}
            />
          ) : (
            <MessageList
              messages={messages || []}
              agents={allAgents || []}
              projectId={dmProjectId}
              chatroomName={chatroomName}
              statusIndex={statusIndex}
              targetMessageId={targetMessageId}
              onTargetResolved={clearTarget}
              untrustedBodies={trust.untrustedBodies}
              isOutsideAuthor={trust.isOutsideAuthor}
            />
          )}

          <RoomFlowStrip flow={chatroom?.flow} viewerIsOwner={isThreadOwner} />
          {dmProjectId && (
            <HeldNotices projectId={dmProjectId} room={chatroomName} messages={messages} viewerId={user?.id} />
          )}

          {sendErrorText && (
            <p role="alert" className="px-4 py-1 text-sm text-red-600" data-testid="dm-send-error">
              {sendErrorText}
              {canResume && (
                <button
                  type="button"
                  className="ml-2 font-semibold text-accent-deep underline disabled:opacity-50"
                  disabled={resumeFlow.isPending}
                  onClick={() => resumeFlow.mutate('open', { onSuccess: () => sendMessageMutation.reset() })}
                  data-testid="dm-resume-flow"
                >
                  {FLOW_COPY.resume}
                </button>
              )}
            </p>
          )}

          {/* Attachment error (e.g. over the size limit) */}
          {attachmentError && (
            <div className="px-4 py-1 text-sm text-red-600">{attachmentError}</div>
          )}

          {/* Message input */}
          <form onSubmit={handleSendMessage} className="p-4 border-t border-border">
            <div
              className="relative rounded-2xl border border-gray-200 bg-white shadow-sm focus-within:border-purple-300 focus-within:shadow-[0_0_0_3px_rgba(168,85,247,0.10)] transition-all"
              {...dragHandlers}
            >
              <DropOverlay visible={isDragging} />
              {/* Header: avatar + you → @agent */}
              <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                {user && <Avatar name={user.username} size="xs" />}
                <span className="text-xs">
                  <span className="font-medium text-gray-700">you</span>
                  <span className="text-gray-300 mx-1.5">→</span>
                  <span className="font-mono text-gray-500">@{agentLabel}</span>
                </span>
              </div>

              {/* Message — rich: an SOP's {{blanks}} become fillable chips */}
              <PromptEditor
                ref={dmEditorRef}
                wrapClassName="px-4 pt-1 pb-2"
                className="text-gray-900 text-sm"
                minHeight={showZeroState ? 76 : 52}
                maxHeight={200}
                placeholder={`Message @${agentLabel}...`}
                disabled={isSending}
                agents={allAgents ?? []}
                viewer={user ?? null}
                onChange={(t) => {
                  setDmMessage(t)
                  dmMessageRef.current = t
                }}
                onSubmit={submitMessage}
              />

              {/* Staged attachments (client-side; uploaded on send) */}
              <StagedAttachments files={stagedFiles} onRemove={removeStagedFile} disabled={isSending} />

              {/* Footer: draft actions only, right-aligned. `flex-wrap` so adding
                  the model selector never pushes the send button out of a narrow
                  column. Every control here is icon-sized except `command`,
                  so the row holds on a phone. */}
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-2">
                <div className="flex items-center gap-0.5 shrink-0">
                  {/* Model for this agent — quick-edit shortcut to Agent Settings */}
                  <ModelSelector agent={agent} />

                  {/* File upload (staged; sent with the message) */}
                  <button
                    type="button"
                    onClick={handleFileSelect}
                    disabled={isSending}
                    className="p-1.5 text-gray-400 hover:text-gray-700 rounded transition-colors disabled:opacity-50"
                    title="Attach file"
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

                  {/* Schedule */}
                  <button
                    type="button"
                    onClick={() => setShowScheduleModal(true)}
                    disabled={!dmProjectId}
                    className="p-1.5 text-gray-400 hover:text-gray-700 rounded transition-colors disabled:opacity-50"
                    title="Schedule message"
                  >
                    <Clock className="w-4 h-4" />
                  </button>

                  {/* Setup CTA, collapsed to an icon so it costs one slot in a
                      row that already flexes instead of a band of its own.
                      Mortarboard, not a sparkle: a sparkle means "AI did
                      something" everywhere else in this app, whereas a
                      graduation cap reads as teach/train/qualify — which is
                      exactly the action for both roles (the assistant learns
                      the USER, every other agent is deep-researched into a
                      field expert). Tinted accent so it does not disappear
                      into the gray attach/schedule pair; the words live in the
                      tooltip and in the zero-state CTA. */}
                  <button
                    type="button"
                    onClick={handlePersonalize}
                    disabled={!agent || isSending}
                    title={personalizeHint}
                    aria-label={isAssistant ? 'Personalize' : 'Train as expert'}
                    className="p-1.5 text-accent/70 hover:text-accent-deep hover:bg-purple-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <GraduationCap className="w-4 h-4" />
                  </button>

                  {/* Send */}
                  <button
                    type="submit"
                    disabled={isSending || (!dmMessage.trim() && stagedFiles.length === 0)}
                    title="Command (⌘/Ctrl+Enter)"
                    className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-white bg-accent hover:bg-accent-deep disabled:bg-accent-soft disabled:cursor-not-allowed transition-colors"
                  >
                    {isSending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    <span>command</span>
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>

        {showFilesPanel && (
          <>
            {/* Backdrop overlay for mobile files panel */}
            <Overlay isOpen={isMobileRightPanelOpen} onClose={closeMobileRightPanel} />

            <ResizeHandle side="right" onResize={setRightPanelWidth} />

            {/* Files sidebar - slide-in on mobile, static on desktop */}
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

              {/* Files */}
              <div className="flex flex-col flex-1 min-h-0 mt-8 lg:mt-0">
                <div className="px-4 py-3 border-b border-border">
                  <h3 className="text-xs font-extrabold text-channel uppercase tracking-wider">
                    Files ({fileCount})
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
                      projectId={dmProjectId}
                      chatroomName={chatroomName}
                      isOutsideFile={(name) => outsideFiles.has(name)}
                    />
                  )}
                </div>
              </div>
            </aside>
          </>
        )}
      </div>
      )}

      {/* Schedule message modal */}
      {showScheduleModal && dmProjectId && (
        <ScheduleMessageModal
          projectId={dmProjectId}
          chatroomName={chatroomName}
          onClose={() => setShowScheduleModal(false)}
        />
      )}

      {/* Personalize method-picker modal (assistant only) */}
      {showPersonalizeModal && agent && (
        <PersonalizeModal
          agentLabel={agentLabel}
          onConfirm={handlePersonalizeConfirm}
          onClose={() => setShowPersonalizeModal(false)}
        />
      )}
    </div>
  )
}

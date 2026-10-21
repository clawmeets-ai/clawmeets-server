import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Paperclip, Send, X } from 'lucide-react'
import {
  fileIdOf, hubError, localAgentOf, payloadTooLargeOf, retryAfterSeconds,
  type ConversationTarget, type HubAgent, type HubAgentPage, type HubErrorBody,
} from '../../api/endpoints/hub'
import { getMessages } from '../../api/endpoints'
import { useChatroom, useProject } from '../../hooks/useProjects'
import { useSetRoomFlow } from '../../hooks/useAgentAccess'
import { useWebSocketStatus } from '../../hooks/useWebSocket'
import {
  useHubAgent, useHubConfig, useHubDeliveries, useHubSend, useReportedThisSession, useStartHubConversation,
} from '../../hooks/useHub'
import { useAuthStore } from '../../stores/authStore'
import { isChatMessage, type ChatMessage } from '../../types'
import { hubThreadPath, REMOTE_TEXT_CAP, safeRemoteText, shortFingerprint } from '../../utils/hubDisplay'
import {
  checkHubPayload, closedBanner, HUB_COPY, hubThreadInputState, payloadTooLargeLine, type HubTargetLive, type HubThreadNames,
} from '../../utils/hubThread'
import { accessErrorText, FLOW_COPY } from '../../utils/agentAccessCopy'
import RoomFlowControl from '../chatroom/RoomFlowControl'
import RoomFlowStrip from '../chatroom/RoomFlowStrip'
import Loading from '../common/Loading'
import HubAvatar from './HubAvatar'
import HubDeliveryLine from './HubDeliveryLine'
import HubDisclosure, { type DisclosureTarget } from './HubDisclosure'
import HubMessageBody from './HubMessageBody'
import HubOfflineConfirm from './HubOfflineConfirm'
import HubThreadBanner from './HubThreadBanner'
import ReportDialog from './ReportDialog'
import RetainButton, { UnretainAction } from './RetainButton'
import UnusualNameChip from './UnusualNameChip'

const UC = 'user-communication'

export const HUB_CHAT_COPY = {
  unlistedDraft: 'This agent is no longer listed on the hub.',
  loadFailed: "Couldn't load this agent.",
  detailBusy: (s: number) => `You've sent a lot of requests. Try again in ${s} s.`,
  ownAgent: 'This is your own agent. Open it from your agents list.',
  sendFailed: "Couldn't send. Your message is kept; try again.",
  threadGone: 'This conversation no longer exists on this server.',
  sendRefused: "Couldn't send: this server refused the message. Your message is kept.",
  fileGone: (name: string) => `That file is no longer in this conversation: ${name}`,
  invalidAgentId: "This link doesn't point to an agent on the hub. Open the agent again from the directory.",
} as const

/** The newest search item for this id, if the directory already has it: the
 *  draft can show the disclosure without spending a detail request. */
function cachedSearchItem(pages: [unknown, { pages: HubAgentPage[] } | undefined][], id: string): HubAgent | undefined {
  let best: HubAgent | undefined
  for (const [, data] of pages) {
    for (const pg of data?.pages ?? []) {
      for (const a of pg.agents) {
        if (a.hub_agent_id === id && (!best || a.listing_refreshed_at > best.listing_refreshed_at)) best = a
      }
    }
  }
  return best
}

/** The sentence for a failed start-conversation (the thread was not created). */
function startErrorText(b: HubErrorBody | null): string {
  const access = accessErrorText(b)
  if (access) return access
  switch (b?.code) {
    case 'own_agent': return HUB_CHAT_COPY.ownAgent
    case 'agent_unlisted':
    case 'agent_not_found': return HUB_CHAT_COPY.unlistedDraft
    case 'rate_limited': return HUB_CHAT_COPY.detailBusy(retryAfterSeconds(b) ?? 60)
    case 'hub_off_on_server': return HUB_COPY.hubOff
    case 'hub_not_registered': return HUB_COPY.notRegistered
    case 'hub_discover_only': return HUB_COPY.browseOnly
    case 'hub_untrusted': return HUB_COPY.untrusted
    case 'hub_unreachable': return HUB_COPY.unreachable(null)
    default: return HUB_CHAT_COPY.sendFailed
  }
}

/** A start-conversation refusal that no retry can change: it replaces the
 *  composer with its sentence instead of inviting the user to try again. */
function startRefusalText(b: HubErrorBody | null, names: HubThreadNames, nowMs: number): string | null {
  switch (b?.code) {
    case 'identity_changed': return closedBanner('identity_changed', names, null, nowMs)
    case 'invalid_agent_id': return HUB_CHAT_COPY.invalidAgentId
    default: return null
  }
}

/** Send errors shown as a file problem instead (see the effect below). */
const FILE_ERROR_CODES = new Set(['file_not_found', 'payload_too_large'])

/** The line for a send error that no banner or file problem already explains. */
function sendErrorText(b: HubErrorBody): string {
  return accessErrorText(b) ?? (b.code === 'project_not_found' ? HUB_CHAT_COPY.threadGone : HUB_CHAT_COPY.sendRefused)
}

/** Re-renders for countdowns and the "Sending…" window: every second while a
 *  wait runs, else every 30 s. Callers read Date.now() themselves. */
function useTick(fast: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), fast ? 1000 : 30_000)
    return () => clearInterval(t)
  }, [fast])
}

/**
 * /hub/:hubAgentId[/:threadId] — a conversation with an agent on another
 * server. The id is opaque and never split. On a thread, the thread's stored
 * hub_target names the agent; a URL with another id redirects to the
 * canonical path, and a project that is not a hub thread leaves /hub.
 *
 * The target comes from the thread's stored hub_target when there is one (it
 * survives a delisting and the hub being off), else from the agent detail or
 * the directory's cached item. History, avatars and delivery lines load in
 * every hub mode. The composer is one function of (config, hub_target, live
 * detail, last send error): hubThreadInputState. Remote message bodies go only
 * through HubMessageBody (untrusted Markdown); every other remote string is
 * text. Sending uses only the hub send route, never the generic room message.
 */
export default function HubChatView() {
  const { hubAgentId: routeAgentId = '', threadId } = useParams<{ hubAgentId: string; threadId?: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const { data: config } = useHubConfig()
  const send = useHubSend()
  const start = useStartHubConversation()

  const { data: project, isLoading: projectLoading } = useProject(threadId ?? '')
  const hubTarget = threadId ? project?.hub_target ?? null : null
  const closed = !!hubTarget?.closed_reason
  // On a thread, the agent is the one the thread stores, never the URL's: a
  // link pairing another agent's id with this thread must not lend that
  // agent this thread's name. A mismatch redirects to the canonical path.
  const hubAgentId = hubTarget?.hub_agent_id ?? routeAgentId
  const urlMismatch = !!hubTarget && hubTarget.hub_agent_id !== routeAgentId

  // Detail is spent only when it can change what the user may do: on a draft
  // or an open thread, while the hub can answer at all.
  const hubCanAnswer = !!config && config.mode !== 'off' && config.registration === 'active' && config.hub_link !== 'untrusted'
  const detailQuery = useHubAgent(hubAgentId, { enabled: hubCanAnswer && !closed && (!threadId || !!project) })
  const detail = detailQuery.data
  const detailError = detailQuery.error ? hubError(detailQuery.error) : null
  const cached = useMemo(
    () => cachedSearchItem(qc.getQueriesData<{ pages: HubAgentPage[] }>({ queryKey: ['hub-directory'] }), hubAgentId),
    [qc, hubAgentId],
  )
  const [startTarget, setStartTarget] = useState<ConversationTarget | null>(null)
  const agentItem: HubAgent | undefined = detail ?? cached

  // The hub no longer knowing the agent reads like a delisting, whether the
  // detail or a send found out.
  const gone = detailError?.code === 'agent_unlisted' || detailError?.code === 'agent_not_found'
    || send.lastError?.code === 'agent_not_found'
  const live: HubTargetLive | null = gone
    ? { agent_online: false, deployment_connected: false, listed: false }
    : detail
      ? { ...detail }
      : startTarget
        ? { agent_online: startTarget.agent_online, deployment_connected: startTarget.deployment_connected }
        : null

  const rawName = hubTarget?.name ?? agentItem?.name ?? ''
  const rawDep = hubTarget?.deployment_name ?? agentItem?.deployment_name ?? startTarget?.deployment_name ?? ''
  const names: HubThreadNames = {
    name: safeRemoteText(rawName, REMOTE_TEXT_CAP.name),
    deploymentName: safeRemoteText(rawDep, REMOTE_TEXT_CAP.name),
    display: hubTarget
      ? safeRemoteText(hubTarget.display, REMOTE_TEXT_CAP.name * 2)
      : `${safeRemoteText(rawName, REMOTE_TEXT_CAP.name)}@${safeRemoteText(rawDep, REMOTE_TEXT_CAP.name)}`,
    fingerprint: hubTarget?.deployment_fingerprint ?? agentItem?.deployment_fingerprint ?? '',
  }
  const known = !!hubTarget || !!agentItem

  // ── history ─────────────────────────────────────────────────────────────
  const socketConnected = useWebSocketStatus()
  const { data: log } = useQuery({
    queryKey: ['messages', threadId ?? '', UC],
    queryFn: () => getMessages(threadId!, UC),
    enabled: !!threadId,
    // A changelog push refreshes this like any room; poll only while the
    // socket is down.
    refetchInterval: socketConnected ? false : 5000,
  })
  const messages = useMemo(
    () => (log ?? []).filter((e): e is ChatMessage => isChatMessage(e) && !e.is_ack),
    [log],
  )
  const deliveries = useHubDeliveries(threadId)
  // The thread's room carries its inbound flow; only the thread's owner
  // (the requester who started it) may stop or resume it.
  const { data: room } = useChatroom(threadId ?? '', threadId ? UC : '')
  const isOwner = !!project && !project.is_viewer && !!userId && project.created_by === userId
  const resumeFlow = useSetRoomFlow(threadId ?? '', UC)

  // ── composer ────────────────────────────────────────────────────────────
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [problem, setProblem] = useState<{ text: string; fileName?: string } | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [startRefusal, setStartRefusal] = useState<string | null>(null)
  const [reporting, setReporting] = useState(false)
  const reported = useReportedThisSession(hubAgentId)
  const [menuOpen, setMenuOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // One key per draft, renewed whenever a fresh draft begins (the two routes
  // may keep this instance alive across navigation).
  const draftKey = useRef(crypto.randomUUID())
  useEffect(() => {
    if (!threadId) {
      draftKey.current = crypto.randomUUID()
      setStartTarget(null)
      setStartError(null)
      setStartRefusal(null)
    }
  }, [threadId, hubAgentId])

  useTick(!!send.rateLimitedUntil && send.rateLimitedUntil > Date.now())

  // A send error that names a file: drop or mark that file.
  const { lastError } = send
  useEffect(() => {
    if (lastError?.code === 'file_not_found') {
      const id = fileIdOf(lastError)
      if (id) setFiles((fs) => fs.filter((f) => f.name !== id))
      setProblem({ text: HUB_CHAT_COPY.fileGone(id ?? 'a file') })
    } else if (lastError?.code === 'payload_too_large') {
      const p = payloadTooLargeOf(lastError)
      if (p) {
        const line = payloadTooLargeLine(p)
        setProblem({ text: line.text, fileName: line.fileId })
      }
    }
  }, [lastError])

  if (threadId && project && !project.hub_target) return <Navigate replace to={`/projects/${encodeURIComponent(threadId)}`} />
  if (urlMismatch) return <Navigate replace to={hubThreadPath(hubAgentId, threadId)} />
  if (!config || (threadId && projectLoading)) return <Loading />
  const nowMs = Date.now()

  const input = hubThreadInputState({
    config, names, hubTarget, live,
    lastError: send.lastError, rateLimitedUntil: send.rateLimitedUntil, nowMs,
  })
  const draftBlocked = !threadId && startRefusal ? startRefusal : !threadId && !known
    ? gone
      ? HUB_CHAT_COPY.unlistedDraft
      : detailError?.code === 'rate_limited'
        ? HUB_CHAT_COPY.detailBusy(retryAfterSeconds(detailError) ?? 60)
        : detailQuery.isError ? HUB_CHAT_COPY.loadFailed : null
    : null
  const busy = send.isSending || start.isPending
  // Every failed send says so: a file problem, a failed start, a network
  // failure, or (while the composer is still open, so no banner explains it)
  // any refusal by code.
  const composerError = problem?.text
    ?? startError
    ?? (send.failed ? HUB_CHAT_COPY.sendFailed : null)
    ?? (send.lastError && input.enabled && !FILE_ERROR_CODES.has(send.lastError.code) ? sendErrorText(send.lastError) : null)
  const disclosureTarget: DisclosureTarget | null = startTarget
    ?? hubTarget
    ?? (agentItem ? { ...agentItem } : null)

  const afterSent = (pid: string) => {
    setText('')
    setFiles([])
    setProblem(null)
    qc.invalidateQueries({ queryKey: ['messages', pid, UC] })
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !input.enabled || !config) return
    const body = text.trim()
    if (!body && files.length === 0) return
    const p = checkHubPayload(body, files, config)
    setProblem(p)
    if (p) return
    setStartError(null)
    send.clearError()

    let pid = threadId
    if (!pid) {
      try {
        const res = await start.mutateAsync({ hubAgentId, key: draftKey.current })
        pid = res.id
        setStartTarget(res.target)
        navigate(hubThreadPath(hubAgentId, pid), { replace: true })
      } catch (err) {
        const b = hubError(err)
        const local = localAgentOf(b)
        if (local) {
          navigate(`/dm/${encodeURIComponent(local.agent_name)}`)
          return
        }
        const refusal = startRefusalText(b, names, Date.now())
        if (refusal) setStartRefusal(refusal)
        else setStartError(startErrorText(b))
        return
      }
    }
    if (await send.send(pid, body, files)) afterSent(pid)
  }

  async function confirmOffline() {
    const pid = threadId
    if (await send.confirm()) afterSent(pid ?? '')
  }

  const avatarUrl = agentItem?.avatar_url ?? null

  return (
    <div className="flex h-full flex-col bg-white" data-testid="hub-chat-view">
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
        <HubAvatar avatarUrl={avatarUrl} refreshedAt={agentItem?.listing_refreshed_at} name={rawName || '?'} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-gray-900" data-testid="hub-chat-title">
            <bdi>{known ? names.display : 'Agent on another server'}</bdi>
          </h1>
          {known && names.fingerprint && (
            <p className="truncate text-xs text-gray-500" data-testid="hub-chat-subtitle">
              Hosted on <bdi>{names.deploymentName}</bdi> · <span className="font-mono">{shortFingerprint(names.fingerprint)}</span>
              <UnusualNameChip name={rawDep} />
            </p>
          )}
        </div>
        {threadId && isOwner && room && (
          <RoomFlowControl projectId={threadId} room={UC} flow={room.flow} />
        )}
        {known && (
          <RetainButton
            size="header"
            agent={{
              hub_agent_id: hubAgentId, name: rawName, deployment_name: rawDep,
              retained: agentItem?.retained, is_local: agentItem?.is_local,
            }}
          />
        )}
        {known && (
          <div className="relative">
            <button
              type="button"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 z-10 mt-1 w-32 rounded border border-gray-200 bg-white py-1 shadow">
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:cursor-default disabled:text-gray-400"
                  disabled={reported}
                  onClick={() => { setMenuOpen(false); setReporting(true) }}
                >
                  {reported ? 'Reported' : 'Report'}
                </button>
                <UnretainAction
                  agent={{ hub_agent_id: hubAgentId, name: rawName, deployment_name: rawDep, retained: agentItem?.retained }}
                  onDone={() => setMenuOpen(false)}
                />
              </div>
            )}
          </div>
        )}
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" data-testid="hub-messages">
        {messages.length === 0 && disclosureTarget && (
          <HubDisclosure target={disclosureTarget} senderLabel={config.sender_label} />
        )}
        {messages.map((m) => {
          const mine = m.from_participant_id === userId
          return mine ? (
            <div key={m.id} className="ml-auto max-w-[80%]" data-testid="hub-message-mine">
              <div className="whitespace-pre-wrap rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white">{m.content}</div>
              <HubDeliveryLine
                delivery={deliveries.get(m.id)}
                names={names}
                text={m.content}
                sentAtMs={Date.parse(m.ts)}
                nowMs={nowMs}
              />
            </div>
          ) : (
            <div key={m.id} className="max-w-[80%] rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-900" data-testid="hub-message-remote">
              <HubMessageBody text={m.content} />
            </div>
          )
        })}
      </div>

      <RoomFlowStrip flow={room?.flow} viewerIsOwner={isOwner} />
      <div className="space-y-2 border-t border-gray-200 px-4 py-3">
        {draftBlocked ? (
          <div role="status" className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700" data-testid="hub-thread-banner">
            {draftBlocked}
          </div>
        ) : !input.enabled && input.reason !== 'rate_limited' ? (
          <HubThreadBanner state={input} onStartNew={() => navigate(hubThreadPath(hubAgentId))} />
        ) : (
          <>
            {/* A rate-limit wait keeps the draft on screen under its banner. */}
            {!input.enabled && <HubThreadBanner state={input} />}
            {input.enabled && input.notice && <p className="text-xs text-indigo-700" data-testid="hub-approval-notice">{input.notice}</p>}
            {send.confirmPending && (
              <HubOfflineConfirm
                warning={send.confirmPending}
                names={names}
                busy={busy}
                onSend={() => { void confirmOffline() }}
                onCancel={send.cancel}
              />
            )}
            {composerError && (
              <p role="alert" className="text-xs text-red-700" data-testid="hub-composer-error">
                {composerError}
                {send.lastError?.code === 'room_flow_stopped' && isOwner && threadId && (
                  <button
                    type="button"
                    className="ml-2 font-semibold text-accent-deep underline disabled:opacity-50"
                    disabled={resumeFlow.isPending}
                    onClick={() => resumeFlow.mutate('open', { onSuccess: () => send.clearError() })}
                    data-testid="hub-resume-flow"
                  >
                    {FLOW_COPY.resume}
                  </button>
                )}
              </p>
            )}
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {files.map((f) => (
                  <li
                    key={f.name}
                    data-testid="hub-file-chip"
                    data-problem={problem?.fileName === f.name || undefined}
                    className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${problem?.fileName === f.name ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700'}`}
                  >
                    {f.name}
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}>
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={(e) => { void submit(e) }} className="flex items-end gap-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                data-testid="hub-file-input"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? [])
                  setFiles((fs) => [...fs, ...picked.filter((p) => !fs.some((f) => f.name === p.name))])
                  setProblem(null)
                  e.target.value = ''
                }}
              />
              <button type="button" aria-label="Attach files" onClick={() => fileInput.current?.click()} className="rounded p-2 text-gray-500 hover:bg-gray-100">
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void submit()
                  }
                }}
                rows={2}
                aria-label={`Message ${names.display}`}
                placeholder={`Message ${names.display}…`}
                className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !input.enabled || !!send.confirmPending || (!text.trim() && files.length === 0)}
                aria-label="Send"
                className="rounded-lg bg-indigo-600 p-2 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </>
        )}
      </div>

      {reporting && <ReportDialog hubAgentId={hubAgentId} display={names.display} onClose={() => setReporting(false)} />}
    </div>
  )
}

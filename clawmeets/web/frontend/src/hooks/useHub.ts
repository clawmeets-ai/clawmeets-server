import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient,
} from '@tanstack/react-query'
import {
  blockDeployment, confirmHubEnrollment, disableHubChannel, enableHubChannel, getHubAgent, getHubEnrollment, getHubAvatar, getHubChannel, getHubConfig,
  HUB_STATE_ERRORS, hubError, listBlockedDeployments, listHubDeliveries, reportHubAgent, retryAfterSeconds,
  searchHubAgents, sendHubMessage, sendWarningOf, startHubConversation, startHubEnrollment, unblockDeployment,
  type BlockedDeployment, type Delivery, type EpochSeconds, type HubAgent, type HubAgentPage, type HubChannel,
  type HubEnrollment,
  type HubErrorBody, type ReportReason, type SendMessageResponse, type SendWarning, type StartConversationResponse,
} from '../api/endpoints/hub'
import { uploadUserFile } from '../api/endpoints/files'
import { useDebouncedValue } from './useDebouncedValue'
import { isProxyAvatarUrl } from '../utils/hubDisplay'
import { mergeDelivery } from '../utils/hubDelivery'

/**
 * Every hub query and mutation the browser makes, and the cache rules that keep
 * them in step with the two hub WebSocket events.
 *
 * Read-only history never depends on the hub: deliveries and avatars are never
 * gated on mode, registration or link, and an error on them never calls
 * onHubError, so a history view cannot flip the config into "hub down".
 */

export const HUB_CONFIG_KEY = ['hub-config'] as const
export const hubChannelKey = (agentFullName: string) => ['hub-channel', agentFullName] as const
export const hubBlockedKey = (agentFullName: string) => ['hub-blocked', agentFullName] as const
export const hubAgentKey = (hubAgentId: string) => ['hub-agent', hubAgentId] as const
export const hubDeliveriesKey = (projectId: string) => ['hub-deliveries', projectId] as const
export const HUB_ENROLLMENT_KEY = ['hub-enrollment'] as const

/** Deliveries are cached by message_id. */
export type DeliveryMap = Record<string, Delivery>

const PENDING_STATES = new Set(['sent_to_hub', 'waiting_for_target'])
/** Final reasons that also close the thread: refetch the project's hub_target. */
const CLOSING_REASONS = new Set(['agent_unlisted', 'key_revoked'])

// ── cache writers, shared with useWebSocket ───────────────────────────────

/** Merge delivery rows into a project's cache (newer state_at wins; see mergeDelivery). */
export function mergeDeliveriesInto(qc: QueryClient, projectId: string, rows: Delivery[]): void {
  qc.setQueryData<DeliveryMap>(hubDeliveriesKey(projectId), (prev) => {
    const next: DeliveryMap = { ...(prev ?? {}) }
    for (const d of rows) next[d.message_id] = mergeDelivery(next[d.message_id], d)
    return next
  })
  if (rows.some((d) => d.state === 'failed' && d.failed_reason && CLOSING_REASONS.has(d.failed_reason))) {
    qc.invalidateQueries({ queryKey: ['project', projectId] })
    qc.invalidateQueries({ queryKey: ['user-projects'] })
  }
}

/** The hub_channel_status push carries the full masked channel: replace, never merge. */
export function replaceHubChannel(qc: QueryClient, agentFullName: string, channel: HubChannel): void {
  qc.setQueryData(hubChannelKey(agentFullName), channel)
}

// ── config ────────────────────────────────────────────────────────────────

export function useHubConfig() {
  return useQuery({
    queryKey: HUB_CONFIG_KEY,
    queryFn: getHubConfig,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** Call after any failed hub call: a hub-state error means the config moved
 *  (mode, registration, link), so refetch it. Returns the parsed body. */
export function useOnHubError(): (e: unknown) => HubErrorBody | null {
  const qc = useQueryClient()
  return useCallback((e: unknown) => {
    const b = hubError(e)
    if (b && HUB_STATE_ERRORS.has(b.code)) qc.invalidateQueries({ queryKey: HUB_CONFIG_KEY })
    return b
  }, [qc])
}

// ── an agent's Hub channel (owner) ────────────────────────────────────────

export function useHubChannel(agentFullName: string) {
  const qc = useQueryClient()
  const onHubError = useOnHubError()
  const channel = useQuery({
    queryKey: hubChannelKey(agentFullName),
    queryFn: () => getHubChannel(agentFullName),
    retry: false,
    // The push is the primary path; this is the fallback while listing.
    refetchInterval: (q) => (q.state.data?.status === 'enabling' ? 10_000 : false),
  })

  // One id per click, reused when the same click is retried after a failure;
  // a success clears it, so the next click (e.g. Reconnect) gets a new one.
  const requestId = useRef<string | null>(null)
  const enable = useMutation({
    mutationFn: () => {
      if (!requestId.current) requestId.current = crypto.randomUUID()
      return enableHubChannel(agentFullName, requestId.current)
    },
    onSuccess: (ch) => {
      requestId.current = null
      replaceHubChannel(qc, agentFullName, ch)
    },
    onError: onHubError,
  })
  const disable = useMutation({
    mutationFn: (stopNow: boolean) => disableHubChannel(agentFullName, stopNow),
    onSuccess: (ch) => replaceHubChannel(qc, agentFullName, ch),
  })
  return { channel, enable, disable }
}

// ── enrollment (this server on the hub, this user as an owner) ────────────

/**
 * The enrollment state and its two steps. Every answer replaces the cached
 * state whole; a confirm that verifies refetches the config, since the same
 * code may have registered the server.
 */
export function useHubEnrollment() {
  const qc = useQueryClient()
  const set = (e: HubEnrollment) => qc.setQueryData(HUB_ENROLLMENT_KEY, e)
  const enrollment = useQuery({
    queryKey: HUB_ENROLLMENT_KEY,
    queryFn: getHubEnrollment,
    retry: false,
    staleTime: 0,
  })
  const start = useMutation({ mutationFn: (tosVersion: string) => startHubEnrollment(tosVersion), onSuccess: set })
  const confirm = useMutation({
    mutationFn: (code: string) => confirmHubEnrollment(code),
    onSuccess: (e) => {
      set(e)
      if (e.owner === 'verified') qc.invalidateQueries({ queryKey: HUB_CONFIG_KEY })
    },
  })
  return { enrollment, start, confirm }
}

export function useBlockedDeployments(agentFullName: string, { enabled = true }: { enabled?: boolean } = {}) {
  const qc = useQueryClient()
  const key = hubBlockedKey(agentFullName)
  const blocked = useQuery({
    queryKey: key,
    queryFn: () => listBlockedDeployments(agentFullName),
    enabled,
    retry: false,
  })
  const set = (rows: BlockedDeployment[]) => qc.setQueryData(key, rows)
  const block = useMutation({ mutationFn: (fp: string) => blockDeployment(agentFullName, fp), onSuccess: set })
  const unblock = useMutation({ mutationFn: (fp: string) => unblockDeployment(agentFullName, fp), onSuccess: set })
  return { blocked, block, unblock }
}

// ── the directory ─────────────────────────────────────────────────────────

export interface HubDirectoryParams {
  q: string
  capabilities: string[]
  onlineOnly: boolean
  /** False when config.mode is 'off' (or not known yet). */
  enabled: boolean
}

export interface HubDirectory {
  /** Every page's agents, in order (not yet deduped). */
  agents: HubAgent[]
  /** The newest page's metadata (served_from, cache age). */
  lastPage: HubAgentPage | null
  isLoading: boolean
  isFetchingMore: boolean
  hasMore: boolean
  loadMore: () => void
  /** The error of the first page (no results to show), parsed. */
  error: HubErrorBody | null
  /** A raw error that is not a hub error (a 422 string, a network failure). */
  failed: boolean
  /** "Narrow your search": a later page answered query_too_broad. */
  tooBroad: boolean
  /** Seconds to wait after a rate_limited answer, else null. */
  retryAfter: number | null
  /** The search the results are for (debounced). */
  q: string
}

/**
 * Search, debounced by 400 ms. A rate-limited answer keeps the last results on
 * screen with a wait; a later page's error keeps the pages already shown.
 */
export function useHubDirectory(p: HubDirectoryParams): HubDirectory {
  const onHubError = useOnHubError()
  const q = useDebouncedValue(p.q.trim(), 400)
  const caps = p.capabilities
  const query = useInfiniteQuery({
    queryKey: ['hub-directory', q, caps, p.onlineOnly],
    queryFn: ({ pageParam, signal }) =>
      searchHubAgents({ q, capabilities: caps, online_only: p.onlineOnly, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: p.enabled,
    retry: false,
    staleTime: 60_000,
  })

  const { error: rawError } = query
  useEffect(() => {
    if (rawError) onHubError(rawError)
  }, [rawError, onHubError])

  // The last good results survive a rate-limited new search.
  const lastGood = useRef<HubAgent[]>([])
  const pages = query.data?.pages
  const fresh = useMemo(() => pages?.flatMap((pg) => pg.agents) ?? null, [pages])
  if (fresh) lastGood.current = fresh

  const body = rawError ? hubError(rawError) : null
  const hasPages = !!pages?.length
  const rateLimited = body?.code === 'rate_limited'
  return {
    agents: fresh ?? (rateLimited ? lastGood.current : []),
    lastPage: pages?.length ? pages[pages.length - 1] : null,
    isLoading: query.isLoading,
    isFetchingMore: query.isFetchingNextPage,
    hasMore: !!query.hasNextPage,
    loadMore: () => { void query.fetchNextPage() },
    error: hasPages && !rateLimited ? null : body,
    failed: !!rawError && !body && !hasPages,
    tooBroad: hasPages && body?.code === 'query_too_broad',
    retryAfter: rateLimited ? retryAfterSeconds(body) : null,
    q,
  }
}

/** Agent detail: cached 60 s and never polled (search, detail and report
 *  share one 60-a-minute budget). */
export function useHubAgent(hubAgentId: string | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  const onHubError = useOnHubError()
  const query = useQuery({
    queryKey: hubAgentKey(hubAgentId ?? ''),
    queryFn: () => getHubAgent(hubAgentId!),
    enabled: !!hubAgentId && enabled,
    staleTime: 60_000,
    retry: false,
  })
  const { error } = query
  useEffect(() => {
    if (error) onHubError(error)
  }, [error, onHubError])
  return query
}

/**
 * The avatar as an object URL, or null (initials). Fetched with the bearer
 * token (an <img src> would 401). The key includes the listing's refresh time,
 * so a newer refresh fetches again; the server re-fetches only then, so a
 * search card may show an image up to 24 h old. Never gated on mode,
 * registration or link; a failure never calls onHubError.
 */
export function useHubAvatar(avatarUrl: string | null | undefined, refreshedAt: EpochSeconds | undefined): string | null {
  const ok = isProxyAvatarUrl(avatarUrl)
  const query = useQuery({
    queryKey: ['hub-avatar', avatarUrl ?? '', refreshedAt ?? 0],
    queryFn: async () => {
      const blob = await getHubAvatar(avatarUrl!)
      if (blob.type !== 'image/png') throw new Error('not a png')
      return blob
    },
    enabled: ok,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  })
  const blob = ok ? query.data : undefined
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}

// ── conversations ─────────────────────────────────────────────────────────

/**
 * A thread's deliveries by message_id: fetched on mount, then kept current by
 * the hub_delivery_state push. Polls every 60 s only while a row is pending.
 * Never gated on mode or registration.
 */
export function useHubDeliveries(projectId: string | undefined): Map<string, Delivery> {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: hubDeliveriesKey(projectId ?? ''),
    queryFn: async () => {
      const rows = await listHubDeliveries(projectId!)
      const prev = qc.getQueryData<DeliveryMap>(hubDeliveriesKey(projectId!)) ?? {}
      const next: DeliveryMap = { ...prev }
      for (const d of rows) next[d.message_id] = mergeDelivery(prev[d.message_id], d)
      return next
    },
    enabled: !!projectId,
    retry: false,
    refetchInterval: (q) =>
      Object.values(q.state.data ?? {}).some((d) => PENDING_STATES.has(d.state)) ? 60_000 : false,
  })
  return useMemo(() => new Map(Object.entries(query.data ?? {})), [query.data])
}

interface PendingSend {
  projectId: string
  text: string
  clientMessageId: string
  fileIds: string[]
}

interface UnsettledSend extends PendingSend {
  /** The draft it was minted for: the project, the text and each file. */
  draftKey: string
  /** The files are on the server already; a retry does not upload them again. */
  uploaded: boolean
}

function sendDraftKey(projectId: string, text: string, files: File[]): string {
  return JSON.stringify([projectId, text, files.map((f) => [f.name, f.size, f.lastModified])])
}

export interface HubSend {
  /** Uploads the files, then sends. Resolves true when the message was
   *  accepted (clear the draft), false otherwise (keep it). */
  send: (projectId: string, text: string, files: File[]) => Promise<boolean>
  /** Set when the server asked for the offline confirm; nothing was stored. */
  confirmPending: SendWarning | null
  /** Re-sends with the SAME client_message_id and confirm_offline: true. */
  confirm: () => Promise<boolean>
  cancel: () => void
  lastError: HubErrorBody | null
  /** A non-hub failure (network, a proxy page): keep the draft, say so. */
  failed: boolean
  /** Epoch ms until a rate-limit wait ends (defensive: send is exempt). */
  rateLimitedUntil: number | null
  isSending: boolean
  clearError: () => void
}

export function useHubSend(): HubSend {
  const qc = useQueryClient()
  const onHubError = useOnHubError()
  const [pending, setPending] = useState<UnsettledSend | null>(null)
  const [confirmPending, setConfirmPending] = useState<SendWarning | null>(null)
  const [lastError, setLastError] = useState<HubErrorBody | null>(null)
  const [failed, setFailed] = useState(false)
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null)
  const [isSending, setIsSending] = useState(false)
  // The send whose fate is unknown (a network failure, or a reply with no hub
  // body): the server may have stored it. A retry of the same draft reuses its
  // client_message_id, so the server answers with the original instead of
  // sending twice. Cleared on success, on any definite answer, and when the
  // draft changes.
  const unsettled = useRef<UnsettledSend | null>(null)

  const post = useCallback(async (p: UnsettledSend, confirmOffline: boolean): Promise<boolean> => {
    setIsSending(true)
    setLastError(null)
    setFailed(false)
    try {
      const res: SendMessageResponse = await sendHubMessage(p.projectId, {
        text: p.text, client_message_id: p.clientMessageId, confirm_offline: confirmOffline, file_ids: p.fileIds,
      })
      mergeDeliveriesInto(qc, p.projectId, [res.delivery])
      unsettled.current = null
      setPending(null)
      setConfirmPending(null)
      return true
    } catch (e) {
      const b = onHubError(e)
      if (!b) unsettled.current = { ...p, uploaded: true }
      else unsettled.current = null
      if (b?.code === 'target_offline_confirm_required') {
        setPending(p)
        setConfirmPending(sendWarningOf(b) ?? 'agent_offline')
        return false
      }
      setPending(null)
      setConfirmPending(null)
      if (b?.code === 'rate_limited') setRateLimitedUntil(Date.now() + (retryAfterSeconds(b) ?? 60) * 1000)
      if (b) setLastError(b)
      else setFailed(true)
      if (b && ['agent_unlisted', 'key_revoked', 'identity_changed', 'conversation_closed'].includes(b.code)) {
        qc.invalidateQueries({ queryKey: ['project', p.projectId] })
        qc.invalidateQueries({ queryKey: ['user-projects'] })
      }
      return false
    } finally {
      setIsSending(false)
    }
  }, [qc, onHubError])

  const send = useCallback(async (projectId: string, text: string, files: File[]) => {
    const draftKey = sendDraftKey(projectId, text, files)
    const retry = unsettled.current?.draftKey === draftKey ? unsettled.current : null
    const p: UnsettledSend = retry ?? {
      projectId, text, clientMessageId: crypto.randomUUID(), fileIds: files.map((f) => f.name), draftKey, uploaded: false,
    }
    unsettled.current = p
    setIsSending(true)
    if (!p.uploaded) {
      try {
        for (const f of files) await uploadUserFile(projectId, 'user-communication', f.name, f)
      } catch {
        setIsSending(false)
        setFailed(true)
        return false
      }
    }
    return post(p, false)
  }, [post])

  const confirm = useCallback(async () => (pending ? post(pending, true) : false), [pending, post])
  const cancel = useCallback(() => {
    setPending(null)
    setConfirmPending(null)
  }, [])
  const clearError = useCallback(() => {
    setLastError(null)
    setFailed(false)
  }, [])

  return { send, confirmPending, confirm, cancel, lastError, failed, rateLimitedUntil, isSending, clearError }
}

/**
 * A one-shot send for surfaces with no thread composer (My Desk): uploads the
 * files, then sends with `confirm_offline` already given, because the user is
 * not in the thread to answer that prompt; an offline target holds the message
 * and the delivery says so in the thread. Throws on any refusal, unlike
 * useHubSend, which keeps a draft and its retry state.
 */
export async function sendHubDraft(
  qc: QueryClient,
  projectId: string,
  text: string,
  files: File[],
): Promise<SendMessageResponse> {
  for (const f of files) await uploadUserFile(projectId, 'user-communication', f.name, f)
  const res = await sendHubMessage(projectId, {
    text, client_message_id: crypto.randomUUID(), confirm_offline: true, file_ids: files.map((f) => f.name),
  })
  mergeDeliveriesInto(qc, projectId, [res.delivery])
  return res
}

export function useStartHubConversation() {
  const qc = useQueryClient()
  const onHubError = useOnHubError()
  return useMutation<StartConversationResponse, unknown, { hubAgentId: string; key: string }>({
    mutationFn: ({ hubAgentId, key }) => startHubConversation(hubAgentId, key),
    onSuccess: (project) => {
      qc.setQueryData(['project', project.id], project)
      qc.invalidateQueries({ queryKey: ['user-projects'] })
    },
    onError: onHubError,
  })
}

/** Agents reported in this browser session: their menu item reads "Reported"
 *  on every card and header that shows them, at once. */
const reportedThisSession = new Set<string>()
const reportedListeners = new Set<() => void>()

function subscribeReported(listener: () => void): () => void {
  reportedListeners.add(listener)
  return () => { reportedListeners.delete(listener) }
}

export function wasReportedThisSession(hubAgentId: string): boolean {
  return reportedThisSession.has(hubAgentId)
}

export function useReportedThisSession(hubAgentId: string): boolean {
  return useSyncExternalStore(subscribeReported, () => reportedThisSession.has(hubAgentId))
}

export function useReportHubAgent() {
  const onHubError = useOnHubError()
  return useMutation<void, unknown, { hubAgentId: string; reason: ReportReason; note?: string }>({
    mutationFn: ({ hubAgentId, reason, note }) => reportHubAgent(hubAgentId, { reason, note }),
    onSuccess: (_r, { hubAgentId }) => {
      reportedThisSession.add(hubAgentId)
      for (const l of reportedListeners) l()
    },
    onError: onHubError,
  })
}

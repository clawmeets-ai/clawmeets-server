import { ApiError, del, get, getFile, post, put } from '../client'
import type { Project } from '../../types'

/**
 * The ClawMeets Hub, as the browser sees it: every `/api/hub/*` and
 * `/me/channels/hub/*` call. The ONLY module that knows those paths.
 *
 * Mirrors `clawmeets/server/hub/browser.py` field for field; the frozen
 * snapshot `tests/server/hub_contract_snapshot.json` is checked against the
 * key lists below by `hub.contract.test.ts`, so a drift on either side fails CI.
 *
 * The browser only ever calls its own server. `hub_url` is display text and is
 * never fetched, linked or used to build a URL. No field here is a secret: the
 * only key material is `key_last4`.
 */

/** Seconds since the epoch, UTC, possibly fractional. Convert with
 *  `epochToDate` (utils/hubDisplay) — never with the ISO parsers. */
export type EpochSeconds = number

// ── vocabularies ──────────────────────────────────────────────────────────
// A response field is typed `X | (string & {})` where a newer server may send a
// value this build does not name: it type-checks and falls to the generic copy.
// Requests use the closed unions.

type Open<T extends string> = T | (string & {})

/** `auto`: works like `full` once registered; the server registers itself the
 *  first time a user turns an agent on or searches (HubEnrollmentDialog). */
export type HubMode = 'off' | 'auto' | 'discover_only' | 'full'
/** `held_for_reclaim` arrives as none; an unknown value is treated like none. */
export type HubRegistration = 'none' | 'pending_email' | 'active' | 'suspended'
export type HubLink = 'connected' | 'unreachable' | 'untrusted' | 'off'
export type HubChannelStatus =
  | 'off' | 'enabling' | 'connected' | 'hub_unreachable' | 'key_revoked' | 'key_rotation_pending'
  | 'hub_cannot_reach_deployment' | 'rejected' | 'hub_off_on_server' | 'agent_not_public'
  | 'hub_untrusted' | 'hub_not_registered'
export type RejectReason =
  | 'name_conflict' | 'deployment_suspended' | 'over_quota' | 'client_too_old' | 'invalid_name'
  | 'invalid_listing' | 'delisted_by_hub' | 'owner_unverified' | 'owner_banned'
export type DeliveryState = 'sent_to_hub' | 'waiting_for_target' | 'delivered' | 'failed'
export type WaitingReason = 'agent_offline' | 'deployment_offline' | 'hub_unreachable' | 'isolation_unavailable'
export type FailedReason =
  | 'expired_72h' | 'held_expired' | 'blocked_by_target' | 'agent_unlisted' | 'key_revoked'
  | 'too_large' | 'rejected_by_hub' | 'retries_exhausted' | 'sender_untrusted' | 'not_accepting'
/** Only with `not_accepting`. Open: an unknown value gets the generic line. */
export type NotAcceptingDetail = 'channel_off' | 'browse_only' | 'daily_cap' | 'requests_full'
export type ClosedReason =
  | 'agent_unlisted' | 'key_revoked' | 'deployment_suspended' | 'conversation_closed'
  | 'hub_off_on_server' | 'identity_changed'
export type SendWarning = 'agent_offline' | 'deployment_offline'
export type ReportReason = 'impersonation' | 'spam' | 'harmful' | 'other'
export type ServedFrom = 'live' | 'cache'
export type PayloadLimit = 'file' | 'files' | 'envelope' | 'text'
export type RetainState = 'active' | 'unlisted' | 'identity_changed'
export type BridgeDeliveryState = 'queued' | 'relayed' | 'delivered' | 'answered' | 'failed' | 'cancelled'
export type BridgeState = 'active' | 'inactive'
export type ParticipantKind = 'agent' | 'user' | 'hub_stand_in'
export type InboundFlow = 'open' | 'stopped'
export type FlowStoppedBy = 'owner' | 'inspector'
/** Why a post was held (HeldForReview.reason). `flow_stopped` is a stopped
 *  room; `room_flow_stopped` is only the 409 refused code, never this. */
export type HeldReason = 'flow_stopped' | 'held' | 'inspector_error' | 'requester_key_pending'
export type ChannelIsolation = 'sandboxed' | 'unavailable'
export type EnrollmentServer = 'none' | 'pending' | 'active' | 'operator_only' | 'off'
export type EnrollmentOwner = 'none' | 'code_sent' | 'verified'

/** Read-only in v1: the server has no route to change it. */
export const DAILY_RUN_CAP = 200

// ── config ────────────────────────────────────────────────────────────────

/** GET /api/hub/config (`HubConfigOut`). Never a hub-state error. */
export interface HubConfig {
  mode: Open<HubMode>
  /** Display only. */
  hub_url: string
  hub_url_is_default: boolean
  deployment_id: string | null
  deployment_connected: boolean
  last_connected_at: EpochSeconds | null
  protocol_version: number
  /** Genesis fingerprint of THIS server. */
  deployment_fingerprint: string | null
  deployment_name: string | null
  registration: Open<HubRegistration>
  hub_link: Open<HubLink>
  channels_enabled: boolean
  /** How this server's users appear to other servers. Render as text. */
  sender_label: string
  max_file_bytes: number
  max_files: number
  max_envelope_bytes: number
  max_text_bytes: number
}

// ── an agent's Hub channel (owner) ────────────────────────────────────────

/** GET /me/channels/hub/{agent}; also enable, disable and the
 *  `hub_channel_status` push (the full, masked object). */
export interface HubChannel {
  enabled: boolean
  status: Open<HubChannelStatus>
  /** The hub's own words. Render as text. */
  status_detail: string | null
  reject_reason: Open<RejectReason> | null
  eligible: boolean
  ineligible_reason: string | null
  /** name@deployment_name */
  listed_as: string | null
  key_last4: string | null
  rotate_by: EpochSeconds | null
  last_success_at: EpochSeconds | null
  next_retry_at: EpochSeconds | null
  hub_url: string
  hub_url_is_default: boolean
  open_conversations: number
  in_flight_messages: number
  daily_run_cap: number
  runs_today: number
  /** The server's next local midnight. */
  runs_reset_at: EpochSeconds
  /** Whether strangers' conversations run in isolated turns on the agent's
   *  computer. Absent or unknown counts as unavailable (the server default). */
  isolation?: Open<ChannelIsolation>
  /** Conversations waiting for a computer that can isolate them. */
  held_conversations?: number
  /** People on this server with a conversation with the agent: turning the
   *  switch off (which makes the agent private) stops their replies. */
  local_conversations?: number
  /** Owner isolation is on; turning the switch off ends it. */
  owner_isolated?: boolean
  /** The agent is public. Off and public: shared on this server before the
   *  Hub switch became the one sharing control (the card offers Make private). */
  public?: boolean
  /** The owner accepts requests the hub routes to this agent (hub-ranked
   *  dispatch), at most `dispatch_daily_cap` a day; `dispatched_today` so far. */
  accept_dispatch?: boolean
  dispatch_daily_cap?: number
  dispatched_today?: number
}

export interface BlockedDeployment {
  /** Genesis. */
  deployment_fingerprint: string
  /** Absent (never null) when the deployment never rotated. */
  current_fingerprint?: string
  deployment_name: string
  created_at: EpochSeconds
}

// ── enrollment: this server on the hub, and this user as an owner ─────────

/** GET/POST /me/channels/hub/enrollment and POST …/enrollment/confirm. One
 *  emailed code both registers the server (when `server` is none) and
 *  verifies this user as an owner. */
export interface HubEnrollment {
  /** none: not on the hub yet (starting registers it); pending: waits for its
   *  code; operator_only: only the operator may register it; off: hub off. */
  server: Open<EnrollmentServer>
  owner: Open<EnrollmentOwner>
  /** Where the code goes, masked (a***@corp.com). */
  email_masked: string | null
  /** Starting makes this user the server's hub contact. */
  becomes_contact: boolean
  contact_is_you: boolean
  tos_version: string
  /** Shown as a link: the server's own setting, never remote text. */
  tos_url: string
  code_expires_at: EpochSeconds | null
}

// ── the directory ─────────────────────────────────────────────────────────

/** One search result. Every string is remote text: render with safeRemoteText. */
export interface HubAgent {
  /** `{genesis fp16}~{agent_name}`, opaque. Compare as a whole string. */
  hub_agent_id: string
  name: string
  deployment_name: string
  deployment_label: string
  deployment_fingerprint: string
  current_fingerprint?: string
  /** null unless verified. Text, never a link. */
  deployment_url: string | null
  deployment_url_verified: boolean
  first_contact: boolean
  description: string
  capabilities: string[]
  /** The same-origin proxy path, or null. Load with useHubAvatar. */
  avatar_url: string | null
  agent_online: boolean
  deployment_connected: boolean
  accepting_messages: boolean
  needs_approval: boolean
  last_seen_at: EpochSeconds | null
  listed_at: EpochSeconds
  listing_refreshed_at: EpochSeconds
  listing_age_s: number
  is_local: boolean
  /** The viewer retained this agent. Absent on an older server: not retained. */
  retained?: boolean
}

export interface HubAgentDetail extends HubAgent {
  listed: boolean
  served_from: Open<ServedFrom>
}

export interface HubAgentPage {
  agents: HubAgent[]
  next_cursor: string | null
  served_from: Open<ServedFrom>
  /** null when live. */
  cache_age_s: number | null
  cached_at: EpochSeconds | null
}

// ── conversations (requester side) ────────────────────────────────────────

/** `hub_target` on project responses; null on every non-hub project. */
export interface HubTarget {
  hub_agent_id: string
  /** name@deployment_name */
  display: string
  name: string
  deployment_name: string
  deployment_label: string
  /** Genesis: the sidebar groups by it. */
  deployment_fingerprint: string
  current_fingerprint?: string
  deployment_url: string | null
  deployment_url_verified: boolean
  listed: boolean
  closed_reason: Open<ClosedReason> | null
  /** null while the thread is open. */
  closed_at: EpochSeconds | null
}

export interface ConversationTarget {
  agent_online: boolean
  deployment_connected: boolean
  send_warning: Open<SendWarning> | null
  deployment_name: string
  deployment_fingerprint: string
  current_fingerprint?: string
  deployment_url: string | null
  deployment_url_verified: boolean
  first_contact: boolean
}

/** The new (or existing) Front Desk project, plus the hub fields. */
export type StartConversationResponse = Project & {
  surface: 'frontdesk'
  hub_target: HubTarget
  target: ConversationTarget
}

export interface Delivery {
  message_id: string
  state: Open<DeliveryState>
  waiting_reason: Open<WaitingReason> | null
  failed_reason: Open<FailedReason> | null
  detail: Open<NotAcceptingDetail> | null
  retry_at: EpochSeconds | null
  held_for_approval: boolean
  delivered_late: boolean
  attempts: number
  state_at: EpochSeconds
  expires_at: EpochSeconds
}

export interface SendMessageResponse {
  message_id: string
  delivery: Delivery
}

// ── generic channel rows (host side) ──────────────────────────────────────

/** What Hub request rows and Hub thread rows add on the existing channel
 *  routes. All three are ABSENT on non-Hub rows, so optional here. On the host,
 *  `deployment_name` can be null for a requester known only by key. */
export interface HubContactFields {
  remote_username?: string | null
  deployment_name?: string | null
  deployment_fingerprint?: string | null
  /** The requester's agent that sent this conversation for them ("via their
   *  agent X"), or null when the person sent it. Remote text. */
  via_agent?: string | null
}

// ── retain (requester side) ───────────────────────────────────────────────

/** POST /api/hub/agents/{id}/retain and each row of GET /api/hub/retained.
 *  The listing fields are as they were at retain time. Remote text. */
export interface RetainedAgent {
  hub_agent_id: string
  name: string
  deployment_name: string
  /** Genesis. */
  deployment_fingerprint: string
  description: string
  capabilities: string[]
  retained_at: EpochSeconds
  state: Open<RetainState>
  /** Workrooms the agent's stand-in is in now. */
  live_rooms: number
  /** Always false: a retained agent has no folder on this server. */
  home_folder_browsable?: false
  /** Another account's agent on THIS server: Message opens the ordinary DM
   *  (`/dm/{name}`); `state` is 'unlisted' once it is no longer shared. */
  is_local?: boolean
  /** The local agent's id (is_local only). */
  agent_id?: string | null
}

/** One relay of a workroom message to a retained agent (owner only). */
export interface BridgeDelivery {
  room_message_id: string
  hub_agent_id: string
  state: Open<BridgeDeliveryState>
  /** Open vocabulary: held, blocked, flow_stopped, ... */
  reason?: string | null
}

// ── a workroom's participants and inbound flow ────────────────────────────

/** The stand-in details of a `hub_stand_in` participant. */
export interface ParticipantHub {
  hub_agent_id?: string | null
  name?: string | null
  deployment_name?: string | null
  deployment_fingerprint?: string | null
  bridge_state?: Open<BridgeState>
  /** Open vocabulary: unretained, unlisted, identity_changed, ... */
  inactive_reason?: string | null
}

/** `Chatroom.participant_info`. Render trust from `outside` only: `kind` says
 *  person or agent, never inside or outside. */
export interface ParticipantInfo {
  id: string
  kind: Open<ParticipantKind>
  outside: boolean
  hub?: ParticipantHub | null
}

/** `Chatroom.flow`, PUT …/flow's answer and the chatroom_flow_changed push. */
export interface RoomFlow {
  inbound_flow?: Open<InboundFlow>
  stopped_by?: Open<FlowStoppedBy> | null
  stopped_at?: EpochSeconds | null
  /** Free text. Render as text. */
  reason?: string | null
  held_count?: number
}

/** 202 on a post the server holds: delivered later, never resend. */
export interface HeldForReview {
  held: true
  reason: Open<HeldReason>
  message: string
}

/** True only for a HeldForReview answer. */
export function isHeldForReview(x: unknown): x is HeldForReview {
  return typeof x === 'object' && x !== null && (x as { held?: unknown }).held === true
}

// ── an owned agent's hub sends ────────────────────────────────────────────

export interface UsageWindowOut {
  /** hour, day, new_conversations_day; open. */
  name: string
  used: number
  limit: number
  resets_at: EpochSeconds
}

export interface AgentUsage {
  windows: UsageWindowOut[]
}

/** GET /api/hub/conversations/{id}/messages: for agent tokens; the browser
 *  reads the room itself. Mirrored for the contract only. */
export interface HubMessage {
  id: string
  author_kind: 'user' | 'agent' | 'remote'
  ts: EpochSeconds
  state?: string | null
  text?: string | null
}

export interface HubMessagePage {
  messages: HubMessage[]
  text_withheld: boolean
}

// ── WebSocket payloads ────────────────────────────────────────────────────

export interface HubDeliveryStatePayload {
  project_id: string
  delivery: Delivery
}

export interface HubChannelStatusPayload {
  agent_full_name: string
  channel: HubChannel
}

export interface HubBridgeDeliveryPayload {
  project_id: string
  chatroom_name: string
  delivery: BridgeDelivery
}

export interface ChatroomFlowChangedPayload {
  project_id: string
  chatroom_name: string
  flow: RoomFlow
}

// ── errors ────────────────────────────────────────────────────────────────

/** payload_too_large [413] extras. */
export interface PayloadTooLarge {
  limit: Open<PayloadLimit>
  max: number
  actual: number
  file_id?: string | null
}

/** local_agent [409] extras: go to /dm/{agent_name}. */
export interface LocalAgentDetail {
  use_path: string
  agent_name: string
}

/** rate_limited [429] extras: whole seconds to wait, 1 to 3600. */
export interface RateLimitedDetail {
  retry_after: number
}

/** target_offline_confirm_required [409] extras: why the send wants a confirm. */
export interface TargetOfflineDetail {
  send_warning: SendWarning
}

/** hub_unreachable [503] extras, on send only (every other route sends it
 *  bare): when this server last had the hub, null when it never connected. */
export interface SendUnreachableDetail {
  last_connected_at: EpochSeconds | null
}

/** file_not_found [404] extras: the first file_ids entry not in the conversation. */
export interface FileNotFoundDetail {
  file_id: string
}

/** `{detail: {code, message, ...extra}}`. Extras are read with the guards below. */
export interface HubErrorBody {
  code: string
  message: string
  [extra: string]: unknown
}

/** The hub-state errors (browser.py `HUB_STATE_ERRORS`). Only search, detail,
 *  start, send, report and enable return them. */
export const HUB_STATE_ERRORS: ReadonlySet<string> = new Set([
  'hub_off_on_server', 'hub_not_registered', 'hub_discover_only', 'hub_untrusted', 'hub_unreachable',
])

/** The hub error body inside an ApiError, or null (a 422's string detail, a
 *  non-JSON body, a network error). Never throws. */
export function hubError(e: unknown): HubErrorBody | null {
  if (!(e instanceof ApiError)) return null
  const data = e.data
  if (typeof data !== 'object' || data === null) return null
  const detail = (data as { detail?: unknown }).detail
  if (typeof detail !== 'object' || detail === null) return null
  const code = (detail as { code?: unknown }).code
  if (typeof code !== 'string') return null
  const message = (detail as { message?: unknown }).message
  return { ...(detail as Record<string, unknown>), code, message: typeof message === 'string' ? message : '' }
}

/** The error's code, or null. */
export const hubErrorCode = (e: unknown): string | null => hubError(e)?.code ?? null

// The extras are pinned in the frozen contract (RateLimitedDetail and the
// rest). The readers still check the value at runtime and answer null on a
// body without it (a non-hub 429 from a proxy, an older server), so the UI
// keeps a generic fallback.

/** `retry_after` of rate_limited (RateLimitedDetail); null when absent or malformed. */
export function retryAfterSeconds(b: HubErrorBody | null): RateLimitedDetail['retry_after'] | null {
  const v = b?.code === 'rate_limited' ? b.retry_after : undefined
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** `send_warning` of target_offline_confirm_required (TargetOfflineDetail). */
export function sendWarningOf(b: HubErrorBody | null): TargetOfflineDetail['send_warning'] | null {
  const v = b?.code === 'target_offline_confirm_required' ? b.send_warning : undefined
  return v === 'agent_offline' || v === 'deployment_offline' ? v : null
}

/** `last_connected_at` of send's hub_unreachable (SendUnreachableDetail). */
export function lastConnectedOf(b: HubErrorBody | null): SendUnreachableDetail['last_connected_at'] {
  const v = b?.code === 'hub_unreachable' ? b.last_connected_at : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `closed_reason` of a send refused on a closed thread (agent_unlisted,
 *  key_revoked, identity_changed or conversation_closed): the stored reason,
 *  which conversation_closed otherwise hides. */
export function closedReasonOf(b: HubErrorBody | null): string | null {
  const v = b?.closed_reason
  return typeof v === 'string' && v !== '' ? v : null
}

/** `file_id` of file_not_found (FileNotFoundDetail) or payload_too_large. */
export function fileIdOf(b: HubErrorBody | null): FileNotFoundDetail['file_id'] | null {
  const v = b?.code === 'file_not_found' || b?.code === 'payload_too_large' ? b.file_id : undefined
  return typeof v === 'string' ? v : null
}

export function payloadTooLargeOf(b: HubErrorBody | null): PayloadTooLarge | null {
  if (b?.code !== 'payload_too_large') return null
  const { limit, max, actual } = b
  if (typeof limit !== 'string' || typeof max !== 'number' || typeof actual !== 'number') return null
  return { limit, max, actual, file_id: fileIdOf(b) }
}

export function localAgentOf(b: HubErrorBody | null): LocalAgentDetail | null {
  if (b?.code !== 'local_agent') return null
  const { use_path, agent_name } = b
  return typeof use_path === 'string' && typeof agent_name === 'string' ? { use_path, agent_name } : null
}

// ── calls ─────────────────────────────────────────────────────────────────

const enc = encodeURIComponent
const channel = (agentFullName: string) => `/me/channels/hub/${enc(agentFullName)}`
const agent = (hubAgentId: string) => `/api/hub/agents/${enc(hubAgentId)}`
const conversation = (projectId: string) => `/api/hub/conversations/${enc(projectId)}`

export const getHubConfig = () => get<HubConfig>('/api/hub/config')

export const getHubChannel = (agentFullName: string) => get<HubChannel>(channel(agentFullName))

/** Idempotent per (agent, clientRequestId): mint the id once per click, reuse it on retry. */
export const enableHubChannel = (agentFullName: string, clientRequestId: string) =>
  post<HubChannel>(`${channel(agentFullName)}/enable`, { client_request_id: clientRequestId })

/** `confirm` is always true: the dialog is the confirmation. */
export const disableHubChannel = (agentFullName: string, stopNow: boolean) =>
  post<HubChannel>(`${channel(agentFullName)}/disable`, { confirm: true, stop_now: stopNow })

/** PUT …/dispatch: owner's user session only (an agent token is `user_only`). */
export const setHubDispatch = (agentFullName: string, accept: boolean, dailyCap: number) =>
  put<HubChannel>(`${channel(agentFullName)}/dispatch`, { accept, daily_cap: dailyCap })

export const getHubEnrollment = () => get<HubEnrollment>('/me/channels/hub/enrollment')

/** Sends the code. Sending again is the resend. */
export const startHubEnrollment = (acceptTosVersion: string) =>
  post<HubEnrollment>('/me/channels/hub/enrollment', { accept_tos_version: acceptTosVersion })

export const confirmHubEnrollment = (code: string) =>
  post<HubEnrollment>('/me/channels/hub/enrollment/confirm', { code })

const blockedPath = (agentFullName: string) => `${channel(agentFullName)}/blocked_deployments`
type BlockedList = { blocked: BlockedDeployment[] }

export const listBlockedDeployments = async (agentFullName: string) =>
  (await get<BlockedList>(blockedPath(agentFullName))).blocked

export const blockDeployment = async (agentFullName: string, fingerprint: string) =>
  (await post<BlockedList>(blockedPath(agentFullName), { deployment_fingerprint: fingerprint })).blocked

export const unblockDeployment = async (agentFullName: string, fingerprint: string) =>
  (await del<BlockedList>(`${blockedPath(agentFullName)}?deployment_fingerprint=${enc(fingerprint)}`)).blocked

export interface HubSearchParams {
  q?: string
  capabilities?: string[]
  online_only?: boolean
  cursor?: string
  limit?: number
}

/** `capabilities` goes as a repeated parameter (capabilities=a&capabilities=b). */
export function hubSearchQuery(p: HubSearchParams): string {
  const qs = new URLSearchParams()
  if (p.q) qs.set('q', p.q)
  for (const c of p.capabilities ?? []) qs.append('capabilities', c)
  if (p.online_only) qs.set('online_only', 'true')
  if (p.cursor) qs.set('cursor', p.cursor)
  qs.set('limit', String(p.limit ?? 20))
  return qs.toString()
}

export const searchHubAgents = (p: HubSearchParams, signal?: AbortSignal) =>
  get<HubAgentPage>(`/api/hub/agents?${hubSearchQuery(p)}`, signal)

export const getHubAgent = (hubAgentId: string) => get<HubAgentDetail>(agent(hubAgentId))

/** The avatar route authenticates by bearer only, so an <img src> would 401.
 *  Call only with a path that passed `isProxyAvatarUrl`. */
export const getHubAvatar = (avatarUrl: string) => getFile(avatarUrl)

export const reportHubAgent = async (hubAgentId: string, b: { reason: ReportReason; note?: string }) => {
  await post<Record<string, never>>(`${agent(hubAgentId)}/report`, b.note ? b : { reason: b.reason })
}

/** Deduped on (user, clientThreadKey): one key per draft. */
export const startHubConversation = (hubAgentId: string, clientThreadKey: string) =>
  post<StartConversationResponse>('/api/hub/conversations', {
    hub_agent_id: hubAgentId, client_thread_key: clientThreadKey,
  })

/** A repeated client_message_id returns the original result. `file_ids` are
 *  names already uploaded to the thread's user-communication room. */
export const sendHubMessage = (
  projectId: string,
  b: { text: string; client_message_id: string; confirm_offline: boolean; file_ids: string[] },
) => post<SendMessageResponse>(`${conversation(projectId)}/messages`, b)

/** A bare Delivery[]. Never gated on mode or registration. */
export const listHubDeliveries = (projectId: string, sinceMessageId?: string) =>
  get<Delivery[]>(
    `${conversation(projectId)}/deliveries` +
      (sinceMessageId ? `?since_message_id=${enc(sinceMessageId)}` : ''),
  )

// ── retain, bridges, agent usage ──────────────────────────────────────────

/** User JWT only. Re-retaining an identity_changed row is the server's call. */
export const retainHubAgent = (hubAgentId: string) => post<RetainedAgent>(`${agent(hubAgentId)}/retain`, {})

export const unretainHubAgent = async (hubAgentId: string) => {
  await del<Record<string, never>>(`${agent(hubAgentId)}/retain`)
}

/** [] when the hub is off. */
export const listRetained = async () => (await get<{ agents: RetainedAgent[] }>('/api/hub/retained')).agents

/** Owner only; [] when the hub is off. */
export const listBridgeDeliveries = async (projectId: string, chatroomName: string, messageIds?: string[]) =>
  (await get<{ deliveries: BridgeDelivery[] }>(
    `/api/hub/bridges/${enc(projectId)}/${enc(chatroomName)}/deliveries` +
      (messageIds && messageIds.length ? `?message_ids=${messageIds.map(enc).join(',')}` : ''),
  )).deliveries

export const getAgentHubUsage = (agentId: string) => get<AgentUsage>(`/api/hub/agents-usage/${enc(agentId)}`)

export const listHubConversationMessages = (projectId: string, before?: EpochSeconds, limit?: number) => {
  const qs = new URLSearchParams()
  if (before !== undefined) qs.set('before', String(before))
  if (limit !== undefined) qs.set('limit', String(limit))
  const q = qs.toString()
  return get<HubMessagePage>(`${conversation(projectId)}/messages${q ? `?${q}` : ''}`)
}

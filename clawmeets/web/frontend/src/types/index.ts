// TypeScript types matching Pydantic models from clawmeets/models/

// The provider union lives in the composer/Settings provider catalog; re-used
// here as the `ModelConfig.provider` type so config and types can't drift.
// (config/llmProviders imports nothing from this module — no cycle.)
import type { LlmProviderId } from '../config/llmProviders'
// The plan's desk-facing summary rides the project record (D23) — one wire
// shape, defined once beside the routes that serve it.
import type { PlanSummary } from '../api/endpoints/projectPlans'
import type {
  ChatroomFlowChangedPayload, HubBridgeDeliveryPayload, HubChannelStatusPayload, HubDeliveryStatePayload, HubTarget,
  ParticipantInfo, RoomFlow,
} from '../api/endpoints/hub'

// Enumerations
export enum AgentStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  BUSY = 'busy',
  RATE_LIMITED = 'rate_limited',
}

export enum ControlMessageType {
  // Notification-only protocol - all data delivered via changelog over HTTP
  CHANGELOG_UPDATE = 'changelog_update',  // Server notifies client of new changelog entries
  HEARTBEAT = 'heartbeat',                // Connection health check
  AGENT_STATUS_CHANGE = 'agent_status_change',  // Agent online/offline notifications
  PROJECT_DELETED = 'project_deleted',            // Project was deleted
  ACTIVE_WORK_CHANGE = 'active_work_change',  // PendingWork state changed in a chatroom
  MCP_AUTH_URL_FOR_USER = 'mcp_auth_url_for_user',  // Runner posted an OAuth link for the agent's owner to click
  SKILL_AUTH_URL_FOR_USER = 'skill_auth_url_for_user',  // Skill-rail sibling of MCP_AUTH_URL_FOR_USER
  AGENT_CARD_UPDATE = 'agent_card_update',  // Server bumped a cursor on the agent card (last_reflected_at)
  BRIEF_TAB_SYNC = 'brief_tab_sync',  // A brief tab was upserted/deleted by one of the user's agents
  PROJECT_REPORT_SYNC = 'project_report_sync',  // The interactive report for a project was upserted/deleted
  PROJECT_PLAN_SYNC = 'project_plan_sync',  // A project's PLAN.md or its sidecar moved (write / note / draft / review / approve / refusal)
  DESK_TODO_SYNC = 'desk_todo_sync',  // The user's desk to-do plate changed (capture / patch / reorder / delete / agent publish)
  DESK_READ_STATE_SYNC = 'desk_read_state_sync',  // A My Desk read-state watermark was upserted by one of the owner's sessions
  DESK_SOP_SYNC = 'desk_sop_sync',        // The owner's SOP library changed (create / edit / delete) in any of their sessions
  DESK_LABEL_SYNC = 'desk_label_sync',    // The owner's label registry changed (add / patch / reorder / delete / merge), from the registry routes OR from a to-do write that auto-registered a slug
  // Owner-scoped snapshot of this user's LIVE runners and the version each
  // reports. Full snapshot, never a delta — the client replaces, never merges.
  //
  // Recipient is the ONE owning user (ws_hub.send_to(registered_by, …)) and
  // NEVER get_status_broadcast_recipients: that set spans every shared project
  // and is consumed by other people's runners, so using it would ship this
  // user's agent names AND version numbers to third parties. Version numbers
  // map to known-vulnerability surface.
  RUNNER_VERSIONS = 'runner_versions',
  // One of this user's COMPUTERS moved: it connected, disconnected, re-reported
  // which of its agents are running, or was renamed / disconnected from one of
  // their own tabs.
  //
  // Recipient is the ONE owning user (ws_hub.send_to(host.owner_user_id)), the
  // same rule and the same reason as RUNNER_VERSIONS: a machine's name, its
  // software version and the roster of agents on it are that user's business
  // alone.
  //
  // A CURSOR, not a snapshot — nothing about the machine's state travels in the
  // payload and the client refetches GET /me/computers. A dropped frame
  // therefore costs a stale page until the next one, never a wrong one.
  HOST_SYNC = 'host_sync',
  INSTALL_SYNC = 'install_sync',
  // "Catch up as if you had just reconnected." Behind the websocket edge a
  // core restart no longer drops the socket, so the server asks for the
  // catch-up instead. Sent only to sockets whose auth frame listed 'resync'.
  RESYNC = 'resync',
  // The ClawMeets Hub, owner-scoped. A requester's delivery moved (payload:
  // {project_id, delivery}); an agent's Hub channel moved (payload:
  // {agent_full_name, channel} — the full masked object, replaced not merged).
  HUB_DELIVERY_STATE = 'hub_delivery_state',
  HUB_CHANNEL_STATUS = 'hub_channel_status',
  // A workroom's relay to a retained agent moved (payload:
  // HubBridgeDeliveryPayload, owner sockets).
  HUB_BRIDGE_DELIVERY = 'hub_bridge_delivery',
  // A room's inbound outside flow stopped or reopened (payload:
  // ChatroomFlowChangedPayload, owner sockets).
  CHATROOM_FLOW_CHANGED = 'chatroom_flow_changed',
}

export enum ProjectStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum ParticipantRole {
  AGENT = 'agent',
  USER = 'user',
}

// User Authentication
export interface User {
  id: string
  username: string
  assistant_agent_id?: string  // Linked assistant agent
  created_at: string
  email?: string
  email_verified?: boolean
}

export interface AgentConnectionInfo {
  connected: boolean
  ip: string | null
  connected_since: string | null
  uptime_seconds: number | null
}

export interface LoginResponse {
  access_token: string
  refresh_token: string
  user: {
    id: string
    username: string
  }
  // AUTH_CONTRACT §3 pins `"<uuid>" | null`, and the backend confirmed the key is
  // ALWAYS present, carrying null when the user has no assistant. Optional AND
  // nullable so both the pinned shape and an omitted key typecheck under strict.
  // authStore.setSession coerces null -> undefined at the one hydration boundary,
  // because User.assistant_agent_id is `?: string`.
  assistant_agent_id?: string | null
  // Present in the /auth/login and /auth/oauth/exchange payloads. The auth store
  // keeps only assistant_agent_id today; declared for type-honesty (no behaviour
  // depends on it). A freshly-created OAuth user has no assistant yet. NOT
  // widened to null: the backend emits "" (never null) for this one.
  assistant_agent_name?: string
}

// --- OAuth invite-login (additive; shapes match the backend /auth/oauth/* contract) ---

export type OAuthProvider = 'google' | 'github'

// The one error envelope across auth: the OAuth endpoints (validate / start /
// exchange) and, since AUTH_CONTRACT §4, password sign-in (400/401/403 on
// /auth/login) plus the lowercase-username rule on /auth/register.
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    field: string | null
  }
}

// POST /auth/oauth/{provider}/start -> 200 body.
export interface StartResponse {
  authorization_url: string
}

// POST /auth/oauth/invite/validate -> 200 body (advisory, non-consuming).
export interface InviteValidateResponse {
  valid: true
}

// GET /auth/username-available?username= -> 200 body (advisory, non-consuming).
// `reason` carries a human message (validation failure or taken) when unavailable.
export interface UsernameAvailableResponse {
  available: boolean
  reason: string | null
}

export interface RefreshResponse {
  access_token: string
  refresh_token: string
}

// Agent Registry
/**
 * A named model configuration owned by an agent (model-config-selection-revamp).
 *
 * Identity/key is `name` (unique per agent, case-insensitive). There is NO
 * per-config `is_default` flag — the default is a separate top-level
 * `default: string | null` (a config name) on the list envelope, so the client
 * derives `isDefault = cfg.name === default`. Each config carries its OWN API
 * key (move-apikey-to-model-config); the raw key is write-only and never
 * returned — reads expose only the `api_key_set` redaction marker below.
 */
export interface ModelConfig {
  name: string
  provider: LlmProviderId
  model: string | null
  base_url: string | null
  /**
   * Read-only redaction marker (move-apikey-to-model-config backend contract).
   * True once a key is stored for THIS config. The raw key is never returned;
   * this boolean drives the per-row "Key set / No key" chip and the dialog's
   * masked "Key saved" state. Optional so pre-migration cached rows stay safe
   * (absent → treated as "no key set").
   */
  api_key_set?: boolean
  /** Read-only: 'auto' = created by the registration CLI probe; 'manual' = user-added. */
  source: 'auto' | 'manual'
  /** Read-only ISO-8601 timestamp. */
  created_at: string
}

export interface AgentCard {
  id: string
  name: string
  description: string
  capabilities: string[]
  status: AgentStatus
  registered_at: string
  last_heartbeat: string | null
  discoverable_through_registry: boolean
  registered_by?: string
  is_verified: boolean
  user_teams?: string[]
  local_settings?: {
    knowledge_dir?: string
    git_url?: string
    git_base_branch?: string
    // Persistent storage folders on the agent's computer, exposed to the agent
    // as $AGENT_LOCAL_STORAGE_DIR / $AGENT_SHARED_STORAGE_DIR. Unset = default.
    local_storage_dir?: string
    shared_storage_dir?: string
    // Existing folders the agent also works in alongside its sandbox (e.g. a
    // tool checkout). Their skills and instruction file load for every provider.
    extra_dirs?: string[]
    // Provider ids come from the catalog — never re-listed here. Adding a
    // provider is one edit, in config/llmProviders.ts.
    llm_provider?: LlmProviderId
    llm_model?: string
    // The API key is no longer agent-level (move-apikey-to-model-config): it
    // lives per model config (ModelConfig.api_key / api_key_set) and is set
    // through the model-config dialog, not here.
    llm_base_url?: string
    output_mode?: 'tool' | 'native'
  }
  last_reflected_at?: string | null
  /**
   * Default allowlist (agent names / IDs) seeded into the `agent_names`
   * field of a new FD-tunnel DM project coordinated by this agent.
   * Editing here does NOT retroactively touch existing FD-tunnel projects.
   * Composes via OR with `default_invitable_teams`; empty on both = solo
   * replies in new tunnels.
   */
  default_invitable_agents?: string[]
  /**
   * Default allowlist (team labels) seeded into the `agent_teams` field
   * of a new FD-tunnel DM project coordinated by this agent. Same
   * non-retroactive semantics as `default_invitable_agents`.
   */
  default_invitable_teams?: string[]
  /** The viewer may browse this agent's home folder (viewer-relative, set by
   *  the server per request). Absent or false: no folder entry. */
  home_folder_browsable?: boolean
}

export interface AgentRegistrationResult {
  agent_id: string
  token: string
  card: AgentCard
}

// Project & Chatroom
export interface Chatroom {
  id: string
  name: string
  project_id: string
  participants: string[]
  version: number
  created_at: string
  /** Who each participant is, and whether they are outside. Trust is read
   *  from `outside` only (utils/roomTrust); also lists non-member senders. */
  participant_info?: ParticipantInfo[]
  /** Inbound outside flow. Absent on an older server: open. */
  flow?: RoomFlow
}

export interface Project {
  id: string
  name: string
  status: ProjectStatus
  coordinator_id: string
  /**
   * The outside party of a requester end (another account's agent, or a hub
   * stand-in). Owner isolation makes the owning user the coordinator of those
   * ends, so a thread's partner is `counterpartOf(project)` =
   * `counterpart_id ?? coordinator_id`. Absent on older projects and servers.
   */
  counterpart_id?: string | null
  counterpart_name?: string | null
  request: string
  chatrooms: string[]
  participating_agents: string[]
  created_at: string
  created_by?: string // user_id of creator (for user auth)
  agent_pool?: 'owned' | 'verified' | 'all'
  is_viewer?: boolean // true if current user is a read-only viewer
  /**
   * Explicit project shape. New-model Front Desk threads (a cross-account
   * thread with a foreign agent) land as `'frontdesk'` — one singly-owned end
   * per account, host-vs-requester distinguished by which account owns the
   * fielding coordinator (`frontDeskSide`), NOT by the name. Legacy shared FD
   * rows remain `'dm'`, matched by the `{requester}-fd-{agent_short}` name
   * pattern (`isFrontDeskProject`) during the migration window.
   */
  surface?: 'regular' | 'dm' | 'frontdesk'
  /**
   * Human-facing title. For DM threads the agent's runloop sets it (a
   * "New chat" placeholder until the first exchange auto-titles it); for
   * regular/legacy projects it may be absent, so fall back to `name`.
   * Optional so pre-M2a rows stay type-safe.
   */
  display_name?: string
  /**
   * ISO-8601 activity timestamp = max(last_request_ts, last_response_ts),
   * the newest-first sort key for both sidebar sections. Optional so
   * pre-M2a rows fall back to `created_at`.
   */
  last_modified?: string
  /**
   * ISO-8601 timestamp of the project's completion report (the report's own
   * `generated_at`), or null when no real report exists — INCLUDING a completed
   * project with no report. Non-null iff `getProjectReport` would return a real
   * completion report. Optional so pre-M1 cached rows / DM rows / optimistic
   * inserts stay type-safe; value type is exactly `string | null` per the
   * locked backend contract. The My Desk report lane gates on this field.
   */
  report_published_at?: string | null
  /**
   * ISO-8601 timestamp of the last time PLAN.md or its sidecar moved, or null.
   * Read straight off `meta.json` — no extra read on the list path.
   */
  plan_updated_at?: string | null
  /**
   * The plan's desk-facing summary, or ABSENT when the project has no plan at
   * all — a DM, or a pre-feature project with no PLAN.md. Absence is the
   * signal; there is no sentinel. Four of its seven members are `null` exactly
   * when `surface === 'frontdesk'`, so read `plan.phase` with a null check
   * rather than switching on it.
   */
  plan?: PlanSummary | null
  /**
   * The remote agent of a Hub conversation (requester side); null on every
   * non-hub project, absent from older servers. Every string in it is remote
   * text: render as text only.
   */
  hub_target?: HubTarget | null
}

/** FD-tunnel project name pattern: {requester_name_prefix}-fd-{agent_short_name}. */
export const FRONT_DESK_NAME_RE = /^([a-z0-9][a-z0-9_-]*)-fd-([a-z0-9][a-z0-9_-]*)$/

/** Own-user DM project name pattern: {username}-dm-{agent_short_name}. */
export const OWN_DM_NAME_RE = /^([a-z0-9][a-z0-9_-]*)-dm-([a-z0-9][a-z0-9_-]*)$/

/**
 * A LEGACY shared Front Desk row: a DM-shaped project (`surface === 'dm'`)
 * whose name matches the FD-tunnel pattern. New-model FD ends are
 * `surface === 'frontdesk'` and are NOT matched here — use `isFrontDeskSurface`
 * / `frontDeskSide` for those. Kept as the legacy fallback during the migration
 * window (see the Front Desk plan §7 for the removal condition: safe to delete
 * once a scan for `surface === 'dm' && FRONT_DESK_NAME_RE` returns zero rows).
 */
export function isFrontDeskProject(project: { name: string; surface?: string }): boolean {
  return project.surface === 'dm' && FRONT_DESK_NAME_RE.test(project.name)
}

/**
 * A new-model Front Desk end (either the host or the requester side), keyed on
 * `surface`. Legacy shared `-fd-` rows stay `surface === 'dm'` and match
 * `isFrontDeskProject`, NOT this predicate.
 */
export function isFrontDeskSurface(project: { surface?: string }): boolean {
  return project.surface === 'frontdesk'
}

/**
 * Any thread-shaped project — an own-DM thread OR either Front Desk end. The
 * single exclusion the regular PROJECTS list, its badge, and the ⌘K palette use
 * so no thread (dm or frontdesk) leaks into the regular Projects surface.
 */
export function isThreadProject(project: { surface?: string }): boolean {
  return project.surface === 'dm' || project.surface === 'frontdesk'
}

/** A DM-shaped project for a direct one-on-one with one of the user's own agents. */
export function isOwnDMProject(project: { name: string; surface?: string }): boolean {
  return project.surface === 'dm' && OWN_DM_NAME_RE.test(project.name)
}

/**
 * The literal suffix marking a DM thread dedicated to scheduled messages
 * (`{username}-dm-{agent_short}-schedule`).
 */
export const SCHEDULED_DM_NAME_SUFFIX = '-schedule'

/**
 * A scheduled-messages DM thread: an own-DM project whose name ends in the
 * literal `-schedule` suffix. Regular own-DM threads end in an 8-char hex uuid
 * (which can never spell "schedule"), so the suffix is an unambiguous signal —
 * no backend flag needed.
 */
export function isScheduledDMProject(project: { name: string; surface?: string }): boolean {
  return isOwnDMProject(project) && project.name.endsWith(SCHEDULED_DM_NAME_SUFFIX)
}

export function parseFrontDeskName(name: string): { requester: string; agentShort: string } | null {
  const m = name.match(FRONT_DESK_NAME_RE)
  if (!m) return null
  return { requester: m[1], agentShort: m[2] }
}

export function parseOwnDMName(name: string): { username: string; agentShort: string } | null {
  const m = name.match(OWN_DM_NAME_RE)
  if (!m) return null
  return { username: m[1], agentShort: m[2] }
}

// Messaging
export interface ChatMessage {
  entry_type?: 'message'
  id: string
  ts: string
  from_participant_id: string
  from_participant_name: string | null
  content: string
  /**
   * Server-populated field from parsing @mentions in message content.
   * - @participant-name in content -> participant is addressed
   * - No @mentions -> empty array (informational message)
   */
  expects_response_from: string[]
  /**
   * True for system-posted placeholder messages (e.g. "Message received,
   * processing...") and cancel-confirmation messages. The web UI hides
   * these — the typing indicator covers the "received" signal — but CLI
   * consumers like `clawmeets user listen` still surface them.
   */
  is_ack?: boolean
  /** This entry's changelog version (null for legacy rows). */
  version?: number | null
  /** Version of the entry that triggered this message (reply-to link). */
  source_version?: number | null
  /**
   * Stamped when written by an owner-isolated agent outside its own
   * conversations: outside content for good, even after the owner turns the
   * setting off (so the live participant rule no longer says so). Renders
   * through the untrusted path. Absent on older servers.
   */
  outside_isolated?: boolean
}

/**
 * File-touched event row in CHATS.ndjson, emitted alongside FILE_CREATED /
 * FILE_UPDATED changelog entries. An agent's ActionBlock tags its reply
 * and its file uploads with the same source_version (the triggering
 * mention), so the web UI groups a file event under its sibling message
 * by matching source_version + from_participant_id.
 */
export interface ChatFileEvent {
  entry_type: 'file_created' | 'file_updated'
  ts: string
  from_participant_id: string
  from_participant_name: string
  filename: string
  version?: number | null
  source_version?: number | null
  /** See ChatMessage.outside_isolated. */
  outside_isolated?: boolean
}

/**
 * Batch-timeout event row in CHATS.ndjson, emitted alongside BATCH_TIMEOUT
 * changelog entries. The chip uses this to flip per-recipient status from
 * "AWAITING" to "TIMED OUT" — message_id matches the @mention message that
 * opened the batch, which is what the chip keys off of.
 */
export interface ChatBatchTimeoutEvent {
  entry_type: 'batch_timeout'
  ts: string
  message_id: string
  coordinator_id: string
  responded_participants: string[]
  timed_out_participants: string[]
  /**
   * Subset of timed_out_participants whose runner was disconnected AT THE
   * MOMENT THE TIMEOUT FIRED (re-checked there, never cached from dispatch).
   * Optional: every batch_timeout row written before this field existed has
   * no such key, and those rows still have to render.
   *
   * This is what keeps "ignored you" distinguishable from "was never there"
   * on a row that already timed out. It is NOT the same state as
   * ChatAgentOfflineEvent: an agent that received the message, worked on it
   * and died mid-flight is not an agent that never received it, and only the
   * second is fixed by resending. Do not fold the two into one status.
   */
  offline_participants?: string[]
  version?: number | null
  source_version?: number | null
}

/**
 * Dispatch-time offline event row in CHATS.ndjson, emitted alongside
 * AGENT_OFFLINE changelog entries. Sibling of ChatBatchTimeoutEvent —
 * same message_id key, different producer and different clock: this one fires
 * at T+0 from the dispatch path and means "we did not wait, nobody was there";
 * that one fires at T+1800 and means "we waited and nobody came".
 *
 * Both id lists are AGENT IDS, matching expects_response_from.
 *
 * NOT terminal the way batch_timeout is: a runner can connect a moment after
 * the liveness check, and the message stays queued for it either way. A later
 * real reply must still win — see buildRecipientStatusIndex.
 */
export interface ChatAgentOfflineEvent {
  entry_type: 'agent_offline'
  ts: string
  /**
   * REQUIRED. Keys the offline state to the @mention that would have opened
   * the batch — the per-recipient index is (message_id, agent_id), and
   * timedOutByMessageId resolves by message.id. Without it, an agent
   * addressed twice — once while offline, once after `clawmeets start` —
   * reads OFFLINE on both rows forever, and the once-per-message explainer
   * has no grouping key.
   */
  message_id: string
  coordinator_id: string
  offline_participants: string[]
  dispatched_participants: string[]
  version?: number | null
  source_version?: number | null
}

/** CHATS.ndjson row: a message, a file event, a batch timeout, or an offline event. */
export type ChatLogEntry =
  | ChatMessage
  | ChatFileEvent
  | ChatBatchTimeoutEvent
  | ChatAgentOfflineEvent

export function isChatFileEvent(entry: ChatLogEntry): entry is ChatFileEvent {
  return entry.entry_type === 'file_created' || entry.entry_type === 'file_updated'
}

export function isBatchTimeoutEvent(
  entry: ChatLogEntry,
): entry is ChatBatchTimeoutEvent {
  return entry.entry_type === 'batch_timeout'
}

export function isAgentOfflineEvent(
  entry: ChatLogEntry,
): entry is ChatAgentOfflineEvent {
  return entry.entry_type === 'agent_offline'
}

/**
 * Positive test, deliberately NOT "everything that isn't one of the event
 * rows". `ChatMessage.entry_type` is optional (legacy rows predate the
 * discriminator) which is why this was once written negatively — but that
 * shape made every NEW union member silently classify as a message, and the
 * consumers of this guard render what it admits: MessageList as a bubble,
 * useDeskUpdates as a room's newest message, ActivityFeed, recipientStatus.
 * Adding a member to ChatLogEntry must never widen this again.
 */
export function isChatMessage(entry: ChatLogEntry): entry is ChatMessage {
  return entry.entry_type === undefined || entry.entry_type === 'message'
}

// WebSocket payload types
export interface ChangelogUpdatePayload {
  project_id: string
  project_name: string
  new_version: number
}

export interface AgentStatusChangePayload {
  agent_id: string
  agent_name: string
  new_status: string
}

export interface ActiveWorkChangePayload {
  project_id: string
  project_name: string
  chatroom_name: string
  active_participants: string[]
}

export interface McpAuthUrlForUserPayload {
  agent_id: string
  agent_name: string
  mcp_name: string
  auth_url: string
  state: string
}

export interface SkillAuthUrlForUserPayload {
  agent_id: string
  agent_name: string
  skill_name: string
  auth_url: string
  state: string
}

export interface AgentCardUpdatePayload {
  agent_id: string
  agent_name: string
  last_reflected_at?: string | null
}

export interface BriefTabSyncPayload {
  action: 'upsert' | 'delete'
  slug: string
  title?: string | null
  generated_at?: string | null
}

export interface DeskTodoSyncPayload {
  /** `associate` / `dissociate` carry the TO-DO id, like every other member.
   *
   *  `project` carries `id: null`, and that is not an omission: one project
   *  event can move several rows at once, and it fires on three of them — a
   *  project COMPLETING, REACTIVATING and being DELETED — addressed to the
   *  to-do's OWNER rather than to the mutating project's subscribers. The
   *  refetch is whole-plate anyway, so there is no id worth naming.
   *
   *  No new payload shape, and the handler needs no new branch: it already
   *  ignores the payload and invalidates `['desk-todos']`, which is precisely
   *  what makes a null id work. */
  action:
    | 'add'
    | 'patch'
    | 'reorder'
    | 'delete'
    | 'publish'
    | 'associate'
    | 'dissociate'
    | 'project'
  id?: string | null
}

/** Sent to every live session the SOP owner holds, so a library edited in one
 *  tab refreshes in all of them. Carries only the action + affected id; the
 *  full list comes from `GET /me/desk/sops`. */
export interface DeskSopSyncPayload {
  action: 'add' | 'patch' | 'delete'
  id?: string | null
}

/**
 * Sent to every live session the registry's owner holds.
 *
 * Arrives from MORE than the six registry endpoints: `POST` and `PATCH
 * /me/desk/todos` auto-register any unregistered slug and emit one
 * `{action:'add', slug}` per row they create. `PUT` publish does NOT
 * auto-register and sends nothing.
 *
 * `delete` and `merge` change two documents, so each sends TWO envelopes with
 * `DESK_TODO_SYNC` FIRST — the transient that order produces is a registry
 * still listing a label no item carries, which renders as an empty group the
 * rail already handles. The reverse order renders every chip dashed-
 * unregistered for a frame. The to-do envelope carries `id: null`: a delete
 * can touch any number of rows and the client refetches the whole plate.
 *
 * `into` is populated on `merge` ONLY, and it is load-bearing: without it a
 * receiving tab has `{action, slug}` and cannot tell a merge from a delete, so
 * a filter sitting on the merged label could not follow it and would have to
 * degrade to clear-and-notice. The merge RESPONSE carries the same field for
 * the tab that made the call; this one serves every other tab.
 */
export interface DeskLabelSyncPayload {
  action: 'add' | 'patch' | 'reorder' | 'delete' | 'merge'
  /** The affected slug. Absent on `reorder`, which moves the whole array. */
  slug?: string | null
  /** The merge TARGET. Present on `merge` and on nothing else. */
  into?: string | null
}

export interface DeskReadStateSyncPayload {
  project_id: string
  chatroom_name: string
  last_seen_message_id: string  // "__dismissed__" sentinel allowed
  updated_at: string            // server ISO-8601 clock; drives last-writer-wins
}

// WebSocket control envelopes
/** One live runner as reported on the wire. §2.1 — exactly these three keys,
 *  no more and no fewer. Mirrors `RunnerVersion` in `clawmeets/api/control.py`;
 *  the two are independent mirrors of the frozen contract, not a shared file. */
export interface Runner {
  id: string
  name: string
  /** The reported version string, or `null` when the runner sent no version
   *  field / could not determine one. NEVER the string "unknown", never
   *  omitted. */
  version: string | null
}

/** Payload of a RUNNER_VERSIONS envelope. `runners` is always present on the
 *  initial browser-connect push, `[]` included — so there is exactly one empty
 *  state and no optional chaining is needed. On an internal failure during an
 *  UPDATE push the server sends nothing at all; see runnerVersionStore.apply(). */
export interface RunnerVersionsPayload {
  runners: Runner[]
}

/** Payload of a HOST_SYNC envelope. Two required fields and no state: the
 *  client's only job is to refetch. `action` says why it was woken, which is
 *  useful for logging and useless as a delta — do not try to apply it. */
export interface HostSyncPayload {
  host_id: string
  action: 'connected' | 'disconnected' | 'state' | 'renamed' | 'revoked' | 'paired'
}

/** Payload of an INSTALL_SYNC envelope — the user's one-command install reported
 *  a step. A cursor, exactly like `HostSyncPayload`: the run is defined by
 *  `GET /me/install-progress` and the client's only job is to refetch.
 *
 *  `step` / `state` are carried so a websocket trace is readable on its own, NOT
 *  so a client can apply them as a delta. Do not. */
export interface InstallSyncPayload {
  step: string
  state: 'started' | 'ok' | 'failed' | 'skipped'
}

/** Payload of a RESYNC envelope (api/control.py ResyncPayload). The client
 *  waits `Math.random() * jitter_s` seconds, then catches up — `full` is
 *  everything a reconnect does, `changelog` the changelog part alone. */
export interface ResyncPayload {
  scope: 'full' | 'changelog'
  reason: 'core_restart' | 'outbox_overflow'
  jitter_s: number
}

export interface ControlEnvelope {
  type: ControlMessageType
  payload:
    | ChangelogUpdatePayload
    | AgentStatusChangePayload
    | ActiveWorkChangePayload
    | McpAuthUrlForUserPayload
    | SkillAuthUrlForUserPayload
    | AgentCardUpdatePayload
    | BriefTabSyncPayload
    | DeskTodoSyncPayload
    | DeskReadStateSyncPayload
    | DeskSopSyncPayload
    | DeskLabelSyncPayload
    | RunnerVersionsPayload
    | HostSyncPayload
    | InstallSyncPayload
    | ResyncPayload
    | HubDeliveryStatePayload
    | HubChannelStatusPayload
    | HubBridgeDeliveryPayload
    | ChatroomFlowChangedPayload
    | Record<string, unknown>
}

// Agent Search
export interface AgentSearchParams {
  q?: string
  capabilities?: string
  status?: string
  offset?: number
  limit?: number
  sort?: 'status_first' | 'name'
  discoverable_only?: boolean
}

export interface AgentSearchResponse {
  agents: AgentCard[]
  total: number
  offset: number
  limit: number
}

// Skill Hub

/** OAuth declaration on a skill's registry entry. Surfaced via
 *  `GET /skills/<name>` so the catalog can render an "OAuth" badge + an
 *  Authenticate affordance for skills that need it (gmail / google-calendar
 *  / google-drive / google-drive-write). */
export interface SkillAuthMeta {
  method: string  // currently only "google_oauth_installed"
  scopes: string[]
  token_file: string
}

export interface SkillMeta {
  name: string
  summary?: string | null
  description: string
  tags: string[]
  version: string
  attribution: string | null
  auth?: SkillAuthMeta | null
}

export interface SkillDetail extends SkillMeta {
  content: string  // Full SKILL.md
  /** Parsed starter template (JSONC stripped). Non-null iff the skill ships a
   * `starter_config.jsonc` sibling — gates the Configure pill in the catalog. */
  starter_config?: Record<string, unknown> | null
}

export interface SkillConfigResponse {
  config: Record<string, unknown> | null
  /** Parsed starter template (JSONC stripped). Kept for any consumer that wants a dict view. */
  starter_config: Record<string, unknown> | null
  /** Raw JSONC text with inline comments. Drives the Configure modal's editor seed. */
  starter_config_text: string | null
}

// MCP Hub
export interface McpMeta {
  name: string
  description: string
  tags: string[]
  version: string
  attribution: string | null
}

export interface McpDetail extends McpMeta {
  manifest: {
    launch?: { command?: string; args?: string[]; env?: Record<string, string> }
    auth?: { method?: string; scopes?: string[]; token_file?: string }
    starter_config?: Record<string, unknown> | null
  } | null
  readme: string | null
}

export interface McpConfigResponse {
  config: Record<string, unknown> | null
  /** Parsed starter template (JSONC stripped). Kept for any consumer that wants a dict view. */
  starter_config: Record<string, unknown> | null
  /** Raw JSONC text with inline comments. Drives the Configure modal's editor seed. */
  starter_config_text: string | null
}

// File info (from list files endpoint)
export interface FileInfo {
  name: string
  size: number
  modified: string
}

// Activity event for progress tracker
export interface ActivityEvent {
  type: 'message' | 'invite' | 'room_created'
  timestamp: string
  projectId: string
  chatroomName: string
  data: ChatMessage | { agentId: string }
}

// ---------------------------------------------------------------------------
// Chat message search — mirrors SEARCH_API_CONTRACT.md v1.0 §3–§4 field for
// field. Nothing here is invented: every member exists on the wire. Keep this
// block in sync with the contract, not with what a component happens to need.
// ---------------------------------------------------------------------------

export type RoomType = 'dm' | 'project'
export type DeepLinkKind = 'dm' | 'project_room'

export interface SearchDeepLink {
  /** Complete, URL-encoded, app-relative route. navigate() this verbatim (§4.1). */
  path: string
  kind: DeepLinkKind
  project_id: string
  chatroom_name: string
  /** Non-null iff kind === 'dm'. */
  agent_name: string | null
  message_id: string
}

export interface SearchHit {
  message_id: string
  project_id: string
  project_name: string
  room_id: string
  room_type: RoomType
  /** Pre-computed group header — render as-is, never re-derive (§3.4). */
  room_label: string
  ts: string
  author_id: string
  author_name: string
  /** PLAIN TEXT. May contain '<' and '&' — render as a JSX text node (§3.5). */
  snippet: string
  snippet_truncated_start: boolean
  snippet_truncated_end: boolean
  /** UTF-16 [start, end) pairs into `snippet`; legally empty (§3.5). */
  match_offsets: Array<[number, number]>
  /** Opaque sort key. Never displayed, never thresholded (§3.6). */
  score: number
  deep_link: SearchDeepLink
}

export interface MessageSearchResponse {
  /** Verbatim echo of `q` — the stale-response discard key (§2.3). */
  query: string
  /** Already best-first. Do NOT re-sort (§3.1). */
  hits: SearchHit[]
  limit: number
  offset: number
  has_more: boolean
  next_offset: number | null
  /** Backfill still running: results are valid but may be incomplete. */
  indexing: boolean
  took_ms: number
}

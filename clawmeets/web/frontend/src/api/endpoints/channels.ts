import { del, get, patch, post, put } from '../client'
import type { HubContactFields } from './hub'

/** An agent's connection to a channel (Telegram, email, LINE, WhatsApp or the web chat widget), as the owner sees it.
 *
 *  Mirrors `ConnectionResponse` in `clawmeets/server/routes/channels.py` field
 *  for field. The bot token is never returned — only its last four characters
 *  — and the webhook secret is never returned at all. With the server's kill
 *  switch off every channel route answers 404. */
export interface ChannelConnection {
  id: string
  agent_id: string
  channel: string
  label: string
  /** Telegram: the bot token's last four. LINE and WhatsApp: the ACCESS
   *  TOKEN's last four — the LINE channel secret and the WhatsApp app secret
   *  are never returned, not even partly. */
  secret_last4: string
  webhook_url: string
  mode: ChannelMode
  fixed_reply: string
  /** `strangers_reach_full_tools` while the mode is "anyone", else null. */
  warning: string | null
  /** Telegram: the bot's `@username`. Email: the agent's address. LINE: the bot's name.
   *  WhatsApp: `"<verified_name> (<display_phone_number>)"`. Render as text. */
  account_name: string
  disabled: boolean
  /** working | token_rejected | webhook_missing | webhook_error |
   *  pending_updates | disabled | key_rotation_pending — LINE adds
   *  signature_mismatch | quota_exhausted | push_not_allowed; WhatsApp adds
   *  permission_denied | number_not_registered | number_unreachable |
   *  payment_issue |
   *  account_restricted | signature_mismatch | no_webhook_yet — or null before
   *  any check. Unknown codes are possible from a newer server. */
  status: string | null
  /** Telegram's own text for webhook_error. Render as text. */
  status_detail: string | null
  /** pending_updates: the count; webhook_error: when it happened (epoch s) —
   *  except on LINE, where webhook_error carries the HTTP status this server
   *  answered LINE's test call with. */
  status_count: number | null
  status_at: number | null
  /** Whether strangers' conversations on this connection run isolated on the
   *  agent's computer; absent or unknown counts as unavailable. */
  isolation?: string
  /** Conversations waiting for a computer that can isolate them. */
  held_conversations?: number
  /** When the provider last delivered a message (email: "last mail received"). */
  last_inbound_at: number | null
  /** LINE: the "got it" acknowledgement sent on LINE's (free) reply token when
   *  a message reaches the agent; "" = send none. null for other channels. */
  ack_text: string | null
  /** LINE: push messages used this month — LINE's figure at the last fetch
   *  plus the pushes sent since. Approximate. null for other channels. */
  push_used: number | null
  /** LINE: the monthly push limit; null when LINE says no limit is set OR
   *  when it was never fetched (tell the two apart with `push_as_of`). */
  push_limit: number | null
  /** LINE: when the push figures were last fetched from LINE (epoch s);
   *  null = never fetched. */
  push_as_of: number | null
  /** LINE and WhatsApp: webhook calls that failed the signature check since
   *  the last one that passed, stopping at 1000. 0 for other channels. */
  unverified_calls: number
  /** LINE: LINE answered a push with its monthly limit this quota month.
   *  Optional: false/absent for other channels. */
  push_limit_reached?: boolean
  /** WhatsApp: the phone number ID — an identifier, not a credential, so it is
   *  shown in full. null/absent for other channels. */
  phone_number_id?: string | null
  /** WhatsApp: the verify token's last four. null/absent for other channels. */
  verify_token_last4?: string | null
  /** WhatsApp: when Meta's subscription check (its GET handshake) last
   *  succeeded (epoch s); null = never. */
  handshake_ok_at?: number | null
  /** WhatsApp: replies held in the last 7 days because the 24-hour window had
   *  closed. null/absent for other channels. */
  held_window_7d?: number | null
  /** Email: automatic mail (bounces, no-reply senders, provider notices,
   *  lists) dropped because its sender has no conversation with the agent,
   *  stopping at 1000. null/absent for other channels. */
  automatic_dropped?: number | null
  /** Email: when the last automatic mail was dropped (epoch s); null = never. */
  automatic_dropped_at?: number | null
  /** Email: the last dropped mail's sender domain (never the address). */
  automatic_dropped_domain?: string | null
  /** Email: why the last one counted as automatic — bounce | system_sender |
   *  delivery_report | auto_submitted | autoreply_header | precedence |
   *  mailing_list. A code, not copy. */
  automatic_dropped_reason?: string | null
}

export type ChannelMode = 'allowlist' | 'anyone'

export const WARNING_ANYONE = 'strangers_reach_full_tools'

export interface AllowlistEntry {
  id: string
  kind: string
  value: string
  /** For an @username entry: the Telegram user id it is pinned to. */
  pinned_to: string | null
}

/** Hub rows add the three `HubContactFields` (absent on every other channel). */
export interface ChannelRequest extends HubContactFields {
  id: string
  state: 'pending' | 'allowing' | 'allowed' | 'blocked'
  display_name: string
  user_key: string
  handle: string | null
  /** Exactly as sent. Render as text, never as markup. */
  first_message: string
  held_count: number
  dropped_count: number
  unverified_count: number
  /** null (none was sent), pending, sending, sent, failed or expired. */
  fixed_reply_state: string | null
  allowed_by: string | null
  project_ids: string[]
  created_at: number
}

const base = '/me/channels/connections'
const one = (id: string) => `${base}/${encodeURIComponent(id)}`

export const listConnections = () => get<ChannelConnection[]>(base)

/** The token is sent once and kept nowhere in the browser. */
export const connectTelegram = (agentName: string, token: string) =>
  post<ChannelConnection>(base, { agent_name: agentName, channel: 'telegram', token })

/** Email needs no credential: the server's own SendGrid account sends and receives. */
export const connectEmail = (agentName: string) =>
  post<ChannelConnection>(base, { agent_name: agentName, channel: 'email' })

/** Both LINE credentials are sent once and kept nowhere in the browser. */
export const connectLine = (agentName: string, channelSecret: string, accessToken: string) =>
  post<ChannelConnection>(base, {
    agent_name: agentName, channel: 'line', channel_secret: channelSecret, access_token: accessToken,
  })

/** All three WhatsApp secrets are sent once and kept nowhere in the browser. */
export const connectWhatsApp = (
  agentName: string, phoneNumberId: string, accessToken: string, appSecret: string, verifyToken: string,
) =>
  post<ChannelConnection>(base, {
    agent_name: agentName,
    channel: 'whatsapp',
    phone_number_id: phoneNumberId,
    access_token: accessToken,
    app_secret: appSecret,
    verify_token: verifyToken,
  })

/** The web chat widget needs no credential: the server mints its signing key,
 *  starts it open to anyone on an allowed site, and creates one default key
 *  whose only site is the ClawMeets server (so the hosted chat page works). */
export const connectWebChat = (agentName: string) =>
  post<ChannelConnection>(base, { agent_name: agentName, channel: 'webchat' })

// ── web chat widget ──────────────────────────────────────────────────────

/** One embeddable key. Mirrors `GrantResponse` in
 *  `clawmeets/server/routes/webchat.py`. The key is public by design — it sits
 *  in the host page's source — so it is always returned. */
export interface WidgetGrant {
  id: string
  label: string
  key: string
  /** Normalised site origins, e.g. `https://acme.com`. */
  origins: string[]
  /** The one line to paste into the site. */
  snippet: string
  created_at: number
}

/** Mirrors `WidgetResponse` in `clawmeets/server/routes/webchat.py`. */
export interface WidgetInfo {
  script_url: string
  /** The hosted chat page; it works while some key lists the server's origin. */
  chat_page_url: string
  chat_page_public: boolean
  grants: WidgetGrant[]
}

export const getWidget = (id: string) => get<WidgetInfo>(`${one(id)}/widget`)
export const createWidgetGrant = (id: string, label: string, origins: string[]) =>
  post<WidgetGrant>(`${one(id)}/grants`, { label, origins })
export const updateWidgetGrant = (id: string, grantId: string, body: { label?: string; origins?: string[] }) =>
  patch<WidgetGrant>(`${one(id)}/grants/${encodeURIComponent(grantId)}`, body)
export const revokeWidgetGrant = (id: string, grantId: string) =>
  del<{ revoked: string }>(`${one(id)}/grants/${encodeURIComponent(grantId)}`)

export const testConnection = (id: string) => post<ChannelConnection>(`${one(id)}/test`)
export const disableConnection = (id: string) => post<ChannelConnection>(`${one(id)}/disable`)
export const enableConnection = (id: string) => post<ChannelConnection>(`${one(id)}/enable`)
export const reconnectConnection = (id: string) => post<ChannelConnection>(`${one(id)}/reconnect`)
export const removeConnection = (id: string) => del<{ removed: string }>(one(id))

export const setConnectionMode = (id: string, mode: ChannelMode) =>
  put<ChannelConnection>(`${one(id)}/mode`, { mode })
export const setFixedReply = (id: string, text: string) =>
  put<ChannelConnection>(`${one(id)}/fixed-reply`, { text })

/** LINE only. "" sends no acknowledgement. At most 1000 characters. */
export const setAckText = (id: string, text: string) =>
  put<ChannelConnection>(`${one(id)}/ack-text`, { text })

export const listAllowlist = (id: string) => get<AllowlistEntry[]>(`${one(id)}/allowlist`)
export const addAllowlistEntry = (id: string, value: string) =>
  post<AllowlistEntry>(`${one(id)}/allowlist`, { value })
export const deleteAllowlistEntry = (id: string, entryId: string) =>
  del<{ deleted: string }>(`${one(id)}/allowlist/${encodeURIComponent(entryId)}`)

export const listRequests = (id: string) => get<ChannelRequest[]>(`${one(id)}/requests`)
export const allowRequest = (id: string, requestId: string) =>
  post<ChannelRequest>(`${one(id)}/requests/${encodeURIComponent(requestId)}/allow`)
export const blockRequest = (id: string, requestId: string) =>
  post<ChannelRequest>(`${one(id)}/requests/${encodeURIComponent(requestId)}/block`)

// ── a conversation (a channel thread) ────────────────────────────────────

/** A reply held because WhatsApp's 24-hour window had closed. Render `text`
 *  as text, never markup. */
export interface HeldReply {
  message_id: string
  part_index: number
  text: string
  reason: string
  held_at: number
}

/** One channel thread, as its owner sees it. 404 when the project is not a
 *  channel thread (or channels are off). */
export interface ChannelThread {
  project_id: string
  channel: string
  paused: boolean
  /** The contact's name as the provider gave it. Render as text. */
  contact_name: string
  /** WhatsApp: non-null while the 24-hour window is closed (epoch s); `held`
   *  then lists the replies held since the contact's last message. */
  window_closed_at: number | null
  held: HeldReply[]
}

/** One of the owner's channel threads, for the Front Desk sidebar. Mirrors
 *  `ThreadListItem` in `clawmeets/server/routes/channels.py` field for field.
 *  Never carries a provider identifier: `contact_id` is opaque. A thread whose
 *  connection was removed has `connection_removed`, no connection and no
 *  contact id, and the contact's name as it was. */
export interface ChannelThreadRow extends HubContactFields {
  project_id: string
  channel: string
  connection_id: string | null
  connection_enabled: boolean
  connection_removed: boolean
  contact_id: string | null
  /** The contact's display name. Render as text. May be empty. */
  contact_name: string
  paused: boolean
}

export interface OutboxItem {
  message_id: string
  part_index: number
  /** pending | sending | sent | failed | expired | held_paused | held_window */
  state: string
  reason: string | null
  attempts: number
  /** held_window rows only: the reply that was not sent. Render as text. */
  text?: string | null
  /** The provider's own words for the last failure (bounded and redacted by
   *  the server); null/absent when it said nothing. Render as text. */
  detail?: string | null
}

const thread = (projectId: string) => `/me/channels/threads/${encodeURIComponent(projectId)}`

export const listChannelThreads = () => get<ChannelThreadRow[]>('/me/channels/threads')
export const getChannelThread = (projectId: string) => get<ChannelThread>(thread(projectId))
export const setThreadPaused = (projectId: string, paused: boolean) =>
  put<{ project_id: string; paused: boolean }>(`${thread(projectId)}/pause`, { paused })
export const getThreadOutbox = (projectId: string) => get<OutboxItem[]>(`${thread(projectId)}/outbox`)

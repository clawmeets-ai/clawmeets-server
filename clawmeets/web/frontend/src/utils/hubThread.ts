import type {
  EpochSeconds, HubConfig, HubErrorBody, HubTarget, PayloadTooLarge, SendWarning,
} from '../api/endpoints/hub'
import { closedReasonOf, lastConnectedOf } from '../api/endpoints/hub'
import { formatHubDate, shortFingerprint } from './hubDisplay'

/**
 * The composer of a hub thread: one pure function decides whether the user can
 * send, and what the banner says when they can't. Every state that must survive
 * a reload is read from stored fields (config, hub_target); the last error is
 * only a live fallback until the next refetch.
 */

/** Names for the copy, already passed through safeRemoteText. */
export interface HubThreadNames {
  /** name@deployment_name */
  display: string
  name: string
  deploymentName: string
  /** Genesis fingerprint of the remote server. */
  fingerprint: string
}

/** What the thread knows of the remote agent right now (detail or start answer). */
export interface HubTargetLive {
  agent_online: boolean
  deployment_connected: boolean
  accepting_messages?: boolean
  listed?: boolean
  needs_approval?: boolean
}

export type HubBlockReason =
  | 'hub_off' | 'not_registered' | 'suspended' | 'browse_only' | 'untrusted' | 'closed'
  | 'unlisted' | 'unreachable' | 'rate_limited' | 'not_accepting'

export type HubInputState =
  | {
      enabled: true
      /** Sending needs the offline confirm first. */
      confirm: SendWarning | null
      /** "…'s owner approves new contacts first…", shown above the composer. */
      notice: string | null
    }
  | {
      enabled: false
      reason: HubBlockReason
      /** The banner sentence. */
      text: string
      /** The closed_reason when reason === 'closed' (stored or live). */
      closedReason?: string
      /** A conversation_closed thread whose agent is still listed. */
      canStartNew?: boolean
      /** Seconds left on a rate-limit wait. */
      waitSeconds?: number
    }

/** Replies may still arrive this long after a close (the owner's drain). */
export const DRAIN_WINDOW_S = 10 * 60

/** Live close reasons a send error can carry before hub_target catches up. */
const LIVE_CLOSE_CODES = new Set(['agent_unlisted', 'key_revoked', 'identity_changed', 'conversation_closed'])

export const HUB_COPY = {
  hubOff: 'The hub is turned off on this server.',
  notRegistered: "This server isn't registered with the hub yet. Ask its operator.",
  suspended: 'The hub has suspended this server. Ask its operator.',
  browseOnly: "This server can browse the hub but can't send or receive hub messages right now.",
  untrusted: "This server can't verify the hub's identity, so nothing is sent to it. Ask this server's operator.",
  unreachable: (last: EpochSeconds | null) =>
    "Can't reach the hub. Sending to other servers is paused." +
    (last !== null ? ` Last connected ${formatHubDate(last)}.` : ''),
  history: 'This conversation is kept as history.',
  cantSend: "You can't send new messages",
  drain: 'Replies already on their way may still arrive for a few minutes.',
  unlisted: (n: HubThreadNames) => `${n.display} is no longer listed on the hub.`,
  notAccepting: (n: HubThreadNames) => `${n.name} isn't taking new messages right now`,
  rateLimited: (n: HubThreadNames, s: number) =>
    `You're sending too fast to ${n.display}. You can send again in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.`,
  needsApproval: (n: HubThreadNames) =>
    `${n.name}'s owner approves new contacts first. Your first message waits until they accept you.`,
  agentOffline: (n: HubThreadNames) =>
    `${n.display} is offline. ${n.deploymentName} will hold your message and the agent answers when it's back. Send anyway?`,
  deploymentOffline: (n: HubThreadNames) =>
    `${n.deploymentName} is offline. Your message waits on this server and is sent when ${n.deploymentName} reconnects, for up to 72 hours. Send anyway?`,
} as const

/** The banner for a closed conversation, by closed_reason. */
export function closedBanner(reason: string, n: HubThreadNames, closedAt: EpochSeconds | null, nowMs: number): string {
  switch (reason) {
    case 'agent_unlisted': {
      const draining = closedAt !== null && nowMs / 1000 - closedAt < DRAIN_WINDOW_S
      return `${HUB_COPY.unlisted(n)} ${HUB_COPY.history}${draining ? ` ${HUB_COPY.drain}` : ''}`
    }
    case 'key_revoked':
      return `This agent's hub key was revoked by its owner. ${HUB_COPY.history}`
    case 'deployment_suspended':
      return `The hub has suspended ${n.deploymentName}. ${HUB_COPY.history}`
    case 'conversation_closed':
      return `${n.display} closed this conversation. Start a new one to continue.`
    case 'hub_off_on_server':
      return `${HUB_COPY.hubOff} ${HUB_COPY.history}`
    case 'identity_changed':
      return `${n.deploymentName}'s identity changed. The server now using this name has a different key ` +
        `(was ${shortFingerprint(n.fingerprint)}). Messages here won't go to it. ` +
        'This can be a re-install, or someone else using the name.'
    default:
      return 'This conversation is closed.'
  }
}

export interface HubThreadInput {
  config: HubConfig
  names: HubThreadNames
  /** null for a new-chat draft (no thread yet). */
  hubTarget: HubTarget | null
  live?: HubTargetLive | null
  lastError?: HubErrorBody | null
  /** Epoch ms until which a rate-limit wait runs. */
  rateLimitedUntil?: number | null
  nowMs: number
}

const KNOWN_REGISTRATION_BLOCKS = new Set(['active', 'suspended'])

/**
 * Whether the config's link state alone means sending is paused. In mode
 * 'auto' the server's hub socket is closed while idle and a send connects it
 * first, so a closed or not-yet-connected link is not a reason to pause: only
 * the server's own refusal (a hub_unreachable answer, a directory served from
 * cache) or a state checked separately (off, suspended, untrusted) is. The
 * explicit modes keep the socket open, so there a link that is down pauses.
 */
export function hubLinkPausesSending(config: Pick<HubConfig, 'mode' | 'hub_link' | 'deployment_connected'>): boolean {
  if (config.mode === 'auto') return false
  return config.hub_link === 'unreachable' || !config.deployment_connected
}

/** First match wins; see the Public tab plan's ordered list. */
export function hubThreadInputState(i: HubThreadInput): HubInputState {
  const { config, names: n, hubTarget: t, live, nowMs } = i
  const code = i.lastError?.code ?? null
  const off = (reason: HubBlockReason, text: string, extra: Partial<HubInputState> = {}): HubInputState =>
    ({ enabled: false, reason, text, ...extra }) as HubInputState

  if (config.mode === 'off') {
    return off('hub_off', t ? `${HUB_COPY.hubOff} ${HUB_COPY.history}` : HUB_COPY.hubOff)
  }
  if (!KNOWN_REGISTRATION_BLOCKS.has(config.registration) || code === 'hub_not_registered') {
    return off('not_registered', HUB_COPY.notRegistered)
  }
  if (config.registration === 'suspended') return off('suspended', HUB_COPY.suspended)
  if (config.mode === 'discover_only' || code === 'hub_discover_only') return off('browse_only', HUB_COPY.browseOnly)
  if (config.hub_link === 'untrusted' || code === 'hub_untrusted') return off('untrusted', HUB_COPY.untrusted)

  const closed = t?.closed_reason
    ?? (code !== null && LIVE_CLOSE_CODES.has(code) ? closedReasonOf(i.lastError ?? null) ?? code : null)
  if (closed !== null) {
    return off('closed', closedBanner(closed, n, t?.closed_at ?? null, nowMs), {
      closedReason: closed,
      canStartNew: closed === 'conversation_closed' && t?.listed !== false && live?.listed !== false,
    })
  }
  if (t?.listed === false || live?.listed === false) return off('unlisted', HUB_COPY.unlisted(n))

  if (hubLinkPausesSending(config) || code === 'hub_unreachable') {
    const last = code === 'hub_unreachable' ? lastConnectedOf(i.lastError ?? null) ?? config.last_connected_at : config.last_connected_at
    return off('unreachable', HUB_COPY.unreachable(last))
  }
  if (i.rateLimitedUntil && i.rateLimitedUntil > nowMs) {
    const s = Math.ceil((i.rateLimitedUntil - nowMs) / 1000)
    return off('rate_limited', HUB_COPY.rateLimited(n, s), { waitSeconds: s })
  }
  if (live?.accepting_messages === false) return off('not_accepting', HUB_COPY.notAccepting(n))

  const notice = live?.needs_approval ? HUB_COPY.needsApproval(n) : null
  if (live && !live.deployment_connected) return { enabled: true, confirm: 'deployment_offline', notice }
  if (live && !live.agent_online) return { enabled: true, confirm: 'agent_offline', notice }
  return { enabled: true, confirm: null, notice }
}

/** The confirm sentence for an offline warning. */
export function offlineConfirmText(w: SendWarning, n: HubThreadNames): string {
  return w === 'deployment_offline' ? HUB_COPY.deploymentOffline(n) : HUB_COPY.agentOffline(n)
}

// ── attachments ───────────────────────────────────────────────────────────

/** "12.4 MB", "820 KB", "512 bytes". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

export interface PayloadProblem {
  limit: 'file' | 'files' | 'envelope' | 'text'
  text: string
  /** The file to mark, when one file is the problem. */
  fileName?: string
}

type Limits = Pick<HubConfig, 'max_file_bytes' | 'max_files' | 'max_envelope_bytes' | 'max_text_bytes'>

export function limitsSentence(c: Limits): string {
  return `Remove a file to send. Up to ${c.max_files} files, ${formatBytes(c.max_file_bytes)} each, ` +
    `${formatBytes(c.max_envelope_bytes)} total.`
}

/** Checked before upload against the server's limits from /api/hub/config. */
export function checkHubPayload(text: string, files: { name: string; size: number }[], c: Limits): PayloadProblem | null {
  if (new TextEncoder().encode(text).length > c.max_text_bytes) {
    return { limit: 'text', text: `The message is too long for other servers (up to ${formatBytes(c.max_text_bytes)}).` }
  }
  if (files.length > c.max_files) {
    return { limit: 'files', text: `Too many files for other servers. ${limitsSentence(c)}` }
  }
  const big = files.find((f) => f.size > c.max_file_bytes)
  if (big) {
    return {
      limit: 'file', fileName: big.name,
      text: `${big.name} ${formatBytes(big.size)} — over the ${formatBytes(c.max_file_bytes)} limit for other servers. ${limitsSentence(c)}`,
    }
  }
  const total = files.reduce((s, f) => s + f.size, 0)
  if (total > c.max_envelope_bytes) {
    return { limit: 'envelope', text: `The files add up to ${formatBytes(total)}. ${limitsSentence(c)}` }
  }
  return null
}

/** The server's 413 answer, as a sentence and the file it names. */
export function payloadTooLargeLine(p: PayloadTooLarge): { text: string; fileId?: string } {
  const fileId = p.file_id ?? undefined
  switch (p.limit) {
    case 'file':
      return { text: `A file is ${formatBytes(p.actual)} — over the ${formatBytes(p.max)} limit for other servers.`, fileId }
    case 'files':
      return { text: `Too many files: ${p.actual}. Up to ${p.max} can go to other servers.`, fileId }
    case 'envelope':
      return { text: `The files add up to ${formatBytes(p.actual)} — over the ${formatBytes(p.max)} total for other servers.`, fileId }
    case 'text':
      return { text: `The message is too long for other servers (up to ${formatBytes(p.max)}).`, fileId }
    default:
      return { text: 'The message is too large for other servers.', fileId }
  }
}

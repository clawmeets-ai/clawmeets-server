import type { OutboxItem } from '../api/endpoints/channels'

/**
 * Words for channel threads in the Front Desk sidebar and the thread view, and
 * the rule that turns a message's outbox rows into the one line the owner sees
 * under it. Kept apart from the components so every sentence the owner reads
 * about a channel is in one file.
 */

export const CHANNEL_ORDER = ['telegram', 'email', 'line', 'whatsapp', 'webchat', 'hub'] as const

const CHANNEL_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  email: 'Email',
  line: 'LINE',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
  hub: 'Hub',
}

/** Who sends for each channel: the name the provider's own words are quoted under. */
const PROVIDER_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  email: 'SendGrid',
  line: 'LINE',
  whatsapp: 'Meta',
}

/** "Telegram", "Email", "LINE", "WhatsApp", "Web chat", "Hub"; an unknown channel from a newer
 *  server keeps its own name rather than borrowing another's. */
export function channelName(channel: string): string {
  return CHANNEL_NAMES[channel] ?? channel
}

export const UNNAMED_CONTACT = 'Unnamed contact'

/** The contact as the owner sees them: their name, or a fixed fallback.
 *  Never the room name, never an identifier. */
export function contactLabel(name: string, channel: string): string {
  return name.trim() ? name : `${UNNAMED_CONTACT} (${channelName(channel)})`
}

export const THREAD_COPY = {
  allTab: 'All',
  emptyTab: (channel: string) => `No ${channelName(channel)} conversations yet`,
  removedGroup: 'No longer connected',
  offGroup: 'Channel conversations (channels are off)',
  loadingGroup: 'Loading conversations…',
  errorGroup: "Couldn't load channel details",
  disabled: 'Disabled',
  paused: 'Paused',
  via: (channel: string, contact: string) => `via ${channelName(channel)} · ${contact}`,
  pause: 'Take over',
  resume: 'Hand back to the agent',
  pauseState: (paused: boolean) => (paused ? 'Paused: yes' : 'Paused: no'),
  pauseNote: 'A reply already on its way may still be delivered.',
  pausedBanner: (contact: string, channel: string) =>
    `You've taken over. ${contact} still sees this conversation on ${channelName(channel)}; ` +
    "the agent won't answer. What you type is sent to them.",
  resumeNote: (contact: string) =>
    `The agent answers ${contact}'s next message. Messages from while you were in charge stay in the conversation for context.`,
  sendLabel: (channel: string) => `Send on ${channelName(channel)}`,
  placeholder: (channel: string, contact: string) =>
    `Write to ${contact} — sent on ${channelName(channel)}`,
  unpausedNote: (channel: string) =>
    `What you type here is sent on ${channelName(channel)}, and the agent also reads it and may answer.`,
  windowClosed: (contact: string) => `WhatsApp won't deliver this until ${contact} writes again.`,
  disabledNote: (channel: string) =>
    `${channelName(channel)} is disabled for this agent. Your message will wait and be sent when you enable it again.`,
  removedNote: (channel: string) =>
    `This conversation is no longer connected to ${channelName(channel)}. What you type here stays in ClawMeets.`,
  offNote: 'Channels are switched off on this server; nothing you type is sent.',
  forbidden: 'Only the owner of this conversation can do that',
  gone: "This conversation can't be paused any more: it is no longer connected, or channels are off.",
  failed: "Couldn't change that. Try again.",
} as const

// ── delivery status under each outgoing message ─────────────────────────

/** How the owner reads one outgoing message's delivery. `tone` picks the colour. */
export interface DeliveryLine {
  text: string
  tone: 'quiet' | 'pending' | 'warn' | 'held'
  /** True when the message didn't reach the contact and won't be retried:
   *  the owner gets a Copy text button for their own post. */
  notDelivered: boolean
  /** When it wasn't delivered and the provider explained why, its own words
   *  quoted (`SendGrid said: "…"`). Render as text, after `text`. */
  providerSaid?: string
}

/** Reasons the owner can act on, in words. Reasons are codes, not copy: an
 *  unknown one reads as plain "Not delivered". */
const FAILED_REASONS: Record<string, string> = {
  token_rejected: 'the connection was refused by the provider',
  connection_removed: 'the connection was removed',
  earlier_part_failed: 'an earlier part was not delivered',
  format_error: "it couldn't be converted for this channel",
  reply_limit_reached: 'too many replies in an hour',
  blocked_by_user: 'the person has blocked the bot',
  retries_exhausted: 'gave up after retries',
  number_not_registered: "this number isn't on WhatsApp",
  push_not_allowed: "LINE doesn't allow messages to this person",
  quota_exhausted: 'the monthly message limit was reached',
}

export const DELIVERY_COPY = {
  sending: (channel: string) => `Sending on ${channelName(channel)}…`,
  waitingDisabled: 'Waiting: connection disabled',
  sent: 'Sent',
  notDelivered: 'Not delivered',
  notDeliveredBecause: (why: string) => `Not delivered: ${why}`,
  providerSaid: (channel: string, detail: string) =>
    `${PROVIDER_NAMES[channel] ?? channelName(channel)} said: "${detail}"`,
  gaveUp: 'Not delivered (gave up after retries)',
  maybe: 'May have been delivered',
  heldPaused: 'Held: you had paused the agent. Not sent.',
  heldWindow: "Held: WhatsApp's 24-hour window had closed. Not sent.",
  part: (n: number, of: number) => ` (part ${n} of ${of})`,
  copy: 'Copy text',
  copied: 'Copied',
} as const

/** Worst first: the line shown for a message is its worst part's. */
function rank(row: OutboxItem): number {
  if (row.state === 'failed') return 0
  if (row.state === 'expired' && row.reason !== 'expired_maybe_sent') return 1
  if (row.state === 'held_paused') return 2
  if (row.state === 'held_window' && row.reason !== 'window_closed_maybe_sent') return 3
  if (row.state === 'held_window' || row.state === 'expired') return 4
  if (row.state === 'pending' || row.state === 'sending') return 5
  if (row.state === 'sent') return 7
  return 6 // a state from a newer server: not "sent"
}

/**
 * The line under one outgoing message, from its outbox rows (one per part).
 * `rows` empty means the outbox hasn't picked the message up yet.
 */
export function deliveryLine(
  rows: OutboxItem[], channel: string, { connectionEnabled = true }: { connectionEnabled?: boolean } = {},
): DeliveryLine {
  if (rows.length === 0) return { text: DELIVERY_COPY.sending(channel), tone: 'pending', notDelivered: false }
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || a.part_index - b.part_index)
  const worst = sorted[0]
  const parts = new Set(rows.map((r) => r.part_index)).size
  const part = parts > 1 && rank(worst) < 7 && rows.some((r) => r.state === 'sent')
    ? DELIVERY_COPY.part(worst.part_index + 1, parts)
    : ''
  const said = worst.detail ? { providerSaid: DELIVERY_COPY.providerSaid(channel, worst.detail) } : {}
  switch (rank(worst)) {
    case 0: {
      const why = worst.reason ? FAILED_REASONS[worst.reason] : undefined
      const text = why ? DELIVERY_COPY.notDeliveredBecause(why) : DELIVERY_COPY.notDelivered
      return { text: text + part, tone: 'warn', notDelivered: true, ...said }
    }
    case 1:
      return { text: DELIVERY_COPY.gaveUp + part, tone: 'warn', notDelivered: true, ...said }
    case 2:
      return { text: DELIVERY_COPY.heldPaused + part, tone: 'held', notDelivered: true }
    case 3:
      return { text: DELIVERY_COPY.heldWindow + part, tone: 'held', notDelivered: true }
    case 4:
      return { text: DELIVERY_COPY.maybe + part, tone: 'warn', notDelivered: false }
    case 5:
      return connectionEnabled
        ? { text: DELIVERY_COPY.sending(channel) + part, tone: 'pending', notDelivered: false }
        : { text: DELIVERY_COPY.waitingDisabled + part, tone: 'pending', notDelivered: false }
    case 7:
      return { text: DELIVERY_COPY.sent, tone: 'quiet', notDelivered: false }
    default:
      return { text: DELIVERY_COPY.notDelivered + part, tone: 'warn', notDelivered: true }
  }
}

/** Whether anything in the outbox may still change on its own (poll while so). */
export function outboxInFlight(rows: OutboxItem[]): boolean {
  return rows.some((r) => r.state === 'pending' || r.state === 'sending')
}

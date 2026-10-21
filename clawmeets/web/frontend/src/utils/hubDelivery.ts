import type { Delivery } from '../api/endpoints/hub'
import { formatHubTime } from './hubDisplay'

/**
 * The one line under each message a user sent to an agent on another server,
 * and the rule that merges delivery updates. Every sentence is the approved
 * copy (Public tab plan, revision 4.2). An unknown state, reason or detail
 * from a newer server falls to a generic line and is never shown raw.
 */

export type HubDeliveryTone = 'quiet' | 'pending' | 'held' | 'warn' | 'amber'

export interface HubDeliveryLine {
  text: string
  tone: HubDeliveryTone
  /** A failed message offers "Copy text" so the user can send it elsewhere. */
  copyable: boolean
}

export interface DeliveryNames {
  /** The remote agent's name (already safe text). */
  name: string
  /** The remote server's name (already safe text). */
  deploymentName: string
}

/** Before any delivery row arrives, the line reads "Sending…" for this long. */
export const SENDING_FRESH_MS = 2 * 60 * 1000

/** The server's flag is the only source of truth: no inference from expires_at. */
export function isDeliveredLate(d: Delivery): boolean {
  return d.state === 'delivered' && d.delivered_late
}

const until = (s: number | null) => (s !== null ? ` (until ${formatHubTime(s)})` : '')
const tryAfter = (s: number | null) => (s !== null ? ` Try again after ${formatHubTime(s)}.` : '')

function failedText(d: Delivery, { name, deploymentName: dep }: DeliveryNames): string {
  switch (d.failed_reason) {
    case 'expired_72h':
      return `Not delivered: ${dep} stayed offline for 72 hours`
    case 'held_expired':
      return d.held_for_approval
        ? `Not delivered: ${name}'s owner didn't accept you within 7 days.`
        : `Not delivered: ${name} didn't come back online within 7 days`
    case 'not_accepting':
      switch (d.detail) {
        case 'daily_cap':
          return `Not delivered: ${name} isn't taking new messages right now.${tryAfter(d.retry_at)}`
        case 'requests_full':
          return `Not delivered: ${name}'s owner has too many requests waiting right now.` +
            (d.retry_at !== null ? tryAfter(d.retry_at) : ' Try again later.')
        case 'channel_off':
          return `Not delivered: ${name}'s owner has turned off hub messages`
        default:
          return `Not delivered: ${dep} isn't accepting hub messages right now.${tryAfter(d.retry_at)}`
      }
    case 'blocked_by_target':
      return "Not delivered: the agent's owner isn't accepting messages from you"
    case 'agent_unlisted':
      return 'Not delivered: the agent is no longer listed'
    case 'key_revoked':
      return `Not confirmed: a hub key was revoked before ${dep} confirmed this message. It may have been delivered.`
    case 'too_large':
      return 'Not delivered: the message or file is too large'
    case 'rejected_by_hub':
      return 'Not delivered: the hub refused it'
    case 'retries_exhausted':
      return 'Not delivered (gave up after retries)'
    case 'sender_untrusted':
      return `Not delivered: ${dep} couldn't verify this server's signature`
    default:
      return 'Not delivered'
  }
}

/** The line for one delivery row, for every state × reason × detail. */
export function deliveryLine(d: Delivery, names: DeliveryNames): HubDeliveryLine {
  switch (d.state) {
    case 'sent_to_hub':
      return { text: 'Sent to hub', tone: 'quiet', copyable: false }
    case 'waiting_for_target': {
      switch (d.waiting_reason) {
        case 'agent_offline':
          return {
            text: `Waiting: ${names.name} is offline — ${names.deploymentName} holds it${until(d.expires_at)}`,
            tone: 'pending', copyable: false,
          }
        case 'isolation_unavailable':
          return {
            text: `Waiting: ${names.name}'s computer can't take this conversation safely yet — its owner has been notified${until(d.expires_at)}`,
            tone: 'pending', copyable: false,
          }
        case 'deployment_offline':
          return {
            text: `Waiting: ${names.deploymentName} is offline — trying until ${formatHubTime(d.expires_at)}`,
            tone: 'pending', copyable: false,
          }
        case 'hub_unreachable':
          // Also rows waiting because this server switched to browse-only.
          return { text: `Waiting: can't reach the hub — retrying${until(d.expires_at)}`, tone: 'pending', copyable: false }
        default:
          return { text: 'Waiting', tone: 'pending', copyable: false }
      }
    }
    case 'delivered':
      if (isDeliveredLate(d)) return { text: 'Delivered late', tone: 'quiet', copyable: false }
      if (d.held_for_approval) {
        return { text: 'Delivered — waiting for the owner to accept you', tone: 'held', copyable: false }
      }
      return { text: 'Delivered', tone: 'quiet', copyable: false }
    case 'failed':
      return {
        text: failedText(d, names),
        tone: d.failed_reason === 'key_revoked' ? 'amber' : 'warn',
        copyable: true,
      }
    default:
      return { text: 'Status unknown', tone: 'quiet', copyable: false }
  }
}

const FINAL = new Set(['delivered', 'failed'])

/**
 * Merge a pushed or polled row into the stored one. A newer (or equal)
 * state_at replaces it; an older one is ignored. Once final, the only move
 * allowed to another final state is failed → delivered ("Delivered late").
 */
export function mergeDelivery(prev: Delivery | undefined, next: Delivery): Delivery {
  if (!prev) return next
  if (next.state_at < prev.state_at) return prev
  if (FINAL.has(prev.state) && next.state !== prev.state) {
    return prev.state === 'failed' && next.state === 'delivered' ? next : prev
  }
  return next
}

import { describe, expect, it } from 'vitest'
import { deliveryLine, isDeliveredLate, mergeDelivery } from './hubDelivery'
import { formatHubTime } from './hubDisplay'
import { NOW_S, delivery } from '../test/hubFixtures'

const names = { name: 'scout', deploymentName: 'acme.dev' }
const at = (s: number) => formatHubTime(s)
const EXP = NOW_S + 72 * 3600
const RETRY = NOW_S + 3600

describe('deliveryLine: every state × reason × detail', () => {
  const rows: [string, Parameters<typeof delivery>[0], string, string, boolean][] = [
    ['sent_to_hub', { state: 'sent_to_hub' }, 'Sent to hub', 'quiet', false],
    ['waiting agent_offline', { state: 'waiting_for_target', waiting_reason: 'agent_offline' },
      `Waiting: scout is offline — acme.dev holds it (until ${at(EXP)})`, 'pending', false],
    ['waiting isolation_unavailable', { state: 'waiting_for_target', waiting_reason: 'isolation_unavailable' },
      `Waiting: scout's computer can't take this conversation safely yet — its owner has been notified (until ${at(EXP)})`, 'pending', false],
    ['waiting deployment_offline', { state: 'waiting_for_target', waiting_reason: 'deployment_offline' },
      `Waiting: acme.dev is offline — trying until ${at(EXP)}`, 'pending', false],
    ['waiting hub_unreachable', { state: 'waiting_for_target', waiting_reason: 'hub_unreachable' },
      `Waiting: can't reach the hub — retrying (until ${at(EXP)})`, 'pending', false],
    ['waiting unknown reason', { state: 'waiting_for_target', waiting_reason: 'surprise' }, 'Waiting', 'pending', false],
    ['delivered', { state: 'delivered' }, 'Delivered', 'quiet', false],
    ['delivered held', { state: 'delivered', held_for_approval: true },
      'Delivered — waiting for the owner to accept you', 'held', false],
    ['delivered late', { state: 'delivered', delivered_late: true }, 'Delivered late', 'quiet', false],
    ['expired_72h', { state: 'failed', failed_reason: 'expired_72h' },
      'Not delivered: acme.dev stayed offline for 72 hours', 'warn', true],
    ['held_expired, held for approval', { state: 'failed', failed_reason: 'held_expired', held_for_approval: true },
      "Not delivered: scout's owner didn't accept you within 7 days.", 'warn', true],
    ['held_expired, offline', { state: 'failed', failed_reason: 'held_expired' },
      "Not delivered: scout didn't come back online within 7 days", 'warn', true],
    ['not_accepting daily_cap + retry', { state: 'failed', failed_reason: 'not_accepting', detail: 'daily_cap', retry_at: RETRY },
      `Not delivered: scout isn't taking new messages right now. Try again after ${at(RETRY)}.`, 'warn', true],
    ['not_accepting daily_cap', { state: 'failed', failed_reason: 'not_accepting', detail: 'daily_cap' },
      "Not delivered: scout isn't taking new messages right now.", 'warn', true],
    ['not_accepting requests_full + retry', { state: 'failed', failed_reason: 'not_accepting', detail: 'requests_full', retry_at: RETRY },
      `Not delivered: scout's owner has too many requests waiting right now. Try again after ${at(RETRY)}.`, 'warn', true],
    ['not_accepting requests_full', { state: 'failed', failed_reason: 'not_accepting', detail: 'requests_full' },
      "Not delivered: scout's owner has too many requests waiting right now. Try again later.", 'warn', true],
    ['not_accepting channel_off', { state: 'failed', failed_reason: 'not_accepting', detail: 'channel_off' },
      "Not delivered: scout's owner has turned off hub messages", 'warn', true],
    ['not_accepting browse_only', { state: 'failed', failed_reason: 'not_accepting', detail: 'browse_only' },
      "Not delivered: acme.dev isn't accepting hub messages right now.", 'warn', true],
    ['not_accepting unknown detail is never shown raw', { state: 'failed', failed_reason: 'not_accepting', detail: '<b>x</b>' },
      "Not delivered: acme.dev isn't accepting hub messages right now.", 'warn', true],
    ['not_accepting no detail', { state: 'failed', failed_reason: 'not_accepting' },
      "Not delivered: acme.dev isn't accepting hub messages right now.", 'warn', true],
    ['blocked_by_target', { state: 'failed', failed_reason: 'blocked_by_target' },
      "Not delivered: the agent's owner isn't accepting messages from you", 'warn', true],
    ['agent_unlisted', { state: 'failed', failed_reason: 'agent_unlisted' },
      'Not delivered: the agent is no longer listed', 'warn', true],
    ['key_revoked', { state: 'failed', failed_reason: 'key_revoked' },
      'Not confirmed: a hub key was revoked before acme.dev confirmed this message. It may have been delivered.', 'amber', true],
    ['too_large', { state: 'failed', failed_reason: 'too_large' }, 'Not delivered: the message or file is too large', 'warn', true],
    ['rejected_by_hub', { state: 'failed', failed_reason: 'rejected_by_hub' }, 'Not delivered: the hub refused it', 'warn', true],
    ['retries_exhausted', { state: 'failed', failed_reason: 'retries_exhausted' }, 'Not delivered (gave up after retries)', 'warn', true],
    ['sender_untrusted', { state: 'failed', failed_reason: 'sender_untrusted' },
      "Not delivered: acme.dev couldn't verify this server's signature", 'warn', true],
    ['unknown failed reason', { state: 'failed', failed_reason: 'brand_new' }, 'Not delivered', 'warn', true],
    ['unknown state', { state: 'teleported' }, 'Status unknown', 'quiet', false],
  ]

  it.each(rows)('%s', (_label, over, text, tone, copyable) => {
    expect(deliveryLine(delivery(over), names)).toEqual({ text, tone, copyable })
  })
})

describe('isDeliveredLate', () => {
  it('reads the server flag only', () => {
    expect(isDeliveredLate(delivery({ state: 'delivered', delivered_late: true }))).toBe(true)
    // state_at after expires_at is NOT inferred as late
    expect(isDeliveredLate(delivery({ state: 'delivered', state_at: EXP + 10 }))).toBe(false)
    expect(isDeliveredLate(delivery({ state: 'failed', delivered_late: true }))).toBe(false)
  })
})

describe('mergeDelivery', () => {
  it('takes the first row', () => {
    const d = delivery()
    expect(mergeDelivery(undefined, d)).toBe(d)
  })
  it('a newer state_at wins, an older one is ignored', () => {
    const a = delivery({ state: 'sent_to_hub', state_at: 10 })
    const b = delivery({ state: 'waiting_for_target', waiting_reason: 'agent_offline', state_at: 20 })
    expect(mergeDelivery(a, b)).toBe(b)
    expect(mergeDelivery(b, a)).toBe(b)
  })
  it('a final state does not go back to pending', () => {
    const done = delivery({ state: 'delivered', state_at: 10 })
    expect(mergeDelivery(done, delivery({ state: 'waiting_for_target', state_at: 20 }))).toBe(done)
  })
  it('failed → delivered is the one final-to-final move', () => {
    const failed = delivery({ state: 'failed', failed_reason: 'expired_72h', state_at: 10 })
    const late = delivery({ state: 'delivered', delivered_late: true, state_at: 20 })
    expect(mergeDelivery(failed, late)).toBe(late)
    const delivered = delivery({ state: 'delivered', state_at: 10 })
    expect(mergeDelivery(delivered, delivery({ state: 'failed', state_at: 20 }))).toBe(delivered)
  })
  it('the same final state with a newer row replaces it (held → accepted)', () => {
    const held = delivery({ state: 'delivered', held_for_approval: true, state_at: 10 })
    const accepted = delivery({ state: 'delivered', held_for_approval: false, state_at: 20 })
    expect(mergeDelivery(held, accepted)).toBe(accepted)
  })
})

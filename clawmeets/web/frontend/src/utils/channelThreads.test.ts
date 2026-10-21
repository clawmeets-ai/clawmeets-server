import { describe, expect, it } from 'vitest'
import type { OutboxItem } from '../api/endpoints/channels'
import { DELIVERY_COPY, channelName, contactLabel, deliveryLine, outboxInFlight } from './channelThreads'

/**
 * One case per row of the delivery-status table: what the owner reads under
 * an outgoing message for each outbox state. Each uses the real `OutboxItem`
 * shape the server answers with.
 */

function row(state: string, reason: string | null = null, part_index = 0): OutboxItem {
  return { message_id: 'm1', part_index, state, reason, attempts: 1 }
}

const line = (rows: OutboxItem[], opts?: { connectionEnabled?: boolean }) => deliveryLine(rows, 'telegram', opts)

describe('deliveryLine — one case per outbox state', () => {
  it('no rows yet: sending', () => {
    expect(line([])).toMatchObject({ text: 'Sending on Telegram…', notDelivered: false })
  })
  it('pending: sending', () => {
    expect(line([row('pending')]).text).toBe('Sending on Telegram…')
  })
  it('sending: sending', () => {
    expect(line([row('sending')]).text).toBe('Sending on Telegram…')
  })
  it('pending on a disabled connection: waiting', () => {
    expect(line([row('pending')], { connectionEnabled: false }).text).toBe(DELIVERY_COPY.waitingDisabled)
  })
  it('all sent: a quiet "Sent"', () => {
    expect(line([row('sent'), row('sent', null, 1)])).toEqual({ text: 'Sent', tone: 'quiet', notDelivered: false })
  })
  it.each([
    ['token_rejected', 'Not delivered: the connection was refused by the provider'],
    ['connection_removed', 'Not delivered: the connection was removed'],
    ['earlier_part_failed', 'Not delivered: an earlier part was not delivered'],
    ['format_error', "Not delivered: it couldn't be converted for this channel"],
    ['reply_limit_reached', 'Not delivered: too many replies in an hour'],
    ['blocked_by_user', 'Not delivered: the person has blocked the bot'],
  ])('failed / %s: "%s"', (reason, text) => {
    expect(line([row('failed', reason)])).toEqual({ text, tone: 'warn', notDelivered: true })
  })
  it('failed with an unknown reason code: plain "Not delivered", never the raw code', () => {
    const l = line([row('failed', 'some_new_code_xyz')])
    expect(l.text).toBe('Not delivered')
    expect(l.text).not.toContain('some_new_code_xyz')
  })
  it('expired / expired_never_sent: gave up', () => {
    expect(line([row('expired', 'expired_never_sent')])).toMatchObject({ text: DELIVERY_COPY.gaveUp, notDelivered: true })
  })
  it('expired / thread_deleted: gave up (never sent)', () => {
    expect(line([row('expired', 'thread_deleted')]).text).toBe(DELIVERY_COPY.gaveUp)
  })
  it('expired / expired_maybe_sent: may have been delivered', () => {
    expect(line([row('expired', 'expired_maybe_sent')])).toMatchObject({ text: DELIVERY_COPY.maybe, notDelivered: false })
  })
  it('held_paused: held because you had paused the agent', () => {
    expect(line([row('held_paused', 'paused')])).toEqual({ text: DELIVERY_COPY.heldPaused, tone: 'held', notDelivered: true })
  })
  it("held_window / window_closed: held because WhatsApp's window had closed", () => {
    expect(line([row('held_window', 'window_closed')])).toMatchObject({ text: DELIVERY_COPY.heldWindow, notDelivered: true })
  })
  it('held_window / window_closed_maybe_sent: may have been delivered', () => {
    expect(line([row('held_window', 'window_closed_maybe_sent')])).toMatchObject({ text: DELIVERY_COPY.maybe, notDelivered: false })
  })
  it('a state from a newer server is never "Sent"', () => {
    expect(line([row('quarantined')]).text).toBe('Not delivered')
  })
  it('a mix of parts: the worst part, and which part', () => {
    expect(line([row('sent', null, 0), row('failed', 'token_rejected', 1), row('failed', 'earlier_part_failed', 2)]).text)
      .toBe('Not delivered: the connection was refused by the provider (part 2 of 3)')
    expect(line([row('sent', null, 0), row('pending', null, 1)]).text).toBe('Sending on Telegram… (part 2 of 2)')
  })
})

describe("deliveryLine — the provider's own words", () => {
  const said = 'The from address does not match a verified Sender Identity.'
  it('a failed row with detail quotes it under the channel\'s provider', () => {
    const failed = { ...row('failed', 'sender_not_authorized'), detail: said }
    expect(deliveryLine([failed], 'email')).toMatchObject({
      text: 'Not delivered', notDelivered: true, providerSaid: `SendGrid said: "${said}"`,
    })
    expect(deliveryLine([failed], 'telegram').providerSaid).toBe(`Telegram said: "${said}"`)
    expect(deliveryLine([failed], 'line').providerSaid).toBe(`LINE said: "${said}"`)
    expect(deliveryLine([failed], 'whatsapp').providerSaid).toBe(`Meta said: "${said}"`)
  })
  it('expired never sent with detail quotes it too', () => {
    expect(deliveryLine([{ ...row('expired', 'expired_never_sent'), detail: 'busy' }], 'email').providerSaid)
      .toBe('SendGrid said: "busy"')
  })
  it('no detail, or a line that is not "not delivered": nothing quoted', () => {
    expect(deliveryLine([row('failed', 'token_rejected')], 'email').providerSaid).toBeUndefined()
    expect(deliveryLine([{ ...row('pending'), detail: 'busy' }], 'email').providerSaid).toBeUndefined()
    expect(deliveryLine([{ ...row('sent'), detail: 'old' }], 'email').providerSaid).toBeUndefined()
  })
})

describe('the rest', () => {
  it('outboxInFlight: only pending or sending', () => {
    expect(outboxInFlight([row('sent'), row('pending')])).toBe(true)
    expect(outboxInFlight([row('sent'), row('held_paused'), row('failed')])).toBe(false)
  })
  it('channel names and the unnamed fallback', () => {
    expect(['telegram', 'email', 'line', 'whatsapp'].map(channelName)).toEqual(['Telegram', 'Email', 'LINE', 'WhatsApp'])
    expect(contactLabel('', 'line')).toBe('Unnamed contact (LINE)')
    expect(contactLabel('  ', 'email')).toBe('Unnamed contact (Email)')
    expect(contactLabel('Ana', 'email')).toBe('Ana')
  })
})

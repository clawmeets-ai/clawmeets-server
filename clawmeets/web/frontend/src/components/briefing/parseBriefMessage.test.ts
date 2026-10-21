import { describe, expect, it } from 'vitest'
import {
  BRIEF_MESSAGE_SOURCE,
  MAX_FRAME_PX,
  MIN_FRAME_PX,
  parseBriefMessage,
} from './heightBootstrap'

/**
 * THE ENVELOPE VALIDATOR.
 *
 * The frame runs on an opaque origin, so `event.origin` is the literal string
 * "null" for it and for every other opaque frame on the page. An origin check
 * here would not be a weak check — it would be one that LOOKS like a check and
 * validates nothing. Authentication is `event.source === contentWindow`, made
 * by the caller; this function's job is only "what does the payload mean", and
 * these tests pin the cases where a wrong answer is expensive.
 */

const envelope = (over: Record<string, unknown> = {}) => ({
  source: BRIEF_MESSAGE_SOURCE,
  v: 1,
  type: 'height',
  slug: 'wine',
  height: 400,
  ...over,
})

describe('parseBriefMessage — what is accepted', () => {
  it('accepts a well-formed height envelope', () => {
    expect(parseBriefMessage(envelope(), 'wine')).toEqual({
      source: BRIEF_MESSAGE_SOURCE,
      v: 1,
      type: 'height',
      slug: 'wine',
      height: 400,
    })
  })

  it('accepts ready / error / remeasure without a height', () => {
    for (const type of ['ready', 'error', 'remeasure']) {
      const parsed = parseBriefMessage(envelope({ type, height: undefined }), 'wine')
      expect(parsed?.type).toBe(type)
      expect(parsed?.height).toBeUndefined()
    }
  })
})

describe('parseBriefMessage — what is rejected', () => {
  it("rejects source: 'clawmeets-briefing'", () => {
    // The literal backend first proposed. Accepting both would leave the app
    // with two contracts and this one silently half-working.
    expect(parseBriefMessage(envelope({ source: 'clawmeets-briefing' }), 'wine')).toBeNull()
  })

  it('rejects a wrong version, a wrong slug, and an unknown type', () => {
    expect(parseBriefMessage(envelope({ v: 2 }), 'wine')).toBeNull()
    // A message from the OTHER briefing's frame must not resize this one.
    expect(parseBriefMessage(envelope({ slug: 'cheese' }), 'wine')).toBeNull()
    expect(parseBriefMessage(envelope({ type: 'resize' }), 'wine')).toBeNull()
  })

  it('rejects non-finite and out-of-range heights', () => {
    // Not tidiness: a bad height is not a rendering bug, it is a 2,000,000px
    // iframe that hangs the desk.
    for (const height of [NaN, Infinity, -Infinity, -1, 0, MIN_FRAME_PX - 1, 10_000_000]) {
      expect(parseBriefMessage(envelope({ height }), 'wine')).toBeNull()
    }
    expect(parseBriefMessage(envelope({ height: '400' }), 'wine')).toBeNull()
    expect(parseBriefMessage(envelope({ height: undefined }), 'wine')).toBeNull()
  })

  it('accepts the bounds themselves', () => {
    expect(parseBriefMessage(envelope({ height: MIN_FRAME_PX }), 'wine')?.height).toBe(MIN_FRAME_PX)
    expect(parseBriefMessage(envelope({ height: MAX_FRAME_PX }), 'wine')?.height).toBe(MAX_FRAME_PX)
  })

  it('rounds a fractional height up, and rejects one that rounds out of range', () => {
    expect(parseBriefMessage(envelope({ height: 400.2 }), 'wine')?.height).toBe(401)
    expect(parseBriefMessage(envelope({ height: MAX_FRAME_PX + 0.1 }), 'wine')).toBeNull()
  })

  it('rejects payloads that are not plain objects', () => {
    // Anything on the page can postMessage. A string, a null or an array
    // reaching this function must not become a resize.
    for (const data of ['clawmeets-brief', null, undefined, 42, [envelope()]]) {
      expect(parseBriefMessage(data, 'wine')).toBeNull()
    }
  })
})

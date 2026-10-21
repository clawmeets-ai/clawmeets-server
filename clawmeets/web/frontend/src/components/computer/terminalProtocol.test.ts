import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACK_FLUSH_BYTES,
  ACK_FLUSH_MS,
  AckAccumulator,
  TERM_INPUT_MAX_BYTES,
  base64ToBytes,
  binaryInputFrames,
  bytesToBase64,
  inputFrames,
  parseServerFrame,
  textInputFrames,
} from './terminalProtocol'

/**
 * The three wire rules a session dies without: output is acknowledged (the
 * machine stops at 256 KB unacked), no input frame exceeds 16 KB, and bytes
 * survive the base64 round trip exactly — including ones that are not UTF-8.
 */

afterEach(() => {
  vi.useRealTimers()
})

function decodeInput(frames: ReturnType<typeof inputFrames>): Uint8Array[] {
  return frames.map((f) => {
    if (!('type' in f) || f.type !== 'term_input') throw new Error('not an input frame')
    return base64ToBytes(f.data_b64)
  })
}

describe('base64 <-> bytes', () => {
  it('round-trips every byte value, including invalid UTF-8', () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('round-trips a buffer larger than one apply() chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) & 0xff)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })
})

describe('input chunking', () => {
  it('sends a keystroke as one frame of its UTF-8 bytes', () => {
    const [bytes] = decodeInput(textInputFrames('é'))
    expect(Array.from(bytes)).toEqual([0xc3, 0xa9])
  })

  it('splits at exactly 16384 bytes and loses nothing', () => {
    const total = TERM_INPUT_MAX_BYTES * 2 + 5
    const bytes = new Uint8Array(total).map((_, i) => i & 0xff)
    const chunks = decodeInput(inputFrames(bytes))
    expect(chunks.map((c) => c.length)).toEqual([TERM_INPUT_MAX_BYTES, TERM_INPUT_MAX_BYTES, 5])
    const joined = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      joined.set(c, at)
      at += c.length
    }
    expect(joined).toEqual(bytes)
  })

  it('a paste of exactly the limit is one frame', () => {
    expect(inputFrames(new Uint8Array(TERM_INPUT_MAX_BYTES))).toHaveLength(1)
  })

  it('counts the limit in bytes, not characters', () => {
    // 10 000 three-byte characters = 30 000 bytes -> two frames.
    expect(textInputFrames('€'.repeat(10_000))).toHaveLength(2)
  })

  it('passes binary input through as raw bytes', () => {
    const [bytes] = decodeInput(binaryInputFrames('\x1b[M\xff'))
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x4d, 0xff])
  })
})

describe('ack accounting', () => {
  it('flushes at the threshold without waiting for the timer', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const acks = new AckAccumulator(flush)
    acks.add(ACK_FLUSH_BYTES - 1)
    expect(flush).not.toHaveBeenCalled()
    acks.add(1)
    expect(flush).toHaveBeenCalledWith(ACK_FLUSH_BYTES)
    vi.advanceTimersByTime(ACK_FLUSH_MS * 2)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('acks a small output promptly, accumulated, on the timer', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const acks = new AckAccumulator(flush)
    acks.add(10)
    acks.add(32)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ACK_FLUSH_MS)
    expect(flush).toHaveBeenCalledWith(42)
    // Nothing pending, nothing re-sent.
    vi.advanceTimersByTime(ACK_FLUSH_MS * 4)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('sends nothing after dispose', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const acks = new AckAccumulator(flush)
    acks.add(100)
    acks.dispose()
    vi.advanceTimersByTime(ACK_FLUSH_MS * 4)
    expect(flush).not.toHaveBeenCalled()
  })
})

describe('server frames', () => {
  it('parses the three frame types', () => {
    expect(parseServerFrame('{"type":"term_opened","ok":false,"detail":"Terminal is off"}')).toEqual({
      type: 'term_opened', ok: false, detail: 'Terminal is off',
    })
    expect(parseServerFrame('{"type":"term_output","data_b64":"aGk="}')).toEqual({
      type: 'term_output', data_b64: 'aGk=',
    })
    expect(parseServerFrame('{"type":"term_exit","code":null,"reason":"Idle for 15 minutes"}')).toEqual({
      type: 'term_exit', code: null, reason: 'Idle for 15 minutes',
    })
  })

  it('ignores what it does not understand rather than throwing', () => {
    expect(parseServerFrame('not json')).toBeNull()
    expect(parseServerFrame('{"type":"term_future"}')).toBeNull()
    expect(parseServerFrame(new ArrayBuffer(2))).toBeNull()
  })
})

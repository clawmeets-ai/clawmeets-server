/**
 * The browser's half of the `/ws/terminal/{computer_id}` wire, as pure helpers.
 *
 * Kept apart from the panel for two reasons: none of it needs xterm (so it is
 * testable without a DOM terminal), and the three rules that keep a session
 * alive — acknowledge what was rendered, never send an oversized input frame,
 * speak only the frame types below — are each one function a test can pin.
 *
 * Frames are JSON text both ways. Terminal bytes travel as base64 because a
 * shell's output is not guaranteed to be valid UTF-8 (a half-written multibyte
 * character at a read boundary, a binary `cat`), and a text frame must be.
 */

/** The machine refuses larger `term_input` frames; bigger pastes are split. */
export const TERM_INPUT_MAX_BYTES = 16384
/** Flush an acknowledgement once this much output has been rendered… */
export const ACK_FLUSH_BYTES = 64 * 1024
/** …or this long after the first unacknowledged byte, whichever comes first.
 *  The machine pauses at 256 KB unacknowledged, so a small prompt must be
 *  acked promptly too or an idle session would slowly starve. */
export const ACK_FLUSH_MS = 50
/** A window drag fires dozens of resizes; the shell needs only the last. */
export const RESIZE_DEBOUNCE_MS = 100
/** Close code for a bad or expired ticket — the same 4001 every socket uses. */
export const CLOSE_BAD_TICKET = 4001

export type TerminalServerFrame =
  | { type: 'term_opened'; ok: boolean; detail: string }
  | { type: 'term_output'; data_b64: string }
  | { type: 'term_exit'; code: number | null; reason: string }

export type TerminalClientFrame =
  | { ticket: string }
  | { type: 'term_input'; data_b64: string }
  | { type: 'term_resize'; cols: number; rows: number }
  | { type: 'term_ack'; bytes: number }
  | { type: 'term_close' }

/** Same origin rule as the app's other sockets (`api/websocket.ts`): the dev
 *  server proxies HTTP but not sockets, so dev goes straight to the backend. */
export function terminalSocketUrl(computerId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = import.meta.env.DEV ? 'localhost:4567' : window.location.host
  return `${protocol}//${host}/ws/terminal/${encodeURIComponent(computerId)}`
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so a 16 KB frame does not blow the argument limit of apply().
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * What the user typed (or pasted), as one or more `term_input` frames.
 *
 * Split on BYTES, not characters, because the limit is on bytes. A split may
 * fall inside a multibyte character; that is fine — the machine writes the
 * frames to the terminal in order, and the terminal reassembles the bytes.
 */
export function inputFrames(bytes: Uint8Array): TerminalClientFrame[] {
  const frames: TerminalClientFrame[] = []
  for (let i = 0; i < bytes.length; i += TERM_INPUT_MAX_BYTES) {
    frames.push({
      type: 'term_input',
      data_b64: bytesToBase64(bytes.subarray(i, i + TERM_INPUT_MAX_BYTES)),
    })
  }
  return frames
}

/** xterm hands typed text as a JS string; the wire wants its UTF-8 bytes. */
export function textInputFrames(text: string): TerminalClientFrame[] {
  return inputFrames(new TextEncoder().encode(text))
}

/** xterm's `onBinary` hands raw bytes as a string of 0–255 code units. */
export function binaryInputFrames(data: string): TerminalClientFrame[] {
  const bytes = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff
  return inputFrames(bytes)
}

/** A server frame, or null for anything this client does not understand —
 *  ignored rather than thrown on, so a newer server can add frame types. */
export function parseServerFrame(raw: unknown): TerminalServerFrame | null {
  if (typeof raw !== 'string') return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const frame = data as Record<string, unknown>
  switch (frame.type) {
    case 'term_opened':
      return { type: 'term_opened', ok: frame.ok === true, detail: String(frame.detail ?? '') }
    case 'term_output':
      return typeof frame.data_b64 === 'string'
        ? { type: 'term_output', data_b64: frame.data_b64 }
        : null
    case 'term_exit':
      return {
        type: 'term_exit',
        code: typeof frame.code === 'number' ? frame.code : null,
        reason: String(frame.reason ?? ''),
      }
    default:
      return null
  }
}

/**
 * Flow-control credit: counts rendered bytes and hands them back in batches.
 *
 * Acking every output frame would double the frame count; acking only at 64 KB
 * would leave a quiet session's last few hundred bytes unacknowledged forever.
 * So: flush at the threshold, or on a short timer started by the first
 * unacknowledged byte — whichever comes first.
 */
export class AckAccumulator {
  private pending = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flush: (bytes: number) => void,
    private readonly thresholdBytes = ACK_FLUSH_BYTES,
    private readonly delayMs = ACK_FLUSH_MS,
  ) {}

  /** Record `n` rendered bytes. */
  add(n: number): void {
    if (n <= 0) return
    this.pending += n
    if (this.pending >= this.thresholdBytes) {
      this.drain()
    } else if (this.timer === null) {
      this.timer = setTimeout(() => this.drain(), this.delayMs)
    }
  }

  /** Send whatever is pending now. */
  drain(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending === 0) return
    const bytes = this.pending
    this.pending = 0
    this.flush(bytes)
  }

  /** Drop pending credit and the timer — the session is over. */
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = 0
  }
}

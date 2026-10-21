/**
 * The client half of the thread-display-name rules.
 *
 * This module is a deliberate MIRROR of `normalize_thread_display_name` +
 * `THREAD_DISPLAY_NAME_MAX_LEN` in `clawmeets/models/project.py`. It exists so
 * the user learns a name is too long while typing it, not from a 400 — but the
 * server stays the authority: it re-normalizes whatever we send and the stored
 * value is the one that comes back in the 200. Nothing here is a security or
 * correctness boundary; it is the same rule, said earlier.
 *
 * Two things it must get exactly right, because a mismatch is user-visible:
 *
 * 1. LENGTH IS CODE POINTS. `[...s].length`, never `s.length`. Python's `len()`
 *    counts code points; JS `.length` counts UTF-16 units. They agree below
 *    U+FFFF and disagree above it — 60 emoji is 60 to the server and 120 to
 *    `.length`, so a `.length` check would reject a name the server accepts.
 * 2. NORMALIZATION MUST PRODUCE THE SERVER'S STRING. We compare the normalized
 *    draft against the current name to decide "unchanged ⇒ send no request".
 *    If our normalizer disagreed with the server's, a no-op rename would look
 *    like a real one (or vice versa).
 */

/**
 * Max length of a thread display name, in Unicode code points, measured after
 * `normalizeThreadName`. Must equal `THREAD_DISPLAY_NAME_MAX_LEN`
 * (`clawmeets/models/project.py`). 60 is the DM auto-titler's own generation
 * cap — storage and generation are deliberately in lockstep, so this number
 * cannot be lowered here alone.
 */
export const THREAD_NAME_MAX_LENGTH = 60

/**
 * How far from the ceiling the soft counter appears. At 60 that puts it on
 * screen from 40 code points, so the limit is visible before it is hit rather
 * than arriving as a rejection. Advisory only — 41..60 is valid and saves.
 */
export const THREAD_NAME_COUNTER_THRESHOLD = 20

export type ThreadNameError = 'empty' | 'too_long'

/**
 * Invisible directional-formatting characters the server strips. ZWJ (U+200D)
 * and VS16 (U+FE0F) are deliberately absent from this set on both sides —
 * stripping them would shatter emoji sequences.
 *
 * Spelled with `\u` escapes on purpose, as the server's set is: a literal copy
 * of these characters would be invisible in this file and in every diff of it.
 * LRM, RLM, then LRE/RLE/PDF/LRO/RLO, then LRI/RLI/FSI/PDI.
 */
const BIDI_OVERRIDES = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * The Cc control characters that Python's `str.isspace()` does NOT treat as
 * whitespace — i.e. exactly the ones the server deletes outright. The
 * whitespace Cc characters (`\t \n \v \f \r \x1c-\x1f \x85`) are deliberately
 * excluded here so they survive to the collapse step below and become a space:
 * deleting them instead would glue the surrounding words together
 * ("Trip\tplan" -> "Tripplan"). This is the same bug the server's plan had and
 * fixed, so the mirror has to reproduce the FIX, not the plan.
 */
const NON_SPACE_CONTROLS = /[\u0000-\u0008\u000e-\u001b\u007f-\u0084\u0086-\u009f]/g

/**
 * A run of whitespace as Python's `str.split()` defines it. Spelled out rather
 * than using `\s` because the two sets are not equal: `\s` includes U+FEFF
 * (which Python does not) and omits U+001C-U+001F and U+0085 (which Python
 * treats as whitespace). Either difference would make our normalized string
 * disagree with the stored one.
 */
const WHITESPACE_RUN = /[\t\n\v\f\r\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g

/**
 * Canonicalize a name into the form the server will store.
 *
 * NFC normalize, drop bidi overrides and non-whitespace controls, collapse
 * every whitespace run to a single space, trim both ends. Interior structure is
 * otherwise preserved. Rewrites silently — a trailing space is not an error,
 * it is normalized away.
 */
export function normalizeThreadName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(BIDI_OVERRIDES, '')
    .replace(NON_SPACE_CONTROLS, '')
    .replace(WHITESPACE_RUN, ' ')
    .replace(/^ | $/g, '')
}

/**
 * Code-point length of the NORMALIZED value — the number the server measures,
 * and therefore the only number worth showing the user. Drives both the counter
 * and the limit check.
 */
export function threadNameLength(raw: string): number {
  return [...normalizeThreadName(raw)].length
}

/**
 * `null` when the value would be accepted. Order matters and matches the
 * server's: empty is checked before length.
 */
export function validateThreadName(raw: string): ThreadNameError | null {
  const normalized = normalizeThreadName(raw)
  if (normalized === '') return 'empty'
  if ([...normalized].length > THREAD_NAME_MAX_LENGTH) return 'too_long'
  return null
}

/**
 * User-facing copy, worded identically to the server's `ValueError` messages
 * (`models/project.py`) so a client-side rejection and the 400 it prevents read
 * the same. Interpolates the constant for the same reason the server does:
 * re-literalling the number is how the two sides drift.
 */
export function threadNameErrorMessage(error: ThreadNameError): string {
  switch (error) {
    case 'empty':
      return 'Thread name cannot be empty.'
    case 'too_long':
      return `Thread name must be ${THREAD_NAME_MAX_LENGTH} characters or fewer.`
  }
}

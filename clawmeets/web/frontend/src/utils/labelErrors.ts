import { ApiError } from '../api/client'

/**
 * The label surface's coded-error parse (contract §9).
 *
 * Every label failure the server raises has `detail = "<code>: <sentence>"`
 * with `code` matching `^labels\.[a-z0-9_]+$` — 18 failure paths, all of them
 * a STRING and never FastAPI's 422 list (the routes read their bodies untyped
 * precisely so that stays true).
 *
 * TWO MECHANICAL DETAILS, both verified rather than assumed:
 *
 *  - `api/client.ts:87-91` already lifts `detail` into `ApiError.message`. So
 *    this parses `err.message`, NOT `err.data`. Reaching into `err.data` for
 *    `detail` works today and breaks the day a route answers with a non-JSON
 *    body, which `throwApiError` also handles.
 *  - THE FALLBACK IS WHY THIS IS A FUNCTION and not a regex at each call site.
 *    Every OTHER error in this codebase is uncoded: a 401 from the refresh
 *    path, a plain 404, a network throw. A client that assumes a code breaks on
 *    the first one of those. No match ⇒ `code: null` and the WHOLE string is
 *    the sentence.
 */

const CODED = /^(labels\.[a-z0-9_]+):\s*(.*)$/s

export interface ParsedLabelError {
  code: string | null
  sentence: string
  /** HTTP status when the throw was an `ApiError`; `null` for anything else
   *  (a network failure, an aborted fetch, a programmer error). */
  status: number | null
}

export function parseLabelError(err: unknown): ParsedLabelError {
  const status = err instanceof ApiError ? err.status : null
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const text = raw.trim()
  if (!text) {
    return { code: null, sentence: 'Something went wrong. Try again.', status }
  }
  const m = CODED.exec(text)
  if (!m) return { code: null, sentence: text, status }
  // An empty sentence after a valid code is still a coded error; fall back to
  // the whole string rather than rendering an empty banner.
  return { code: m[1], sentence: m[2].trim() || text, status }
}

/** What the browser actually renders.
 *
 *  The rule is asymmetric on purpose: the client branches on `code` to write
 *  copy it can make BETTER than the server's (because it holds context the
 *  server does not — the other row's kind, the label the owner just typed),
 *  and falls through to the server's own sentence for everything else. An
 *  UNRECOGNISED `labels.*` code therefore still shows a real sentence rather
 *  than "something went wrong", which is the whole reason the code and the
 *  sentence are separate fields on the wire.
 *
 *  `ctx` is optional context the caller holds; every field is optional and an
 *  absent one just means the generic branch is used.
 *
 *  `wanted` / `otherKind` are GONE with the state axis. They existed so the
 *  client could rewrite a kind clash as "that name is already a state — press
 *  ! instead", and with one kind left there is no other axis to name and no
 *  second key to press. Their codes are NOT gone — see below.
 */
export interface LabelErrorContext {
  /** The slug the owner was acting on. */
  slug?: string
}

export function labelErrorCopy(
  parsed: ParsedLabelError,
  ctx: LabelErrorContext = {},
): string {
  const { code, sentence } = parsed
  switch (code) {
    // THE FOUR KIND CODES ARE KEPT, and keeping them is the point rather than
    // an oversight: the server can still emit every one of them for a registry
    // row written before the retirement, and dropping a case here turns a
    // legible refusal into a raw code on screen. What they LOSE is the client
    // rewrite that named the other sigil — there is no second key to press — so
    // each now renders the server's own sentence, which is already written for
    // the owner.
    case 'labels.kind_conflict':
    case 'labels.invalid_kind':
      return sentence
    case 'labels.duplicate':
      return ctx.slug
        ? `You already have ${ctx.slug} in your list.`
        : sentence
    case 'labels.cap_exceeded':
      // The server's sentence names the would-be RESULT size, which is the
      // number the owner needs ("got 10" on an 8-label item plus two), so it
      // is kept verbatim and only framed.
      return `That would put too many labels on one to-do — ${sentence}. Take one off first.`
    case 'labels.slug_too_long':
      return `That name is too long — ${sentence}. Shorten it and try again.`
    case 'labels.invalid_slug':
      return `That is not a usable label — use letters, numbers and hyphens.`
    case 'labels.registry_full':
      return `Your label list is full — ${sentence}. Delete one to make room.`
    case 'labels.kind_immutable':
      return `${sentence}`
    case 'labels.kind_mismatch':
      return `Labels can only be merged into another label of the same kind.`
    case 'labels.merge_self':
      return `A label cannot be merged into itself.`
    case 'labels.unknown_slug':
    case 'labels.unknown_merge_target':
      return `${sentence} — your list may have changed in another tab.`
    default:
      // Covers every unrecognised `labels.*` code AND every uncoded error
      // (401s, plain 404s, network throws). Both render the server's own
      // words; neither renders a shrug.
      return sentence
  }
}

/** One-shot convenience for the three call sites that only want a string. */
export function labelErrorMessage(err: unknown, ctx: LabelErrorContext = {}): string {
  return labelErrorCopy(parseLabelError(err), ctx)
}

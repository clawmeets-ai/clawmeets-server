// THE ONE VERSION MATCHER IN THIS SYSTEM. The old Python PEP-440 matcher is
// deleted and is not coming back. Every runner version ever shipped is a clean
// major.minor.patch triple (runner-v1.1.0 … runner-v1.2.10), so a numeric-triple
// compare covers 100% of shipped versions in ~10 lines. The server relays facts;
// this file decides what they mean.
//
// §7 ACCEPTED LIMITATION 3 — DOCUMENTED, NOT FIXED: non-triple versions
// ("1.2.11.dev3", "1.2.10+local") parse as UNKNOWN and, under
// `match_unknown_version: true`, MATCH. That is noise on source installs and the
// correct direction for everyone else. Do NOT add dev/local/prerelease handling
// to "fix" it — that is PEP 440 coming back in through the side door, and with
// it the two-matchers-that-must-agree-forever problem this redesign removed.

export type Triple = readonly [number, number, number]
export type CompareOp = '<=' | '>=' | '==' | '!=' | '<' | '>'

export interface Clause {
  op: CompareOp
  version: Triple
}

export interface Target {
  clawmeets_version?: string
  match_unknown_version?: boolean
}

export interface AnnouncementRecord {
  id: string
  target: Target
  severity: string
  title: string
  body: string
}

/** §4.1 — strict, and nothing else. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * §4.1 — Strict `/^(\d+)\.(\d+)\.(\d+)$/`. `null`, `""`, `"1.2"`,
 * `"1.2.11.dev3"`, `"1.2.10+local"`, a git sha, a leading `"v"` and surrounding
 * whitespace all return `null`, meaning UNKNOWN — not "zero", not "invalid",
 * unknown, which branch 2 of `versionMatches` then governs.
 */
export function parseVersion(v: string | null | undefined): Triple | null {
  if (typeof v !== 'string') return null
  const m = VERSION_RE.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const
}

// Two-char operators are tested BEFORE one-char ones. Reversed, "<=1.2.9" parses
// as "<" + "=1.2.9" and then fails on the version — the right answer for the
// wrong reason — while ">=" would break outright.
const OPS: readonly CompareOp[] = ['<=', '>=', '==', '!=', '<', '>']

/**
 * Parse the §2.3 restricted grammar:
 *
 *     spec   := clause ("," clause)*
 *     clause := op version
 *     op     := "<=" | ">=" | "==" | "!=" | "<" | ">"
 *
 * Whitespace around clauses and operators is tolerated; all clauses are ANDed.
 *
 * AN OPERATOR IS REQUIRED. A bare `"1.2.9"` is invalid — it was the exact trap
 * the old `InvalidSpecifier` branch guarded and it is still the most likely typo.
 * So are `"~=1.2"`, `"latest"`, `">=1.2"`, `""` and a trailing empty clause.
 *
 * Returns `null` — NOT `[]` — on any malformed clause. `[]` would read as "no
 * constraints, matches everything", which is the exact inversion §4.2 fails
 * closed against.
 */
export function parseSpec(spec: string): Clause[] | null {
  if (typeof spec !== 'string') return null
  const clauses: Clause[] = []
  for (const part of spec.split(',')) {
    const text = part.trim()
    if (!text) return null
    const op = OPS.find(candidate => text.startsWith(candidate))
    if (!op) return null
    const version = parseVersion(text.slice(op.length).trim())
    if (!version) return null
    clauses.push({ op, version })
  }
  return clauses.length ? clauses : null
}

/**
 * Componentwise major, then minor, then patch. Returns <0 / 0 / >0.
 *
 * THE TRAP: `"1.2.10" < "1.2.9"` is `true` as STRINGS, and 1.2.10 is a CURRENT
 * RELEASE — so a lexical compare classifies the newest runner as needing an
 * upgrade. It is the single most likely way this gets rewritten wrong. Pinned by
 * a named test that asserts the lexical result alongside the correct one, so a
 * string-compare rewrite fails with the explanation already attached.
 */
export function compareTriple(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function satisfies(reported: Triple, clause: Clause): boolean {
  const c = compareTriple(reported, clause.version)
  switch (clause.op) {
    case '<=': return c <= 0
    case '>=': return c >= 0
    case '==': return c === 0
    case '!=': return c !== 0
    case '<': return c < 0
    case '>': return c > 0
  }
}

/**
 * §4.3 — BRANCH ORDER IS LOAD-BEARING. Keep it in this order.
 *
 *   1. NO VERSION CONSTRAINT. `clawmeets_version` absent, empty or
 *      whitespace-only → matches every live runner.
 *
 *   2. UNKNOWN VERSION. `parseVersion(reported) === null` → return
 *      `target.match_unknown_version === true` (default `false`).
 *
 *      ⚠ THIS IS THE BRANCH THAT MAKES THE FIRST SHIPPED ANNOUNCEMENT WORK AT
 *      ALL. Version reporting exists in NO RELEASED RUNNER, so on day one every
 *      live runner reports `null`. Without this branch `upgrade-1-2-9` reaches
 *      exactly ZERO of its intended targets WHILE EVERY TEST STILL PASSES — the
 *      same silent failure signature as a banner that never renders. It must sit
 *      ABOVE the comparison branch: a `null` reported version has no triple to
 *      compare, so any ordering that reaches branch 3 first has already lost.
 *
 *   3. TRIPLE COMPARISON. Every comma-separated clause must hold (AND).
 *
 * A record whose spec is unparseable never reaches here — `validateRecords()`
 * dropped it (§4.2). The defensive `false` in branch 3 is for the case where it
 * does anyway AND THE REPORTED VERSION PARSES: only then is that check reached.
 * If the reported version is unknown, branch 2 answers first from
 * `match_unknown_version` and never consults the spec. Both gaps are
 * unreachable by construction, and the branch order above is frozen — the
 * narrower claim is simply the accurate one.
 */
export function versionMatches(target: Target, reported: string | null): boolean {
  const spec = target?.clawmeets_version

  // BRANCH 1 — no version constraint.
  if (spec === undefined || spec === null || (typeof spec === 'string' && spec.trim() === '')) {
    return true
  }
  // Present but not a string is a contract violation. Fail CLOSED rather than
  // falling through to branch 1: "no constraint" matches every live runner.
  if (typeof spec !== 'string') return false

  // BRANCH 2 — unknown version. Above branch 3, deliberately.
  const triple = parseVersion(reported)
  if (triple === null) return target.match_unknown_version === true

  // BRANCH 3 — triple comparison, all clauses ANDed.
  const clauses = parseSpec(spec)
  if (clauses === null) return false
  return clauses.every(clause => satisfies(triple, clause))
}

/**
 * §4.2 — FAIL CLOSED. A port of the deleted Python `_validated_record`, and THE
 * ONLY COPY: the server serves the config verbatim and validates nothing, ever.
 *
 *   non-object record (null, array, string, number)  → skip
 *   missing / blank / non-string `id`                → skip
 *   duplicate `id`                                   → FIRST WINS, later skipped
 *   `title` or `body` not a string                   → skip
 *   `clawmeets_version` present but UNPARSEABLE
 *     ("1.2.9", "latest", "~=1.2", ">=1.2")          → SKIP THE RECORD
 *   `severity` missing / blank / non-string          → default "info"
 *   unknown keys at any level                        → IGNORE, NEVER REJECT
 *
 * The unparseable-spec row is LOAD-BEARING. A dropped record matches NOBODY; a
 * record that fell through to the "no version constraint" branch would match
 * EVERY runner. The failure modes are not symmetric, so the invalid case must
 * exit before the empty case is considered.
 *
 * Unknown keys are ignored rather than rejected so a config written for a NEWER
 * client cannot break an OLDER one — the file is hand-edited on a server the
 * browser does not control.
 *
 * Accepts `raw` as the whole response object OR a bare array; anything else
 * yields `[]`. `target` is normalized to `{}` when absent or non-object so §4.3
 * branch 1 handles it uniformly, and `match_unknown_version` is coerced to a
 * strict boolean — only literal `true` counts, which the `=== true` in branch 2
 * depends on.
 */
export function validateRecords(raw: unknown): AnnouncementRecord[] {
  let list: unknown[] | null = null
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw && typeof raw === 'object') {
    const wrapped = (raw as { announcements?: unknown }).announcements
    if (Array.isArray(wrapped)) list = wrapped
  }
  if (!list) return []

  const out: AnnouncementRecord[] = []
  const seen = new Set<string>()

  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>

    const id = rec.id
    if (typeof id !== 'string' || !id.trim()) continue
    // Duplicate id: FIRST WINS. `seen` holds only ACCEPTED ids, so a record
    // rejected on other grounds does not consume its id.
    if (seen.has(id)) continue

    const title = rec.title
    const body = rec.body
    if (typeof title !== 'string' || typeof body !== 'string') continue

    const rawTarget = rec.target
    const t: Record<string, unknown> =
      rawTarget && typeof rawTarget === 'object' && !Array.isArray(rawTarget)
        ? (rawTarget as Record<string, unknown>)
        : {}

    const target: Target = {}
    const spec = t.clawmeets_version
    if (spec !== undefined && spec !== null) {
      // Present but unparseable DROPS THE RECORD. Never fall through.
      if (typeof spec !== 'string') continue
      if (spec.trim() !== '') {
        if (parseSpec(spec) === null) continue
        target.clawmeets_version = spec
      }
    }
    target.match_unknown_version = t.match_unknown_version === true

    const sev = rec.severity
    const severity = typeof sev === 'string' && sev.trim() ? sev : 'info'

    seen.add(id)
    out.push({ id, target, severity, title, body })
  }

  return out
}

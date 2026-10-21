/**
 * Placeholder syntax for stored prompts (SOPs).
 *
 * A blank is written `{{Label}}` or `{{Label|kind:config}}` — label before the
 * pipe, kind after, config after the colon:
 *
 *   {{Company}}                          free text
 *   {{Threshold|text:$50}}               free text, $50 pre-offered
 *   {{Count|number:6}}                   numeric, default 6
 *   {{Voice|select:warm,punchy,expert}}  pick one of a set
 *   {{Deadline|date}}                    date quick-picks
 *   {{Deadline|date:Today,Friday}}       custom quick-picks
 *   {{Approver|agent}}                   pick from the agent roster
 *   {{Mentors|agents}}                   pick SEVERAL from the roster
 *
 * Every kind also accepts a typed-in custom value, so a set is a shortcut,
 * never a cage. Unknown kinds fall back to text.
 *
 * A label used twice is ONE blank: `{{Region}} … {{Region}}` asks a single
 * question and that one answer fills every occurrence. `phKey` is that identity
 * and `parse_blanks` in `models/sop_template.py` applies the same rule, so the
 * composer and `clawmeets sop trigger` can never disagree about how many
 * questions an SOP asks.
 *
 * Pure module: no React, no DOM construction. `PromptEditor` renders these
 * nodes as chips; `SopItem` and the authoring dialog's preview reuse the same
 * parse so the rail and the composer can never disagree about what a body's
 * blanks are.
 */

export type PhKind = 'text' | 'number' | 'select' | 'date' | 'agent' | 'agents'

/** Short mono tag shown on an unfilled chip. */
export const PH_TAGS: Record<PhKind, string> = {
  text: 'txt',
  number: 'num',
  select: 'sel',
  date: 'day',
  agent: 'who',
  agents: 'who+',
}

/** Kinds whose answer is a LIST. One blank, one answer, one string — the names
 *  joined by `MULTI_SEP` — so nothing downstream of the fill has to know a list
 *  was involved: `domText` substitutes it, `clawmeets sop trigger` takes it as
 *  `--set Mentors="a, b"`, and the prose around the blank ("brief every mentor
 *  listed") is what reads it back. `MULTI_KINDS` in `models/sop_template.py` is
 *  the same list on the Python side. */
export const MULTI_KINDS: ReadonlySet<PhKind> = new Set<PhKind>(['agents'])

export const isMultiKind = (k: PhKind): boolean => MULTI_KINDS.has(k)

/** Kinds whose offered values are the live agent roster rather than anything
 *  written in the body. `ROSTER_KINDS` in `models/sop_template.py` is the twin. */
export const ROSTER_KINDS: ReadonlySet<PhKind> = new Set<PhKind>(['agent', 'agents'])

export const isRosterKind = (k: PhKind): boolean => ROSTER_KINDS.has(k)

/** What a multi value joins on, and splits on. A comma because that is what a
 *  human types when listing names, and what `select`/`agent` configs already
 *  use — so a typed "a, b" and two clicks produce the same string. */
export const MULTI_SEP = ', '

export const splitMulti = (value: string): string[] =>
  String(value ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export const joinMulti = (items: string[]): string => items.join(MULTI_SEP)

/** Add `item` if absent, drop it if present — the tick-box semantics of the
 *  roster menu. Order is selection order, deliberately: the body reads the
 *  list as prose, and a user who picked the domain owner first means it. */
export function toggleMulti(value: string, item: string): string {
  const picked = splitMulti(value)
  const at = picked.findIndex((p) => p.toLowerCase() === item.trim().toLowerCase())
  if (at >= 0) picked.splice(at, 1)
  else picked.push(item.trim())
  return joinMulti(picked)
}

export const DATE_DEFAULTS = ['Today', 'Tomorrow', 'End of week', 'Next Monday']

export interface PhChip {
  id: string
  label: string
  kind: PhKind
  /** Offered values. Empty for text/number, AND for a bare `agent` / `agents`
   *  blank — that roster is resolved when the popover opens, not at parse time,
   *  since a template can load before the agent list has settled. */
  options: string[]
  /** Pre-offered default, for text/number only. */
  def: string
  value: string
  /** The original `{{…}}` source, so a half-filled draft can be saved back
   *  as a template rather than flattened. See `domSource`. */
  raw: string
}

export type PhNode = { t: 'text'; v: string } | { t: 'ph'; chip: PhChip }

// Label group excludes `|` and `}` so it can't swallow the spec; the spec
// group excludes only `}`, so option values may contain colons and pipes are
// already consumed. Global — callers must reset `lastIndex` before reuse.
const PH_RE = /\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}/g

const KIND_SET = new Set<string>(Object.keys(PH_TAGS))

const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** True if `body` contains at least one blank. Cheap pre-check for callers
 *  that only need to branch (e.g. "is this a template or plain text?"). */
export function hasPlaceholders(body: string): boolean {
  PH_RE.lastIndex = 0
  return PH_RE.test(String(body ?? ''))
}

export function makeChip(
  label: string,
  spec: string | undefined,
  raw: string,
  id: string,
): PhChip {
  let kind = 'text'
  let cfg = ''
  if (spec) {
    // Split at the FIRST colon only, so `select:9:16,1:1` keeps its colons.
    const i = spec.indexOf(':')
    kind = (i < 0 ? spec : spec.slice(0, i)).trim().toLowerCase()
    cfg = i < 0 ? '' : spec.slice(i + 1).trim()
  }
  if (!KIND_SET.has(kind)) kind = 'text'
  const k = kind as PhKind

  let options: string[] = []
  let def = ''
  if (k === 'select' || k === 'agent' || k === 'agents') {
    options = splitList(cfg)
  } else if (k === 'date') {
    const custom = splitList(cfg)
    options = custom.length ? custom : DATE_DEFAULTS.slice()
  } else {
    def = cfg
  }

  return { id, label: label.trim(), kind: k, options, def, value: '', raw }
}

/** A blank's identity: its label, trimmed and lowercased. `{{Region}}` and
 *  `{{ region }}` are the same question — the rule `parse_blanks` uses. */
export function phKey(label: string): string {
  return label.trim().toLowerCase()
}

/** The first chip of each label group, in document order. The de-duplicated
 *  view every "what does this body ask for?" caller wants. First occurrence
 *  wins, so the earliest spec defines the question. */
export function uniqueChips(chips: PhChip[]): PhChip[] {
  const seen = new Set<string>()
  return chips.filter((c) => {
    const k = phKey(c.label)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Every `{{…}}` occurrence as its own chip, each carrying its own spec. The
 *  raw grammar, before repeated labels collapse — split out so `parsePrompt`
 *  can canonicalize on top of it and `placeholderChips` can stay the pin
 *  against `_make_blank` on the Python side. */
function scanPrompt(src: string, nextId: () => string): PhNode[] {
  const str = String(src ?? '')
  const nodes: PhNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  PH_RE.lastIndex = 0
  while ((m = PH_RE.exec(str)) !== null) {
    if (m.index > last) nodes.push({ t: 'text', v: str.slice(last, m.index) })
    nodes.push({ t: 'ph', chip: makeChip(m[1], m[2], m[0], nextId()) })
    last = m.index + m[0].length
  }
  if (last < str.length) nodes.push({ t: 'text', v: str.slice(last) })
  return nodes
}

/**
 * Parse a prompt body into an alternating text / placeholder node list.
 * `nextId` mints chip ids — the caller owns the counter so ids stay unique
 * across every parse in one editor instance.
 *
 * Repeated labels are ONE blank, so every occurrence in a group adopts the
 * FIRST one's label/kind/options/default: clicking any of them opens the same
 * question, and the answer is the same answer. `raw` and `id` stay
 * per-occurrence — `raw` because `domSource` round-trips the exact source text
 * a draft was written with, `id` because each occurrence is its own DOM node.
 */
export function parsePrompt(src: string, nextId: () => string): PhNode[] {
  const nodes = scanPrompt(src, nextId)
  const first = new Map<string, PhChip>()
  for (const n of nodes) {
    if (n.t !== 'ph') continue
    const k = phKey(n.chip.label)
    const f = first.get(k)
    if (!f) {
      first.set(k, n.chip)
      continue
    }
    n.chip.label = f.label
    n.chip.kind = f.kind
    n.chip.options = f.options
    n.chip.def = f.def
  }
  return nodes
}

/** Just the chips, one per `{{…}}` OCCURRENCE — the grammar alone, which is
 *  what `tests/fixtures/sop_templates.json` pins across both languages.
 *  Callers asking what a body wants from the user want `placeholderBlanks`. */
export function placeholderChips(src: string): PhChip[] {
  let n = 0
  return scanPrompt(src, () => 'prev' + ++n)
    .filter((x): x is { t: 'ph'; chip: PhChip } => x.t === 'ph')
    .map((x) => x.chip)
}

/** The questions a body asks: one chip per distinct label, first occurrence's
 *  spec, document order. The TS twin of `parse_blanks`. */
export function placeholderBlanks(src: string): PhChip[] {
  return uniqueChips(placeholderChips(src))
}

// --------------------------------------------------------------------------
// HTML rendering (the editor writes these strings imperatively)
// --------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function chipInnerHtml(c: PhChip): string {
  return c.value
    ? `<span class="ph-tx">${escapeHtml(c.value)}</span>`
    : `<span class="ph-k">${PH_TAGS[c.kind]}</span><span class="ph-tx">${escapeHtml(c.label)}</span>`
}

export function chipOuterHtml(c: PhChip): string {
  // contenteditable="false" makes the chip atomic — the caret steps over it
  // rather than into it, and Backspace removes the whole chip.
  return (
    `<span class="ph-chip${c.value ? ' filled' : ''}" data-ph="${escapeHtml(c.id)}"` +
    ` contenteditable="false" aria-label="${escapeHtml(c.label)} placeholder">` +
    `${chipInnerHtml(c)}</span>`
  )
}

export function nodesToHtml(nodes: PhNode[]): string {
  return nodes
    .map((n) =>
      n.t === 'ph' ? chipOuterHtml(n.chip) : escapeHtml(n.v).replace(/\n/g, '<br>'),
    )
    .join('')
}

// --------------------------------------------------------------------------
// DOM → plain text
// --------------------------------------------------------------------------

export interface TextSeg {
  node: Text
  /** Offset of this text node's first character in the serialized string. */
  start: number
}

export interface DomText {
  text: string
  segs: TextSeg[]
}

/**
 * Serialize an editable subtree to plain text, recording where each real text
 * node landed.
 *
 * This is THE single walker: `getText`, `getSource` and the caret-offset
 * calculation all go through it, which is what guarantees the offsets reported
 * to the @mention detector index the exact string it scans, and that
 * `replaceRange` maps those offsets back to the same positions.
 *
 * `resolve` turns a chip id into its contribution — the value for a filled
 * chip, and either `[Label]` (send path) or the raw `{{…}}` (draft path) for
 * an unfilled one.
 */
export function walkDom(root: HTMLElement, resolve: (id: string) => string): DomText {
  let text = ''
  const segs: TextSeg[] = []

  const walk = (n: Node) => {
    n.childNodes.forEach((k) => {
      if (k.nodeType === Node.TEXT_NODE) {
        segs.push({ node: k as Text, start: text.length })
        text += (k as Text).nodeValue ?? ''
        return
      }
      if (k.nodeType !== Node.ELEMENT_NODE) return
      const el = k as HTMLElement
      const id = el.getAttribute('data-ph')
      if (id) {
        // Chips are atomic: contribute their resolved text, never recurse.
        text += resolve(id)
        return
      }
      if (el.tagName === 'BR') {
        text += '\n'
        return
      }
      // A block boundary reads as a newline, but never a leading one and
      // never a doubled one.
      if (/^(DIV|P)$/.test(el.tagName) && text && !text.endsWith('\n')) text += '\n'
      walk(el)
    })
  }

  walk(root)
  return { text, segs }
}

/** What the agent actually receives. Unfilled chips degrade to `[Label]` —
 *  only reachable from draft paths, because send is blocked on empties. */
export function domText(root: HTMLElement, chips: Record<string, PhChip>): string {
  return walkDom(root, (id) => {
    const c = chips[id]
    if (!c) return ''
    return c.value || '[' + c.label + ']'
  }).text
}

/** What a saved draft stores. Unfilled chips keep their `{{…}}` syntax so a
 *  half-filled template survives a save/reload round-trip intact. */
export function domSource(root: HTMLElement, chips: Record<string, PhChip>): string {
  return walkDom(root, (id) => {
    const c = chips[id]
    if (!c) return ''
    return c.value || c.raw
  }).text
}

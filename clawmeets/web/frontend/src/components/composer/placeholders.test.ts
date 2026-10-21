import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DATE_DEFAULTS,
  domSource,
  domText,
  hasPlaceholders,
  isMultiKind,
  isRosterKind,
  joinMulti,
  nodesToHtml,
  parsePrompt,
  placeholderBlanks,
  placeholderChips,
  splitMulti,
  toggleMulti,
  walkDom,
  type PhChip,
  type PhNode,
} from './placeholders'

/**
 * The placeholder grammar is the contract shared by the SOP library (which
 * previews a body's blanks) and the composer (which renders them as chips and
 * blocks send until they're filled). These lock down every row of that table
 * plus the two serializations the editor depends on.
 */

let n = 0
const ids = () => 'ph' + ++n
const parse = (s: string) => parsePrompt(s, ids)
const chipsOf = (s: string) =>
  parse(s).filter((x): x is { t: 'ph'; chip: PhChip } => x.t === 'ph').map((x) => x.chip)

describe('parsePrompt — the syntax table', () => {
  it('bare label is free text with no default', () => {
    const [c] = chipsOf('Brief {{Company}} today.')
    expect(c.kind).toBe('text')
    expect(c.label).toBe('Company')
    expect(c.options).toEqual([])
    expect(c.def).toBe('')
  })

  it('text with a default pre-offers it', () => {
    const [c] = chipsOf('{{Threshold|text:$50}}')
    expect(c.kind).toBe('text')
    expect(c.def).toBe('$50')
  })

  it('number carries its default', () => {
    const [c] = chipsOf('{{Count|number:6}}')
    expect(c.kind).toBe('number')
    expect(c.def).toBe('6')
  })

  it('select lists its options', () => {
    const [c] = chipsOf('{{Voice|select:warm,punchy,expert}}')
    expect(c.kind).toBe('select')
    expect(c.options).toEqual(['warm', 'punchy', 'expert'])
  })

  it('bare date falls back to the standard quick picks', () => {
    const [c] = chipsOf('{{Deadline|date}}')
    expect(c.kind).toBe('date')
    expect(c.options).toEqual(DATE_DEFAULTS)
  })

  it('date with a config uses that list instead', () => {
    const [c] = chipsOf('{{Deadline|date:Today,Friday}}')
    expect(c.options).toEqual(['Today', 'Friday'])
  })

  it('bare agent defers its roster to popover-open time', () => {
    // Deliberately empty: the roster may not have loaded when a template does.
    const [c] = chipsOf('{{Approver|agent}}')
    expect(c.kind).toBe('agent')
    expect(c.options).toEqual([])
  })

  it('agent with an explicit list uses it', () => {
    const [c] = chipsOf('{{Approver|agent:ana,bo}}')
    expect(c.options).toEqual(['ana', 'bo'])
  })
})

describe('parsePrompt — edge cases', () => {
  it('splits the kind at the FIRST colon so option values keep theirs', () => {
    const [c] = chipsOf('{{Aspect|select:9:16,1:1,4:5}}')
    expect(c.kind).toBe('select')
    expect(c.options).toEqual(['9:16', '1:1', '4:5'])
  })

  it('falls back to text on an unknown kind', () => {
    const [c] = chipsOf('{{Thing|wat:a,b}}')
    expect(c.kind).toBe('text')
  })

  it('trims whitespace around the label and the spec', () => {
    const [c] = chipsOf('{{  Spaced Label  |  select: a , b  }}')
    expect(c.label).toBe('Spaced Label')
    expect(c.options).toEqual(['a', 'b'])
  })

  it('handles adjacent placeholders with no text between', () => {
    const nodes = parse('{{A}}{{B}}')
    expect(nodes.map((x) => x.t)).toEqual(['ph', 'ph'])
  })

  it('keeps surrounding text as its own nodes', () => {
    const nodes = parse('pre {{A}} post')
    expect(nodes.map((x) => x.t)).toEqual(['text', 'ph', 'text'])
    expect((nodes[0] as { v: string }).v).toBe('pre ')
    expect((nodes[2] as { v: string }).v).toBe(' post')
  })

  it('returns a single text node when there are no blanks', () => {
    const nodes = parse('just a plain message')
    expect(nodes).toEqual([{ t: 'text', v: 'just a plain message' }])
  })

  it('is empty for an empty body', () => {
    expect(parse('')).toEqual([])
  })

  it('mints unique ids across repeated parses', () => {
    const a = chipsOf('{{X}}')
    const b = chipsOf('{{X}}')
    expect(a[0].id).not.toBe(b[0].id)
  })

  it('records the raw source on every chip', () => {
    const [c] = chipsOf('go {{Count|number:6}}')
    expect(c.raw).toBe('{{Count|number:6}}')
  })

  it('hasPlaceholders / placeholderChips agree with the parse', () => {
    expect(hasPlaceholders('a {{B}} c')).toBe(true)
    expect(hasPlaceholders('no blanks here')).toBe(false)
    // Repeated calls must not be affected by the shared /g regex's lastIndex.
    expect(hasPlaceholders('a {{B}} c')).toBe(true)
    expect(placeholderChips('{{A}} {{B|number:2}}').map((c) => c.label)).toEqual(['A', 'B'])
  })
})

// --------------------------------------------------------------------------
// A repeated label is ONE blank
// --------------------------------------------------------------------------

/**
 * `{{A}} {{B}} {{A}}` asks TWO questions, not three — the rule `parse_blanks`
 * has always applied on the Python side, so `clawmeets sop trigger --set A=…`
 * already fills both occurrences from one answer. These pin the browser half:
 * one chip per occurrence to render, one blank per label to ask about.
 */
describe('repeated labels', () => {
  it('keeps a node per occurrence but asks once', () => {
    expect(parse('{{A}} {{B}} {{A}}').filter((x) => x.t === 'ph')).toHaveLength(3)
    expect(placeholderBlanks('{{A}} {{B}} {{A}}').map((c) => c.label)).toEqual(['A', 'B'])
  })

  it('collapses casing and whitespace variants of one label', () => {
    expect(placeholderBlanks('{{Region}} {{ region }}').map((c) => c.label)).toEqual(['Region'])
  })

  it('gives every occurrence the FIRST one label and spec', () => {
    // Mismatched specs resolve the way parse_blanks resolves them, so clicking
    // either chip opens the same question.
    const [a, b] = chipsOf('{{N|number:6}} then {{ n |text:x}}')
    expect([a.kind, a.def]).toEqual(['number', '6'])
    expect([b.kind, b.def, b.label]).toEqual(['number', '6', 'N'])
  })

  it('leaves each occurrence its own raw, so a draft round-trips', () => {
    const [a, b] = chipsOf('{{N|number:6}} then {{n|text:x}}')
    expect(a.raw).toBe('{{N|number:6}}')
    expect(b.raw).toBe('{{n|text:x}}')
  })

  it('placeholderChips still reports every occurrence, spec and all', () => {
    // The grammar pin below rests on this: dedupe is a layer above the parse.
    const chips = placeholderChips('{{N|number:6}} then {{N|text:x}}')
    expect(chips.map((c) => c.kind)).toEqual(['number', 'text'])
  })
})

// --------------------------------------------------------------------------
// Cross-language pin
// --------------------------------------------------------------------------

/**
 * The grammar is implemented twice: here, and in
 * `clawmeets/models/sop_template.py` (server + the `clawmeets sop` CLI, which
 * fills a stored SOP's blanks and DMs the result). They have to agree, or the
 * message the assistant sends stops matching the blanks this editor showed the
 * user — and shelling this parser from Python would mean a Node dependency in
 * the runner wheel.
 *
 * `tests/fixtures/sop_templates.json` is the pin. `tests/test_sop_template.py`
 * asserts the Python side against the same rows, so a divergence fails on
 * whichever side moved. Add awkward cases THERE, not here, so both sides get
 * them.
 */
interface CorpusChip {
  label: string
  kind: string
  options: string[]
  /** The fixture spells this `default`; a chip calls it `def`. */
  default: string
  raw: string
}
interface CorpusCase {
  name: string
  body: string
  /** Every `{{…}}` occurrence — the grammar, pre-dedupe. */
  chips: CorpusChip[]
  /** The questions the body asks — labels, de-duplicated, first-wins. */
  blanks: string[]
}

const corpus: { cases: CorpusCase[] } = JSON.parse(
  readFileSync(
    // .../src/components/composer -> repo root -> tests/fixtures
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../tests/fixtures/sop_templates.json'),
    'utf8',
  ),
)

describe('shared corpus — pinned to models/sop_template.py', () => {
  it('has cases to check (a silently unreadable fixture must not pass)', () => {
    expect(corpus.cases.length).toBeGreaterThan(20)
  })

  corpus.cases.forEach((c) => {
    it(c.name, () => {
      const got = placeholderChips(c.body).map((x) => ({
        label: x.label,
        kind: x.kind as string,
        options: x.options,
        default: x.def,
        raw: x.raw,
      }))
      expect(got).toEqual(c.chips)
      // The other half of the row: how many questions the body asks. Pinned
      // against `parse_blanks`, which `test_sop_template.py` asserts on the
      // same field — so a dedupe rule that drifts fails on the side that moved.
      expect(placeholderBlanks(c.body).map((x) => x.label)).toEqual(c.blanks)
    })
  })
})

// --------------------------------------------------------------------------
// DOM serialization
// --------------------------------------------------------------------------

/** Build a real editable subtree the way PromptEditor does. */
function mount(body: string, fill: Record<string, string> = {}) {
  const nodes: PhNode[] = parse(body)
  const chips: Record<string, PhChip> = {}
  nodes.forEach((x) => {
    if (x.t === 'ph') {
      if (fill[x.chip.label] !== undefined) x.chip.value = fill[x.chip.label]
      chips[x.chip.id] = x.chip
    }
  })
  const root = document.createElement('div')
  root.innerHTML = nodesToHtml(nodes)
  return { root, chips }
}

describe('domText / domSource', () => {
  it('sends filled values and degrades unfilled chips to [Label]', () => {
    const { root, chips } = mount('Cut {{Count|number:6}} for {{Client}}.', { Count: '8' })
    expect(domText(root, chips)).toBe('Cut 8 for [Client].')
  })

  it('saves drafts with the unfilled blanks intact', () => {
    const { root, chips } = mount('Cut {{Count|number:6}} for {{Client}}.', { Count: '8' })
    // This is what makes a half-filled take-over draft survive a round-trip.
    expect(domSource(root, chips)).toBe('Cut 8 for {{Client}}.')
  })

  it('round-trips a fully unfilled template through domSource', () => {
    const body = 'Reconcile {{Day|date}} for {{Loc|select:A,B}}.'
    const { root, chips } = mount(body)
    expect(domSource(root, chips)).toBe(body)
  })

  it('renders <br> as a newline', () => {
    const root = document.createElement('div')
    root.innerHTML = 'one<br>two'
    expect(domText(root, {})).toBe('one\ntwo')
  })

  it('escapes markup in text and in chip values', () => {
    const { root, chips } = mount('{{X}} <b>hi</b>', { X: '<script>' })
    expect(root.querySelector('script')).toBeNull()
    expect(domText(root, chips)).toBe('<script> <b>hi</b>')
  })
})

describe('walkDom offsets', () => {
  it('reports text-node starts in the same space domText produces', () => {
    const { root, chips } = mount('ab {{X}} cd', { X: 'ZZ' })
    const { text, segs } = walkDom(root, (id) => chips[id].value || '')
    expect(text).toBe('ab ZZ cd')
    // The trailing text node begins right after the chip's expansion —
    // this is the invariant caretOffset and replaceRange both rely on.
    const last = segs[segs.length - 1]
    expect(last.start).toBe(5)
    expect(text.slice(last.start)).toBe(' cd')
  })

  it('accounts for an unfilled chip at its [Label] width', () => {
    const { root, chips } = mount('{{Ab}} tail')
    const { text, segs } = walkDom(root, (id) => {
      const c = chips[id]
      return c.value || '[' + c.label + ']'
    })
    expect(text).toBe('[Ab] tail')
    expect(segs[segs.length - 1].start).toBe(4)
  })
})

describe('a multi value is one string', () => {
  it('names the multi and roster kinds', () => {
    expect(isMultiKind('agents')).toBe(true)
    expect(isMultiKind('agent')).toBe(false)
    expect(isRosterKind('agents')).toBe(true)
    expect(isRosterKind('agent')).toBe(true)
    expect(isRosterKind('select')).toBe(false)
  })

  it('round-trips a list through the comma separator', () => {
    expect(joinMulti(['ana', 'bo'])).toBe('ana, bo')
    expect(splitMulti('ana, bo')).toEqual(['ana', 'bo'])
    // A hand-typed list and a clicked one produce the same value: spacing and
    // trailing separators are normalized away on the way back in.
    expect(splitMulti(' ana ,bo, ')).toEqual(['ana', 'bo'])
    expect(splitMulti('')).toEqual([])
  })

  it('toggles a name in and out, keeping selection order', () => {
    expect(toggleMulti('', 'ana')).toBe('ana')
    expect(toggleMulti('ana', 'bo')).toBe('ana, bo')
    expect(toggleMulti('ana, bo', 'ana')).toBe('bo')
    // Case-insensitive, so a typed name can't shadow the roster entry it means.
    expect(toggleMulti('Ana, bo', 'ana')).toBe('bo')
    expect(toggleMulti('ana', '  bo  ')).toBe('ana, bo')
  })
})

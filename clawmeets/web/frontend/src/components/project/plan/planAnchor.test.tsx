import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { ReactNode } from 'react'
import {
  blockCarries,
  capQuote,
  dropInlineMarkers,
  flattenOwn,
  normalizeText,
  PLAN_QUOTE_CHARS,
  QUOTE_LABEL_CHARS,
  splitQuoteLabel,
  stripMarkers,
} from './planAnchor'
import { splitOwnChildren } from './planBlocks'

// followup B11. `vitest.config.ts` sets `globals: false`, so testing-library's
// auto-cleanup never registers: a render left standing here stays MOUNTED, and
// mounted means still subscribed to every store it reads and still holding
// every timer its effects started. The next file's fixture then re-renders it
// and re-fires those effects, in a file that has no idea this component exists.
// Audited suite-wide in M5; asserted by `src/test/suiteHygiene.test.ts`.
afterEach(cleanup)

/**
 * THE MATCHER, AWAY FROM REACT.
 *
 * Everything a note's position depends on is decided in this module, so this is
 * where the defect that motivated the feature is pinned. The rendering half —
 * which block the note lands under, which section holds it when it lands
 * nowhere — is in `PlanBody.test.tsx`.
 */

/** Render a markdown source through the real pipeline and hand back the
 *  children of the first element with the given tag, exactly as a block
 *  component receives them. Nothing is hand-built: the tree under test is
 *  remark's own output.
 *
 *  `nest` names the tags to render through a COMPONENT rather than a plain tag,
 *  which is not a detail: react-markdown passes a `node` prop to a component
 *  and the element it builds has a FUNCTION as its type, so a nested block only
 *  announces its tag through `node`. `PlanBody` substitutes every block tag, so
 *  that is the tree the real code sees. */
function childrenOf(md: string, tag: string, nest: string[] = []): ReactNode {
  let kids: ReactNode = null
  const components: Record<string, unknown> = {}
  for (const t of [tag, ...nest]) {
    const El = t as 'p'
    components[t] = (props: { children?: ReactNode }) => {
      if (t === tag && kids === null) kids = props.children
      return <El>{props.children}</El>
    }
  }
  render(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components as never}>
      {md}
    </ReactMarkdown>,
  )
  return kids
}

/** The children of the first paragraph. */
function paragraphChildren(md: string): ReactNode {
  return childrenOf(md, 'p')
}

/** What a block would capture and claim with: its OWN children, flattened. */
function ownTextOf(md: string, tag: string, nest: string[] = []): string {
  return flattenOwn(splitOwnChildren(childrenOf(md, tag, nest)).own)
}

describe('normalisation is whitespace, on both sides, and nothing else', () => {
  it('collapses runs and trims', () => {
    expect(normalizeText('  the   keeper \n writes  ')).toBe('the keeper writes')
  })

  it('does NOT strip markdown markers — the block side has none left to strip', () => {
    // This is the whole point. If normalisation stripped markers it would be
    // doing the prototype's job on the prototype's side of the comparison.
    expect(normalizeText('the **keeper** writes')).toBe('the **keeper** writes')
  })
})

describe('flattenOwn reads the text the browser painted', () => {
  it('reads through inline elements as though they were not there', () => {
    expect(flattenOwn(paragraphChildren('the **keeper** writes `it` down'))).toBe(
      'the keeper writes it down',
    )
  })

  it('collapses the newline remark-breaks renders as a <br>', () => {
    expect(flattenOwn(paragraphChildren('one line\nand its continuation'))).toBe(
      'one line and its continuation',
    )
  })
})

/**
 * OWN TEXT, AND THE REGRESSION IT EXISTS TO PREVENT.
 *
 * Reading the whole subtree would make an outer list item's text CONTAIN its
 * nested bullets' text. Claims are first-match in document order and a parent
 * renders before its child, so the outer item would take a note about an inner
 * bullet — and under block painting it would then tint the entire outer
 * subtree. Stopping at the first block-level child is what makes the innermost
 * block the only one that can claim it, with no block id and no ordering rule.
 */
describe('a block owns its own run and not its children', () => {
  const OUTLINE = '- outer item\n  - inner one\n  - inner two\n'

  it("an outer item's own text is its bullet, NOT its bullet plus the nest", () => {
    expect(ownTextOf(OUTLINE, 'li')).toBe('outer item')
  })

  it('reading the subtree instead would swallow them — the shape of the bug', () => {
    // Same tree, flattened WITHOUT the split. This is what the old `flatten`
    // returned and why the outer item would have claimed the inner note.
    expect(flattenOwn(childrenOf(OUTLINE, 'li'))).toBe('outer item inner one inner two')
  })

  it('so only the inner block carries a note about an inner bullet', () => {
    expect(blockCarries(ownTextOf(OUTLINE, 'li'), 'inner one')).toBe(false)
  })

  it('a nested block is recognised through `node` when it renders as a component', () => {
    // A blockquote's children are all paragraphs, and `PlanBody` renders a
    // paragraph through a COMPONENT — so its element type is a function and its
    // tag is legible only through the `node` prop. Reading `type` alone would
    // miss it and hand the blockquote its paragraphs' words.
    expect(ownTextOf('> the keeper writes it\n', 'blockquote', ['p'])).toBe('')
  })

  it('which is why a blockquote offers no bubble of its own', () => {
    // Below MIN_QUOTE_CHARS, so `PlanBody` suppresses the bubble: you comment
    // on the paragraphs inside a blockquote, not on the blockquote. Accepted,
    // and consistent with innermost-wins rather than an exception to it.
    expect(ownTextOf('> the keeper writes it\n', 'blockquote', ['p']).length).toBe(0)
  })
})

/**
 * DEFECT (a) — THE ONE THAT MATTERS, PINNED FROM BOTH ENDS.
 *
 * The prototype compares a RENDERED quote against RAW MARKDOWN:
 * `prdInlineMarked` tests `t.includes(m.quote)` with `t = prdText(b)`, and
 * `prdDoc`'s `locate()` does the same. The first test below is that comparison,
 * written out, and it FAILS on a perfectly ordinary quote — which is the bug
 * the user reported. The second is the shipped comparison on the same input,
 * and it holds.
 */
describe('defect (a) — a quote that spans inline formatting', () => {
  const SOURCE = 'the **keeper** writes the first plan'
  // What the block hands us: the DOM has no asterisks in it.
  const CAPTURED = 'keeper writes the first'

  it("the prototype's comparison — rendered quote against raw markdown — MISSES", () => {
    expect(SOURCE.includes(CAPTURED)).toBe(false)
  })

  it('the shipped comparison — rendered against rendered — HITS', () => {
    expect(blockCarries(flattenOwn(paragraphChildren(SOURCE)), CAPTURED)).toBe(true)
  })

  it('and it hits across a code span and an emphasis too', () => {
    const own = flattenOwn(paragraphChildren('run `plan approve` when _everyone_ has signed'))
    expect(blockCarries(own, 'plan approve when everyone has')).toBe(true)
  })

  it('a quote filed as RAW markdown still anchors, through the fallback', () => {
    // `clawmeets plan note --quote '**keeper** writes'` stores the markers. The
    // markers come off the QUOTE — never off the block, which is where the
    // prototype went wrong.
    expect(blockCarries(flattenOwn(paragraphChildren(SOURCE)), '**keeper** writes')).toBe(true)
  })

  it('stripMarkers leaves an ordinary underscore inside a word alone', () => {
    expect(stripMarkers('char_start and char_end')).toBe('char_start and char_end')
    expect(stripMarkers('_emphasised_ text')).toBe('emphasised text')
  })
})

describe('a quote that is not there is not there', () => {
  it('returns false rather than a nearest guess', () => {
    expect(blockCarries(flattenOwn(paragraphChildren('the keeper writes')), 'nobody wrote this'))
      .toBe(false)
  })

  it('an empty quote never matches — it would otherwise match everything', () => {
    expect(blockCarries(flattenOwn(paragraphChildren('the keeper writes')), '   ')).toBe(false)
  })

  it('and a block with no own text carries nothing at all', () => {
    expect(blockCarries('', 'the keeper writes')).toBe(false)
  })
})

/**
 * AMBIGUITY WITHIN A BLOCK STOPPED BEING A QUESTION.
 *
 * `locate` used to return the FIRST occurrence's offsets and a count of how
 * many there were, and the UI printed "appears 2 times in this block — pinned
 * to the first" because a highlight had to sit on one of them. The block is the
 * extent now, so there is nothing to pin and nothing to disclose.
 */
describe('a quote occurring twice in one block is just carried', () => {
  it('matches once, with no occurrence to choose and no count to report', () => {
    const own = flattenOwn(paragraphChildren('the keeper, and then the keeper again'))
    expect(blockCarries(own, 'the keeper')).toBe(true)
  })

  it('and two notes quoting NESTED phrases both land, where one used to be lost', () => {
    // `mergeRanges` dropped an overlapping range rather than nesting it, so two
    // reviewers quoting `the keeper writes the first plan` and `writes the
    // first` got ONE highlight for two notes. Both are carried now; the block
    // is painted once.
    const own = flattenOwn(paragraphChildren('the keeper writes the first plan'))
    expect(blockCarries(own, 'the keeper writes the first plan')).toBe(true)
    expect(blockCarries(own, 'writes the first')).toBe(true)
  })
})

describe('the cap', () => {
  it('bounds a long capture', () => {
    const long = 'x '.repeat(4000)
    expect(capQuote(long).length).toBeLessThanOrEqual(PLAN_QUOTE_CHARS)
    expect(capQuote(long).length).toBeGreaterThan(PLAN_QUOTE_CHARS - 4)
  })

  it('is IDEMPOTENT, so applying it at capture AND at the wire agrees', () => {
    // The wire-side application is a guard, not a second transformation. If it
    // shortened an already-capped quote the stored text would differ from the
    // text the composer showed — by one character, silently, and only when the
    // cut landed on a space.
    const long = 'the keeper writes '.repeat(500)
    const once = capQuote(long)
    expect(capQuote(once)).toBe(once)
  })

  it('normalises before it measures, so whitespace cannot smuggle length past it', () => {
    expect(capQuote('  a   b  ')).toBe('a b')
  })

  it('leaves an ordinary quote untouched', () => {
    expect(capQuote('the keeper writes')).toBe('the keeper writes')
  })

  it('4000 is far enough under the note cap that a note is never refused for it', () => {
    expect(PLAN_QUOTE_CHARS).toBeLessThan(32 * 1024)
  })

  it('A TRUNCATED WHOLE-BLOCK QUOTE STILL ANCHORS, which is why 4000 is safe', () => {
    // Block capture reaches the cap on any long enough paragraph, with no user
    // intent involved — so the truncated case stopped being exotic. What is
    // stored is a PREFIX of the block's own text, and `blockCarries` tests
    // `includes`, so the block still carries it and still paints whole. The
    // cost is display-side only: the quote is echoed verbatim wherever it is
    // listed, and there it reads as a sentence cut mid-air.
    const own = normalizeText('the keeper writes. '.repeat(400))
    expect(own.length).toBeGreaterThan(PLAN_QUOTE_CHARS)
    expect(blockCarries(own, capQuote(own))).toBe(true)
  })
})

/**
 * THE CUT LANDS ON A CHARACTER, NOT ON HALF OF ONE.
 *
 * `slice` counts UTF-16 code units, so a cut at 4000 falling between the halves
 * of a surrogate pair used to store a lone high surrogate. Every assertion the
 * cap already made still passed on that string — it is the right length, and it
 * is idempotent — because the defect is not in its length or its stability but
 * in it not being well-formed UTF-16 at all. That is why the table below adds a
 * WELL-FORMED column to the idempotence one rather than replacing it, and why
 * the last test asserts against the crash instead of against the fix.
 */
describe('the cut respects the character it lands in', () => {
  /** A quote whose character at index 4000 is `mid`, so the cap cuts there. */
  function cutAt(mid: string): string {
    return 'a'.repeat(PLAN_QUOTE_CHARS - 1) + mid + 'b'.repeat(200)
  }

  it('never stores a lone high surrogate — the write-path crash', () => {
    const capped = capQuote(cutAt('\u{1F600}'))
    expect(capped.isWellFormed()).toBe(true)
    expect(capped.length).toBeLessThanOrEqual(PLAN_QUOTE_CHARS)
    // And it dropped the orphan rather than keeping half of it.
    expect(capped.endsWith('a')).toBe(true)
  })

  it('keeps a pair the cut does NOT split', () => {
    // The emoji starts at 3998, so both halves are inside the bound and both
    // must survive: the fix trims an orphan, not every astral character.
    const q = 'a'.repeat(PLAN_QUOTE_CHARS - 2) + '\u{1F600}' + 'b'.repeat(200)
    const capped = capQuote(q)
    expect(capped.isWellFormed()).toBe(true)
    expect(capped.endsWith('\u{1F600}')).toBe(true)
    expect(capped.length).toBe(PLAN_QUOTE_CHARS)
  })

  // The reviewer's own table. It read "yes" down the idempotent column before
  // this fix and must still; the well-formed column is what was missing.
  const CUTS: [string, string][] = [
    ['a space', ' '],
    ['an astral emoji', '\u{1F600}'],
    ['a ZWJ sequence', '\u{1F468}‍\u{1F4BB}'],
    ['a combining mark', 'é'],
    ['CJK', '中文'],
    ['an astral CJK character', '\u{20BB7}'],
    ['an NBSP', ' '],
  ]

  it.each(CUTS)('a cut landing on %s stays idempotent AND well-formed', (_what, mid) => {
    const once = capQuote(cutAt(mid))
    expect(capQuote(once)).toBe(once)
    expect(once.isWellFormed()).toBe(true)
    expect(once.length).toBeLessThanOrEqual(PLAN_QUOTE_CHARS)
  })

  it('survives the round-trip that used to 500 the server', () => {
    // PINNED FROM THE CONSUMER SIDE, so the test is tied to the crash and not
    // to one spelling of the fix. The quote goes out through `JSON.stringify`,
    // Python parses it into a `str`, and the plan writer encodes that `str` as
    // UTF-8 — where a lone surrogate raises `UnicodeEncodeError: … surrogates
    // not allowed`. `TextEncoder` would be the obvious stand-in and is the
    // wrong one: it substitutes U+FFFD and never throws, so it would pass on
    // the broken string. `encodeURIComponent` is JS's one STRICT UTF-8 encoder
    // — it raises `URIError` on exactly the input Python refuses.
    const wire = JSON.parse(JSON.stringify(capQuote(cutAt('\u{1F600}')))) as string
    expect(() => encodeURIComponent(wire)).not.toThrow()

    // ...and the encoder really is strict, so the assertion above can fail.
    expect(() => encodeURIComponent('a\uD83D')).toThrow()
  })
})

/**
 * THE MODULE'S OWN SURFACE, asserted because the shrinking is the change.
 *
 * Nine exported symbols became five. Gone: `Flat`, `flatten`, `Hit`, `locate`,
 * `MarkRange`, `mergeRanges`, `markChildren` — the per-character owner array,
 * the co-walk that relied on leaf *n* of one pass being leaf *n* of the other,
 * the range merger and the tree rebuilder. Anything that reintroduces an offset
 * here has reintroduced the coupling this change bought its way out of.
 *
 * `QUOTE_PREVIEW_CHARS` LEFT WITH THE PREVIEW IT BOUNDED. The composer used to
 * reprint the quoted words in an italic block and cut them at 90 characters to
 * do it; the block being commented on lights up in the document instead, so
 * there is no preview to bound and the constant had no reader left. The
 * STORAGE cap beside it (`PLAN_QUOTE_CHARS`) is untouched — that one bounds
 * what reaches the wire and every path that mints a quote still applies it.
 *
 * THE THREE THAT ARRIVED LATER ARE ALL DISPLAY, AND NONE IS AN OFFSET.
 * `dropInlineMarkers` is the half of `stripMarkers` that leaves whitespace
 * alone; `splitQuoteLabel` and its `QUOTE_LABEL_CHARS` cut a quote into the
 * identifier it opens with and the sentence that follows. They read a quote and
 * hand back strings — nothing here paints, nothing here reaches the wire, and
 * `blockCarries` still matches against the verbatim quote it always did.
 */
describe('the module exports a matcher and nothing that paints', () => {
  it('exports ten symbols, and not one of them is an offset', async () => {
    const mod = await import('./planAnchor')
    expect(Object.keys(mod).sort()).toEqual([
      'MIN_QUOTE_CHARS',
      'PLAN_QUOTE_CHARS',
      'QUOTE_LABEL_CHARS',
      'blockCarries',
      'capQuote',
      'dropInlineMarkers',
      'flattenOwn',
      'normalizeText',
      'splitQuoteLabel',
      'stripMarkers',
    ].sort())
  })
})

/**
 * THE QUOTE AS THE CARD PRINTS IT, WHICH IS NOT THE QUOTE AS THE MATCHER READS
 * IT — and keeping those two apart is the whole of these two functions.
 *
 * A stored quote is raw markdown, verbatim, because that is what anchors. What
 * the card needs is text a human reads, so `**AC-2.1**` must not reach the
 * screen with its asterisks on. The split is display-only in both directions:
 * every assertion here is about strings, and `blockCarries` above still gets
 * the untouched quote.
 */
describe('a quote is cut for display without being changed for matching', () => {
  it('drops inline markers and keeps the line breaks', () => {
    expect(dropInlineMarkers('**bold** and `code`\nand _em_')).toBe('bold and code\nand em')
  })

  /** THE ONE THING THAT MUST NOT BE FOLDED BACK INTO `stripMarkers`. The matcher
   *  collapses whitespace because the other side of its comparison is a
   *  flattened render; a `whitespace-pre-wrap` blockquote must not. */
  it('differs from `stripMarkers` exactly in leaving whitespace alone', () => {
    const q = '**one**\n  two'
    expect(dropInlineMarkers(q)).toBe('one\n  two')
    expect(stripMarkers(q)).toBe('one two')
  })

  it('lifts an identifier a quote opens with, and leaves the sentence behind', () => {
    expect(splitQuoteLabel('**AC-2.1** — ct can read one short list')).toEqual({
      label: 'AC-2.1',
      body: 'ct can read one short list',
    })
  })

  it('takes a code-span identifier and a colon separator too', () => {
    expect(splitQuoteLabel('`M2`: ship the runner').label).toBe('M2')
    expect(splitQuoteLabel('**G2** ship the runner').label).toBe('')
  })

  /** THE SEPARATOR IS THE TEST, and this is the case it exists for: a bolded
   *  word inside a sentence is emphasis, not a name, and hoisting it onto the
   *  header row would put a fragment where a label belongs. The markers still
   *  come off — it just stays in the body. */
  it('does not mistake an emphasized word for a label', () => {
    expect(splitQuoteLabel('**Never** ship this on a Friday')).toEqual({
      label: '',
      body: 'Never ship this on a Friday',
    })
  })

  it('leaves a whole quote in the body when it opens with no emphasis at all', () => {
    expect(splitQuoteLabel('ct can read one short list')).toEqual({
      label: '',
      body: 'ct can read one short list',
    })
  })

  /** A quote that is nothing BUT its identifier — a note anchored on a bare
   *  heading. There is no sentence left, and the card draws no blockquote. */
  it('yields an empty body when the quote is only the identifier', () => {
    expect(splitQuoteLabel('**AC-2.1**')).toEqual({ label: 'AC-2.1', body: '' })
  })

  /** A BOLDED CLAUSE IS NOT AN IDENTIFIER. Past the cap it stays in the body,
   *  because a label that wraps the header row is worse than no label. */
  it('refuses a run too long to read as a name', () => {
    const long = 'x'.repeat(QUOTE_LABEL_CHARS + 1)
    expect(splitQuoteLabel(`**${long}** — and then some`).label).toBe('')
    expect(splitQuoteLabel(`**${'x'.repeat(QUOTE_LABEL_CHARS)}** — and then some`).label)
      .toBe('x'.repeat(QUOTE_LABEL_CHARS))
  })

  it('an empty quote cuts into two empty halves rather than throwing', () => {
    expect(splitQuoteLabel('')).toEqual({ label: '', body: '' })
  })

  /** THE CLAIM THE REST OF THE FILE DEPENDS ON: cutting a quote for display
   *  changes nothing about where its note lands. */
  it('does not disturb the match — the matcher still sees the verbatim quote', () => {
    const quote = '**AC-2.1** — ct can read one short list'
    const block = flattenOwn(paragraphChildren(quote))
    expect(blockCarries(block, quote)).toBe(true)
  })
})

import { isValidElement, type ReactNode } from 'react'

/**
 * WHICH BLOCK A NOTE IS ABOUT, DERIVED — never stored.
 *
 * A note carries a `quote` and a `section` and NOTHING ELSE about its position.
 * There is no anchor field on the wire, no block id, no offset pair, and this
 * module exists so that there never needs to be one: the anchor is recomputed
 * from the quote against the document as it reads NOW, every render. A stored
 * offset would be a second copy of a fact the document already states, and it
 * would be wrong the moment anyone edits the line above.
 *
 * A NOTE'S EXTENT IS A BLOCK, NOT A PHRASE, and that is what this module used
 * to be twice this size for. It carried a per-leaf character map, a range
 * merger and a tree-rebuilder, all so a quote could be underlined exactly where
 * it sat. Every one of them is gone, because nothing cuts characters back out
 * any more: the question shrank from "which characters" to "does this block
 * carry it", and a boolean needs none of that machinery. Three things went with
 * it and are worth naming, because each was a visible behaviour:
 *
 *   - A quote occurring twice in one block used to pick an occurrence by
 *     position and say so ("appears 2 times in this block — pinned to the
 *     first"). Painting the block makes the question stop existing.
 *   - Two reviewers quoting nested phrases out of one sentence used to get ONE
 *     highlight for two notes, because overlapping ranges were dropped rather
 *     than nested. They now get two notes and one painted block.
 *   - A quote spanning a paragraph that wraps could draw a ragged underline
 *     across several lines. There is no text decoration left to be ragged.
 *
 * THE COMPARISON IS STILL RENDERED-TEXT TO RENDERED-TEXT, and that is still the
 * whole design. A user commenting on `the **keeper** writes it` hands us
 * `the keeper writes it` — the bubble captures the block as the browser painted
 * it, so the asterisks were never in it. The prototype compared that against
 * RAW MARKDOWN (`prdInlineMarked` tests `t.includes(m.quote)` where
 * `t = prdText(b)`, and `prdDoc`'s `locate()` has the identical flaw), so every
 * quote spanning a bold word, a code span or an emphasis failed to match and
 * the note fell loose. That is the exact bug this feature was asked to fix,
 * shipped inside the mock that specifies the fix.
 *
 * So nothing here strips markdown markers to compare. It flattens the RENDERED
 * React subtree — the same elements the browser painted — and compares that.
 * `**bold**` never appears because remark already turned it into a `<strong>`
 * whose child is `bold`. The markdown is parsed by remark, exactly once, for
 * display; this module reads remark's output and parses nothing.
 *
 * `stripMarkers` below is the one concession, and it is a FALLBACK rather than
 * the path: a note filed by `clawmeets plan note --quote` carries whatever the
 * agent pasted, which may well be raw markdown. Matching that needs the markers
 * off the QUOTE — never off the block, which is where the prototype went wrong.
 */

/** The cap on a stored quote, applied on every path that can produce one.
 *
 *  The prototype capped two paths of three (`onComment` and `onAsk` do
 *  `prdPlain(q).slice(0, 120)`; the free-selection path passed `txt` whole), so
 *  a long drag-select stored an unbounded string. The quote is written verbatim
 *  into the plan document and no server-side size limit counts it — the same
 *  blast radius F1 closed — so an uncapped client path is not acceptable.
 *
 *  THE VALUE IS 4000, NOT THE PROTOTYPE'S 120. 120 was a popover-display nicety
 *  and was kept as one until the composer stopped reprinting the quote at all —
 *  the block it is about lights up in the document instead, so there is no
 *  preview left to bound. As a STORAGE bound 120 was always actively harmful
 *  here: truncating a two-sentence capture to 120 characters
 *  produces a string that no longer occurs in the document, so the note it
 *  anchors would be permanently loose — the cap would cause the defect the
 *  feature exists to remove. 4000 is well under `PLAN_LIMITS.noteChars`
 *  (32768), bounds the write, and is long enough that no ordinary paragraph,
 *  heading or list item is cut.
 *
 *  A BLOCK OVER THE CAP IS STORED AS A PREFIX, AND THAT STILL ANCHORS. Both
 *  sides of the match are whitespace-normalised and the test is `includes`, so
 *  a prefix of a block's own text is still carried by that block and still
 *  paints it whole. What it costs is display: the quote is written verbatim
 *  into the plan document, so a listing that echoes it shows a sentence cut
 *  mid-air. That is a display-side truncation to make elsewhere; storing less
 *  is not the answer, because storing less is what breaks the anchor. */
export const PLAN_QUOTE_CHARS = 4000

/** The shortest own-text that offers a comment bubble.
 *
 *  It stops a block with no words OF ITS OWN from offering a quote that could
 *  not anchor. A blockquote's children are all paragraphs and a loose list
 *  item's child is a paragraph, so the container's own text is empty — the
 *  paragraph inside it is the innermost block, and it is the one that carries
 *  the bubble. */
export const MIN_QUOTE_CHARS = 3

/**
 * The one normalisation, applied to BOTH sides of every comparison.
 *
 * Whitespace only. A rendered paragraph that wrapped across three source lines
 * is one run of text on screen but carries newlines in the DOM, and
 * `remark-breaks` turns a single newline into a `<br>` that reads as a space.
 * Collapsing both sides is what makes those agree.
 *
 * It deliberately does NOT touch markdown markers: on the block side there are
 * none left to touch (remark consumed them), and doing it there is precisely
 * the prototype's defect.
 */
export function normalizeText(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

/** Inline markdown markers off a QUOTE, AND NOTHING ELSE TOUCHED.
 *
 *  SPLIT OUT OF `stripMarkers` BECAUSE ITS TWO CALLERS WANT DIFFERENT HALVES OF
 *  IT. Matching wants markers off AND whitespace collapsed, because the other
 *  side of that comparison is a flattened render. DISPLAY wants markers off and
 *  the author's line breaks KEPT — the quote is drawn in a `whitespace-pre-wrap`
 *  blockquote, and collapsing there would silently reflow a multi-line capture
 *  into one run: a second, unrelated change riding along on a marker fix.
 *
 *  It is one regex set rather than two, so what counts as an inline marker
 *  cannot fork between the surface that MATCHES a quote and the surface that
 *  PRINTS it — a quote that anchors and a quote that renders would otherwise be
 *  answering two different questions about the same string.
 *
 *  STILL THE QUOTE SIDE ONLY. Everything the header says about never applying
 *  this to the block text applies verbatim to this function; splitting it moved
 *  no boundary. */
export function dropInlineMarkers(raw: string): string {
  return String(raw ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1$2')
}

/** Inline markdown markers off a QUOTE — the fallback path only. See the header:
 *  applying this to the block text instead is the bug. */
export function stripMarkers(raw: string): string {
  return normalizeText(dropInlineMarkers(raw))
}

/** The longest leading emphasis run that can still be read as an IDENTIFIER
 *  rather than as a phrase. `AC-2.1`, `M2`, `G2`, `PLAN-14` sit far under it;
 *  a bolded clause does not, and a bolded clause hoisted onto the header row
 *  would wrap the row it was meant to fit on. */
export const QUOTE_LABEL_CHARS = 24

/** A quote that OPENS WITH ITS OWN NAME — `**AC-2.1** — ct can read …`.
 *
 *  The two halves are cut here rather than at the card because this is the
 *  module that already knows what an inline marker is; a component that sliced
 *  `**` off a string itself would be the second place in the tree parsing
 *  markdown, and the first one it disagreed with would be this file.
 *
 *  THE SEPARATOR IS THE WHOLE TEST, and it is what keeps an ordinary emphasized
 *  word from being hoisted. `**AC-2.1** — …` names the thing the note is about;
 *  `**Note** this matters` merely stresses a word inside a sentence, and lifting
 *  that onto the header row would put a fragment where a label belongs. So a
 *  label is a leading bold/code run followed by a dash, a colon or the end of
 *  the quote — never by more prose.
 *
 *  DISPLAY ONLY, IN BOTH DIRECTIONS. Nothing here reaches the wire and nothing
 *  here reaches `blockCarries`: the STORED quote stays verbatim, so the text
 *  this splits still anchors against the document exactly as it did. A label
 *  that fails the test is not dropped — it stays in `body`, which is the same
 *  string the card printed before this existed. */
export function splitQuoteLabel(quote: string): { label: string; body: string } {
  const raw = String(quote ?? '')
  const head = /^\s*(?:\*\*([^*\n]+)\*\*|`([^`\n]+)`)(?:\s*(?:[—–:|·-]\s*|$))/.exec(raw)
  const label = (head?.[1] ?? head?.[2] ?? '').trim()
  if (!head || !label || label.length > QUOTE_LABEL_CHARS) {
    return { label: '', body: dropInlineMarkers(raw) }
  }
  return { label, body: dropInlineMarkers(raw.slice(head[0].length)).replace(/^\s+/, '') }
}

/** Normalise and bound, in that order, at the one place a quote is minted.
 *
 *  IDEMPOTENT, deliberately. The cap is applied where a quote is captured (so
 *  the user sees what will be stored) and again where it reaches the wire (so
 *  no path can miss it), and a cut that lands on a space would otherwise leave
 *  a trailing one for the second call to trim — making `cap(cap(x))` a
 *  character shorter than `cap(x)`. Trimming here means the two applications
 *  agree, which is what lets the wire-side call be a guard rather than a second
 *  transformation.
 *
 *  AND IT CUTS ON CHARACTERS, NOT CODE UNITS, WHICH IS A WRITE-PATH CRASH AND
 *  NOT A DISPLAY GLITCH. `slice` counts UTF-16 code units, so a cut landing at
 *  4000 between the halves of a surrogate pair — an emoji, an astral CJK
 *  character, a musical symbol — ends the stored quote on a lone high
 *  surrogate. The string is then not well-formed UTF-16, and idempotence still
 *  holds on it, which is exactly why the cap's own tests could not see it.
 *  `JSON.stringify` escapes the orphan happily, so it crosses the wire, and
 *  Python parses it into a `str` that no strict UTF-8 encoder will accept:
 *  writing that quote into the plan document raises `UnicodeEncodeError:
 *  'utf-8' codec can't encode character '\ud83d' … surrogates not allowed`.
 *  Nothing server-side sanitises it — `add_note` stores `quote` with no length
 *  or encoding validation of any kind — so this is the only place it can be
 *  prevented.
 *
 *  BLOCK CAPTURE MADE THIS PATH ORDINARY RATHER THAN EXOTIC. A drag-select long
 *  enough to hit 4000 characters was a deliberate act; a whole-block capture
 *  reaches it on any paragraph that long, with no user intent involved at all.
 *
 *  Dropping the orphan rather than keeping the whole pair is what preserves the
 *  bound: the result is never longer than `PLAN_QUOTE_CHARS`. Idempotence
 *  survives because what comes back is always well-formed, so a second
 *  application finds nothing left to drop. */
export function capQuote(raw: string): string {
  const q = normalizeText(raw)
  if (q.length <= PLAN_QUOTE_CHARS) return q
  const cut = q.slice(0, PLAN_QUOTE_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  const paired = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
  return paired.trimEnd()
}

/**
 * The text of a rendered run, flattened the way the browser reads it.
 *
 * IT IS HANDED A BLOCK'S OWN CHILDREN, NOT ITS SUBTREE, and that distinction is
 * the whole design of block-scoped notes. `splitOwnChildren` in `planBlocks`
 * partitions a block's children into the inline run it OWNS and the blocks
 * nested under it; this reads the first half only. An outer list item's text is
 * therefore its own bullet rather than its bullet plus everything indented
 * beneath it — so the outer item no longer CONTAINS the inner item's words, the
 * inner block is the only one that can claim a note about them, and
 * "the innermost block wins" falls out of the existing first-match claim map
 * with no block id, no traversal and no new ordering rule.
 *
 * Without that split this change would ship as a regression on every outline in
 * the system: a parent renders before its child, claims are first-match in
 * document order, so the outer item would take a note about an inner bullet and
 * paint the entire subtree with it.
 *
 * NO LEAF ARRAY AND NO OFFSET MAP. It returns a string, because nothing needs
 * to cut characters back out of the tree any more.
 */
export function flattenOwn(children: ReactNode): string {
  let text = ''
  const walk = (node: ReactNode): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string') {
      text += node
      return
    }
    if (typeof node === 'number') {
      text += String(node)
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (isValidElement(node)) {
      const kids = (node.props as { children?: ReactNode }).children
      if (kids !== undefined) walk(kids)
    }
  }
  walk(children)
  return normalizeText(text)
}

/**
 * Does this block's own text carry the quote?
 *
 * Direct match first, then the markers-off-the-QUOTE fallback for a note filed
 * by `clawmeets plan note --quote` with raw markdown in it. It never strips
 * markers off the BLOCK — that was the prototype's defect and it is still the
 * defect.
 *
 * A BOOLEAN, NOT A RANGE. Offsets are gone because nothing paints a range, and
 * the occurrence count went with them.
 *
 * `ownText` is expected to be `flattenOwn`'s output, i.e. already normalised;
 * the quote is normalised here because it arrives off the wire.
 */
export function blockCarries(ownText: string, quote: string): boolean {
  if (!ownText) return false
  const direct = normalizeText(quote)
  if (direct && ownText.includes(direct)) return true
  const stripped = stripMarkers(quote)
  return !!stripped && stripped !== direct && ownText.includes(stripped)
}

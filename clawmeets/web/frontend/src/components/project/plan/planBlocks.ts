/**
 * WHAT A BLOCK IS, AS PURE FUNCTIONS — the string surgery behind click-to-edit
 * and the one question about a block's SHAPE that both features ask, separated
 * from the component so the refusals below can be asserted without mounting
 * anything (the same reason `planTrayLogic` exists).
 *
 * `BLOCK_LEVEL` is the fact both halves share, which is why they live together:
 * editing asks it about a hast node to decide whether a tab stop opens a
 * subtree (`containsBlock`), and commenting asks it about a rendered child to
 * decide where one block's own text ends and its children's begins
 * (`splitOwnChildren`). Two spellings of the same list in two files is how they
 * would come to disagree.
 *
 * THIS MODULE DOES NOT PARSE MARKDOWN AND DOES NOT SCAN. Both numbers in a
 * `BlockRange` are read straight off `node.position` — remark's own report
 * about the parse that produced the pixels on screen — and they are relative
 * to the text that ONE `ReactMarkdown` instance was handed, which is exactly
 * one section. `PlanBody` has always read `start.offset` (it is the block
 * identity in the note-claim map); this reads `end.offset` beside it.
 *
 * The invariant that matters is unchanged: THE CLIENT NEVER RE-DERIVES SECTION
 * STRUCTURE BY SCANNING THE BODY. Sections still come from the server's
 * `char_start`/`char_end`, a splice never crosses a section boundary, and no
 * heading, slug or box count is computed anywhere below.
 *
 * WHY THE SEPARATOR SURVIVES A SPLICE, which is the sharpest edge here: remark
 * ends a block AT ITS LAST CHARACTER, so the blank line, the newline and the
 * fence that follow it are all outside `end.offset` and are carried across
 * verbatim by the tail slice. Nothing in this file adds or trims a newline —
 * doing so is how two blocks weld into one.
 */

import { isValidElement, type ReactNode } from 'react'

/** A block's character range inside ONE section's Markdown. */
export interface BlockRange {
  start: number
  end: number
}

/** What this module reads off react-markdown's `node` — a hast element, which
 *  carries the position of the mdast node it was built from. Narrowed to the
 *  three members used, so nothing here can start depending on hast's shape. */
export interface BlockNode {
  tagName?: string
  position?: { start?: { offset?: number }; end?: { offset?: number } }
  children?: BlockNode[]
}

/** The tags whose raw Markdown a click may open.
 *
 *  `td`/`th` are absent and that is a grammar refusal, not an oversight: a
 *  cell's range is `"| a "` — pipe included, closing pipe not — so splicing one
 *  rewrites the table's structure rather than its content. */
const EDITABLE_TAGS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'])

/** Anything that makes a block a CONTAINER rather than a line. */
const BLOCK_LEVEL = new Set([
  'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr', 'div', 'dl',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
])

/**
 * Does this node hold another BLOCK inside it — is it a CONTAINER whose range
 * spans a nested subtree rather than one line?
 *
 * EXPORTED BECAUSE IT IS NO LONGER A REFUSAL. `editableRange` used to turn a
 * `true` here into `null`; it now allows the container, so the only question
 * left is what to CALL one. `PlanBody` asks this to name the tab stop — a
 * container has to announce that it opens the whole subtree and not a line —
 * and nothing else reads it.
 */
export function containsBlock(node: BlockNode): boolean {
  for (const child of node.children ?? []) {
    if (child.tagName && BLOCK_LEVEL.has(child.tagName)) return true
    if (containsBlock(child)) return true
  }
  return false
}

/** The tag a rendered child was built from.
 *
 *  TWO SOURCES, AND BOTH ARE NEEDED. A child react-markdown rendered with a
 *  plain tag (`ul`, `ol`) has that tag as its `type`; a child it rendered
 *  through a component in the `components` map (`p`, `li`, `blockquote`… — the
 *  ones `PlanBody` substitutes) has a FUNCTION as its type, and its tag is only
 *  legible through the `node` prop react-markdown passes alongside. Reading
 *  `type` alone would miss every paragraph inside a blockquote; reading `node`
 *  alone would miss every nested list. */
function childTag(child: ReactNode): string {
  if (!isValidElement(child)) return ''
  const tag = (child.props as { node?: { tagName?: string } }).node?.tagName
  if (tag) return tag
  return typeof child.type === 'string' ? child.type : ''
}

/**
 * A block's rendered children, split into the run it OWNS and the blocks nested
 * under it.
 *
 * `own` is what the comment bubble captures and what gets painted when a note
 * is on the block; `nested` is re-emitted untouched so the subtree still
 * renders exactly as it did. Concatenating the two in order reproduces
 * `children`, which is why an unnoted block looks byte-identical to before.
 *
 * ONE PASS, NO RECURSION, and it does not need any. Markdown puts a container's
 * own inline content before its block children — an outline item's bullet text
 * precedes the nested list, a blockquote's paragraphs are all it has — so the
 * partition is by element type at the TOP LEVEL only. Nothing here needs to
 * know the shape of anything deeper, because the block one level down is
 * itself a `PlanBlock` that will ask this same question about its own children.
 *
 * THAT RECURSION-BY-RENDERING IS WHAT MAKES "INNERMOST WINS" FREE. See
 * `flattenOwn`: an outer item whose own text excludes its inner items' words
 * cannot claim a note about them, so the claim map arbitrates correctly with no
 * block id and no ordering rule added.
 *
 * A CONTAINER WITH NO OWN TEXT IS THE ACCEPTED COST. A blockquote's children
 * are all paragraphs and a loose list item's child is a paragraph, so `own` is
 * empty and `MIN_QUOTE_CHARS` suppresses the bubble: you comment on the
 * paragraphs inside such a block, not on the block as a whole. That is
 * consistent with innermost-wins rather than an exception to it.
 */
export function splitOwnChildren(children: ReactNode): {
  own: ReactNode[]
  nested: ReactNode[]
} {
  const own: ReactNode[] = []
  const nested: ReactNode[] = []
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || typeof child === 'boolean') continue
    if (BLOCK_LEVEL.has(childTag(child))) nested.push(child)
    else own.push(child)
  }
  return { own, nested }
}

/**
 * WHICH BLOCKS ARE EDITABLE — and the refusal that became the feature.
 *
 * A CONTAINER OPENS AS ITS WHOLE NESTED SUBTREE, AND THE SWALLOW IS THE POINT.
 * `end.offset` spans a node's entire subtree, so a list item with a nested list
 * under it opens as its own bullet AND everything indented beneath it, and a
 * blockquote opens with its `> ` markers and every paragraph inside them. This
 * function used to refuse exactly that — `if (containsBlock(node)) return null`
 * — on the grounds that committing a container would SWALLOW its children. It
 * does swallow them, and that is the edit a reader of an outline actually
 * wants: re-ordering three sub-bullets, promoting one out of its parent, or
 * turning a two-line quote into three is a change to the SUBTREE, and no
 * per-line editor can express it. The old advice — "editable ONE LEVEL DOWN" —
 * could reach every line of an outline and never its shape.
 *
 * NOTHING ABOUT THE SPLICE HAD TO CHANGE FOR THAT TO BE SAFE, which is the
 * whole reason this is a one-line allow rather than a mechanism. The range was
 * always remark's own report about the parse that produced the pixels, a
 * container's `end.offset` still stops at its last character (so the blank line
 * and the fence after it still live in the tail slice), and re-splicing a
 * subtree with its own text is still the identity. What a container costs is
 * that the text a user is handed is longer, not that it is derived differently.
 *
 * WHAT THE CALLER STILL OWES IS RESOLUTION, NOT REFUSAL. Blocks nest, so a
 * pointer inside a nested item is inside its parent too. This function is asked
 * about ONE node and knows nothing about the pointer, so it answers about that
 * node alone; `PlanBody` decides which of the several editable blocks under the
 * cursor wins, and the rule there is that the innermost one does.
 *
 * TWO REFUSALS SURVIVE, and neither is about nesting. A TABLE CELL (absent from
 * `EDITABLE_TAGS` — see above) is refused because its range is `"| a "` with the
 * closing pipe outside it, so splicing one rewrites the table's grammar rather
 * than its content; that is true whether or not anything nests, and this change
 * does not touch it. And a node with NO USABLE `position` is a synthesized node
 * that was never in the source, so there is nothing to slice.
 *
 * A REFUSAL IS STILL NOT A DEAD END, and it is now less of one: a table nested
 * inside a list item is reachable through that item's subtree, and the section's
 * `Edit raw Markdown` button remains the honest tool for a top-level table or a
 * fenced block.
 *
 * NO ID IS INTRODUCED HERE AND NONE IS WANTED. A container's range comes from
 * the same `node.position` every other range comes from, recomputed against the
 * document as it reads now — there is no block id, no content hash and no
 * stored offset in this module. A subtree edit does not create the problem one
 * would answer: a note whose quote survives the rewrite re-anchors by quote
 * exactly as it always did, and one whose quote is gone goes loose at the end
 * of its own section. A subtree edit makes that MORE LIKELY; it does not make
 * it different in kind from any single-line edit, and it loses no note.
 */
export function editableRange(node: BlockNode | undefined, tag: string): BlockRange | null {
  if (!node || !EDITABLE_TAGS.has(tag)) return null
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return null
  return { start, end }
}

/** A block's own Markdown, sliced out of its section. */
export function blockSource(sectionSrc: string, r: BlockRange): string {
  return sectionSrc.slice(r.start, r.end)
}

/**
 * Put `next` back where the block was.
 *
 * Pure string surgery on ONE section: it never touches `body`, never crosses a
 * section boundary, and the caller hands the result to `editRow`, which refuses
 * a no-op. A range that does not fit the string it is being applied to is a
 * stale render, and the answer is to change nothing — `editRow` then sees
 * byte-identical text and stages no row, which is the same "nothing moved"
 * outcome an unedited blur produces.
 */
export function spliceBlock(sectionSrc: string, r: BlockRange, next: string): string {
  if (r.start < 0 || r.end > sectionSrc.length || r.end <= r.start) return sectionSrc
  return sectionSrc.slice(0, r.start) + next + sectionSrc.slice(r.end)
}

/** The task-item marker: the bullet, the box, and the state inside it. */
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/

/** Is this block a ticked box, an unticked one, or not a task item at all?
 *  `null` is the third answer and the caller needs it: a block that is not a
 *  task item renders no checkbox affordance. */
export function taskChecked(blockSrc: string): boolean | null {
  const m = TASK.exec(blockSrc)
  if (!m) return null
  return m[2] !== ' '
}

/**
 * `- [ ] ship it` ⇄ `- [x] ship it`, or `null` when the block is not a task
 * item.
 *
 * TICKING A BOX IS AN ORDINARY SECTION EDIT. There is no checkbox state
 * machine anywhere, client or server — `PlanSection.boxes` is a display count
 * the server derives — so this returns text for the same splice every other
 * edit goes through, and the tick lands in the same batch as everything else.
 */
export function toggleCheckbox(blockSrc: string): string | null {
  const m = TASK.exec(blockSrc)
  if (!m) return null
  const at = m[1].length
  return blockSrc.slice(0, at) + (m[2] === ' ' ? 'x' : ' ') + blockSrc.slice(at + 1)
}

/**
 * HTML COMMENTS RENDER TO NOTHING — restoring, deliberately, what used to be
 * true by accident.
 *
 * A plan's `<!-- evidence: … -->` lines are the agents' layer, not the reader's:
 * `normalize_spec_text` folds them out of the spec digest so swapping a test is
 * not a change the user has to accept, and `strip_comments` folds them out of
 * the reading view `plan show --clean` returns. `plan_markdown._is_anchorable`
 * goes further and refuses to anchor a note to a comment-only line, on the
 * stated grounds that such a line "provably cannot be found" in the rendered
 * DOM. Every one of those rules assumes the browser hides the comment too.
 *
 * IT USED TO, FOR A REASON THAT NO LONGER HOLDS. `PlanBody` mounts
 * `ReactMarkdown` with no `rehype-raw`, so a comment reaches the hast tree as a
 * `raw` node and never becomes an element. Through react-markdown 8 an unhandled
 * `raw` node was spliced out of the tree; from 9 it is converted to a TEXT node
 * instead, so the same document that rendered nothing now renders
 * `<!-- evidence: … -->` to the user verbatim. Nothing in the repo asserted the
 * old behaviour, so the upgrade carried it away silently.
 *
 * WHY NOT `skipHtml`. The one-prop version of this fix drops every raw node, so
 * a `<br>` or a `<details>` written in prose vanishes rather than showing as the
 * literal text it shows today — a second behaviour change riding along with the
 * first. It also leaves the line break BEFORE the comment behind, which is the
 * artifact this plugin exists to avoid: remark-breaks turns the newline that put
 * the comment on its own line into a `<br>`, and a `<br>` whose line is now empty
 * is a blank line under every criterion. So this removes exactly two things —
 * a raw node that is nothing but one comment, and the break that opened its
 * line — and touches no other HTML.
 *
 * WHY NOT STRIP THE TEXT INSTEAD. The plan editor cannot be handed the server's
 * comment-free body: click-to-edit splices a block back into its section using
 * remark's raw character offsets, so the string the renderer parses has to be
 * the byte-exact stored text. Removing comments from the INPUT would shift every
 * offset after them. Removing them from the OUTPUT leaves the offsets alone — a
 * comment still sits inside its criterion's range, so opening that criterion to
 * edit still shows the evidence line in the textarea, which is where the writing
 * agent needs it.
 */

/** The slice of hast this walks. Deliberately not imported from `hast`: the
 *  three members below are all this touches, and react-markdown's tree is
 *  reached through a transitive dependency whose types we do not pin. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  children?: HastNode[]
}

/**
 * A raw node that is EXACTLY ONE comment and nothing else.
 *
 * The inner `(?!-->)` matters. A greedy `[\s\S]*-->` also matches
 * `<!-- a --> visible <!-- b -->`, which markdown hands over as a single raw
 * block, and dropping that node would take the visible text with it. Requiring
 * that no `-->` appear before the last one confines this to the single-comment
 * case and leaves every mixed node rendering as it does today.
 */
const SOLE_COMMENT = /^\s*<!--(?:(?!-->)[\s\S])*-->\s*$/

function isComment(n: HastNode): boolean {
  return n.type === 'raw' && typeof n.value === 'string' && SOLE_COMMENT.test(n.value)
}

/** Whitespace between nodes is layout, not content, so a comment separated from
 *  its line break by a `"\n"` text node still counts as alone on its line. */
function isBlank(n: HastNode): boolean {
  return n.type === 'text' && !(n.value ?? '').trim()
}

/** The nearest sibling on either side that carries content, skipping blanks.
 *  `null` at the edge of the parent, which reads the same as a line boundary. */
function neighbour(kids: HastNode[], from: number, step: -1 | 1): number | null {
  for (let i = from; i >= 0 && i < kids.length; i += step) {
    if (!isBlank(kids[i])) return i
  }
  return null
}

/** Collect, from one parent's children, every node the render should not see. */
function condemn(kids: HastNode[], doomed: Set<HastNode>): void {
  for (let i = 0; i < kids.length; i++) {
    if (!isComment(kids[i])) continue
    doomed.add(kids[i])

    // Only a comment that OWNS its line takes the line's break with it. One
    // sitting mid-sentence (`text <!-- c --> text`) is dropped alone, because
    // there is no break there that belongs to it.
    const before = neighbour(kids, i - 1, -1)
    const after = neighbour(kids, i + 1, 1)
    const opens = before === null || kids[before].tagName === 'br'
    const closes = after === null || kids[after].tagName === 'br'
    if (!opens || !closes) continue

    // Prefer the break that OPENED the line; a comment that starts its parent
    // has none, so the break that closes it is the one to take. Either way the
    // blanks in between go too, or they collapse into the neighbouring line.
    if (before !== null) {
      for (let j = before; j < i; j++) doomed.add(kids[j])
    } else if (after !== null) {
      for (let j = i + 1; j <= after; j++) doomed.add(kids[j])
    }
  }
}

function prune(node: HastNode): void {
  const kids = node.children
  if (!kids) return
  for (const kid of kids) prune(kid)
  const doomed = new Set<HastNode>()
  condemn(kids, doomed)
  if (doomed.size) node.children = kids.filter((k) => !doomed.has(k))
}

/**
 * A rehype plugin: pass it in `rehypePlugins` and comments stop reaching the
 * document. It runs BEFORE react-markdown's own raw-to-text conversion — that
 * conversion is a `visit` over the tree this returns — so a node removed here
 * is never given a chance to become text.
 */
export default function rehypeHideComments() {
  return (tree: HastNode): void => prune(tree)
}

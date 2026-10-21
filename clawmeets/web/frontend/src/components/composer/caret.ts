/**
 * Caret helpers for the contentEditable `PromptEditor`.
 *
 * The whole design rests on one invariant: **there is exactly one plain-text
 * coordinate space**, produced by `walkDom` in `placeholders.ts`. `getText()`
 * serializes through it, `caretOffset()` measures through it, and
 * `selectPlainRange()` maps back through it. Anything that computes an offset
 * some other way will drift the moment a chip is involved.
 */
import { domText, walkDom, type PhChip } from './placeholders'

type Chips = Record<string, PhChip>

/** Put the caret at the very end of the editable and focus it. */
export function caretToEnd(root: HTMLElement): void {
  root.focus()
  const r = document.createRange()
  r.selectNodeContents(root)
  r.collapse(false)
  const s = window.getSelection()
  if (!s) return
  s.removeAllRanges()
  s.addRange(r)
}

/** Put the caret immediately after `node` (used after filling a chip). */
export function caretAfter(node: Node, root: HTMLElement): void {
  const s = window.getSelection()
  if (!s) return
  const r = document.createRange()
  r.setStartAfter(node)
  r.collapse(true)
  s.removeAllRanges()
  s.addRange(r)
  root.focus()
}

/**
 * The caret's index into the plain-text serialization, or -1 when the
 * selection isn't inside `root`.
 *
 * Rather than hand-walking the tree to the anchor — which has to special-case
 * text nodes, element boundaries and chip interiors — we clone everything
 * *before* the caret into a detached div and run the same serializer over it.
 * Correct by construction, and cheap: the clone is a few hundred characters,
 * well under a frame. Cloned chips keep their `data-ph`, so they resolve from
 * the same chip map.
 */
export function caretOffset(root: HTMLElement, chips: Chips): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return -1
  const focus = sel.focusNode
  if (!focus || !root.contains(focus)) return -1

  const r = sel.getRangeAt(0).cloneRange()
  r.collapse(true)
  const pre = document.createRange()
  pre.selectNodeContents(root)
  try {
    pre.setEnd(r.startContainer, r.startOffset)
  } catch {
    return -1
  }
  const host = document.createElement('div')
  host.appendChild(pre.cloneContents())
  return domText(host, chips).length
}

/**
 * Select the plain-text range [start, end) inside `root`.
 *
 * Returns false — rather than throwing — when either endpoint falls inside a
 * chip's expansion, which has no corresponding text position. Unreachable for
 * @mention insertion (a mention is always typed into a text node), but a
 * silent no-op beats a crash if a caller ever asks for one.
 */
export function selectPlainRange(
  root: HTMLElement,
  chips: Chips,
  start: number,
  end: number,
): boolean {
  const { segs } = walkDom(root, (id) => {
    const c = chips[id]
    if (!c) return ''
    return c.value || '[' + c.label + ']'
  })
  if (segs.length === 0) return false

  // Find the text node containing `offset`. `<=` on the upper bound so an
  // offset at a node's very end resolves to that node rather than falling
  // through to the next one.
  const locate = (offset: number): { node: Text; at: number } | null => {
    for (const s of segs) {
      const len = s.node.nodeValue?.length ?? 0
      if (offset >= s.start && offset <= s.start + len) {
        return { node: s.node, at: offset - s.start }
      }
    }
    return null
  }

  const a = locate(start)
  const b = locate(end)
  if (!a || !b) return false

  const sel = window.getSelection()
  if (!sel) return false
  const r = document.createRange()
  try {
    r.setStart(a.node, a.at)
    r.setEnd(b.node, b.at)
  } catch {
    return false
  }
  sel.removeAllRanges()
  sel.addRange(r)
  return true
}

/**
 * Insert a line break at the caret.
 *
 * `execCommand('insertLineBreak')` is **not implemented in Firefox** (it
 * returns false and does nothing), so without the fallback plain Enter would
 * silently do nothing there. The fallback also appends a second `<br>` when
 * the caret is at the end of the content, because a trailing `<br>` isn't
 * rendered on its own and the new line would appear to not exist.
 */
export function insertLineBreakAtCaret(root: HTMLElement): void {
  try {
    if (document.execCommand('insertLineBreak')) return
  } catch {
    /* fall through */
  }

  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const r = sel.getRangeAt(0)
  r.deleteContents()

  const br = document.createElement('br')
  r.insertNode(br)

  // If nothing follows the break, a bare trailing <br> collapses — add a
  // second one so the caret has a line to sit on.
  const needsTrailing = !br.nextSibling
  if (needsTrailing) {
    const pad = document.createElement('br')
    br.parentNode?.insertBefore(pad, br.nextSibling)
  }

  const after = document.createRange()
  after.setStartAfter(br)
  after.collapse(true)
  sel.removeAllRanges()
  sel.addRange(after)
  root.focus()
}

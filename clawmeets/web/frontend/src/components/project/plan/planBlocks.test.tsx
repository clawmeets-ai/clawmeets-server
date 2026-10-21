import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {
  blockSource,
  containsBlock,
  editableRange,
  spliceBlock,
  splitOwnChildren,
  taskChecked,
  toggleCheckbox,
  type BlockNode,
  type BlockRange,
} from './planBlocks'

// followup B11. `vitest.config.ts` sets `globals: false`, so testing-library's
// auto-cleanup never registers: a render left standing here stays MOUNTED, and
// mounted means still subscribed to every store it reads and still holding
// every timer its effects started. The next file's fixture then re-renders it
// and re-fires those effects, in a file that has no idea this component exists.
// Audited suite-wide in M5; asserted by `src/test/suiteHygiene.test.ts`.
afterEach(cleanup)

/**
 * THE SPLICE, AND THE REFUSALS.
 *
 * MOST OF THIS DRIVES THE REAL RENDERER rather than hand-written offsets, and
 * that is deliberate: the whole claim of this feature is that the range comes
 * from remark's own report about the parse that produced the pixels, so a test
 * that supplied its own numbers would be asserting nothing about the thing that
 * can actually break. `collect` renders a section exactly as `PlanBody` does —
 * same plugins, same one-parse-per-section — and hands back what each block
 * component was offered.
 *
 * The sharpest edge here is the SEPARATOR. A block's `end.offset` stops at its
 * last character, so the blank line, the newline and the fence after it live in
 * the tail slice and must survive verbatim; getting that wrong welds two blocks
 * into one, silently, in a document a human then has to un-merge by hand. It
 * gets its own case per shape: last block in a section, block followed by a
 * blank line, block followed by a fence, block followed by a table.
 */

const TAGS = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th'] as const

interface Seen {
  tag: string
  range: BlockRange | null
  /** Does this node hold another block? `PlanBody` reads exactly this to decide
   *  whether the tab stop is named for a line or for a whole subtree. */
  whole: boolean
}

/** Every block the renderer offered, in document order, with the verdict
 *  `PlanBody` would have reached about it. */
function collect(src: string): Seen[] {
  const seen: Seen[] = []
  const make = (tag: string) => {
    const C = ({ node, children }: { node?: BlockNode; children?: React.ReactNode }) => {
      seen.push({ tag, range: editableRange(node, tag), whole: !!node && containsBlock(node) })
      return <span>{children}</span>
    }
    C.displayName = `Probe(${tag})`
    return C
  }
  const components = Object.fromEntries(TAGS.map((t) => [t, make(t)]))
  render(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components as never}>
      {src}
    </ReactMarkdown>,
  )
  return seen
}

/** The first editable block of a given tag, and its source. */
function firstEditable(src: string, tag: string): { range: BlockRange; text: string } {
  const hit = collect(src).find((s) => s.tag === tag && s.range)!
  return { range: hit.range!, text: blockSource(src, hit.range!) }
}

describe('a range is remark’s own, and a block’s source is what the user sees', () => {
  it('a paragraph opens as its own text, with no separator on either end', () => {
    const src = '## Goal\n\nThe keeper writes it.\n\nAnd nobody else does.\n'
    const { text } = firstEditable(src, 'p')
    expect(text).toBe('The keeper writes it.')
  })

  it('a heading opens WITH its marker — renaming one is a legitimate edit', () => {
    const { text } = firstEditable('## Goal\n\nsomething\n', 'h2')
    expect(text).toBe('## Goal')
  })

  it('a list item opens WITH its bullet, so a box can be ticked by hand', () => {
    const { text } = firstEditable('## M\n\n- [ ] ship it\n- done\n', 'li')
    expect(text).toBe('- [ ] ship it')
  })

  it('a nested item keeps its indentation OUTSIDE the range, so a splice cannot lose it', () => {
    const src = '## M\n\n- outer\n  - inner one\n'
    const items = collect(src).filter((s) => s.tag === 'li' && s.range)
    // BOTH are editable since change 2 — the outer as its whole subtree, the
    // inner as its own line. What matters here is the inner one: its range
    // starts at the bullet and not at the indent, so a splice cannot lose the
    // two spaces that make it nested.
    expect(items).toHaveLength(2)
    const inner = items[1]
    expect(blockSource(src, inner.range!)).toBe('- inner one')
    expect(spliceBlock(src, inner.range!, '- inner two')).toBe('## M\n\n- outer\n  - inner two\n')
  })

  it("a quote's PARAGRAPH still opens without the `> ` marker", () => {
    const src = '## Goal\n\n> mind the gap\n'
    const { text, range } = firstEditable(src, 'p')
    expect(text).toBe('mind the gap')
    expect(spliceBlock(src, range, 'mind the step')).toBe('## Goal\n\n> mind the step\n')
  })
})

/**
 * THE REFUSAL THAT BECAME THE FEATURE (AC-3.1, AC-3.2, AC-3.3).
 *
 * Three of the cases below used to assert `range === null` and now assert the
 * subtree. They were not deleted and re-pointed at something else: the same
 * documents, the same tags, the opposite verdict — which is what makes the diff
 * legible as a decision rather than as a test that stopped being run.
 */
describe('a container opens as its whole nested subtree', () => {
  it('a list item with a nested list under it opens as ALL of it', () => {
    const src = '## M\n\n- outer\n  - inner\n'
    const seen = collect(src).filter((s) => s.tag === 'li')
    expect(seen).toHaveLength(2)
    // The outer item — the one that used to be refused for "swallowing" its
    // children — is the container, and the swallow is the range.
    expect(seen[0].whole).toBe(true)
    expect(blockSource(src, seen[0].range!)).toBe('- outer\n  - inner')
    // The inner one is still a line, and still its own editable unit.
    expect(seen[1].whole).toBe(false)
    expect(blockSource(src, seen[1].range!)).toBe('- inner')
  })

  it('committing a subtree re-orders its children — the edit no per-line field can express', () => {
    const src = '## M\n\n- outer\n  - first\n  - second\n\nafter\n'
    const outer = collect(src).filter((s) => s.tag === 'li' && s.whole)[0]
    expect(blockSource(src, outer.range!)).toBe('- outer\n  - first\n  - second')
    expect(spliceBlock(src, outer.range!, '- outer\n  - second\n  - first')).toBe(
      '## M\n\n- outer\n  - second\n  - first\n\nafter\n',
    )
  })

  it('a blockquote opens WITH its `> ` markers, which is what its paragraph cannot do', () => {
    const src = '## G\n\n> said so\n> and more\n\nafter\n'
    const bq = collect(src).filter((s) => s.tag === 'blockquote')[0]
    expect(bq.whole).toBe(true)
    expect(blockSource(src, bq.range!)).toBe('> said so\n> and more')
    expect(spliceBlock(src, bq.range!, '> said so\n> and rather more')).toBe(
      '## G\n\n> said so\n> and rather more\n\nafter\n',
    )
    // WHY THE QUOTE ITSELF IS THE USEFUL UNIT AND NOT ONLY THE PARAGRAPH: the
    // inner paragraph's range starts INSIDE the first `> ` and runs across the
    // second one, so retyping it means retyping a marker in the middle of the
    // text. Adding or removing a line of a multi-line quote is a subtree edit.
    const inner = collect(src).filter((s) => s.tag === 'p' && s.range)[0]
    expect(blockSource(src, inner.range!)).toBe('said so\n> and more')
  })

  it("a loose list's item opens as its own bullet, paragraph and all", () => {
    const src = '## M\n\n- one\n\n- two\n'
    const items = collect(src).filter((s) => s.tag === 'li')
    expect(items.map((i) => i.whole)).toEqual([true, true])
    expect(items.map((i) => blockSource(src, i.range!))).toEqual(['- one', '- two'])
    // …and the paragraphs inside them are STILL editable, so the line remains
    // reachable on its own. Nothing was traded for the container.
    expect(collect(src).filter((s) => s.tag === 'p' && s.range)).toHaveLength(2)
  })

  it('a table nested in a list item is reachable through the item, not through a cell', () => {
    const src = '## M\n\n- outer\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n'
    const seen = collect(src)
    const li = seen.filter((s) => s.tag === 'li')[0]
    expect(li.whole).toBe(true)
    expect(blockSource(src, li.range!)).toContain('| 1 | 2 |')
    // The cells themselves are still refused — see AC-3.3 below.
    expect(seen.filter((s) => s.tag === 'td' || s.tag === 'th').every((c) => !c.range)).toBe(true)
  })

  it('a plain line is not a container, so nothing about its name or range moved', () => {
    const seen = collect('## Goal\n\nOne sentence.\n\n- a bullet\n')
    for (const s of seen.filter((x) => ['p', 'li', 'h2'].includes(x.tag))) {
      expect(s.whole).toBe(false)
      expect(s.range).not.toBeNull()
    }
  })
})

describe('the refusals that survive — and neither of them is about nesting', () => {
  it('refuses a table cell — splicing one would rewrite the grammar, not the content', () => {
    const seen = collect('## M\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')
    const cells = seen.filter((s) => s.tag === 'td' || s.tag === 'th')
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every((s) => s.range === null)).toBe(true)
  })

  it('refuses a node with no position at all', () => {
    expect(editableRange({ tagName: 'p' }, 'p')).toBeNull()
    expect(editableRange({ position: { start: {}, end: {} } }, 'p')).toBeNull()
    expect(editableRange(undefined, 'p')).toBeNull()
  })

  it('refuses a tag that is not in the editable set, however good its position', () => {
    expect(editableRange({ position: { start: { offset: 0 }, end: { offset: 4 } } }, 'pre')).toBeNull()
    expect(editableRange({ position: { start: { offset: 0 }, end: { offset: 4 } } }, 'td')).toBeNull()
    // A whole list is not a unit either: `ul`/`ol` are not tags a click opens,
    // so an outline is edited item by item or subtree by subtree.
    expect(editableRange({ position: { start: { offset: 0 }, end: { offset: 4 } } }, 'ul')).toBeNull()
  })

  it('a container that is REFUSED for another reason is still refused', () => {
    // `containsBlock` is no longer part of the verdict, so a cell holding a
    // block would not sneak through on it.
    const cell: BlockNode = {
      tagName: 'td',
      position: { start: { offset: 0 }, end: { offset: 9 } },
      children: [{ tagName: 'p' }],
    }
    expect(containsBlock(cell)).toBe(true)
    expect(editableRange(cell, 'td')).toBeNull()
  })
})

/**
 * NO ID, NO HASH, NO STORED OFFSET (AC-3.5).
 *
 * The module's whole surface is asserted here rather than described, so adding
 * an export — `blockId`, `blockHash`, an anchor of any kind — fails a test
 * instead of passing review. A range is derived per parse and never stored;
 * `containsBlock` answers a naming question, `splitOwnChildren` partitions a
 * rendered subtree, and neither holds state.
 *
 * `splitOwnChildren` IS THE ONE THAT HAD TO EARN ITS PLACE HERE. Block-scoped
 * notes need to know which block owns which words, and the obvious way to
 * answer that is a block id — which is exactly what this whole design refuses.
 * It answers instead by PARTITION, off the same `BLOCK_LEVEL` list editing
 * already reads, and it returns children rather than a name for them.
 */
describe('the module introduces no identity for a block', () => {
  it('exports exactly what it had, plus the partition — and no identity', async () => {
    const mod = await import('./planBlocks')
    expect(Object.keys(mod).sort()).toEqual([
      'blockSource',
      'containsBlock',
      'editableRange',
      'spliceBlock',
      'splitOwnChildren',
      'taskChecked',
      'toggleCheckbox',
    ])
  })

  it('a range carries two numbers and nothing else — no id rides along', () => {
    const { range } = firstEditable('## M\n\n- outer\n  - inner\n', 'li')
    expect(Object.keys(range).sort()).toEqual(['end', 'start'])
  })

  it('the same block parsed twice yields the same range, because it is derived', () => {
    const src = '## M\n\n- outer\n  - inner\n'
    expect(collect(src).map((s) => s.range)).toEqual(collect(src).map((s) => s.range))
  })
})

describe('THE SEPARATOR SURVIVES — two blocks must never weld into one', () => {
  /** Re-splicing a block with its own text must be the identity. If a
   *  separator were inside the range, this is where it would vanish. */
  const roundTrips = (src: string) => {
    for (const s of collect(src)) {
      if (!s.range) continue
      expect(spliceBlock(src, s.range, blockSource(src, s.range))).toBe(src)
    }
  }

  it('the last block in a section, with no trailing newline at all', () => {
    const src = '## Goal\n\nthe final word'
    roundTrips(src)
    const { range } = firstEditable(src, 'p')
    expect(spliceBlock(src, range, 'a final word')).toBe('## Goal\n\na final word')
  })

  it('a block followed by a blank line keeps BOTH newlines', () => {
    const src = '## Goal\n\nfirst para\n\nsecond para\n'
    roundTrips(src)
    const { range } = firstEditable(src, 'p')
    expect(spliceBlock(src, range, 'FIRST')).toBe('## Goal\n\nFIRST\n\nsecond para\n')
  })

  it('a block followed by a fenced code block keeps the fence intact', () => {
    const src = '## Goal\n\nrun this\n\n```ts\nconst ok = true\n```\n'
    roundTrips(src)
    const { range } = firstEditable(src, 'p')
    expect(spliceBlock(src, range, 'run that')).toBe(
      '## Goal\n\nrun that\n\n```ts\nconst ok = true\n```\n',
    )
  })

  it('a block followed by a table keeps the table parseable', () => {
    const src = '## Goal\n\nsee below\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    roundTrips(src)
    const { range } = firstEditable(src, 'p')
    expect(spliceBlock(src, range, 'see this')).toBe(
      '## Goal\n\nsee this\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    )
  })

  it('a list item in the middle of a list keeps its siblings on their own lines', () => {
    const src = '## M\n\n- one\n- two\n- three\n'
    roundTrips(src)
    const items = collect(src).filter((s) => s.tag === 'li' && s.range)
    expect(spliceBlock(src, items[1].range!, '- TWO')).toBe('## M\n\n- one\n- TWO\n- three\n')
  })

  it('a heading spliced at the top of its section leaves the body untouched', () => {
    const src = '## Goal\n\nbody text\n'
    const { range } = firstEditable(src, 'h2')
    expect(spliceBlock(src, range, '## Purpose')).toBe('## Purpose\n\nbody text\n')
  })
})

describe('a splice refuses a range that does not fit the string it is given', () => {
  /* A stale render is the case: the answer is to change nothing, so `editRow`
   * sees byte-identical text upstream and stages no row. */
  const src = 'short'
  it('changes nothing when the range runs past the end', () => {
    expect(spliceBlock(src, { start: 0, end: 99 }, 'x')).toBe(src)
  })
  it('changes nothing on a negative or inverted range', () => {
    expect(spliceBlock(src, { start: -1, end: 3 }, 'x')).toBe(src)
    expect(spliceBlock(src, { start: 4, end: 2 }, 'x')).toBe(src)
    expect(spliceBlock(src, { start: 2, end: 2 }, 'x')).toBe(src)
  })
})

describe('ticking a box is an ordinary edit, and nothing else is a box', () => {
  it('flips both ways and touches only the one character', () => {
    expect(toggleCheckbox('- [ ] ship it')).toBe('- [x] ship it')
    expect(toggleCheckbox('- [x] ship it')).toBe('- [ ] ship it')
    expect(toggleCheckbox('- [X] ship it')).toBe('- [ ] ship it')
  })

  it('handles every list marker the grammar allows, and keeps the indent', () => {
    expect(toggleCheckbox('* [ ] a')).toBe('* [x] a')
    expect(toggleCheckbox('+ [ ] a')).toBe('+ [x] a')
    expect(toggleCheckbox('1. [ ] a')).toBe('1. [x] a')
    expect(toggleCheckbox('2) [ ] a')).toBe('2) [x] a')
    expect(toggleCheckbox('  - [ ] a')).toBe('  - [x] a')
  })

  it('answers null for anything that is not a task item, so no checkbox is drawn', () => {
    expect(toggleCheckbox('- plain item')).toBeNull()
    expect(toggleCheckbox('a paragraph [ ] with brackets')).toBeNull()
    expect(toggleCheckbox('## Goal')).toBeNull()
    expect(toggleCheckbox('')).toBeNull()
    expect(taskChecked('- plain item')).toBeNull()
  })

  it('reads the state as well as flipping it — the two agree', () => {
    expect(taskChecked('- [ ] a')).toBe(false)
    expect(taskChecked('- [x] a')).toBe(true)
    expect(taskChecked('- [X] a')).toBe(true)
  })

  it('a tick spliced back into its section moves exactly one character', () => {
    const src = '## M\n\n- [ ] one\n- [ ] two\n'
    const items = collect(src).filter((s) => s.tag === 'li' && s.range)
    const ticked = toggleCheckbox(blockSource(src, items[1].range!))!
    expect(spliceBlock(src, items[1].range!, ticked)).toBe('## M\n\n- [ ] one\n- [x] two\n')
  })
})

describe('two edits in one section compose, because the second splices into the first', () => {
  it('the amended text is what the second range is derived from', () => {
    const src = '## Goal\n\nfirst para\n\nsecond para\n'
    const first = collect(src).filter((s) => s.tag === 'p' && s.range)
    const once = spliceBlock(src, first[0].range!, 'FIRST para')
    expect(once).toBe('## Goal\n\nFIRST para\n\nsecond para\n')

    // The document now RENDERS `once`, so the second block's offsets come from
    // parsing `once` — not the pristine source. That is the whole reason
    // `PlanBody` is handed the amended text rather than `body`.
    const second = collect(once).filter((s) => s.tag === 'p' && s.range)
    expect(spliceBlock(once, second[1].range!, 'SECOND para')).toBe(
      '## Goal\n\nFIRST para\n\nSECOND para\n',
    )
  })
})

/**
 * THE PARTITION — where one block's words end and its children's begin.
 *
 * This is what makes a note's extent a block rather than a subtree, and it is
 * the half of block-scoped commenting that could ship as a silent regression:
 * without it, an outer list item's text CONTAINS its nested bullets' text, so
 * the outer item claims a note about an inner bullet (claims are first-match in
 * document order and a parent renders first) and then paints the whole subtree
 * with it. `planAnchor.test.tsx` asserts that consequence end-to-end; this
 * asserts the mechanism.
 */
describe('splitOwnChildren separates a block’s own run from the blocks under it', () => {
  /** The children of the first element with `tag`, off the real renderer, with
   *  every tag in `nest` rendered through a COMPONENT — which is how
   *  `PlanBody` renders them, and the case a naive `child.type` check misses. */
  function childrenOf(md: string, tag: string, nest: string[] = []) {
    let kids: React.ReactNode = null
    const components: Record<string, unknown> = {}
    for (const t of [tag, ...nest]) {
      const El = t as 'p'
      components[t] = (props: { children?: React.ReactNode }) => {
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

  const textOf = (nodes: React.ReactNode[]): string =>
    render(<div>{nodes}</div>).container.textContent ?? ''

  it('an outline item keeps its bullet and hands the nested list back untouched', () => {
    const { own, nested } = splitOwnChildren(childrenOf('- outer item\n  - inner one\n', 'li'))
    expect(textOf(own).trim()).toBe('outer item')
    expect(nested).toHaveLength(1)
    expect(textOf(nested)).toContain('inner one')
  })

  it('recognises a nested block rendered as a COMPONENT, through its `node` prop', () => {
    // A blockquote holds paragraphs, and `PlanBody` substitutes `p` — so the
    // child's `type` is a function and only `node.tagName` names it. Reading
    // `type` alone would leave the paragraph in `own` and hand the blockquote
    // words it does not own.
    const { own, nested } = splitOwnChildren(childrenOf('> quoted line\n', 'blockquote', ['p']))
    expect(textOf(own).trim()).toBe('')
    expect(nested).toHaveLength(1)
  })

  it('keeps inline elements in the own run — a block owns its bold and its links', () => {
    const { own, nested } = splitOwnChildren(
      childrenOf('the **keeper** writes [it](http://x) down\n', 'p'),
    )
    expect(textOf(own)).toBe('the keeper writes it down')
    expect(nested).toHaveLength(0)
  })

  it('own then nested reproduces the children, which is why an unnoted block is unchanged', () => {
    // NORMALISED, and the reason is worth stating rather than hiding behind a
    // `.trim()`. react-markdown emits a `\n` text node BETWEEN block children,
    // so a trailing separator that sat after the nested list moves in front of
    // it when the run is re-emitted first. That whitespace is between two block
    // boxes, where the CSS whitespace model collapses it to nothing — the
    // words, their order and the elements around them are identical, which is
    // what "an unnoted block renders as it always did" actually claims.
    const kids = childrenOf('- outer item\n  - inner one\n', 'li')
    const { own, nested } = splitOwnChildren(kids)
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
    expect(squash(textOf([...own, ...nested]))).toBe(squash(textOf([kids])))
    expect(squash(textOf([...own, ...nested]))).toBe('outer item inner one')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { PlanBody, type QuoteTarget } from './PlanBody'
import { preambleText, sectionText } from './planTrayLogic'

// followup B11. `vitest.config.ts` sets `globals: false`, so testing-library's
// auto-cleanup never registers: a render left standing here stays MOUNTED, and
// mounted means still subscribed to every store it reads and still holding
// every timer its effects started. The next file's fixture then re-renders it
// and re-fires those effects, in a file that has no idea this component exists.
// Audited suite-wide in M5; asserted by `src/test/suiteHygiene.test.ts`.
afterEach(cleanup)

/**
 * WHERE A NOTE LANDS.
 *
 * `planAnchor.test.tsx` pins the matcher; this pins the consequences — the note
 * under the block it is about, the paint on that block and only that block, the
 * note whose line is gone sitting at the end of ITS OWN SECTION rather than at
 * the bottom of the document, and which blocks offer to be commented on.
 */

const BODY = [
  '# Project Plan',
  '',
  '## Goal',
  '',
  'The keeper writes the **first** plan and nobody else does.',
  '',
  'Alpha beta gamma delta epsilon on one line.',
  '',
  '- outer item',
  '  - inner one',
  '',
  '## Guardrails',
  '',
  'Nothing here yet.',
  '',
  // A fenced block. `pre` IS in `BLOCK_TAGS` since notes became block-scoped,
  // so a quote taken out of a fence anchors to the fence rather than falling
  // loose — which is one of the two things this change fixed outright.
  '```ts',
  'const anchored = true',
  '```',
  '',
].join('\n')

/** Stands in for the server's grammar. The client never does this — which is
 *  the point of `char_start`/`char_end` arriving on the wire. */
function sections(): PlanSection[] {
  const goal = BODY.indexOf('## Goal')
  const guard = BODY.indexOf('## Guardrails')
  return [
    { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: goal, char_end: guard },
    {
      id: 'guardrails',
      heading: 'Guardrails',
      depth: 2,
      boxes: [0, 0],
      char_start: guard,
      char_end: BODY.length,
    },
  ]
}

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n1',
    section: 'goal',
    to: 'user',
    by: 'backend',
    at: '2026-01-01T00:00:00Z',
    status: 'open',
    kind: 'note',
    layer: 'spec',
    comment: 'a thing to say',
    proposal: '',
    base_section: '',
    quote: '',
    reply_to: '',
    round: '',
    conflict: false,
    resolved_by: '',
    resolved_at: '',
    resolution: '',
    revision: 1,
    has_proposal: false,
    sent: true,
    replies: [],
    section_missing: false,
    section_new: false,
    section_changed: false,
    display_diff: '',
    ...over,
  }
}

function mount(
  notes: PlanNote[],
  opts: {
    onQuote?: (t: QuoteTarget | null) => void
    /** The document AS RENDERED. Defaults to the pristine body; a test that
     *  stages a block edit passes the amended text for one section, which is
     *  what `PlanEditor`'s `pendingText` does in the app. */
    textOf?: (id: string) => string | undefined
    onBlockEdit?: (section: string, range: { start: number; end: number }, next: string) => void
    anchorOf?: (id: string) => string | undefined
    readOnly?: boolean
  } = {},
) {
  const secs = sections()
  return render(
    <PlanBody
      textOf={(s) => opts.textOf?.(s.id) ?? sectionText(BODY, s)}
      sections={secs}
      preamble={preambleText(BODY, secs)}
      notes={notes}
      readOnly={opts.readOnly ?? false}
      onQuote={opts.onQuote ?? (() => {})}
      onBlockEdit={opts.onBlockEdit ?? (() => {})}
      anchorOf={opts.anchorOf ? (s) => opts.anchorOf?.(s.id) : undefined}
      renderNote={(n) => (
        <div className="plan-note" data-testid={`note-${n.id}`}>
          {n.comment}
        </div>
      )}
    />,
  )
}

/** The painted runs on screen, by their text.
 *
 *  Whitespace-squashed: react-markdown emits a `\n` text node between a block's
 *  own run and the blocks nested under it, so an outline item's own run carries
 *  a trailing separator. It is between two block boxes, where the CSS
 *  whitespace model collapses it to nothing. */
function paints(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.plan-noted')].map((e) =>
    (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

/** The block element carrying the given text, off the real render. */
function blockWith(container: HTMLElement, tag: string, text: string): HTMLElement {
  return [...container.querySelectorAll(tag)].find((e) =>
    (e.textContent ?? '').includes(text),
  ) as HTMLElement
}

describe('an anchored note renders under the block it is about', () => {
  it('places the note immediately after its block and paints the block', () => {
    const { container } = mount([note({ id: 'a', quote: 'The keeper writes' })])
    // THE WHOLE BLOCK, not the quoted phrase inside it. The quote was three
    // words; the paint is the paragraph.
    expect(paints(container)).toEqual([
      'The keeper writes the first plan and nobody else does.',
    ])
    // Immediately after the block: the note is the paragraph's next sibling.
    const para = container.querySelector('p')!
    expect(para.nextElementSibling?.querySelector('[data-testid="note-a"]')).not.toBeNull()
  })

  it('NOTHING IS UNDERLINED — the dashed mark is gone, not restyled', () => {
    // The old `<mark class="plan-mark">` was a substring-scope decoration
    // carrying block-scope content, and a paragraph that wrapped drew it
    // raggedly across every line. There is no `<mark>` in the document now.
    const { container } = mount([note({ id: 'a', quote: 'The keeper writes' })])
    expect(container.querySelectorAll('mark')).toHaveLength(0)
    expect(container.querySelectorAll('.plan-mark')).toHaveLength(0)
  })

  it('anchors a quote that spans a bold word — defect (a), through the real renderer', () => {
    const { container } = mount([note({ id: 'b', quote: 'writes the first plan' })])
    expect(screen.getByTestId('note-b')).toBeTruthy()
    // The <strong> survives inside the paint rather than being flattened away.
    expect(container.querySelector('strong')!.textContent).toBe('first')
    expect(container.querySelector('.plan-noted strong')).not.toBeNull()
    // And it did NOT fall into the loose bucket.
    expect(container.querySelector('[data-testid="plan-loose-notes"]')).toBeNull()
  })

  it('two notes on one block paint it ONCE and both render under it', () => {
    // Two marks used to be the outcome here — and only when the two quotes
    // covered disjoint text. Two reviewers quoting NESTED phrases got one mark
    // for two notes, because `mergeRanges` dropped the overlapping range. The
    // block is the extent now, so overlap is not a question and neither note
    // can lose its paint to the other.
    const { container } = mount([
      note({ id: 'x', quote: 'Alpha beta' }),
      note({ id: 'y', quote: 'beta gamma delta' }),
    ])
    expect(paints(container)).toEqual(['Alpha beta gamma delta epsilon on one line.'])
    expect(screen.getByTestId('note-x')).toBeTruthy()
    expect(screen.getByTestId('note-y')).toBeTruthy()
  })

  it('a closed note stops painting the block, and is still rendered', () => {
    const { container } = mount([
      note({ id: 'c', quote: 'The keeper writes', status: 'dismissed' }),
    ])
    expect(paints(container)).toEqual([])
    // The argument is over; the record is not deleted.
    expect(screen.getByTestId('note-c')).toBeTruthy()
  })

  it('and the block stops advertising itself as editable while a note is open on it', () => {
    // Two backgrounds in one place otherwise — the note's paint and the
    // editable hover tint, in neighbouring shades of the same purple. The
    // block stays editable; only the advertisement stands down.
    const { container } = mount([note({ id: 'a', quote: 'The keeper writes' })])
    const noted = blockWith(container, 'p', 'The keeper writes')
    expect(noted.className).toContain('plan-b--noted')
    expect(noted.className).toContain('plan-b--live')
    expect(blockWith(container, 'p', 'Alpha beta').className).not.toContain('plan-b--noted')
  })

  it('a quote occurring twice in one block paints it once, with nothing to disclose', () => {
    // "This quote appears 2 times in this block — pinned to the first" was a
    // consequence of a highlight having to pick an occurrence. Painting the
    // block makes the question stop existing, so the badge is gone rather than
    // being reworded.
    const twice = '## Goal\n\nship it and then ship it again\n'
    const { container } = mount([note({ id: 'dup', quote: 'ship it' })], {
      textOf: (id) => (id === 'goal' ? twice : undefined),
    })
    expect(paints(container)).toEqual(['ship it and then ship it again'])
    expect(screen.queryByTestId('plan-quote-dupes-dup')).toBeNull()
    expect(container.textContent).not.toContain('times in this block')
  })
})

/**
 * INNERMOST WINS, AND IT FALLS OUT OF OWN-TEXT RATHER THAN A NEW RULE.
 *
 * This is the regression block commenting would have shipped without
 * `splitOwnChildren`. `flatten` walked the whole subtree, so an outer list
 * item's text CONTAINED its nested bullets' text; claims are first-match in
 * document order and a parent renders before its child, so the outer item took
 * the note — and under block painting it would then tint the entire outer
 * subtree, inner bullets and all. There is no block id here and no traversal:
 * the outer item simply no longer contains the inner item's words.
 */
describe('a note about a nested bullet belongs to the nested bullet', () => {
  it('the INNER item claims it, and the paint stops at the inner item', () => {
    const { container } = mount([note({ id: 'i', quote: 'inner one' })])
    expect(paints(container)).toEqual(['inner one'])
    const painted = container.querySelector('.plan-noted')!
    expect(painted.closest('li')!.textContent).toContain('inner one')
    // The outer item is NOT painted: its own text is `outer item` and nothing
    // more, so it never carried the quote in the first place.
    expect(painted.textContent).not.toContain('outer item')
  })

  it('and the note renders under the inner item, not at the end of the outer one', () => {
    const { container } = mount([note({ id: 'i', quote: 'inner one' })])
    const row = screen.getByTestId('note-i')
    const inner = [...container.querySelectorAll('li')].find(
      (li) => !li.querySelector('li') && (li.textContent ?? '').includes('inner one'),
    )!
    expect(inner.parentElement!.contains(row)).toBe(true)
  })

  it('a note about the OUTER item still lands on the outer item', () => {
    const { container } = mount([note({ id: 'o', quote: 'outer item' })])
    expect(paints(container)).toEqual(['outer item'])
  })
})

describe('a note whose line is gone lands at the end of ITS OWN section', () => {
  it('renders it in its section, labelled, and never drops it', () => {
    const { container } = mount([
      note({ id: 'gone', section: 'goal', quote: 'a sentence that was deleted' }),
    ])
    // Never dropped.
    expect(screen.getByTestId('note-gone')).toBeTruthy()
    // Visibly marked as unanchored.
    expect(screen.getByTestId('plan-unanchored-gone').textContent).toContain('no longer in this section')
    // IN ITS OWN SECTION — this is the complaint the feature exists to answer.
    const goal = container.querySelector('[data-testid="plan-sec-goal"]')!
    expect(goal.contains(screen.getByTestId('note-gone'))).toBe(true)
    // ...and NOT at the bottom of the document: a whole section follows it.
    const guard = container.querySelector('[data-testid="plan-sec-guardrails"]')!
    expect(goal.compareDocumentPosition(guard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(guard.contains(screen.getByTestId('note-gone'))).toBe(false)
  })

  it('says the line is GONE only when it is actually gone', () => {
    // The other half of the pair below. The two cases are distinguishable, so
    // they are not collapsed into one hedge that under-reports a deletion.
    mount([note({ id: 'g2', section: 'guardrails', quote: 'a sentence that was deleted' })])
    expect(screen.getByTestId('plan-unanchored-g2').textContent).toBe(
      'The line this quotes is no longer in this section.',
    )
  })

  it("does NOT claim the line is gone when it is on screen — it says it couldn't find it", () => {
    // A QUOTE THAT SPANS TWO BLOCKS is the plain case now: no single block's
    // own text contains both halves, so nothing can claim it, and yet every
    // word of it is on screen. Telling the user the line "is no longer in this
    // section" would be the app asserting something the user can see is false.
    const spanning = 'Nothing here yet. ```ts'
    const { container } = mount([
      note({ id: 'across', section: 'guardrails', quote: spanning }),
    ])
    const why = screen.getByTestId('plan-unanchored-across')
    expect(why.textContent).toBe("Couldn't find this line in the section.")
    expect(why.textContent).not.toContain('no longer')
    // The claim the old string made, refuted from the DOM: the text IS there.
    const guard = container.querySelector('[data-testid="plan-sec-guardrails"]')!
    expect(guard.textContent).toContain('Nothing here yet.')
    // Still loose, still rendered, still in its own section — unchanged.
    expect(guard.contains(screen.getByTestId('note-across'))).toBe(true)
  })

  it('A QUOTE OUT OF A FENCE NO LONGER GOES LOOSE — `pre` is a block now', () => {
    // It used to land here, labelled "couldn't find this line", because
    // `pre`/`code` were absent from `BLOCK_TAGS` and no block was ever offered
    // the chance to claim it. Commenting on a code fence is the whole reason
    // that changed.
    const { container } = mount([
      note({ id: 'fenced', section: 'guardrails', quote: 'const anchored = true' }),
    ])
    expect(container.querySelector('[data-testid="plan-loose-notes"]')).toBeNull()
    expect(screen.getByTestId('plan-anchored-fenced')).toBeTruthy()
    expect(container.querySelector('pre.plan-noted')).not.toBeNull()
  })

  it('keeps a lost note in the section it was filed against, not the one holding the text', () => {
    // The quote exists — in `guardrails` — but the note says `goal`. It stays
    // where it was filed rather than migrating to wherever the words turn up.
    const { container } = mount([
      note({ id: 'moved', section: 'goal', quote: 'Nothing here yet' }),
    ])
    const goal = container.querySelector('[data-testid="plan-sec-goal"]')!
    expect(goal.contains(screen.getByTestId('note-moved'))).toBe(true)
    expect(paints(container)).toEqual([])
  })
})

describe('the preamble', () => {
  it('renders the document title, which is not a section and carries no notes', () => {
    const { container } = mount([])
    expect(container.querySelector('.plan-preamble')!.textContent).toContain('Project Plan')
  })
})

/**
 * THE ONE CAPTURE GESTURE.
 *
 * There used to be two, and they collided: a drag-select anywhere in the
 * document also minted a `QuoteTarget`, a drag ends in a click, and that click
 * landed on an editable paragraph — so the block's own handler had to inspect
 * `window.getSelection()` to guess which feature the gesture meant. The whole
 * arbitration is deleted, along with the four guards that told a selection of
 * the document from a selection of an editor, a diff, the composer or a note.
 * SELECTION MEANS EDIT, ICON MEANS COMMENT.
 */
describe('the comment bubble is the only thing that offers a quote', () => {
  it('a drag-select of document text offers nothing at all', () => {
    const onQuote = vi.fn()
    const { container } = mount([], { onQuote })
    const para = container.querySelector('p')!
    const spy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'The keeper writes',
      anchorNode: para.firstChild,
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 0, bottom: 0 }) }),
    } as unknown as Selection)
    try {
      fireEvent.mouseUp(container.querySelector('.plan-body')!)
      fireEvent.keyUp(container.querySelector('.plan-body')!, { key: 'Shift', shiftKey: true })
    } finally {
      spy.mockRestore()
    }
    expect(onQuote).not.toHaveBeenCalled()
  })

  it('the bubble captures the WHOLE block, not the phrase a note happened to quote', () => {
    const onQuote = vi.fn()
    const { container } = mount([], { onQuote })
    const para = blockWith(container, 'p', 'The keeper writes')
    fireEvent.click(para.querySelector('.plan-b-tool')!)
    expect(onQuote).toHaveBeenCalledTimes(1)
    const target = onQuote.mock.calls[0][0] as QuoteTarget
    expect(target.quote).toBe('The keeper writes the first plan and nobody else does.')
    // The section is bound by the block's context, not found by scanning text.
    expect(target.section).toBe('goal')
  })

  it('an outline item captures its OWN bullet and not the nest under it', () => {
    const onQuote = vi.fn()
    const { container } = mount([], { onQuote })
    const outer = [...container.querySelectorAll('li')].find((li) => li.querySelector('li'))!
    // `:scope >` matters: the outer item's own bubble flows AFTER the nested
    // list, so a plain descendant query finds the INNER item's bubble first.
    fireEvent.click(outer.querySelector(':scope > .plan-b-tools > .plan-b-tool')!)
    const target = onQuote.mock.calls[0][0] as QuoteTarget
    expect(target.quote).toBe('outer item')
  })

  it('a read-only document offers no bubble anywhere', () => {
    const { container } = mount([], { readOnly: true })
    expect(container.querySelectorAll('.plan-b-tool')).toHaveLength(0)
  })
})

/**
 * WHAT IS COMMENTABLE — the list changed in both directions, and both follow
 * from a note being a block rather than a phrase.
 */
describe('which blocks offer a bubble', () => {
  const TABLE = ['## Goal', '', '| a | b |', '| - | - |', '| one | two |', ''].join('\n')

  it('a code fence and a table are commentable, with the bubble BESIDE the block', () => {
    // `.plan-b-tools` is a `<span>`: the HTML parser fosters it out of a
    // `<table>` and drops it into the code text of a `<pre>`. Both render
    // inside a wrapper that carries the bubble as a sibling instead.
    const { container } = mount([], { textOf: (id) => (id === 'goal' ? TABLE : undefined) })
    const table = container.querySelector('table')!
    const fence = container.querySelector('pre')!
    for (const block of [table, fence]) {
      const fig = block.parentElement!
      expect(fig.className).toContain('plan-b-fig')
      expect(fig.querySelector(':scope > .plan-b-tools')).not.toBeNull()
      // ...and NOT inside the block itself, which is the invalid half.
      expect(block.querySelector('.plan-b-tools')).toBeNull()
    }
  })

  it('a table cell is no longer its own comment target — it rolls up to the table', () => {
    const { container } = mount([], { textOf: (id) => (id === 'goal' ? TABLE : undefined) })
    expect(container.querySelector('td .plan-b-tool')).toBeNull()
    expect(container.querySelector('th .plan-b-tool')).toBeNull()
    // A note quoting one cell re-anchors to the table and paints it whole. No
    // note is lost; the extent widens.
    cleanup()
    const { container: c2 } = mount([note({ id: 't', quote: 'two' })], {
      textOf: (id) => (id === 'goal' ? TABLE : undefined),
    })
    expect(c2.querySelector('table.plan-noted')).not.toBeNull()
  })

  it('a blockquote offers nothing of its own — its paragraphs do', () => {
    // Its children are all paragraphs, so its own text is empty and the
    // MIN_QUOTE_CHARS guard suppresses the bubble. Consistent with
    // innermost-wins rather than an exception to it, and the accepted cost of
    // getting innermost-wins for free.
    const quoted = '## Goal\n\n> the keeper said so\n'
    const { container } = mount([], { textOf: (id) => (id === 'goal' ? quoted : undefined) })
    const bq = container.querySelector('blockquote')!
    expect(bq.querySelector(':scope > .plan-b-tools')).toBeNull()
    expect(bq.querySelector('p .plan-b-tool')).not.toBeNull()
  })
})

/**
 * THE OPTIONAL ANCHOR — one attribute, so a section the tray is rewriting is a
 * scroll target.
 *
 * `PlanCommentList` draws a staged text edit as the comment it is, and clicking
 * it routes through the same `showNote` a real note uses. A note is scrolled to
 * by `[data-note-id]`; a staged edit is drawn AS the section's own text and
 * owns no element of its own, so without this the list would need a second
 * click contract for one row type — which is the whole thing the projection
 * exists to avoid.
 */
describe('anchorOf — a rewritten section becomes a landing target', () => {
  it('hangs the given id on that section and on no other', () => {
    const { container } = mount([], { anchorOf: (id) => (id === 'goal' ? 'e1' : undefined) })
    const anchored = container.querySelectorAll('[data-note-id]')
    expect(anchored).toHaveLength(1)
    expect(anchored[0].getAttribute('data-plan-section')).toBe('goal')
    expect(anchored[0].getAttribute('data-note-id')).toBe('e1')
  })

  it('IS OPTIONAL, and absent means no attribute at all', () => {
    const { container } = mount([])
    expect(container.querySelectorAll('[data-note-id]')).toHaveLength(0)
  })

  it('A SECTION WITH BOTH AN ANCHOR AND A NOTE IS NOT A COLLISION', () => {
    // The scroll effect compares attribute VALUES and takes the match, and the
    // two ids can never be equal — one is a client-generated row id, the other a
    // server note id. Listed because it reads like a collision and is not one.
    const { container } = mount([note({ id: 'a', section: 'goal', quote: 'The keeper writes' })], {
      anchorOf: (id) => (id === 'goal' ? 'e1' : undefined),
    })
    const ids = [...container.querySelectorAll('[data-note-id]')].map((e) =>
      e.getAttribute('data-note-id'),
    )
    expect(ids).toContain('e1')
    expect(new Set(ids).size).toBe(ids.length)
  })
})

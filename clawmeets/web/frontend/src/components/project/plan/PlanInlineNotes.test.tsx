import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * INLINE NOTES, END TO END, ON BOTH MOUNTS.
 *
 * `planAnchor.test.tsx` pins the matcher and `PlanBody.test.tsx` pins the
 * placement; this drives the whole thing through the real editor and the fake
 * server — the same seam the tab's own 26 assertions use — and it does it on
 * the Plan tab AND on the desk card's PLAN band, because the two are one
 * component and a feature that reached only one of them would be the fork the
 * design forbids.
 */

const routes = { current: null as ReturnType<typeof routeTo> | null }

vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return {
    ...actual,
    get: (path: string) => routes.current!.get(path),
    post: (path: string, body?: unknown) => routes.current!.post(path, body),
    put: (path: string, body?: unknown) => routes.current!.put(path, body),
    del: (path: string) => routes.current!.del(path),
  }
})

vi.mock('./PlanDiff', () => ({
  PlanDiff: ({ text }: { text: string }) =>
    createElement('pre', { className: 'plan-diff', 'data-testid': 'plan-diff' }, text),
}))

const { PlanEditor } = await import('./PlanEditor')

const PID = 'p-1'

const BODY = [
  '# Project Plan: demo',
  '',
  '## Goal',
  '',
  'The keeper writes the **first** plan and nobody else does.',
  '',
  '## Guardrails',
  '',
  'Do not break it.',
  '',
].join('\n')

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'guardrails', heading: 'Guardrails', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n',
    section: 'goal',
    to: 'user',
    by: 'backend',
    at: 't',
    status: 'open',
    kind: 'note',
    layer: 'spec',
    comment: 'a note',
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
    sent: false,
    replies: [],
    section_missing: false,
    section_new: false,
    section_changed: false,
    display_diff: '',
    ...over,
  }
}

let server: FakePlanServer
let qc: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, children)

beforeEach(() => {
  server = new FakePlanServer(BODY, SECTIONS)
  routes.current = routeTo(server, PID)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})

afterEach(() => {
  cleanup()
  qc.clear()
})

/** The Goal paragraph AS RENDERED — which is what a capture stores now.
 *  The bubble quotes the whole block, so every assertion about a stored quote
 *  is about this string rather than about a phrase inside it. */
const GOAL_PARA = 'The keeper writes the first plan and nobody else does.'

/** jsdom does no layout, so a real drag cannot be simulated: the anchor node is
 *  a real element out of the real render and only the geometry is stubbed.
 *  Kept for the tests that prove a selection does NOT capture any more. */
function withSelection(text: string, anchor: Node | null, fn: () => void) {
  const spy = vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => text,
    anchorNode: anchor,
    rangeCount: anchor ? 1 : 0,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 12, bottom: 30 }) }),
  } as unknown as Selection)
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
}

async function editor(density: 'full' | 'compact') {
  const view = render(createElement(PlanEditor, { projectId: PID, density }), { wrapper })
  await screen.findByTestId('plan-body')
  return view
}

/**
 * OPEN THE COMPOSER ON A BLOCK — the one capture gesture there is.
 *
 * This replaces `selectInDoc`, which dragged a phrase. The drag-select path is
 * deleted: it collided with click-to-edit (a drag ends in a click, and that
 * click landed on an editable paragraph), and the block's own handler had to
 * inspect `window.getSelection()` to guess which of the two features a gesture
 * meant. Selection means edit; the icon means comment.
 *
 * `:scope >` on the toolbar matters for a container: an outline item's own
 * bubble flows after its nested list, so a plain descendant query would find
 * the inner item's.
 */
function commentOn(container: HTMLElement, text: string) {
  const target = [...container.querySelectorAll('.plan-sec p.plan-b')].find((p) =>
    (p.textContent ?? '').includes(text.slice(0, 12)),
  ) as HTMLElement
  fireEvent.click(target.querySelector(':scope > .plan-b-tools > .plan-b-tool')!)
}

describe('AC-1 — the comment bubble opens the composer, on BOTH mounts', () => {
  for (const density of ['full', 'compact'] as const) {
    it(`${density} mount: the bubble opens the composer over the block`, async () => {
      const { container } = await editor(density)
      expect(container.querySelector('[data-density]')!.getAttribute('data-density')).toBe(density)
      commentOn(container as HTMLElement, 'The keeper writes')
      const pop = await screen.findByTestId('plan-quote-pop')
      // THE WHOLE BLOCK, not a phrase inside it — AND THE DOCUMENT IS WHERE
      // THAT IS NOW VISIBLE. The composer used to reprint the block's words
      // inside itself and this read them there; the block lights up instead,
      // so the same fact is asserted at its new home and the popover is
      // asserted NOT to be repeating it.
      expect(
        container.querySelector('[data-plan-commenting="true"]')!.textContent,
      ).toContain(GOAL_PARA)
      expect(pop.textContent).not.toContain(GOAL_PARA)
      // Positioned against the selection, inside the document host.
      expect((pop as HTMLElement).style.top).not.toBe('')
      expect(container.querySelector('.plan-body')!.contains(pop)).toBe(true)
    })
  }
})

/**
 * AC-2 — THE GUARDS ARE GONE, AND THAT IS THE CHANGE RATHER THAN A GAP.
 *
 * Four guards used to say where a SELECTION was not a quote of the document: a
 * raw-Markdown textarea, a proposal's rendered diff, the composer itself and a
 * note's own body — all of which render inside the document flow, so selecting
 * any of them would have offered to quote the plan with words the plan does not
 * contain. None of them can arise now: a capture is a click on a bubble, and a
 * bubble exists only on a block of the document. The guards are replaced by the
 * absence of the affordance, and that is what these assert.
 */
/**
 * THE COMPOSER ASKS FOR A COMMENT AND NOTHING ELSE.
 *
 * Four things came off this surface at once, and the reason they are asserted
 * TOGETHER in one case rather than one case each is that the claim is about the
 * whole surface: a user who opens it sees a box to type in and the two controls
 * that dismiss it or file it. Asserted one at a time, four passing cases would
 * still allow a fifth thing to be sitting there.
 *
 * WHAT STAYS IS NOT SYMMETRICAL WITH WHAT WENT, and the difference is whether a
 * user can act on it. The footer explained what filing does — a gesture every
 * editor people already use has taught them — so it taught nothing. The
 * over-length warning and the post-failure alert are refusals a user can hit
 * and fix, so both are kept and both are pinned below.
 */
describe('AC-1 — the composer is a text box, a Cancel and a file button', () => {
  it('renders no quote, no addressee, no proposal and no footer', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const pop = await screen.findByTestId('plan-quote-pop')

    // The words being commented on are not reprinted inside it.
    expect(within(pop).queryByTestId('plan-pop-quote')).toBeNull()
    expect(pop.textContent).not.toContain(GOAL_PARA)
    // It neither asks nor states who the note goes to.
    expect(within(pop).queryByTestId('plan-pop-to')).toBeNull()
    expect(pop.textContent).not.toContain('@coordinator')
    expect(pop.textContent).not.toContain('To')
    // It offers no way to write a replacement for the section.
    expect(within(pop).queryByRole('button', { name: 'Propose a replacement' })).toBeNull()
    // And it does not explain what filing does.
    expect(pop.textContent).not.toContain('Filed straight away')
    expect(pop.textContent).not.toContain('writes no plan bytes')
    expect(pop.textContent).not.toContain('characters of the quote')

    // WHAT IS LEFT, stated positively — otherwise the four assertions above
    // are also satisfied by a composer that renders nothing at all.
    expect(within(pop).getByLabelText('What do you want to say about this?')).toBeTruthy()
    expect(within(pop).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(within(pop).getByText('File note')).toBeTruthy()
    // Exactly two buttons: no third control hiding behind an icon.
    expect(pop.querySelectorAll('button')).toHaveLength(2)
  })

  /** AC-1.2 — the refusal that is NOT the footer. A user can hit this one and
   *  can act on it, which is the whole reason the footer went and this stayed. */
  it('an over-length note names the limit and refuses to file', async () => {
    const { PLAN_LIMITS } = await import('../../../api/endpoints/projectPlans')
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const pop = await screen.findByTestId('plan-quote-pop')
    const ta = screen.getByLabelText('What do you want to say about this?')

    fireEvent.change(ta, { target: { value: 'x'.repeat(PLAN_LIMITS.noteChars + 1) } })
    expect(pop.textContent).toContain(`at most ${PLAN_LIMITS.noteChars} characters`)
    // Refused, and this one IS `disabled` — it is a state the user is standing
    // in and can see, not a transient one that would strand a keyboard user.
    expect((screen.getByText('File note') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('File note'))
    expect(server.notes).toHaveLength(0)

    // Cut it back down and the refusal goes with the condition.
    fireEvent.change(ta, { target: { value: 'x'.repeat(PLAN_LIMITS.noteChars) } })
    expect(pop.textContent).not.toContain('at most')
    expect((screen.getByText('File note') as HTMLButtonElement).disabled).toBe(false)
  })

  /** AC-3.2 — the addressee row is gone and the ADDRESSEE is not. A plan with
   *  no coordinator still files the note against the line and sends it to
   *  nobody, which is the degenerate case the deleted row used to spell out. */
  it('a plan with no coordinator still files, addressed to nobody', async () => {
    server.keeper = ''
    const { container } = await editor('full')
    const bodies: Array<Record<string, unknown>> = []
    const realPost = routes.current!.post
    routes.current!.post = async (path: string, body?: unknown) => {
      if (path.endsWith('/plan/notes')) bodies.push(body as Record<string, unknown>)
      return realPost(path, body)
    }

    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'into the void' },
    })
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].to).toEqual([])
    // The quote still rides, which is what keeps the note under its own block.
    expect(bodies[0].quote).toBe(GOAL_PARA)
  })
})

/**
 * AC-2 — THE DOCUMENT SAYS WHICH BLOCK THE COMMENT IS ABOUT.
 *
 * This is the other half of deleting the quote preview, and it is why the
 * highlight ships in the same change rather than after it: the preview was the
 * only thing on screen answering "which block am I writing about", so removing
 * it without this would leave the question with no answer at all.
 *
 * THE MARK IS KEYED ON THE BLOCK, NOT ON THE QUOTE. A phrase occurring in two
 * blocks of one section would light both if the quote were the identity; the
 * block's own offset within its section is what the target carries, and that is
 * unique by construction.
 */
describe('AC-2 — the block being commented on is marked in the document', () => {
  const lit = (c: HTMLElement) => [...c.querySelectorAll('[data-plan-commenting="true"]')]

  it('marks exactly the block whose bubble was pressed', async () => {
    const { container } = await editor('full')
    expect(lit(container as HTMLElement)).toHaveLength(0)
    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')

    const marked = lit(container as HTMLElement)
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain(GOAL_PARA)
    expect(marked[0].className).toContain('plan-b--commenting')
    // The other section's block is a block nobody is commenting on, and reads
    // as one.
    const other = [...container.querySelectorAll('.plan-sec p.plan-b')].find((p) =>
      (p.textContent ?? '').includes('Do not break it'),
    )!
    expect(other.getAttribute('data-plan-commenting')).toBeNull()
  })

  /**
   * ONE CASE PER DISMISSAL PATH, and they are listed rather than folded into
   * one because they are four different mechanisms: two the composer owns
   * (Cancel and Escape both call `onClose`), one the document owns (a press
   * anywhere in the body clears the target), and one the post owns (the parent
   * clears the target after the request resolves). A regression in any one of
   * them leaves the document permanently lit on a block nobody is writing
   * about, which is worse than no mark at all.
   */
  const dismissals: [string, (c: HTMLElement) => void][] = [
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    [
      'Escape',
      () =>
        fireEvent.keyDown(screen.getByLabelText('What do you want to say about this?'), {
          key: 'Escape',
        }),
    ],
    [
      'a press elsewhere in the document',
      (c) => fireEvent.mouseDown(c.querySelector('.plan-body')!),
    ],
  ]

  it.each(dismissals)('the mark goes away on %s', async (_what, dismiss) => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    expect(lit(container as HTMLElement)).toHaveLength(1)

    dismiss(container as HTMLElement)
    await waitFor(() => expect(screen.queryByTestId('plan-quote-pop')).toBeNull())
    expect(lit(container as HTMLElement)).toHaveLength(0)
  })

  it('the mark goes away when the note files successfully', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'filed' },
    })
    fireEvent.click(screen.getByText('File note'))

    await waitFor(() => expect(screen.queryByTestId('plan-quote-pop')).toBeNull())
    expect(server.notes).toHaveLength(1)
    expect(lit(container as HTMLElement)).toHaveLength(0)
  })

  /**
   * AC-2.3 — THE TWO MARKS ARE SIBLINGS, NOT ALTERNATIVES.
   *
   * A block carrying an open note is painted; a block being commented on is
   * outlined. A block that is both must read as both, which is why they are
   * separate classes on separate elements rather than one class with two
   * states — neither is in a position to erase the other, and this is the case
   * that would catch it if someone made them one.
   */
  it('a block that already carries a note keeps saying so, before, during and after', async () => {
    server.notes = [note({ id: 'a', quote: 'The keeper writes', comment: 'why only the keeper?' })]
    const { container } = await editor('full')
    await screen.findByTestId('plan-anchored-a')

    const painted = () => container.querySelector('.plan-noted')
    // Before.
    expect(painted()!.textContent).toBe(GOAL_PARA)
    expect(lit(container as HTMLElement)).toHaveLength(0)

    // During — both at once, on the same block.
    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    expect(painted()!.textContent).toBe(GOAL_PARA)
    const marked = lit(container as HTMLElement)
    expect(marked).toHaveLength(1)
    expect(marked[0].contains(painted())).toBe(true)

    // After — the note's paint outlives the composer, because it is about a
    // note that is still open rather than about a gesture that has ended.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('plan-quote-pop')).toBeNull())
    expect(painted()!.textContent).toBe(GOAL_PARA)
    expect(lit(container as HTMLElement)).toHaveLength(0)
  })
})

describe('AC-2 — a capture is only ever possible on a block of the document', () => {
  it('a drag-select of document text offers nothing, on either input', async () => {
    const { container } = await editor('full')
    const para = container.querySelector('.plan-sec p')!
    withSelection('The keeper writes', para.firstChild, () => {
      fireEvent.mouseUp(container.querySelector('.plan-body')!)
      fireEvent.keyUp(container.querySelector('.plan-body')!, { key: 'Shift', shiftKey: true })
    })
    expect(screen.queryByTestId('plan-quote-pop')).toBeNull()
  })

  it('an active inline editor carries no bubble — the block is a textarea', async () => {
    const { container } = await editor('full')
    fireEvent.click(screen.getByRole('button', { name: /^Goal/ }))
    fireEvent.click(await screen.findByText('Edit raw Markdown'))
    const ta = await screen.findByLabelText('Raw Markdown for Goal')
    expect(ta.className).toContain('plan-raw-edit')
    expect(container.querySelectorAll('.plan-raw-edit .plan-b-tool')).toHaveLength(0)
    expect(screen.queryByTestId('plan-quote-pop')).toBeNull()
  })

  it("a proposal's incoming side carries no bubble — it is not the document", async () => {
    // That text is what someone PROPOSES the document should say. Quoting it as
    // though the document said it is how a note ends up anchored to a line that
    // does not exist.
    server.notes = [
      note({ id: 'p1', kind: 'proposal', proposal: '## Goal\n\nrewritten\n', comment: 'try this' }),
    ]
    const { container } = await editor('full')
    const diff = await screen.findByTestId('plan-diff')
    expect(diff.querySelector('.plan-b-tool')).toBeNull()
    expect(container.querySelectorAll('.plan-note .plan-b-tool')).toHaveLength(0)
  })

  it('the composer itself: pressing the same bubble again re-opens one, not two', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const pop = await screen.findByTestId('plan-quote-pop')
    expect(pop.querySelector('.plan-b-tool')).toBeNull()
    commentOn(container as HTMLElement, 'The keeper writes')
    expect(screen.getAllByTestId('plan-quote-pop')).toHaveLength(1)
  })
})

describe('AC-3 / AC-5 — where a note renders', () => {
  it('a found quote anchors under its block and paints the WHOLE block', async () => {
    // The quote is three words; the paint is the paragraph. A note filed by an
    // agent with `--section` derives its quote from a whole source LINE, so the
    // old dashed underline already spanned a rendered paragraph — block-scope
    // content drawn with a substring-scope decoration. Nothing is underlined
    // now: there is no `<mark>` in the document at all.
    server.notes = [note({ id: 'a', quote: 'The keeper writes', comment: 'why only the keeper?' })]
    const { container } = await editor('full')
    await screen.findByTestId('plan-anchored-a')
    expect(container.querySelector('.plan-noted')!.textContent).toBe(GOAL_PARA)
    expect(container.querySelectorAll('mark')).toHaveLength(0)
    const para = container.querySelector('.plan-sec p')!
    expect(para.nextElementSibling!.getAttribute('data-testid')).toBe('plan-anchored-a')
  })

  it('a quote that spans **bold** anchors too — defect (a), through the whole stack', async () => {
    server.notes = [note({ id: 'b', quote: 'writes the first plan' })]
    const { container } = await editor('full')
    await screen.findByTestId('plan-anchored-b')
    expect(container.querySelector('[data-testid="plan-loose-notes"]')).toBeNull()
    // The prototype's comparison, on the same input, would have missed:
    expect(server.body.includes('writes the first plan')).toBe(false)
  })

  it('a quote that is gone renders at the end of ITS OWN section, labelled', async () => {
    server.notes = [note({ id: 'g', section: 'goal', quote: 'a clause that was deleted' })]
    const { container } = await editor('full')
    const unanchored = await screen.findByTestId('plan-unanchored-g')
    expect(unanchored.textContent).toContain('no longer in this section')
    const goal = container.querySelector('[data-testid="plan-sec-goal"]')!
    expect(goal.contains(unanchored)).toBe(true)
    // Not at the bottom of the document — a whole section follows it.
    expect(container.querySelector('[data-testid="plan-sec-guardrails"]')!.contains(unanchored)).toBe(
      false,
    )
  })

  it('a note is drawn ONCE — the body and the list below it are disjoint', async () => {
    server.notes = [
      note({ id: 'q', quote: 'The keeper writes', comment: 'the quoted one' }),
      note({ id: 'u', quote: '', comment: 'the unquoted one' }),
    ]
    const { container } = await editor('full')
    await screen.findByTestId('plan-anchored-q')
    // Counted over the note surfaces themselves.
    const notesWith = (text: string) =>
      [...container.querySelectorAll('.plan-note')].filter((n) => n.textContent?.includes(text))
    expect(notesWith('the quoted one')).toHaveLength(1)
    expect(notesWith('the unquoted one')).toHaveLength(1)
  })
})

/**
 * AC-7.1 — AN ACTED-ON NOTE IS DONE AND GONE, AND THAT REVERSES THIS FILE'S
 * OWN PREVIOUS CLAIM.
 *
 * This block used to end "the record is not deleted; only the highlight is
 * gone", asserting that a dismissed note stayed on screen. It did, forever:
 * `PlanEditor` read `index.notes` with no status filter at all, so every note
 * ever accepted, rejected, answered or dismissed accumulated in the pane with
 * its controls stripped. The record is STILL not deleted — the status ladder
 * closes a note and the server keeps every one of them, which the second
 * assertion below checks against the fake server rather than the DOM. What
 * changed is that this surface stops drawing it.
 */
describe('AC-7 — a closed note leaves the pane, and its paint with it', () => {
  it('the block reads clean, the note is gone from the DOM, and the record survives', async () => {
    server.notes = [note({ id: 'r', quote: 'The keeper writes', to: 'user' })]
    const { container } = await editor('full')
    await screen.findByTestId('plan-anchored-r')
    expect(container.querySelectorAll('.plan-noted')).toHaveLength(1)

    // A STAGED dismiss and then the submit — `Dismiss now` is gone, and this is
    // the whole of how a note closes from the browser now. The status still
    // moves SERVER-SIDE, inside the submit's one transaction; nothing here
    // holds it.
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(server.notes[0].status).toBe('open')
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    await waitFor(() => expect(container.querySelectorAll('.plan-noted')).toHaveLength(0))
    expect(server.notes[0].status).toBe('dismissed')
    // Gone from BOTH halves of the partition, not merely un-marked in the body.
    expect(screen.queryByTestId('plan-anchored-r')).toBeNull()
    expect(screen.getByTestId('plan-notes').textContent).toContain('No notes here')
  })

  /** One filter, at one place, so every partition inherits it. Four closed
   *  statuses and one open one: only the open note is drawn. */
  it('every closed status is filtered, and only `open` renders', async () => {
    server.notes = [
      note({ id: 'a', status: 'answered', comment: 'answered one' }),
      note({ id: 'b', status: 'applied', comment: 'applied one' }),
      note({ id: 'c', status: 'rejected', comment: 'rejected one' }),
      note({ id: 'd', status: 'dismissed', comment: 'dismissed one' }),
      note({ id: 'e', status: 'open', comment: 'the live one' }),
    ]
    const { container } = await editor('full')
    // ASSERTED OVER THE WHOLE EDITOR, not over one pane, and that is the point
    // of the filter: it runs once, above the partition, so no surface can
    // inherit a closed note. Every note here names `goal` and quotes nothing,
    // so the open one draws at the end of that section rather than in the
    // page-bottom list — which is a fact about PLACEMENT and must not be able
    // to weaken a test about FILTERING.
    expect(container.textContent).toContain('the live one')
    for (const gone of ['answered one', 'applied one', 'rejected one', 'dismissed one']) {
      expect(container.textContent).not.toContain(gone)
    }
    expect(container.querySelectorAll('[data-note-id]')).toHaveLength(1)
  })

  /**
   * PT-2 — THE FILTER, PINNED ACROSS EVERY SURFACE THAT INHERITS IT, ON BOTH
   * MOUNTS. The test above proves the notes LIST drops a closed note. This one
   * proves the other four consumers do too, and it exists because they are the
   * ones that would fail SILENTLY.
   *
   * Every closed note here carries a QUOTE that matches the document, so an
   * unfiltered note would not merely appear in the list — it would anchor into
   * the body, paint its block, add a rail dot and be counted by the tray. The
   * single `useMemo` in `PlanEditor` is what stops all five, and nothing else
   * does: `bodyRoots`, `roots`, `pending`, `byId` and `openNotesOn` all read
   * that one array.
   *
   * WHY IT IS WORTH A TEST NOBODY ASKED FOR. Loosening this filter is exactly
   * how a surface comes to render a non-`open` note, and the AC-2.9 diff gate
   * one file over was fixed on the assumption that it does not happen yet. Both
   * changes are cheap now and expensive to discover in four months, so the
   * assumption is written down as an assertion rather than left in a comment.
   */
  it('PT-2 — no surface renders a non-`open` note: body, paint, rail and tray', async () => {
    const closed = ['answered', 'applied', 'rejected', 'dismissed'] as const
    server.notes = [
      ...closed.map((status, i) =>
        note({ id: `c${i}`, status, quote: 'The keeper writes', comment: `${status} one` }),
      ),
      note({ id: 'live', status: 'open', quote: 'The keeper writes', comment: 'the live one' }),
    ]
    for (const density of ['full', 'compact'] as const) {
      const { container, unmount } = await editor(density)
      await screen.findByTestId('plan-anchored-live')
      // The body's partition: one anchored note and one painted block, not five.
      expect(container.querySelectorAll('[data-testid^="plan-anchored-"]')).toHaveLength(1)
      expect(container.querySelectorAll('.plan-noted')).toHaveLength(1)
      // Not swept into the loose bucket either — filtered, not merely unanchored.
      expect(screen.queryByTestId('plan-loose-notes')).toBeNull()
      for (const status of closed) {
        expect(container.textContent).not.toContain(`${status} one`)
      }
      // The section navigation's unresolved count is the fifth consumer, and it
      // reads the same array through `openNotesOn`. Both mounts render it —
      // the rail as a dot, the <select> as words — so both are asserted.
      if (density === 'full') {
        expect(
          container.querySelector('[data-section="goal"] [data-note-dot]')?.getAttribute('data-note-dot'),
        ).toBe('1')
      } else {
        expect(screen.getByLabelText('Plan sections').textContent).toContain('· 1 open')
      }
      unmount()
      cleanup()
    }
  })

  /**
   * THREADING IS GONE — a note with `reply_to` is a ROOT on ITS OWN SECTION.
   *
   * The response to a question about one section may legitimately belong on
   * another, which is why the parent/child tree had to go: there is no parent
   * under which such a note is correctly drawn. `reply_to` survives on the
   * payload as provenance and drives no layout, which is what the last
   * assertion pins — the note carries it and renders anyway.
   */
  it('a reply renders as a root on its own section, not nested under its parent', async () => {
    server.notes = [
      note({ id: 'par', section: 'goal', comment: 'why this goal?', to: 'coordinator' }),
      // The answer lands on a DIFFERENT section, which is the normal case.
      note({ id: 'rep', section: 'guardrails', reply_to: 'par', by: 'coordinator', to: 'user', comment: 'because of M2' }),
    ]
    const { container } = await editor('full')
    // Each lands in the section it NAMES — `goal` and `milestones` — which is
    // the whole claim being made and is now visible in the layout instead of
    // being flattened into one list at the foot of the page.
    const parent = container.querySelector('[data-note-id="par"]')!
    const reply = container.querySelector('[data-note-id="rep"]')!
    expect(screen.getByTestId('plan-sec-goal').contains(parent)).toBe(true)
    expect(screen.getByTestId('plan-sec-guardrails').contains(reply)).toBe(true)
    expect(parent).toBeTruthy()
    expect(reply).toBeTruthy()
    // NOT nested: neither contains the other anywhere in its subtree.
    expect(parent.contains(reply)).toBe(false)
    expect(reply.contains(parent)).toBe(false)
    // And nothing indents it — `depth` and its margin went with the recursion.
    expect((reply as HTMLElement).style.marginLeft).toBe('')
    // The provenance is still on the wire; it just stopped deciding layout.
    expect(server.notes[1].reply_to).toBe('par')
    // It DOES decide one line of text now, and this is the case that needs it
    // most: the two are on different sections, so the adjacency that would
    // otherwise imply the relation is gone and this line is the only thing
    // tying them together.
    const answering = within(reply as HTMLElement).getByTestId('plan-note-answering-rep')
    expect(answering.textContent).toContain("In reply to @backend's note")
    expect(answering.textContent).toContain('goal')
  })

  /**
   * THE ORDINARY CASE: same section, same quote, so `PlanBody` has already
   * drawn the two under the same block and the line only names what the
   * adjacency implies. It says WHOSE note is being answered and stops — no
   * section, because repeating one both notes are sitting in is noise.
   */
  it('names the note a reply answers, without naming a section they share', async () => {
    server.notes = [
      note({ id: 'par', section: 'goal', quote: 'The keeper writes', by: 'user', to: 'coordinator', kind: 'reply', comment: 'does this cover storage?' }),
      note({ id: 'rep', section: 'goal', quote: 'The keeper writes', reply_to: 'par', by: 'coordinator', to: 'user', comment: 'it does' }),
    ]
    await editor('full')
    const reply = await screen.findByTestId('plan-anchored-rep')
    const answering = within(reply).getByTestId('plan-note-answering-rep')
    // `reply`, not `question`: the parent's kind is the wire's reply marker —
    // `submit_review` stamps it and nothing else files one — so the line names
    // the act the user performed rather than the field it landed in. The
    // sibling above, whose parent is a `comment`, still reads `note`.
    expect(answering.textContent).toContain('In reply to your reply')
    expect(answering.textContent).not.toContain('goal')
    // Still not nested, and still not indented — this is text, not layout.
    const parent = await screen.findByTestId('plan-anchored-par')
    expect(parent.contains(reply)).toBe(false)
  })

  /**
   * A DANGLING `reply_to` DRAWS NOTHING. An id pointing at no note is a 400 at
   * the door now (`_reply_parent`), but notes filed before that door existed
   * are still on disk and must render — as themselves, not as a broken
   * reference to something that is not there.
   */
  it('draws no provenance line when reply_to resolves to nothing', async () => {
    server.notes = [note({ id: 'rep', section: 'goal', reply_to: 'n-gone', comment: 'orphan' })]
    await editor('full')
    await screen.findByTestId('plan-notes')
    expect(screen.queryByTestId('plan-note-answering-rep')).toBeNull()
  })

  /**
   * A REPLY OUTLIVES THE QUESTION IT ANSWERS. `PlanEditor` narrows `notes` to
   * `status === 'open'` before rendering, so resolving the parent against THAT
   * list would blink the line out the moment the parent closed — the one
   * moment the provenance is most worth having. It resolves against the
   * unfiltered `index.notes` instead.
   */
  it('keeps naming the parent after the parent has been resolved', async () => {
    server.notes = [
      note({ id: 'par', section: 'goal', by: 'user', to: 'coordinator', kind: 'reply', comment: 'why?', status: 'answered' }),
      note({ id: 'rep', section: 'goal', reply_to: 'par', by: 'coordinator', to: 'user', comment: 'because' }),
    ]
    await editor('full')
    const list = await screen.findByTestId('plan-notes')
    // The parent is closed, so it is off the screen entirely...
    expect(list.querySelector('[data-note-id="par"]')).toBeNull()
    // ...and the reply still says what it was answering.
    expect(screen.getByTestId('plan-note-answering-rep').textContent).toContain(
      'In reply to your reply',
    )
  })
})

describe('AC-8 — a staged reply inherits the anchor and adds no second mark', () => {
  it('stages an `ask` row, and the SUBMIT is what files the reply', async () => {
    server.notes = [note({ id: 'par', quote: 'The keeper writes', by: 'backend', to: 'user' })]
    const { container } = await editor('full')
    await screen.findByTestId('plan-anchored-par')

    // REPLYING WITHOUT LEAVING THE LINE: the field opens on the note, not in a
    // composer at the bottom of the page.
    fireEvent.click(screen.getByTestId('plan-note-reply-par'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'because it is' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-par'))

    // NOTHING IS FILED YET. One `ask` row, carrying the parent's id and a
    // computed addressee — and no `quote` and no `reply_to`, because the server
    // derives both from `note_id`. That derivation is why this is not a wire
    // change.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('ask')
    expect(server.draft[0].note_id).toBe('par')
    expect(server.draft[0].to).toBe('backend')
    expect(server.draft[0].comment).toBe('because it is')
    expect(server.notes).toHaveLength(1)

    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    await waitFor(() => expect(server.notes).toHaveLength(2))
    const reply = server.notes[1]
    expect(reply.reply_to).toBe('par')
    // `reply_to` is what MAKES it a reply; `kind` is derived from it rather
    // than stamped alongside it, so the two can no longer disagree.
    expect(reply.kind).toBe('reply')
    expect(reply.quote).toBe('The keeper writes')
    // THE PARENT STAYS OPEN. A question is not a resolution — the one deliberate
    // behaviour change change 9 makes, and nothing on this surface may imply the
    // parent was closed.
    expect(server.notes[0].status).toBe('open')
    // ONE paint, not two: a block is painted once however many notes it carries.
    await waitFor(() => expect(container.querySelectorAll('.plan-noted')).toHaveLength(1))
  })

  /**
   * THE `sends` DRIFT, PINNED. `round.sends` is keyed on the PARENT's `note_id`
   * for an `ask` row, so the reply never appears in it under its OWN id and
   * comes back `sent: false` even though the submit delivered it. A client that
   * reads `sent` to decide what is still waiting would put the delivered reply
   * straight back in the tray and send it a second time.
   */
  it('a delivered reply does NOT come back as something still to send', async () => {
    server.notes = [note({ id: 'par', by: 'backend', to: 'user' })]
    await editor('full')
    fireEvent.click(await screen.findByTestId('plan-note-reply-par'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'noted' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-par'))
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    await waitFor(() => expect(server.notes).toHaveLength(2))
    // The wire really does say this, which is the whole point of the test.
    expect(server.notes[1].sent).toBe(false)
    // ...and the tray is gone anyway. One message, not two.
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
    expect(server.messages).toHaveLength(1)
  })
})

/**
 * ONE ACT, ONE WORD, AT EVERY MOMENT OF ITS LIFE — and the wire keeping the
 * older one underneath the whole time.
 *
 * Change 9 collapsed `Ask` into `Reply` on the note bar and stopped there, so
 * the three surfaces that print the kind rather than the button kept saying
 * `ask`, and the note the submit filed came back labelled `question`. Both
 * values are load-bearing and neither moves: `ask` is `DRAFT_KINDS`, persisted
 * in `plan.json` while a tray is open, and `question` is `PlanNote.kind`,
 * stored permanently and read back by threading.
 *
 * THE WIRE ASSERTIONS BELOW ARE NOT DECORATION. They are what makes this a
 * vocabulary test and not a rename waiting to happen: a future change that
 * "finishes the job" by moving the enum has to fail here, in the same test
 * that asked for the words.
 */
describe('a reply is called a reply everywhere the user can read it', () => {
  it('the badge, the tray row and its ✕ all say `reply`, and the wire says `ask`', async () => {
    server.notes = [note({ id: 'par', by: 'backend', to: 'user' })]
    await editor('full')

    fireEvent.click(await screen.findByTestId('plan-note-reply-par'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'which one?' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-par'))
    await waitFor(() => expect(server.draft).toHaveLength(1))

    // 1. THE BADGE, which reports the staged row from the note's end and used
    //    to contradict the button an inch above it.
    expect(screen.getByTestId('plan-note-acts-par').textContent).toContain('Staged as reply')

    // 2. THE LIST ROW, which reports the same row from the batch's end — on the
    //    comment it decides, which is where it moved when the tray became a
    //    send bar.
    const list = await screen.findByTestId('plan-comment-list')
    const row = list.querySelector('[data-row-kind]') as HTMLElement
    expect(row.textContent).toContain('reply')
    // The label is a DISPLAY word: the attribute beside it still carries the
    // kind, and that is how the two stay distinguishable at all.
    expect(row.dataset.rowKind).toBe('ask')

    // 3. THE ✕, which no sighted user reads and every screen-reader user does.
    expect(within(list).getByRole('button', { name: 'Remove reply row' })).toBeTruthy()
    expect(within(list).queryByRole('button', { name: 'Remove ask row' })).toBeNull()

    // AND THE PAYLOAD, unchanged by any of it.
    expect(server.draft[0].kind).toBe('ask')
  })

  /**
   * AFTER THE SEND, where the word used to change under the user: they clicked
   * `Reply` and got a card labelled `question`. The browser papered over that
   * with a `KIND_LABEL` map; the map is gone, because the wire word is `reply`
   * now — derived from `reply_to`, which every reply carries whichever door it
   * came through. So the chip and the button say the same thing, and they say
   * it for an agent's `plan note --reply-to` too, which the old stamp missed.
   */
  it('the filed note is chipped `reply`, and that is its kind on the wire', async () => {
    server.notes = [note({ id: 'par', by: 'backend', to: 'user' })]
    const { container } = await editor('full')

    fireEvent.click(await screen.findByTestId('plan-note-reply-par'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'it does' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-par'))
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(server.notes).toHaveLength(2))

    expect(server.notes[1].kind).toBe('reply')
    const card = await waitFor(() => {
      const el = container.querySelector('[data-note-id="' + server.notes[1].id + '"]')
      if (!el) throw new Error('the filed reply has not rendered')
      return el as HTMLElement
    })
    // The kind chip is the only `uppercase` span on a note card.
    expect((card.querySelector('.uppercase') as HTMLElement).textContent).toBe('reply')
  })
})

describe('AC-9 — one cap, every path that can mint a quote', () => {
  it('a paragraph longer than the cap is stored truncated, and STILL ANCHORS', async () => {
    // THE CAP STOPPED BEING EXOTIC. It used to be reachable only by dragging
    // across half the document — a deliberate act. A whole-block capture hits
    // it on any paragraph that long, with no user intent involved at all, so
    // the truncated case is now ordinary and has to behave.
    //
    // What is stored is a PREFIX of the block's own text. `blockCarries` tests
    // `includes` on whitespace-normalised text, so the block still carries it
    // and still paints WHOLE — the note does not go loose for being cut. The
    // only cost is display: the quote is echoed verbatim wherever it is listed,
    // and there it reads as a sentence cut mid-air.
    const long = 'The keeper writes it. '.repeat(400)
    server.body = `# Project Plan: demo\n\n## Goal\n\n${long.trim()}\n`
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    fireEvent.change(await screen.findByLabelText('What do you want to say about this?'), {
      target: { value: 'far too much' },
    })
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(server.notes).toHaveLength(1))
    // ~8800 characters in the block; at most 4000 stored.
    expect(server.notes[0].quote.length).toBeLessThanOrEqual(4000)
    expect(server.notes[0].quote.length).toBeGreaterThan(3990)
    // ...and the truncated quote still anchors, on the refetch, whole.
    await screen.findByTestId(`plan-anchored-${server.notes[0].id}`)
    expect(container.querySelector('[data-testid="plan-loose-notes"]')).toBeNull()
    expect(container.querySelector('.plan-noted')!.textContent).toBe(long.trim())
  })

  /**
   * THE REPLY PATH NO LONGER MINTS A QUOTE, so there is nothing left for it to
   * smuggle. It used to POST a note carrying `quote: note.quote`, which is why
   * this file capped it; a staged `ask` row carries no quote at all and the
   * server derives one from `note_id`. The assertion moves from "the client caps
   * it" to "the client does not send it" — which is the stronger claim, because
   * a field that is never sent cannot be over-long.
   */
  it('a reply sends NO quote — the server derives it from the parent', async () => {
    server.notes = [note({ id: 'big', quote: 'x '.repeat(6000), to: 'user' })]
    await editor('full')
    fireEvent.click(await screen.findByTestId('plan-note-reply-big'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'noted' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-big'))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(JSON.stringify(server.draft[0])).not.toContain('xxxx')
  })

  /**
   * THE UN-QUOTED CHANNEL LEFT THE BROWSER WITH THE COMPOSER, and this is what
   * replaces the test that drove it. Such notes are still FILED — by
   * `clawmeets plan note` with no `--quote` — and they still RENDER.
   *
   * **WHERE they render is the assertion that changed, and it is the middle
   * rung of the placement ladder.** This used to demand the page-bottom list,
   * on the reasoning that "a note with no quote has no line to sit under" —
   * true, and an answer to a question nobody asked. It has no LINE; it has a
   * SECTION, and the end of that section is a place. The old expectation put a
   * note about `## Goal` below the whole document, level with notes about
   * nothing, and called that the only option.
   *
   * So the two halves are now pinned separately, because they are different
   * claims: NOT under a block (there is no line to choose), and IN the section
   * (there is a section to be at the end of).
   */
  it('no browser control files an un-quoted note, and an un-quoted note sits at the end of its section', async () => {
    server.notes = [note({ id: 'cli', section: 'goal', quote: '', comment: 'about the whole thing' })]
    const { container } = await editor('full')
    // The composer that used to file these is gone — both of its fields with it.
    expect(screen.queryByTestId('plan-composer')).toBeNull()
    expect(screen.queryByLabelText('Comment')).toBeNull()
    expect(screen.queryByRole('button', { name: 'File note' })).toBeNull()
    // ...and the CLI's note is on screen anyway, inside the section it names.
    const section = await screen.findByTestId('plan-sec-goal')
    expect(section.textContent).toContain('about the whole thing')
    // Not under a block — there is no line it claims to be about.
    expect(container.querySelector('[data-testid="plan-anchored-cli"]')).toBeNull()
    // And the reason printed above it says exactly that. It must NOT be either
    // of the two "your line is gone" sentences: nothing is missing here, and
    // reporting a deletion that did not happen is the failure this branch
    // exists to prevent.
    const why = within(section).getByTestId('plan-unanchored-cli')
    expect(why.textContent).toBe('On this section as a whole, not on one line.')
    // The page-bottom list is left for notes whose SECTION does not resolve.
    expect(screen.getByTestId('plan-notes').textContent).toContain('No notes here')
  })

  /**
   * THE BOTTOM RUNG, AND THE REASON THE PAGE-BOTTOM LIST CANNOT BE DELETED.
   *
   * Its old justification — "this is where every un-quoted note ever filed from
   * the CLI renders" — stopped being true the moment such notes went to the end
   * of their section, and a list kept for a reason that has expired is a list
   * somebody deletes. This is the reason that survives: a note whose section
   * does not resolve names nothing on screen to sit beside, so there is nowhere
   * in the document to put it and it must not be dropped.
   *
   * Two ways to name nothing, both pinned, because they are separate bugs:
   * a section that is GONE from the body, and no section at all.
   */
  it('a note whose section does not resolve renders in the page-bottom list', async () => {
    server.notes = [
      note({ id: 'gone', section: 'a-section-nobody-kept', comment: 'about a deleted heading' }),
      note({ id: 'none', section: '', comment: 'about the document as a whole' }),
    ]
    const { container } = await editor('full')
    const list = await screen.findByTestId('plan-notes')
    expect(list.textContent).toContain('about a deleted heading')
    expect(list.textContent).toContain('about the document as a whole')
    // Both are HERE and only here — nothing invented a section to hide them in.
    expect(container.querySelectorAll('[data-note-id]')).toHaveLength(2)
    expect(list.querySelectorAll('[data-note-id]')).toHaveLength(2)
  })
})

describe('the composer posts through the one note route', () => {
  it('files the note with the quote, the section off the DOM, and the chosen addressee', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'who decided this?' },
    })
    // The keeper is the default addressee and is already a chip; choosing is
    // now a matter of adding to or removing from that set, which the picker's
    // own suite drives. Here it is filed as it opens.
    fireEvent.click(screen.getByText('File note'))

    await waitFor(() => expect(server.notes).toHaveLength(1))
    expect(server.notes[0]).toMatchObject({
      section: 'goal',
      to: 'coordinator',
      comment: 'who decided this?',
      quote: GOAL_PARA,
    })
    // And it anchors on the refetch, without a reload.
    await screen.findByTestId(`plan-anchored-${server.notes[0].id}`)
  })

  it('Escape closes it and files nothing', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const ta = await screen.findByLabelText('What do you want to say about this?')
    fireEvent.keyDown(ta, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('plan-quote-pop')).toBeNull())
    expect(server.notes).toHaveLength(0)
  })

  /**
   * ESCAPE FROM ANYWHERE INSIDE THE COMPOSER, not only from the textarea.
   *
   * Focus starts in the textarea, so the old handler covered the common path —
   * but this surface deliberately supports keyboard selection (`PlanBody`
   * captures shift+arrows, which the prototype did not), so keyboard users are
   * exactly the people who tab on to a To-chip, and from there Escape did
   * nothing at all: the only ways out were Cancel or a click on the document.
   */
  /* EVERY ENTRY POINT BUT TWO HAS NOW GONE, AND THE MECHANISM IS UNCHANGED.
     The picker took three with it (the To-chip, the "someone else" chip and the
     free-text addressee field), the question flag a fourth, and the addressee
     strip and the proposal textarea the last two. What they exercised survives
     every one of those deletions: ONE handler on the popover root, and nothing
     inside it calling `stopPropagation` on a keydown. So it is asserted through
     whatever the composer still contains — and the shrinking of this list is
     the simplification landing rather than coverage draining away, because a
     control that no longer exists cannot fail to close the popover. */
  describe('Escape closes it from every control it contains', () => {
    const from: [string, (pop: HTMLElement) => Element][] = [
      ['the Cancel button', (pop) => pop.querySelector('.plan-pop-bar .plan-btn')!],
      ['the popover container itself', (pop) => pop],
    ]

    it.each(from)('from %s', async (_what, pick) => {
      const { container } = await editor('full')
      commentOn(container as HTMLElement, 'The keeper writes')
      const pop = await screen.findByTestId('plan-quote-pop')
      fireEvent.keyDown(pick(pop), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByTestId('plan-quote-pop')).toBeNull())
      expect(server.notes).toHaveLength(0)
    })
  })

  it('Cmd+Enter submits', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const ta = await screen.findByLabelText('What do you want to say about this?')
    fireEvent.change(ta, { target: { value: 'quick one' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(server.notes).toHaveLength(1))
  })
})

/**
 * OPERATING A NOTE WHERE IT SITS.
 *
 * The gestures that used to live at the bottom of the page — reply through the
 * composer, resolve inside a collapsed `<details>` — are on the note now. What
 * these pin is not the pixels but the two things that would be silently wrong:
 * WHICH ROUTE each control reaches, and WHO a reply is addressed to.
 */
/**
 * CHANGE 9 — NOTHING ABOUT A NOTE HAPPENS ON THE CLICK.
 *
 * The row used to carry two labelled groups because `Dismiss` and `Dismiss now`
 * sat side by side, one word apart and irreversibly different. `Apply now`,
 * `Resolve` and `Dismiss now` are gone, `Reply` stages, and the labels went with
 * them: a label that splits a set into one group and an empty one is noise.
 */
/**
 * AC-2.1 — WHO WROTE THE NOTE NOW REACHES A CONDITION.
 *
 * `note.by` was read five times on the row for display and gated nothing, so
 * the owner's own unsent note, the owner's own sent note and an agent's note
 * rendered byte-identical verb sets. Two of the three were wrong.
 *
 * SHIPPED WITH TWO CLAUSES OF THREE, BY AN OPEN OWNER DECISION. The third would
 * also withhold `Reply` on your own note addressed to nobody; that behaviour is
 * deliberately pinned further down this file and removing it is not a keyboard
 * decision. The case below that would have moved is asserted at its CURRENT
 * behaviour, so the day the ruling lands there is one assertion to invert and
 * it is impossible to miss.
 */
describe('AC-2.1 — the verbs on a note depend on who wrote it', () => {
  /** Your own note, still in the batch. Answering yourself before the thing has
   *  gone anywhere is not a reply — the act available here is editing the
   *  batch. */
  it('your own unsent note offers no Reply', async () => {
    server.notes = [note({ id: 'n1', by: 'user', to: 'backend' })]
    await editor('full')
    const acts = within(await screen.findByTestId('plan-note-acts-n1'))
    // The precondition the whole case rests on, asserted rather than assumed:
    // this note really is in the tray's pending half.
    expect(screen.getByTestId('plan-note-waiting-n1')).toBeTruthy()
    expect(screen.queryByTestId('plan-note-reply-n1')).toBeNull()
    // The third verb survives on your own note — it is how you take it back out
    // of the batch — and this item does not touch it. AC-2.3 later gives it the
    // label that says what it does; the button is the same button.
    expect(acts.getByRole('button', { name: 'Drop from this batch' })).toBeTruthy()
  })

  /** Once it HAS gone out, replying is adding to a thread an agent can see. */
  it('your own SENT note offers Reply again', async () => {
    server.notes = [note({ id: 'n1', by: 'user', to: 'backend', sent: true })]
    await editor('full')
    expect(screen.queryByTestId('plan-note-waiting-n1')).toBeNull()
    expect(screen.getByTestId('plan-note-reply-n1')).toBeTruthy()
  })

  /** THE ROW THAT MUST NOT MOVE. An agent's note is the common case and the
   *  author gate has no business narrowing it — a rule that fires on everything
   *  is the failure mode of a predicate this cheap. */
  it("an agent's note is untouched: Reply stays", async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor('full')
    expect(screen.getByTestId('plan-note-reply-n1')).toBeTruthy()
  })

  /**
   * `Ask` IS GONE FROM THE BAR, AND THE CASE THAT PROVES IT IS THE ONE WHERE IT
   * USED TO RENDER. `Ask` and `Reply` staged the byte-identical `ask` row, and
   * `Ask` was offered only on `!mine` — a strict subset of `mayReply` — so the
   * collapse loses no reachable act. Asserted on an agent's note precisely
   * because that is where `Ask` DID appear: a `queryByRole` on your own note
   * would have passed before the removal too and proven nothing.
   */
  it('the second label for that act is gone — `Ask` renders nowhere', async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor('full')
    const acts = within(await screen.findByTestId('plan-note-acts-n1'))
    expect(acts.queryByRole('button', { name: 'Ask' })).toBeNull()
    // The act itself survives under the surviving label, on the same note.
    fireEvent.click(screen.getByTestId('plan-note-reply-n1'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'why this?' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-n1'))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    // The DRAFT KIND is untouched by the label removal — `ask` is what `Reply`
    // stages, which is why this is not a wire change.
    expect(server.draft[0].kind).toBe('ask')
    expect(server.draft[0].to).toBe('backend')
  })
})

describe('AC-2.8 — the decision verbs read a permission, not a scratch pad', () => {
  /**
   * The one assertion this item exists for, and the fake is built so that it
   * CANNOT pass by accident: `FakePlanServer` hands out a `draft` object
   * unconditionally, so `draft !== null` is true throughout. If anyone restores
   * that proxy — as a fallback, an `??`, or a "defensive" default — this test
   * goes green-to-red on the spot, which is exactly the version mismatch the
   * no-fallback rule is there to make visible.
   */
  it('`can_decide: false` withholds Accept and Reject even with a tray in hand', async () => {
    server.canDecide = false
    server.notes = [note({ id: 'n1', to: 'user', by: 'backend', has_proposal: true, proposal: 'x' })]
    await editor('full')
    const acts = within(await screen.findByTestId('plan-note-acts-n1'))
    expect(acts.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(acts.queryByRole('button', { name: 'Reject' })).toBeNull()
    // The tray IS present — so the old proxy would have said yes here. That is
    // the whole content of the test.
    expect(server.index().draft).not.toBeNull()
    // Nothing else on the bar moved: this item is about the two decision verbs
    // and about nothing else.
    expect(screen.getByTestId('plan-note-reply-n1')).toBeTruthy()
    expect(acts.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })
})

/**
 * AC-2.2 — THE ABSENCE OF `Accept`/`Reject` IS EXPLAINED, AND BOTH CAUSES ARE.
 *
 * The verbs are withheld by two unrelated conditions and the card stated
 * neither, so the owner read one absence with two possible meanings. Two
 * sentences rather than one hedge, for the reason `looseReason` already gives
 * one file over: the cases are distinguishable, so collapsing them
 * under-reports both.
 */
/**
 * AC-2.3 — DISMISSAL IS DEFERRED, NOT IMPOSSIBLE, AND THE COPY SAID NEITHER.
 *
 * Dismissing your own note takes it out of THIS BATCH on the click and closes
 * it on the next SEND — two different times in one act. The tray implied the
 * second was a way of not sending; the button and the staged line named only
 * the row. All three now say what actually happens, and the act itself is
 * unchanged: same handler, same `dismiss` row on the wire.
 */
/**
 * AC-2.4 — THE COMPOSER STAYS ON SCREEN WHILE THE NOTE GOES, AND KEEPS YOUR
 * TEXT WHEN IT DOES NOT.
 *
 * `submit` used to call `onClose()` on the same tick, which was doing two jobs
 * by accident: closing on success, and unmounting the component before the
 * request resolved. The unmount WAS the double-submit protection, and it was
 * also what destroyed a failed note's text — `setQuoted(null)` had already run,
 * so the user got an error banner at the top of the pane and an empty screen.
 * Both cases are pinned here because fixing either one alone breaks the other.
 */
/**
 * AC-2.6 — THE CONFLICT IS SHOWN AT ACCEPT TIME, NOT AFTER A REFUSED SUBMIT.
 *
 * `PlanCollide` already handled this case and already had the right three
 * choices; what it did not have was the signal, one decision earlier. The owner
 * used to accept, stage, batch, press `Send review`, have the whole batch
 * refused, and only then see the two texts. `section_changed` was on the note
 * the entire time.
 */
describe('AC-2.6 — accepting a proposal written against an older section', () => {
  it('opens the three-way control instead of staging silently', async () => {
    server.notes = [
      note({
        id: 'n1',
        to: 'user',
        by: 'backend',
        has_proposal: true,
        proposal: '## Goal\n\ntheirs\n',
        base_section: '## Goal\n\nsomething older\n',
      }),
    ]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

    // Nothing staged. The accept is a QUESTION now, not a silent write.
    const collide = await screen.findByRole('group', { name: 'Two versions of goal' })
    expect(server.draft).toHaveLength(0)
    expect(collide.textContent).toContain(
      'This section changed since @backend proposed this. Their text was written against an older version.',
    )
    // BOTH DIRECTIONS OF THE QUESTION, AS DIFFS. The panes are gone: a
    // side-by-side of two whole sections was two screenfuls to compare by eye,
    // and a unified diff pairs the lines instead. So the section's own line
    // appears as a REMOVAL under "what taking theirs does" and the proposal's
    // line as an addition — which is the fact the panes left the reader to
    // work out.
    expect(collide.textContent).toContain("What taking @backend's does")
    expect(collide.textContent).toContain('What keeping what it says now does')
    expect(collide.textContent).toContain('-The keeper writes the **first** plan and nobody else does.')
    expect(collide.textContent).toContain('+theirs')

    // Taking theirs stages the accept it would have staged silently — the
    // control reports the conflict, it does not change the outcome the user
    // chooses.
    fireEvent.click(within(collide).getByRole('button', { name: /^Take @backend's/ }))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('accept')
  })

  /**
   * MOUNTED AND VISIBLE ARE THE SAME FACT IN JSDOM AND TWO DIFFERENT FACTS IN A
   * BROWSER, WHICH IS HOW THIS SHIPPED.
   *
   * The test above asserts the control is in the DOM, and it always was. What
   * the owner saw on a desk card was `Accept` doing nothing: `PlanCollide`
   * renders at the top of the pane, the note whose button opened it is below,
   * and at `density="compact"` the pane is a 420px scroller — so the question
   * mounted off-screen above them. Both open notes on the reported plan carried
   * `section_changed`, so every Accept on that card was inert.
   *
   * `scrollIntoView` does not exist in jsdom, which is why the production call
   * is optional-chained; stubbing it is therefore the only way this is
   * observable at all, and asserting WHICH element it was called on is what
   * makes the test about the fix rather than about the stub.
   */
  it('scrolls the control into view, because it opens above the button', async () => {
    const scrolled: Element[] = []
    const proto = window.HTMLElement.prototype as unknown as {
      scrollIntoView?: (arg?: unknown) => void
    }
    const had = 'scrollIntoView' in proto
    const prior = proto.scrollIntoView
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      server.notes = [
        note({
          id: 'n1',
          to: 'user',
          by: 'backend',
          has_proposal: true,
          proposal: '## Goal\n\ntheirs\n',
          base_section: '## Goal\n\nsomething older\n',
        }),
      ]
      await editor('compact')
      fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

      const collide = await screen.findByRole('group', { name: 'Two versions of goal' })
      await waitFor(() =>
        expect(scrolled.some((el) => el.contains(collide))).toBe(true),
      )
    } finally {
      if (had) proto.scrollIntoView = prior
      else delete proto.scrollIntoView
    }
  })

  /**
   * THE FIELD REPORT, AS A TEST. Both open notes on the reported plan differed
   * from the section by ONE line out of ninety — a ticked box — and the same
   * agent had written both the section and the proposal. So the control put two
   * identical screenfuls side by side under `Keep @devops's` and
   * `Take @devops's`, and the owner could not tell the two choices apart, let
   * alone see what taking one would do.
   *
   * Neither half of that is about when to ask. `acceptRow` stages `base:
   * current`, so this gate guards no precondition and §3.3 keeps it a string
   * comparison rather than a merge trial — the question is right, and it was
   * only illegible.
   */
  it('shows only what differs, and names the choices apart', async () => {
    const head = Array.from({ length: 40 }, (_, i) => `head ${i}`).join('\n')
    const tail = Array.from({ length: 40 }, (_, i) => `tail ${i}`).join('\n')
    const current = `## Goal\n\n${head}\n- [x] **M3** — unassigned\n${tail}\n`
    const theirs = `## Goal\n\n${head}\n- [x] **M3** — frontend (delivered)\n${tail}\n`
    server.body = server.body.replace(server.sectionText('goal'), current)
    server.notes = [
      note({
        id: 'n1',
        to: 'user',
        by: 'devops',
        has_proposal: true,
        proposal: theirs,
        base_section: `## Goal\n\n${head}\n- [ ] **M3** — unassigned\n${tail}\n`,
      }),
    ]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    const collide = await screen.findByRole('group', { name: 'Two versions of goal' })

    // The disputed line is on screen and the 40 identical lines above it are
    // not. `differingBand` used to buy that with a head/tail trimmer of its
    // own; a unified diff gives it natively, as a hunk header plus three lines
    // of context, and the heuristic went with the panes rather than being kept
    // beside them.
    expect(collide.textContent).toContain('- [x] **M3** — frontend (delivered)')
    expect(collide.textContent).not.toContain('head 0')
    expect(collide.textContent).not.toContain('tail 39')
    expect(collide.textContent).toContain('head 39')
    expect(collide.textContent).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)

    // The document side is named by WHAT it is, so the two buttons are not the
    // same words. `devops` still appears, as attribution rather than as a choice.
    expect(within(collide).getByRole('button', { name: 'Keep what it says now' })).toBeTruthy()
    expect(within(collide).getByRole('button', { name: /^Take @devops's/ })).toBeTruthy()
    expect(collide.textContent).toContain('last edited by @')

    // And it still stages the accept it was always going to stage.
    fireEvent.click(within(collide).getByRole('button', { name: /^Take @devops's/ }))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('accept')
  })

  it('a proposal against the CURRENT section still stages on the click', async () => {
    server.notes = [
      note({
        id: 'n1',
        to: 'user',
        by: 'backend',
        has_proposal: true,
        proposal: '## Goal\n\ntheirs\n',
        base_section: server.sectionText('goal'),
      }),
    ]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    // No control, no question: nothing moved, so there is nothing to reconcile.
    expect(screen.queryByRole('group', { name: 'Two versions of goal' })).toBeNull()
  })
})

describe('AC-2.4 — the composer survives its own request', () => {
  /** Two clicks in one tick. The parent's `busy` cannot cover this and never
   *  could: it is set inside the async handler, a render later, so both clicks
   *  read it `false`. The guard is `pending`, set synchronously in `submit`. */
  it('two clicks on a slow post file one note, not two', async () => {
    const { container } = await editor('full')
    let release: (() => void) | null = null
    const realPost = routes.current!.post
    const seen: unknown[] = []
    routes.current!.post = async (path: string, body?: unknown) => {
      if (!path.endsWith('/plan/notes')) return realPost(path, body)
      seen.push(body)
      await new Promise<void>((r) => {
        release = r
      })
      return realPost(path, body)
    }

    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'once, please' },
    })
    const button = screen.getByText('File note')
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)

    // The composer is still on screen and says so without being disabled — a
    // disabled button cannot hold focus, and this surface autofocuses.
    expect(screen.getByTestId('plan-quote-pop')).toBeTruthy()
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(seen).toHaveLength(1)

    release!()
    // Success is what closes it, and the parent is what does the closing.
    await waitFor(() => expect(screen.queryByTestId('plan-quote-pop')).toBeNull())
    expect(server.notes).toHaveLength(1)
  })

  /** The data loss, pinned. Everything typed survives a refusal, the refusal is
   *  rendered where the text is, and a second attempt is one click away.
   *
   *  IT USED TO DRIVE THE PROPOSAL BOX TOO, and that half is deleted rather
   *  than re-pointed: there is no second box to keep, because a user does not
   *  author a proposal here any more. What the case was actually pinning — a
   *  refusal does not unmount the composer, and does not take the user's words
   *  with it — is unchanged and is what remains.
   *
   *  AND IT PINS THE ONE PLACE THE HIGHLIGHT OUTLIVES THE GESTURE. Every other
   *  path out of the composer drops the mark on the block; a failure is not a
   *  path out, so the block stays lit while the user fixes the text and
   *  retries. That is deliberate — the mark answers "which block is this
   *  about", and the answer is still needed while the note is still unsent. */
  it('a refused post keeps the popover, the comment, and the block lit', async () => {
    const { container } = await editor('full')
    const realPost = routes.current!.post
    let fail = true
    routes.current!.post = async (path: string, body?: unknown) => {
      if (path.endsWith('/plan/notes') && fail) throw new Error('The section moved under this note.')
      return realPost(path, body)
    }

    commentOn(container as HTMLElement, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'a thought worth keeping' },
    })
    fireEvent.click(screen.getByText('File note'))

    const pop = await screen.findByTestId('plan-quote-pop')
    await waitFor(() => expect(within(pop).getByRole('alert')).toBeTruthy())
    // The refusal is INSIDE the composer, tied to the field a fix would be
    // typed into — not a red line at the top of the pane, possibly a full
    // scroll away from a popover that no longer exists.
    expect(within(pop).getByRole('alert').textContent).toContain('The section moved under this note.')
    const ta = screen.getByLabelText('What do you want to say about this?') as HTMLTextAreaElement
    expect(ta.getAttribute('aria-describedby')).toBe(within(pop).getByRole('alert').id)
    // Every character still there.
    expect(ta.value).toBe('a thought worth keeping')
    // And the block is still marked, because the composer never went away.
    expect(container.querySelector('[data-plan-commenting="true"]')).toBeTruthy()
    // Not stuck: the guard released, so the same text files on a retry.
    expect(screen.getByText('File note').getAttribute('aria-busy')).toBe('false')
    fail = false
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(server.notes).toHaveLength(1))
    expect(server.notes[0].comment).toBe('a thought worth keeping')
  })
})

describe('AC-2.3 — dismissing your own note is deferred, and says so', () => {
  it('the verb, the staged line and the tray all name the two times', async () => {
    server.notes = [note({ id: 'n1', by: 'user', to: 'backend', comment: 'mine' })]
    await editor('full')
    const acts = within(await screen.findByTestId('plan-note-acts-n1'))
    // The label, on your own note still in the batch.
    const drop = acts.getByRole('button', { name: 'Drop from this batch' })
    expect(acts.queryByRole('button', { name: 'Dismiss' })).toBeNull()

    // The comment list states the immediate half and the deferred half
    // separately. It is the list's line rather than the tray's because it
    // explains why a PENDING ROW carries no ✕, and the rows live there now.
    expect(screen.getByTestId('plan-comment-list').textContent).toContain(
      'A filed note cannot be unwritten. Dismissing one drops it from this batch straight away; it closes on your next send.',
    )

    fireEvent.click(drop)
    // The immediate half, asserted as behaviour and not only as copy: the note
    // is out of the tray's pending list and has lost its chip on the click.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('dismiss')
    expect(screen.queryByTestId('plan-note-waiting-n1')).toBeNull()
    // And the staged line names the deferred half rather than the row's kind.
    expect(screen.getByTestId('plan-note-dropped-n1').textContent).toBe(
      'Dropped from this batch — closes on your next send',
    )
    // The deferred half is genuinely deferred: nothing has closed yet.
    expect(server.notes[0].status).toBe('open')
  })

  /** The one clause beyond the spec's condition column, pinned so it is a
   *  decision rather than an accident. A dismiss staged on an AGENT's note is
   *  not a drop from anything — that note was never in your batch — so it keeps
   *  the row's own word. */
  it("an agent's note keeps `Staged as dismiss`, which is what it is", async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    const acts = await screen.findByTestId('plan-note-acts-n1')
    await waitFor(() => expect(acts.textContent).toContain('Staged as dismiss'))
    expect(screen.queryByTestId('plan-note-dropped-n1')).toBeNull()
  })

  /**
   * THE SAME FALSE SENTENCE ON THE OTHER AXIS, AND THE BUTTON ALREADY KNEW.
   *
   * `mine` is not the whole condition: the Dismiss button gates its own label
   * on `mine && unsent`, and `unsent` is false on three shapes of own-note —
   * SENT, addressed to NOBODY, and a reply. On each of those the button says
   * `Dismiss` while the staged line claimed a drop from a batch the note was
   * never in: two controls one row apart contradicting each other, and the
   * line the one the user can check and find false. They are asserted TOGETHER
   * here, because agreement between them is the actual property — either alone
   * would pass with the pair still inconsistent.
   */
  it.each([
    ['a SENT own-note — it was never in this batch', { sent: true, to: 'backend' }],
    ['an own-note addressed to NOBODY — it never was pending', { sent: false, to: '' }],
    // The third shape the docstring names. `reply_to` is dangling on purpose:
    // the provenance line resolves it off the unfiltered list and draws nothing
    // when it misses, so this row is the reply case and nothing else.
    [
      'a REPLY of your own — never offered for delivery',
      { sent: false, to: 'backend', reply_to: 'n0' },
    ],
  ])('%s keeps `Staged as dismiss`, and the button agrees', async (_what, over) => {
    server.notes = [note({ id: 'n1', by: 'user', status: 'open', comment: 'mine', ...over })]
    await editor('full')
    const acts = within(await screen.findByTestId('plan-note-acts-n1'))
    // The button's own label already reports this note is not in the batch.
    expect(acts.queryByRole('button', { name: 'Drop from this batch' })).toBeNull()
    // `WITHDRAW`, NOT `DISMISS`, AND THE CLAIM IS UNCHANGED. These are the
    // three own-note shapes that are not in your batch, and the button now
    // says so with a verb for the act instead of `Dismiss` — which reads as
    // "make this go away" and is what made a note of your own look like a
    // chore you owed. The property under test is that the button and the
    // staged line AGREE about the batch, and both still do; the assertion
    // moves to the word the button now uses rather than being dropped.
    fireEvent.click(acts.getByRole('button', { name: 'Withdraw' }))

    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('dismiss')
    // And the staged line now says the same thing the button did.
    expect(screen.getByTestId('plan-note-acts-n1').textContent).toContain('Staged as dismiss')
    expect(screen.queryByTestId('plan-note-dropped-n1')).toBeNull()
  })
})

describe('AC-2.2 — the card says WHY it is not offering Accept or Reject', () => {
  it('no proposal on the note names the missing text, not the missing permission', async () => {
    server.notes = [note({ id: 'n1', to: 'user', by: 'backend', has_proposal: false })]
    await editor('full')
    const acts = await screen.findByTestId('plan-note-acts-n1')
    expect(acts.textContent).toContain(
      'No proposed text on this note — nothing to accept or reject. Reply to ask for one, or edit the section yourself.',
    )
    // The OTHER cause is not asserted here, and that is the point of splitting
    // them: this reader may decide perfectly well, there is just nothing to
    // decide about.
    expect(screen.queryByTestId('plan-note-why-not-you-n1')).toBeNull()
    expect(within(acts).queryByRole('button', { name: 'Accept' })).toBeNull()
  })

  it('a proposal you may not decide names the permission, not the missing text', async () => {
    server.canDecide = false
    server.notes = [note({ id: 'n1', to: 'user', by: 'backend', has_proposal: true, proposal: 'x' })]
    await editor('full')
    const acts = await screen.findByTestId('plan-note-acts-n1')
    expect(acts.textContent).toContain("Only the plan's owner can accept or reject a proposal.")
    // Never both. The two conditions are mutually exclusive by construction —
    // one needs `has_proposal`, the other needs its negation — and a card that
    // printed both would be the hedge this item exists to avoid.
    expect(screen.queryByTestId('plan-note-why-none-n1')).toBeNull()
    expect(within(acts).queryByRole('button', { name: 'Accept' })).toBeNull()
  })
})

describe('every control on a note stages, and the bar says so once', () => {
  it('one help line, no group labels, and none of the three immediate controls', async () => {
    server.notes = [note({ id: 'n1', to: 'user', by: 'backend', has_proposal: true, proposal: 'x' })]
    await editor('full')
    const acts = await screen.findByTestId('plan-note-acts-n1')
    // The settled string, asserted EXACTLY. "written" was loose about the draft
    // PUT that every staged control performs; "reaches the plan or its
    // addressees" is exact about it, and a later paraphrase that re-introduces
    // the old word has to argue with this line rather than slip through review.
    expect(acts.textContent).toContain('nothing reaches the plan or its addressees until you submit')
    expect(acts.textContent).not.toContain('nothing is written until you submit')
    expect(acts.textContent).not.toContain('Goes in your batch')
    expect(acts.textContent).not.toContain('Happens now')
    expect(acts.textContent).not.toContain('filed straight away')
    for (const gone of ['Dismiss now', 'Apply now', 'Resolve']) {
      expect(within(acts).queryByRole('button', { name: gone })).toBeNull()
    }
    // What is left, all of it batched.
    for (const kept of ['Accept', 'Reject', 'Dismiss']) {
      expect(within(acts).getByRole('button', { name: kept })).toBeTruthy()
    }
    expect(within(acts).getByTestId('plan-note-reply-n1')).toBeTruthy()
    // `Ask` was the fourth, and it was `Reply` under a second label. Named in
    // the gone-list rather than dropped silently, so the removal is asserted
    // where the surviving set is.
    expect(within(acts).queryByRole('button', { name: 'Ask' })).toBeNull()
  })

  it('Dismiss stages and moves no status; the SUBMIT is what moves it', async () => {
    server.notes = [note({ id: 'n1', to: 'user', by: 'backend' })]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('dismiss')
    // The note is untouched — a staged dismiss is a PROPOSAL to dismiss.
    expect(server.notes[0].status).toBe('open')

    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(server.notes[0].status).toBe('dismissed'))
  })

  /**
   * AC-2.15 — THE RULE, ASSERTED DIRECTLY. Stage a note EVERY way the row allows
   * and count what reached the wire. Both halves matter: the resolve route is
   * what `Apply now` / `Resolve` / `Dismiss now` used to reach, and
   * `POST /plan/notes` is what `Reply` used to reach — the resolve half alone
   * would have passed against a Reply that still POSTed on the click.
   *
   * SCOPED TO THE EDITOR MOUNT ON PURPOSE. `PlanBand`'s deviation callout still
   * posts the resolve route on its own click; it is not a note-row control, and
   * change 9's rule is about the note action bar. Stated rather than silently
   * included.
   */
  it('AC-2.15 — ZERO writes reach a route until Send review is pressed', async () => {
    // FOUR notes, because a note can only be staged ONE way: the decision
    // controls collapse to "Staged as X" the moment one of them is used, which
    // is itself the row saying it holds no status of its own. It was five while
    // `Ask` existed; `Ask` and `Reply` were one act under two labels and staged
    // the same `ask` row, so the fifth row was never a fifth WAY.
    const prop = { has_proposal: true, proposal: '## Goal\n\nx\n' }
    server.notes = [
      note({ id: 'n-acc', to: 'user', by: 'backend', ...prop }),
      note({ id: 'n-rej', to: 'user', by: 'backend', ...prop }),
      note({ id: 'n-dis', to: 'user', by: 'backend' }),
      note({ id: 'n-rep', to: 'user', by: 'backend' }),
    ]
    await editor('full')
    const seen: string[] = []
    const realPost = routes.current!.post
    routes.current!.post = async (path: string, body?: unknown) => {
      seen.push(path)
      return realPost(path, body)
    }
    const bar = async (id: string) => within(await screen.findByTestId(`plan-note-acts-${id}`))

    fireEvent.click((await bar('n-acc')).getByRole('button', { name: 'Accept' }))
    fireEvent.click((await bar('n-rej')).getByRole('button', { name: 'Reject' }))
    fireEvent.change(screen.getByPlaceholderText('Why are you rejecting this?'), {
      target: { value: 'no' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-n-rej'))
    fireEvent.click((await bar('n-dis')).getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByTestId('plan-note-reply-n-rep'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'and this' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-n-rep'))

    await waitFor(() => expect(server.draft).toHaveLength(4))
    // The two routes that used to be reachable from this bar. The resolve half
    // covers `Apply now` / `Resolve` / `Dismiss now`; the notes half covers
    // `Reply`, and without it this test would have passed against a Reply that
    // still POSTed a note on the click.
    expect(seen.filter((p) => /\/resolve$/.test(p))).toEqual([])
    expect(seen.filter((p) => p.endsWith('/plan/notes'))).toEqual([])
    // Nothing filed, nothing closed, nothing sent.
    expect(server.notes).toHaveLength(4)
    expect(server.notes.every((n) => n.status === 'open')).toBe(true)
    expect(server.messages).toEqual([])

    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(seen.some((p) => p.endsWith('/plan/review'))).toBe(true))
  })

  /**
   * F9 — the blast radius is smaller than it looks, and this is why. All three
   * deleted controls were gated on `to === 'user'`, so a note addressed to an
   * AGENT never showed them: on those rows the "HAPPENS NOW" group had always
   * held only `Reply`, and the labels already split a set into one group and an
   * empty one.
   */
  it('a note addressed to someone else offers the same bar it always did', async () => {
    // `sent` is a PRECONDITION REPAIR, not a change to the claim. This case is
    // about the ADDRESSEE axis — the three deleted controls were gated on
    // `to === 'user'` — and AC-2.1 later gated `Reply` on the AUTHOR axis, so
    // an unsent note of your own now legitimately has no `Reply` for a reason
    // this test is not about. Sending it puts the fixture back in the shape the
    // claim describes.
    server.notes = [note({ id: 'n1', to: 'backend', by: 'user', sent: true })]
    await editor('full')
    const acts = await screen.findByTestId('plan-note-acts-n1')
    expect(within(acts).getByTestId('plan-note-reply-n1')).toBeTruthy()
    // `Withdraw` is `Dismiss`'s label on a SENT note of your own — same
    // handler, same `dismiss` row on the wire. This case is about the ADDRESSEE
    // axis, so the word it is asserted under moved with the author axis and the
    // claim did not.
    expect(within(acts).getByRole('button', { name: 'Withdraw' })).toBeTruthy()
    expect(within(acts).queryByRole('button', { name: 'Resolve' })).toBeNull()
    expect(within(acts).queryByRole('button', { name: 'Dismiss now' })).toBeNull()
  })
})

/**
 * WHO A REPLY IS ADDRESSED TO IS COMPUTED BY THE CLIENT, and that is a decision
 * rather than an accident. `DraftEntry.to` could be left empty and defaulted by
 * the server's `or parent.by` — but on a reply to YOUR OWN note `parent.by` is
 * the literal `"user"`, so the fallback addresses the reply back to you.
 */
describe('who a reply is addressed to is read off the note, never typed in', () => {
  it("answers the note's AUTHOR when the note was sent to you", async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user', quote: 'The keeper writes' })]
    await editor('full')
    fireEvent.click(await screen.findByTestId('plan-note-reply-n1'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'agreed' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-n1'))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    // The ROW carries it, before anything is filed.
    expect(server.draft[0].to).toBe('backend')

    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(server.notes).toHaveLength(2))
    expect(server.notes[1].to).toBe('backend')
    expect(server.notes[1].section).toBe('goal')
  })

  it('answers the ADDRESSEE when the note was your own', async () => {
    // `sent` for the same reason as the F9 case above: AC-2.1 withholds `Reply`
    // on your own note while it is still in the tray, which is a different
    // rule from the one under test here. The addressee computation this pins
    // — `note.by === 'user' ? note.to : note.by` — is untouched by it.
    server.notes = [note({ id: 'n1', by: 'user', to: 'backend', sent: true })]
    await editor('full')
    fireEvent.click(await screen.findByTestId('plan-note-reply-n1'))
    fireEvent.change(await screen.findByLabelText(/Reply to/), { target: { value: 'and also' } })
    fireEvent.click(screen.getByTestId('plan-note-send-n1'))
    // THIS is the case the computed `to` exists for: leave the row empty and the
    // server's `or parent.by` resolves to the literal "user", i.e. back to you.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].to).toBe('backend')

    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(server.notes).toHaveLength(2))
    expect(server.notes[1].to).toBe('backend')
  })

  /**
   * INVERTS "a reply to a never-sent note of your own IS sent, to you".
   *
   * WHAT THAT ASSERTION PINNED, and it was pinned deliberately rather than
   * discovered: reply to your own note addressed to NOBODY and the computed
   * addressee is `''`, so the server's fallback fires and resolves to the
   * OWNER — the COMPLETE send path, a real send, a posted message and a to-do
   * on your own desk. Being pinned did not make it wanted. It was a live
   * self-message, AC-2.1 classifies it as the defect the item exists to
   * remove, and the plan owner ruled to remove it with both readings in front
   * of them. So the offer is gone from the row and this case now pins its
   * ABSENCE.
   *
   * WHY THE CLAUSE THAT REMOVES IT LOOKS REDUNDANT AND IS NOT — read this
   * before deleting anything from `mayReply`. `isPendingNote` requires
   * `!!n.to && n.to !== 'user'`, so this note was never pending and `unsent`
   * is ALREADY false. That is why the two-clause `!mine || !unsent` left the
   * button standing by ARITHMETIC rather than by omission, and why nothing had
   * to be special-cased to keep the old assertion green while the ruling was
   * open. `!unsent` does not mean "has gone out". Fold `!!note.to &&
   * note.to !== 'user'` away as duplicated work and this case goes red.
   */
  it('a reply to a never-sent note of your own is not offered', async () => {
    server.notes = [note({ id: 'n1', by: 'user', to: '' })]
    await editor('full')
    // The row is ON SCREEN, so the absence below is the gate and not a note
    // that failed to render.
    const acts = within(await screen.findByTestId('plan-note-acts-n1'))
    expect(screen.queryByTestId('plan-note-reply-n1')).toBeNull()
    // And it is ONLY `Reply` that went — this cannot pass by the row having
    // lost its controls wholesale. `Withdraw` is the label `Dismiss` wears on
    // your own note; the button, the handler and the `dismiss` row on the wire
    // are the same one this line always asserted.
    expect(acts.getByRole('button', { name: 'Withdraw' })).toBeTruthy()

    // The whole point: no reply is staged, none is filed, no message is posted
    // and nothing lands on the owner's own desk. Every assertion the old case
    // made, negated.
    expect(server.draft).toHaveLength(0)
    expect(server.notes).toHaveLength(1)
    expect(server.messages).toHaveLength(0)
    expect(server.openForYou()).toBe(0)
  })

  it('Cmd+Enter stages it without reaching for the mouse', async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor('full')
    fireEvent.click(await screen.findByTestId('plan-note-reply-n1'))
    const ta = await screen.findByLabelText('Reply to @backend')
    fireEvent.change(ta, { target: { value: 'quickly' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].comment).toBe('quickly')
    expect(server.notes).toHaveLength(1)
  })
})

/**
 * AN INLINE COMMENT REACHES SOMEBODY — the whole point of writing one.
 *
 * `POST …/plan/notes` RECORDS a note and stops: no message, no wake-up. What
 * delivers it is a submit that NAMES it in `note_ids`, and the server refuses
 * to guess that set on a browser's behalf. Until this, `PlanEditor.onSubmit`
 * sent `{ batch_comment }` alone and the tray — whose only rows come from
 * DECIDING on someone else's note or editing a section — rendered `null`,
 * so a comment produced no button to press and no way to press it.
 *
 * Everything below runs through the real editor and the fake server, and the
 * fake now honours `note_ids` (it marks named notes sent and reports their
 * addressees), so a client that still dropped them would fail here.
 */
describe('a comment you write goes out with the next batch', () => {
  /** THE CLICK ON `@coordinator` IS GONE, AND NOTHING ABOUT THE OUTCOME MOVED.
   *  The keeper has always been the popover's default addressee — `defaultTo`
   *  is `index.keeper` and always was — so when the addressee was one string,
   *  clicking its chip called `setTo` with the value it already held. The
   *  addressee is a SET now and the same click REMOVES it, which is the correct
   *  behaviour for a chip whose accessible name is "Remove @coordinator" and
   *  the wrong gesture for a helper whose job is "file a note to the keeper".
   *  Every assertion downstream of this helper is unchanged. */
  async function comment(container: HTMLElement, text: string) {
    commentOn(container, 'The keeper writes')
    await screen.findByTestId('plan-quote-pop')
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: text },
    })
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(server.notes.some((n) => n.comment === text)).toBe(true))
  }

  for (const density of ['full', 'compact'] as const) {
    it(`${density} mount: one comment, no decisions, and there IS a Send button`, async () => {
      const { container } = await editor(density)
      expect(screen.queryByTestId('plan-tray')).toBeNull()

      await comment(container as HTMLElement, 'who decided this?')

      // The tray mounts on the comment alone — no row was staged.
      const tray = await screen.findByTestId('plan-tray')
      expect(within(tray).getByText('Send review · 1')).toBeTruthy()
      expect(within(tray).getByText(/to @coordinator/)).toBeTruthy()
    })
  }

  it('pressing Send delivers it: the note is marked sent and @coordinator is written to', async () => {
    const { container } = await editor('full')
    await comment(container as HTMLElement, 'who decided this?')
    fireEvent.click(await screen.findByText('Send review · 1'))

    await waitFor(() => expect(server.notes[0].sent).toBe(true))
    expect(server.messages).toEqual([{ to: 'coordinator', round: 'r-1' }])
    // A batch of one comment moves no bytes: no write, no new revision.
    expect(server.revision).toBe(1)
    expect(server.body).toContain('The keeper writes the **first** plan')
    // Delivered — so it leaves the tray, and the tray with it.
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
  })

  it('an undelivered comment says so on the note, and stops saying it once sent', async () => {
    const { container } = await editor('full')
    await comment(container as HTMLElement, 'who decided this?')
    const id = server.notes[0].id
    await screen.findByTestId(`plan-note-waiting-${id}`)
    fireEvent.click(await screen.findByText('Send review · 1'))
    await waitFor(() => expect(screen.queryByTestId(`plan-note-waiting-${id}`)).toBeNull())
  })

  it('a note recorded with no addressee is never named, and never mounts the tray', async () => {
    // `to === ''` is "recorded, never sent". Naming it would make the server
    // address it to the KEEPER — the opposite of what recording it meant.
    server.notes = [note({ id: 'r1', by: 'user', to: '', comment: 'for the record' })]
    await editor('full')
    await screen.findByTestId('plan-body')
    expect(screen.queryByTestId('plan-tray')).toBeNull()
  })

  it("an agent's note to you never rides the batch — deciding on it is the row", async () => {
    // The double-send this excludes: one submit would carry the note as a row's
    // `note_id` AND as a named id, and the server would address it twice.
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor('full')
    expect(screen.queryByTestId('plan-tray')).toBeNull()

    fireEvent.click(await screen.findByText('Dismiss'))
    const tray = await screen.findByTestId('plan-tray')
    expect(within(tray).getByText('Send review · 1')).toBeTruthy()
    fireEvent.click(within(tray).getByText('Send review · 1'))

    // One message, to the note's AUTHOR — a decision's direction, not a note's.
    await waitFor(() => expect(server.messages).toHaveLength(1))
    expect(server.messages[0].to).toBe('backend')
    expect(server.notes[0].sent).toBe(false)
  })

  it('a batch carries both halves at once, each to the right person', async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    const { container } = await editor('full')
    fireEvent.click(await screen.findByText('Dismiss'))
    await comment(container as HTMLElement, 'and about the goal')

    const tray = await screen.findByTestId('plan-tray')
    fireEvent.click(within(tray).getByText('Send review · 2'))
    await waitFor(() => expect(server.messages).toHaveLength(2))
    expect(server.messages.map((m) => m.to).sort()).toEqual(['backend', 'coordinator'])
  })

  /**
   * WITHDRAWING A COMMENT MUST NOT DELIVER IT.
   *
   * The tray tells you a filed comment cannot be unwritten — "send it, or
   * dismiss it on the note itself" — and the staged `Dismiss` is the whole of
   * that path. It used to need an explanation about GATING to say why: there
   * was a second, immediate dismissal on the row, and it was gated on
   * `to === 'user'`, so on your own outbound note the staged one was the only
   * dismissal on offer. After change 9 that gating no longer decides anything —
   * every control on a note stages, and `Dismiss` is simply the only dismissal
   * there is.
   *
   * What the test is about is unchanged, and it is the double-send: the note
   * stays `open` and unsent while the dismiss is only staged, so without
   * `decided` the notes payload still reads it as pending and one submit carries
   * it twice — once as the row's `note_id`, addressed back to you, and once as a
   * named id, addressed to the very person you were withdrawing it from.
   */
  it('dismissing your own filed comment withdraws it — it does not send it', async () => {
    server.notes = [note({ id: 'n1', by: 'user', to: 'backend', comment: 'who decided this?' })]
    await editor('full')
    // Filed and undelivered: it rides the batch, and the row says so.
    const tray = await screen.findByTestId('plan-tray')
    expect(within(tray).getByText('Send review · 1')).toBeTruthy()
    expect(within(tray).getByText(/to @backend/)).toBeTruthy()
    await screen.findByTestId('plan-note-waiting-n1')

    // Label movement only — AC-2.3 renames the verb on your OWN unsent note to
    // say what it does. Same button, same handler, same `dismiss` row.
    fireEvent.click(await screen.findByRole('button', { name: 'Drop from this batch' }))

    // ONE item, not two: the note is in the batch as the dismiss, and the row
    // stops saying it is waiting to go out — because it is not.
    expect(within(await screen.findByTestId('plan-tray')).getByText('Send review · 1')).toBeTruthy()
    expect(screen.queryByTestId('plan-note-waiting-n1')).toBeNull()

    fireEvent.click(screen.getByText('Send review · 1'))

    // @backend is never written to. The decision goes back to the note's
    // author, which is you — the server's direction rule, not this client's.
    await waitFor(() => expect(server.notes[0].status).toBe('dismissed'))
    expect(server.notes[0].sent).toBe(false)
    expect(server.messages.map((m) => m.to)).toEqual(['user'])
  })

  it('staging a decision does not delete the comment — undo puts it back in the batch', async () => {
    server.notes = [note({ id: 'n1', by: 'user', to: 'backend', comment: 'who decided this?' })]
    await editor('full')
    // Label movement only — see the case above.
    fireEvent.click(await screen.findByRole('button', { name: 'Drop from this batch' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))

    // `✕` on the row — the tray's undo — and the note is pending again, which
    // is the state it never left on the server.
    fireEvent.click(screen.getByRole('button', { name: 'Remove dismiss row' }))
    await screen.findByTestId('plan-note-waiting-n1')
    expect(within(screen.getByTestId('plan-tray')).getByText('Send review · 1')).toBeTruthy()
    expect(within(screen.getByTestId('plan-tray')).getByText(/to @backend/)).toBeTruthy()
  })

  it('a comment already out is refused as itself, not as a reconciliation with nothing to reconcile', async () => {
    // The server's OTHER 409: "already out" carries no stale row, so the
    // reconciliation panel would render with zero rows and read as "the
    // document moved" when nothing did.
    const { container } = await editor('full')
    await comment(container as HTMLElement, 'another thought')
    const send = await screen.findByText('Send review · 1')
    // It went out from a second tab, under this one.
    server.notes[0].sent = true

    fireEvent.click(send)
    expect(await screen.findByText(/already out/)).toBeTruthy()
    expect(screen.queryByTestId('plan-stale-reconcile')).toBeNull()
    // Nothing was sent twice.
    expect(server.messages).toEqual([])
  })
})

/**
 * CHANGE 1 — THE COMPOSER'S CAPABILITIES, WHERE THEY WENT.
 *
 * `PlanNoteComposer` is deleted. The `question` flag moved on to this popover
 * and was then derived away; `deviation` left for the CLI; the un-quoted
 * channel left for `clawmeets plan note` with no `--quote`. Each of those is
 * asserted rather than assumed, because a capability that quietly disappeared
 * would look exactly like one that moved.
 *
 * AND A WHOLE-SECTION `proposal` MOVED HERE AND HAS NOW LEFT AGAIN — which is
 * the one case in this file where the honest word is REMOVED rather than moved,
 * so it is the one this block spends most of its words on. A user who wants
 * different words edits the block inline, and that editor is one click away on
 * the block itself. What is NOT removed is an agent's proposal: it arrives over
 * `clawmeets plan note --proposal` and over this same route, and every surface
 * that renders one still renders it. The pair of cases below is the fence —
 * the browser cannot author one, the browser still decides on one — and they
 * are deliberately adjacent so that deleting either one leaves the other
 * looking obviously incomplete.
 */
describe('the popover is the only composer, and it carries what the old one did', () => {
  /** Record what actually went on the wire — a note's `question` flag is not
   *  echoed back on the fake's stored note, and asserting on the request is the
   *  only way to see it at all. */
  function captureNotes(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    const realPost = routes.current!.post
    routes.current!.post = async (path: string, body?: unknown) => {
      if (path.endsWith('/plan/notes')) bodies.push(body as Record<string, unknown>)
      return realPost(path, body)
    }
    return bodies
  }

  /**
   * THE CAPABILITY THAT WAS REMOVED, PINNED AT ITS ABSENCE.
   *
   * This replaces two cases that DROVE the proposal box — one seeding it with
   * the section's pristine text and asserting `base_section` on the wire, the
   * other asserting the box was collapsed by default. Both drove a control that
   * no longer exists, so neither could be re-pointed: what they asserted was
   * the control's behaviour, and the behaviour is that there is no control.
   *
   * IT ASSERTS THE WIRE AS WELL AS THE SURFACE, because those are two different
   * claims and only one of them is visible. `proposal` and `base_section` are
   * not sent as `''` — they are not sent at all, which is what "the fields the
   * deleted control used to add" means. Both default to `""` server-side, so
   * the note the server records is unchanged.
   */
  it('a user cannot author a proposal here, and neither field reaches the wire', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const pop = await screen.findByTestId('plan-quote-pop')

    // Neither the collapsed control nor the box it opened.
    expect(within(pop).queryByRole('button', { name: 'Propose a replacement' })).toBeNull()
    expect(within(pop).queryByRole('button', { name: 'Drop the proposal' })).toBeNull()
    expect(document.getElementById('plan-pop-proposal')).toBeNull()
    expect(pop.querySelector('.plan-pop-prop')).toBeNull()
    expect(pop.textContent).not.toContain('Replacement for')

    const bodies = captureNotes()
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'just a thought' },
    })
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(server.notes).toHaveLength(1))
    // ABSENT, not empty.
    expect('proposal' in bodies[0]).toBe(false)
    expect('base_section' in bodies[0]).toBe(false)
    // And the note the server recorded is an ordinary comment on the block.
    expect(server.notes[0]).toMatchObject({ section: 'goal', comment: 'just a thought' })
  })

  /**
   * THE OTHER HALF OF THE FENCE — AN AGENT'S PROPOSAL IS UNTOUCHED.
   *
   * The removal above is bounded to the BROWSER'S WRITER. A proposal filed by
   * an agent still arrives, still renders against the current text as a diff,
   * and can still be accepted — the whole point of the capability, and the part
   * a careless deletion would take with it. Placed beside the case above so the
   * two read as one rule rather than as a removal and an unrelated survival.
   */
  it("an agent's proposal still renders as a diff and can still be accepted", async () => {
    server.notes = [
      note({
        id: 'p1',
        by: 'backend',
        to: 'user',
        comment: 'the goal should say who may write',
        proposal: '## Goal\n\nThe keeper writes it, and so may you.\n',
        base_section: server.sectionText('goal'),
      }),
    ]
    await editor('full')
    // The server's own diff, on the note the agent filed.
    await screen.findByTestId('plan-diff')
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0]).toMatchObject({ kind: 'accept', section: 'goal' })
  })

  it('AC-2.10 — neither `question` nor `deviation` is a control, and neither is sent', async () => {
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const pop = await screen.findByTestId('plan-quote-pop')
    expect(within(pop).queryByLabelText('question')).toBeNull()
    // `deviation` was never offered here and still is not: it is an agent
    // reporting its OWN work went off-contract, which is not an act a human
    // performs in this editor.
    expect(screen.queryByLabelText('deviation')).toBeNull()

    const bodies = captureNotes()
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'who decided this?' },
    })
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(server.notes).toHaveLength(1))
    // Absent from the payload, not sent as `false`. BOTH fields are gone from
    // `NewNote` now, so a value for either could only come from a caller that
    // rebuilt it.
    expect('question' in bodies[0]).toBe(false)
    expect('deviation' in bodies[0]).toBe(false)
    // AND THE WORD STILL ARRIVES, derived rather than flagged: a note with no
    // proposal and no parent reads `note`, which is what this one is.
    expect(server.notes[0].kind).toBe('note')
  })

  it('the preamble is not commentable, so nothing can reach the no-section case', async () => {
    // The document preamble is rendered as prose rather than as a section, so a
    // selection there carries `section: ''`. That used to matter because a
    // whole-section proposal needed a section to replace; no surface in this
    // browser authors one any more, so the empty-section branch it guarded is
    // unreachable from both ends — there is no bubble on the preamble, and
    // there is no proposal area to withhold.
    server.body = [
      '# Project Plan: demo',
      '',
      'A line of preamble before any heading at all.',
      '',
      '## Goal',
      '',
      'The keeper writes the **first** plan and nobody else does.',
      '',
    ].join('\n')
    const { container } = await editor('full')
    const lede = container.querySelector('.plan-preamble p') as HTMLElement
    expect(lede.textContent).toContain('A line of preamble')
    // THE PREAMBLE IS NO LONGER COMMENTABLE AT ALL, and that follows from the
    // capture being an icon rather than a selection: the preamble renders
    // through the plain chat components, so it has no block component and
    // therefore no bubble. It was already the weakest of the paths — a note
    // filed there carries `section: ''`, which no section on screen holds, so
    // the body could never draw it and only the comment list ever showed it.
    // Losing it is a real narrowing, named here rather than left to be found.
    expect(container.querySelector('.plan-preamble .plan-b-tool')).toBeNull()
    commentOn(container as HTMLElement, 'The keeper writes')
    const pop = await screen.findByTestId('plan-quote-pop')
    // A block inside a real section opens an ordinary composer, which is the
    // half of this test that was always about the rule rather than the
    // preamble. It used to check the proposal control appeared there; with the
    // control gone the text box IS the composer, so that is what it checks.
    expect(within(pop).getByLabelText('What do you want to say about this?')).toBeTruthy()
  })
})

/**
 * THE OPEN-NOTE CEILING — the one budget the server sums across the whole
 * transaction, and the one change 9 made reachable from a control that used to
 * cost nothing. Asserted against `MAX_OPEN_NOTES`, deliberately NOT against a
 * quote length: `MAX_QUOTE_CHARS` is checked per note, so an inherited copy of a
 * quote that already passed passes again by construction, and `MAX_NOTE_CHARS`
 * does not count the quote at all. A quote-length test here would pass for the
 * wrong reason and hide the cap that can actually fire.
 */
describe('a 413 is refused whole, and nothing you typed is lost', () => {
  it('names the limit that was hit, keeps the tray, and sends nothing', async () => {
    const { ApiError } = await import('../../../api/client')
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))

    server.failNextSubmit = new ApiError(413, 'plan has 201 open notes, limit is 200')
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    const alert = await screen.findByRole('alert')
    // It says WHICH limit, because the refusal names its ceiling — so the user
    // is told what to do rather than that something was "too big".
    expect(alert.textContent).toContain('200 open notes')
    expect(alert.textContent).toContain('Nothing was sent and your tray is intact')
    // Refused WHOLE: nothing applied, nothing sent, tray untouched — and the
    // reconciliation panel does NOT appear, because nothing moved underneath.
    expect(screen.queryByTestId('plan-stale-reconcile')).toBeNull()
    expect(document.querySelectorAll('[data-row-id]')).toHaveLength(1)
    expect(server.draft).toHaveLength(1)
    expect(server.notes[0].status).toBe('open')
    expect(server.messages).toEqual([])
  })

  /**
   * THE SAME REFUSAL, WITH THE COMPOSER OPEN — and the case above cannot see
   * it, which is why this one exists rather than an assertion bolted onto it.
   *
   * There is no click-outside handler: the popover closes on a filed note and
   * on an explicit Cancel/Escape, and on nothing else. So `Send review` in the
   * tray is reachable with a composer standing open over a selection, holding
   * text the user has not filed — and the batch refusal that comes back is not
   * the composer's. `PlanQuotePop` renders `failure` only when its OWN post
   * failed, deliberately, so it will not show this one; if the pane suppresses
   * it too, the user presses Send, sees NOTHING change and nothing appear, and
   * has no way to learn the batch never went out.
   */
  it('renders with the composer OPEN, where it used to render nowhere at all', async () => {
    const { ApiError } = await import('../../../api/client')
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    const { container } = await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))

    // The composer, open over a selection and holding unfiled text — the state
    // the pane used to read as "there is somewhere better for this to go".
    commentOn(container as HTMLElement, 'The keeper writes')
    const ta = await screen.findByLabelText('What do you want to say about this?')
    fireEvent.change(ta, { target: { value: 'a thought I have not filed yet' } })

    server.failNextSubmit = new ApiError(413, 'plan has 201 open notes, limit is 200')
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    // The refusal is ON SCREEN, and names the ceiling.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('200 open notes')
    expect(alert.textContent).toContain('Nothing was sent and your tray is intact')
    // The composer is still up and still holds every character — a refused
    // batch is not a reason to destroy text the user has not filed.
    expect(screen.getByTestId('plan-quote-pop')).toBeTruthy()
    expect((ta as HTMLTextAreaElement).value).toBe('a thought I have not filed yet')
    // Refused whole, exactly as with the composer closed.
    expect(server.draft).toHaveLength(1)
    expect(server.notes[0].status).toBe('open')
    expect(server.messages).toEqual([])
  })

  /**
   * AND STILL ONCE, WHICH IS THE PROPERTY THE SUPPRESSION EXISTS FOR. The pane
   * gates on WHOSE failure it is rather than on whether a composer is open, so
   * a NOTE refusal is still the composer's alone: it renders beside the text it
   * refused and not a full scroll away as well.
   */
  it('a NOTE refusal still renders once, in the composer and not in the pane', async () => {
    const { ApiError } = await import('../../../api/client')
    const { container } = await editor('full')
    commentOn(container as HTMLElement, 'The keeper writes')
    const ta = await screen.findByLabelText('What do you want to say about this?')
    fireEvent.change(ta, { target: { value: 'this one gets refused' } })

    server.failNextNote = new ApiError(413, 'plan has 201 open notes, limit is 200')
    fireEvent.click(screen.getByRole('button', { name: /^File note/ }))

    const pop = await screen.findByTestId('plan-quote-pop')
    await waitFor(() => expect(within(pop).getByRole('alert').textContent).toContain('201 open'))
    // ONE copy, and it is the composer's. The pane holds no alert of its own.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(pop.contains(screen.getByRole('alert'))).toBe(true)
    // Nothing was filed, and the text is still there to retry with.
    expect(server.notes).toHaveLength(0)
    expect((ta as HTMLTextAreaElement).value).toBe('this one gets refused')
  })

  /**
   * A NOTE REFUSAL, THEN A BATCH ONE, WITH THE COMPOSER NEVER CLOSING — the
   * sequence that turns the two tests above into a pair that can both pass
   * while the screen is wrong.
   *
   * `PlanQuotePop`'s `failed` is a LATCH: set after a failed post, cleared only
   * by the next submit. Its `failure` prop is not — it is the parent's live
   * one. So once a note post has failed, the composer is a standing renderer
   * for whatever the parent fails at next, and the very next batch refusal
   * arrives wearing the composer's alert on text that had nothing to do with
   * it: two alerts for one failure, the near one misattributed, and the user's
   * unfiled words marked `aria-invalid` for a ceiling they did not hit.
   *
   * The parent partitions instead of trusting the latch, so this asserts the
   * partition rather than the latch: exactly ONE alert, in the pane, carrying
   * the batch's words — and a composer that is clean, still holding every
   * character, and no longer claiming its field is at fault.
   */
  it('a note refusal then a batch one leaves ONE alert, and not in the composer', async () => {
    const { ApiError } = await import('../../../api/client')
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    const { container } = await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))

    // 1. The composer's OWN post is refused. This is the correct state: the
    //    refusal is the composer's, so the pane stays silent.
    commentOn(container as HTMLElement, 'The keeper writes')
    const ta = (await screen.findByLabelText(
      'What do you want to say about this?',
    )) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'text I still have not filed' } })
    server.failNextNote = new ApiError(413, 'that note alone would be the 201st')
    fireEvent.click(screen.getByRole('button', { name: /^File note/ }))

    const pop = await screen.findByTestId('plan-quote-pop')
    await waitFor(() => expect(within(pop).getByRole('alert').textContent).toContain('201st'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    // 2. Nothing closes the composer — there is still no click-outside — so
    //    `Send review` is pressed with it standing and its latch set.
    server.failNextSubmit = new ApiError(413, 'plan has 201 open notes, limit is 200')
    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))

    // ONE alert, and it is the pane's. Not two, and not the composer's.
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Nothing was sent'),
    )
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toContain('200 open notes')
    // The composer carries no alert at all now — its own refusal is gone with
    // the failure that replaced it, and the batch's never arrives here.
    expect(within(screen.getByTestId('plan-quote-pop')).queryByRole('alert')).toBeNull()
    // And it is not blaming the field for a batch ceiling, nor has it eaten
    // the words the user has still not filed.
    expect(ta.getAttribute('aria-invalid')).not.toBe('true')
    expect(ta.value).toBe('text I still have not filed')
    // Refused whole, as ever: nothing sent, tray intact.
    expect(server.draft).toHaveLength(1)
    expect(server.messages).toEqual([])
  })

  it('and the tray PRE-EMPTS it, before Send review is pressed', async () => {
    // The client renders the notes, so it knows the open count; it holds the
    // tray, so it knows what the batch would add. A staged reply files a new
    // open note while the parent stays open, so it ADDS one.
    server.notes = [
      ...Array.from({ length: 200 }, (_, i) =>
        note({ id: `bulk-${i}`, by: 'backend', to: 'backend', quote: '' }),
      ),
      note({ id: 'par', by: 'backend', to: 'user' }),
    ]
    await editor('full')
    expect(screen.queryByTestId('plan-tray-open-cap')).toBeNull()

    fireEvent.click(await screen.findByTestId('plan-note-reply-par'))
    fireEvent.change(await screen.findByLabelText('Reply to @backend'), {
      target: { value: 'one more' },
    })
    fireEvent.click(screen.getByTestId('plan-note-send-par'))

    const warn = await screen.findByTestId('plan-tray-open-cap')
    expect(warn.textContent).toContain('200 open notes')
    // A warning, never a block: the row is staged and the button still works.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(screen.getByRole('button', { name: /^Send review/ })).toBeTruthy()
  })
})

/**
 * A 200 THAT PARTLY WENT NOWHERE. Delivery resolves every addressee against the
 * consultation room's MEMBERSHIP and silently deletes anyone who is not in it.
 * `clawmeets plan consult` reconciles that membership — it is idempotent per
 * participant, so an agent registered after the last consult is seated by the
 * next one — but a submit that runs BEFORE any consult, or that names an agent
 * outside the project's invitable roster, still resolves to nobody behind a
 * success. `unresolved` is the ONLY signal this surface has, so it is rendered
 * rather than swallowed.
 */
describe('an addressee the batch could not reach is reported, not swallowed', () => {
  it('names them, and does not claim the note was delivered', async () => {
    server.notMembers = ['ghost']
    server.notes = [note({ id: 'g', by: 'user', to: 'ghost', comment: 'are you there?' })]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    const said = await screen.findByTestId('plan-unresolved')
    expect(said.textContent).toContain('@ghost')
    expect(said.textContent).toContain('not in its review room')
    // Nothing reached them, and the success line does not list them either.
    expect(server.messages).toEqual([])
    expect(screen.getByRole('status').textContent).not.toContain('ghost')
  })

  it('a clean submit says nothing at all', async () => {
    server.notes = [note({ id: 'g', by: 'user', to: 'backend', comment: 'still there?' })]
    await editor('full')
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(server.messages).toHaveLength(1))
    expect(screen.queryByTestId('plan-unresolved')).toBeNull()
  })
})

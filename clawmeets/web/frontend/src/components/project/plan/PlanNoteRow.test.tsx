import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import type { PlanNote } from '../../../api/endpoints/projectPlans'
import type { NoteActions } from './PlanNoteRow'

// The same stand-in the editor's own suites use. `PlanDiff` renders through
// `diff2html`, which is not what is under test here — the gate above it is.
vi.mock('./PlanDiff', () => ({
  PlanDiff: ({ text }: { text: string }) =>
    createElement('pre', { className: 'plan-diff', 'data-testid': 'plan-diff' }, text),
}))

const { PlanNoteRow } = await import('./PlanNoteRow')
const { diffSeries } = await import('./planDiffs')

/**
 * THE NOTE ROW, MOUNTED DIRECTLY — AND THAT IS THE POINT OF THIS FILE, NOT A
 * SHORTCUT AROUND THE EDITOR.
 *
 * Every other test of this component drives it through `PlanEditor`, which is
 * right for anything about the wiring. It is USELESS for the one claim below:
 * the editor filters its notes to `status === 'open'` in a single `useMemo`
 * (`PlanEditor.tsx`), so an applied note is never handed to this row on any
 * surface that exists today. A test that "proved" the applied-note diff through
 * the editor would be asserting against a note the editor threw away — green,
 * and worth nothing.
 *
 * So the row is mounted with the note the editor cannot give it. That is the
 * only honest way to pin a behaviour whose whole reason for existing is the
 * surface that does not exist YET, and it is why the gate was fixed before that
 * surface arrives rather than after: the failure mode is a diff silently absent,
 * not an error anybody would notice.
 */

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n1',
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

/** THE ROW'S SERIES, GENERATED THE WAY THE EDITOR GENERATES IT, so these three
 *  claims keep testing the surface rather than a hand-written prop.
 *
 *  ONE note and NO current text: no rivals, and no "against the plan as it
 *  stands" step either, so every case below produces a series of AT MOST ONE
 *  step — which is exactly the shape the old `{note.display_diff && …}` gate
 *  produced, and the shape that makes these assertions still about the gate.
 *
 *  `''` for `currentText` is not a shortcut. A note mounted outside the editor
 *  has no document behind it, and step [1] is skipped for a note with no
 *  proposal — which every note here is, or is applied. */
function seriesFor(n: PlanNote) {
  return diffSeries(n, [n], '')
}

/** The row asks the editor five questions and stages through it. None of them
 *  is under test here, so all five are inert. */
function actions(over: Partial<NoteActions> = {}): NoteActions {
  return {
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onDismiss: vi.fn(),
    onReply: vi.fn(),
    staged: () => null,
    pending: () => false,
    canDecide: true,
    ...over,
  }
}

afterEach(cleanup)

describe('AC-2.9 — the diff gate reads the diff, not `has_proposal`', () => {
  /**
   * PT-1. An APPLIED note has `has_proposal: false` — the proposal is no longer
   * pending, it is in the document — and a non-empty `display_diff`, because the
   * server renders it from `proposal or applied_text` and keeps the record of
   * what was applied. The old gate `has_proposal && display_diff` suppressed
   * exactly that record. This is the assertion that fails if anyone restores it.
   */
  it('an applied note still renders the record of what was applied', () => {
    const n = note({
      status: 'applied',
      has_proposal: false,
      display_diff: '--- goal (base)\n+++ goal (applied)\n',
    })
    render(
      createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }),
    )
    expect(screen.getByTestId('plan-diff').textContent).toContain('goal (applied)')
  })

  /** The converse, so the gate is pinned in both directions: no diff text, no
   *  diff element. A comment filed against no section has `display_diff: ''`
   *  and must draw nothing — the server decides there is nothing to show, and
   *  this row does not second-guess it with a flag of its own. */
  it('a note the server rendered no diff for draws none', () => {
    const n = note({ has_proposal: true, display_diff: '' })
    render(
      createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }),
    )
    expect(screen.queryByTestId('plan-diff')).toBeNull()
  })

  /** `has_proposal` KEEPS its other job. Loosening the diff gate must not
   *  loosen the decision gate: `Accept`/`Reject` still ask "is there
   *  replacement text to apply?", which a rendered diff does not answer. */
  it('`has_proposal` still gates Accept and Reject', () => {
    const n = note({ has_proposal: false, display_diff: '--- goal\n' })
    render(
      createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }),
    )
    expect(screen.getByTestId('plan-diff')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })
})

/**
 * THE SIXTH STATUS, DRAWN — AND MOUNTED DIRECTLY FOR THE REASON THIS FILE'S
 * HEADER ALREADY GIVES, not as a shortcut.
 *
 * `PlanEditor` filters its notes to `status === 'open'` in a single `useMemo`,
 * so a folded note — like an applied, rejected or dismissed one — reaches this
 * row on NO surface that exists today. A test that drove `folded` through the
 * editor would assert against a note the editor threw away: green, and worth
 * nothing. Drawing closed notes somewhere is a recorded followup; the round
 * trip that proves a fold PRODUCES this status lives in `PlanDiffSeries`, and
 * these three cases prove the row RENDERS it.
 */
describe('the folded record, on the row', () => {
  /** `STATUS_LABEL`'s only coverage, and the reason the entry cannot be
   *  forgotten when the union widens. The word is `folded in` rather than the
   *  bare status: `folded` alone is already this app's word for a collapsed
   *  diff band, and the direction is the entire news — this is the one terminal
   *  status that means the work LANDED. */
  it('renders the folded status as `folded in`', () => {
    const n = note({ status: 'folded' })
    render(createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }))
    expect(screen.getByText('folded in')).toBeTruthy()
  })

  /** THE CHIP'S OBJECT COMES FROM THE SERVER, VERBATIM. `note.resolution` has
   *  been on the wire since the field was added and nothing has ever drawn it,
   *  which is why a folded-away author was told nothing. The sentence names the
   *  winning author — and the client never builds it, because it has no stable
   *  knowledge of who won. This is the exact string the server writes. */
  it('renders the server sentence naming the winning author', () => {
    const n = note({
      status: 'folded',
      resolution:
        "folded into @frontend's change on the same section — your text is in the section that landed",
    })
    render(createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }))
    expect(screen.getByTestId('plan-note-resolution-n1').textContent).toBe(
      "folded into @frontend's change on the same section — your text is in the section that landed",
    )
  })

  /** GATED ON THE STRING, NOT ON THE STATUS — which is what makes a plain
   *  reject's reason and an `ask`'s question visible for free, with no second
   *  status-keyed site to keep in step with the server's word list. */
  it('renders a reason on a note that is not folded, and none when there is no reason', () => {
    const rejected = note({
      id: 'n1',
      status: 'rejected',
      resolution: 'the section was renamed before this landed',
    })
    render(
      createElement(PlanNoteRow, { note: rejected, actions: actions(), series: seriesFor(rejected) }),
    )
    expect(screen.getByTestId('plan-note-resolution-n1').textContent).toBe(
      'the section was renamed before this landed',
    )

    cleanup()
    const open = note({ id: 'n1', status: 'open', resolution: '' })
    render(createElement(PlanNoteRow, { note: open, actions: actions(), series: seriesFor(open) }))
    expect(screen.queryByTestId('plan-note-resolution-n1')).toBeNull()
  })

  /** A SEVENTH STATUS MUST DEGRADE, NEVER BLANK. `NOTE_STATUSES` is advisory on
   *  the server — never a `Literal`, never an `Enum`, never a validator — so a
   *  newer server can send a word this bundle has never heard of, and the map
   *  is advisory on this side to match. Printing the raw word is strictly
   *  better than printing nothing. */
  it('prints an unknown status raw rather than blank', () => {
    const n = note({ status: 'merged' as PlanNote['status'] })
    render(createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }))
    expect(screen.getByText('merged')).toBeTruthy()
  })
})

/**
 * THE ANSWER CARRIES THE QUESTION — and this is the surface that PAID for the
 * status change behind it.
 *
 * A reply now closes its parent `answered` from BOTH doors: the review tray
 * always did, and `plan note --reply-to` does since the coordinator's answers
 * stopped leaving the user's questions open forever. The objection that had
 * kept the second door from closing was exactly this row: the editor draws only
 * OPEN notes, so a closed question leaves the screen and the answer is left
 * standing alone saying "Answering your question" about a question nobody can
 * see.
 *
 * MOUNTED DIRECTLY, FOR THE SAME REASON THE REST OF THIS FILE IS. The parent
 * here is CLOSED — which is precisely the state the editor filters out — so
 * driving this through `PlanEditor` would assert against a note it had already
 * discarded. The `parent` prop is resolved off the UNFILTERED note list for
 * that reason, and these cases are what make that contract load-bearing rather
 * than incidental.
 */
describe('a reply quotes the question it answers, which may be closed', () => {
  it('carries the parent’s first line, one-line-cut, even once it is closed', () => {
    const parent = note({
      id: 'n0',
      by: 'user',
      to: 'keeper',
      kind: 'note',
      status: 'answered',
      comment: 'Does this cover storage? I want it named in the milestone.',
    })
    const reply = note({ id: 'n1', by: 'keeper', to: 'user', kind: 'reply', reply_to: 'n0' })
    render(
      createElement(PlanNoteRow, {
        note: reply,
        actions: actions(),
        series: seriesFor(reply),
        parent,
      }),
    )
    const line = screen.getByTestId('plan-note-answering-n1')
    expect(line.textContent).toContain('In reply to your note')
    // THE QUESTION SITS ABOVE THE REPLY'S OWN HEADER, and the reply hangs
    // under it — so "they asked → you said" reads top-down.
    const card = line.closest('.plan-note') as HTMLElement
    expect(card.firstElementChild).toBe(line)
    expect(card.querySelector('.plan-note-reply-body')).toBeTruthy()
    // `noteSummary`'s cut — the first SENTENCE, not the whole comment. Same
    // function the comment list uses, so the two surfaces cut a note the same
    // way rather than each inventing a truncation.
    expect(screen.getByTestId('plan-note-answering-quote-n1').textContent).toBe(
      'Does this cover storage?',
    )
    // The untruncated text is one hover away, so the cut costs nothing.
    expect(
      screen.getByTestId('plan-note-answering-quote-n1').getAttribute('title'),
    ).toBe('Does this cover storage? I want it named in the milestone.')
  })

  /** GATED ON THE STRING, NOT ON THE KIND OR THE STATUS — the same rule
   *  `note.resolution` is gated by. A bare proposal has no comment to quote,
   *  and the line then reads exactly as it did before this existed. */
  it('draws no quote when the parent carries no comment', () => {
    const parent = note({ id: 'n0', by: 'user', to: 'keeper', comment: '' })
    const reply = note({ id: 'n1', by: 'keeper', to: 'user', kind: 'reply', reply_to: 'n0' })
    render(
      createElement(PlanNoteRow, {
        note: reply,
        actions: actions(),
        series: seriesFor(reply),
        parent,
      }),
    )
    expect(screen.getByTestId('plan-note-answering-n1')).toBeTruthy()
    expect(screen.queryByTestId('plan-note-answering-quote-n1')).toBeNull()
  })

  /** A DANGLING `reply_to` DRAWS NOTHING, not a broken reference. The prop is
   *  `null` when the caller cannot resolve the id, and nothing here reads
   *  `reply_to` itself — which is what keeps the quote from being a second
   *  place that decides what a parent is. */
  it('draws nothing at all when the parent did not resolve', () => {
    const reply = note({ id: 'n1', by: 'keeper', to: 'user', kind: 'reply', reply_to: 'gone' })
    render(
      createElement(PlanNoteRow, { note: reply, actions: actions(), series: seriesFor(reply) }),
    )
    expect(screen.queryByTestId('plan-note-answering-n1')).toBeNull()
    expect(screen.queryByTestId('plan-note-answering-quote-n1')).toBeNull()
  })
})

/**
 * THE SNAPSHOT QUOTE — "The Plan said, when this was raised" — AND THE TWO
 * QUESTIONS THAT DECIDE WHETHER IT IS A RECORD OR A REPEAT.
 *
 * The block prints `base_section`, the text of the section as it stood when the
 * note was filed. It used to be gated on `kind === 'deviation'` alone, which
 * answers neither question: a deviation that also carries replacement text has
 * `base_section` on the LEFT-HAND SIDE of its own diff two lines above, and a
 * deviation on a section nobody has touched is quoting what the document pane
 * is saying one column over. Both printed the same text twice on one card.
 *
 * The gate now asks the two questions directly, and these four cases are the
 * quadrants they make. Only one of them leaves the quote on the card, and it is
 * the one the block was written for: nothing else on screen still says it.
 */
describe('the snapshot quote is drawn only where nothing else says it', () => {
  const BASE = '## Goal\nShip six slides.\n'
  const PROPOSED = '## Goal\nShip six slides, tightly.\n'

  /** A note that carries no replacement text: `diffSeries` returns `[]` for it,
   *  so the card draws no diff at all. */
  const commentOnly = () =>
    note({ kind: 'deviation', comment: 'shipped four', base_section: BASE })

  /** A deviation that ALSO carries a proposal — the card with a DEVIATION
   *  badge, an Accept button AND a diff, which is what `note_kind`'s
   *  deviation-first precedence produces for a post-acceptance note with text.
   *  Its series has a `self` step whose left-hand side IS `BASE`. */
  const withProposal = () =>
    note({
      kind: 'deviation',
      comment: 'shipped four',
      base_section: BASE,
      proposal: PROPOSED,
      has_proposal: true,
    })

  const draw = (n: PlanNote, baseIsCurrent: boolean) =>
    render(
      createElement(PlanNoteRow, {
        note: n,
        actions: actions(),
        series: seriesFor(n),
        baseIsCurrent,
      }),
    )

  /** THE ONE SURVIVING CASE. No diff on the card, and the section has moved on
   *  since — so this quote is the only place the text the author was reading
   *  still exists. It is also the sentence the amber "this section changed"
   *  warning below has always been missing. */
  it('a comment-only note on a section that has moved keeps its quote', () => {
    draw(commentOnly(), false)
    expect(screen.getByTestId('plan-note-base').textContent).toContain('Ship six slides.')
  })

  /** The document pane is already showing this text, unchanged, a few
   *  centimetres away. */
  it('drops the quote when the section still reads the way the author saw it', () => {
    draw(commentOnly(), true)
    expect(screen.queryByTestId('plan-note-base')).toBeNull()
  })

  /** THE CASE A "has the section changed?" TEST ALONE MISSES, and the card in
   *  the bug report: the section HAS moved, so that test says "show it" — but
   *  the diff's left-hand side is `base_section` whether it moved or not, so
   *  the snapshot is already on the card. */
  it('drops the quote on a diff-carrying note even when the section has moved', () => {
    draw(withProposal(), false)
    expect(screen.getByTestId('plan-diff')).toBeTruthy()
    expect(screen.queryByTestId('plan-note-base')).toBeNull()
  })

  it('drops the quote on a diff-carrying note whose section has not moved', () => {
    draw(withProposal(), true)
    expect(screen.queryByTestId('plan-note-base')).toBeNull()
  })

  /** THE CHECK THAT WAS REMOVED, PINNED AS REMOVED. A stale plain comment has
   *  the identical missing sentence and the identical amber warning as a stale
   *  deviation; the old `kind === 'deviation'` gate was the only reason it went
   *  without. Nothing about the two cards differs in what the reader needs. */
  it('a plain comment gets the same quote — the gate is not about `kind`', () => {
    draw(note({ kind: 'note', comment: 'is this still right?', base_section: BASE }), false)
    expect(screen.getByTestId('plan-note-base').textContent).toContain('Ship six slides.')
  })

  /** DEFAULTS TO SHOWING IT. A caller that has not been taught to answer gets
   *  the harmless failure — the same text twice — rather than a snapshot
   *  silently deleted off the only card that carries it. */
  it('an omitted answer keeps the quote', () => {
    const n = commentOnly()
    render(
      createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }),
    )
    expect(screen.getByTestId('plan-note-base')).toBeTruthy()
  })
})

/** THE TWO SENTENCES "THE SLUG DOES NOT RESOLVE" CAN MEAN.
 *
 *  Sixteen notes on one server read *"the section `milestones` is no longer in
 *  the document"* — on notes whose entire purpose was to PROPOSE writing that
 *  section. The server always knew the difference (`resolve_note`'s apply arm
 *  and `_row_creates` share the rule and both go on to create the section); the
 *  field this row rendered never asked. It does now, and the flags are mutually
 *  exclusive server-side, so neither branch here defers to the other.
 */
describe('a section that does not resolve', () => {
  afterEach(cleanup)

  const MISSING = 'is no longer in the document'
  const NEW = 'This proposes a new section'

  it('says the section was deleted when the note did not propose it', () => {
    const n = note({ section: 'milestones', section_missing: true })
    render(createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }))
    expect(screen.getByText(new RegExp(MISSING))).toBeTruthy()
    expect(screen.queryByText(new RegExp(NEW))).toBeNull()
  })

  it('says the note creates the section when the note is what would create it', () => {
    const n = note({
      section: 'milestones',
      section_new: true,
      proposal: '## Milestones\n\n- [ ] one\n',
      has_proposal: true,
    })
    render(createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }))
    expect(screen.getByText(new RegExp(NEW))).toBeTruthy()
    expect(screen.queryByText(new RegExp(MISSING))).toBeNull()
  })

  it('names the slug either way, so the reader knows which section is meant', () => {
    for (const over of [{ section_missing: true }, { section_new: true }]) {
      cleanup()
      const n = note({ section: 'milestones', ...over })
      render(createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }))
      expect(screen.getByText('milestones')).toBeTruthy()
    }
  })
})


/**
 * THE ANCHOR QUOTE, WHICH WAS PRINTING ITS OWN SOURCE.
 *
 * `note.quote` is stored VERBATIM — raw markdown, whatever the document said —
 * because that string is what `blockCarries` matches against the rendered
 * document to decide where the note's highlight goes. Storing anything else
 * breaks the anchor. But the card was also PRINTING that string, so the one
 * line whose job is to orient the reader was the one line that rendered as
 * source: a note on `**AC-2.1** — …` showed the asterisks.
 *
 * Two claims here, and they are separable:
 *   - the markers come off for DISPLAY, and only for display;
 *   - a leading identifier is LIFTED to the header row rather than repeated,
 *     so the card names the clause without spending a line on it.
 *
 * `planAnchor.test.tsx` pins the cut itself against the strings; this pins what
 * the card does with each half, which is the part a refactor can silently
 * drop.
 */
describe('a quote renders as text, and its identifier rides the header row', () => {
  const draw = (quote: string) => {
    const n = note({ quote })
    render(createElement(PlanNoteRow, { note: n, actions: actions(), series: seriesFor(n) }))
    return n
  }

  it('lifts the identifier out of the quote instead of printing it twice', () => {
    draw('**AC-2.1** — ct can read one short list of the questions about his own')
    expect(screen.getByTestId('plan-note-anchor-n1').textContent).toBe('AC-2.1')
    expect(screen.getByTestId('plan-note-quote-n1').textContent).toBe(
      'ct can read one short list of the questions about his own',
    )
  })

  /** THE DEFECT, PINNED AS A DEFECT. Nothing on this card parses markdown, so
   *  the asterisks used to reach the screen. They must not, in either half. */
  it('never shows a marker in either half', () => {
    draw('**AC-2.1** — the `plan note` path and _its_ fallback')
    expect(screen.getByTestId('plan-note-anchor-n1').textContent).not.toContain('*')
    const body = screen.getByTestId('plan-note-quote-n1').textContent ?? ''
    expect(body).toBe('the plan note path and its fallback')
  })

  /** THE WHOLE STRING IS ONE HOVER AWAY. The chip is a CUT of the quote, so the
   *  thing it was cut from stays reachable — which is what makes lifting it a
   *  display choice rather than a deletion. */
  it('keeps the verbatim quote on the chip as its title', () => {
    const q = '**AC-2.1** — ct can read one short list'
    draw(q)
    expect(screen.getByTestId('plan-note-anchor-n1').getAttribute('title')).toBe(q)
  })

  /** A QUOTE THAT IS ONLY THE SECTION'S OWN HEADING. The card already sits
   *  under that heading, so quoting it again read like a second message. */
  it('draws no blockquote when the quote just repeats the section heading', () => {
    const n = note({ quote: 'Goal', section: 'goal' })
    render(
      createElement(PlanNoteRow, {
        note: n,
        actions: actions(),
        series: seriesFor(n),
        sectionHeading: 'Goal',
      }),
    )
    expect(screen.queryByTestId('plan-note-quote-n1')).toBeNull()
  })

  it('still quotes a real excerpt of the section', () => {
    const n = note({ quote: 'The server forwards each file op', section: 'goal' })
    render(
      createElement(PlanNoteRow, {
        note: n,
        actions: actions(),
        series: seriesFor(n),
        sectionHeading: 'Goal',
      }),
    )
    expect(screen.getByTestId('plan-note-quote-n1').textContent).toBe(
      'The server forwards each file op',
    )
  })

  /** A BARE HEADING ANCHOR. The quote is nothing BUT the identifier, so once the
   *  chip has it there is no sentence left — and an empty blockquote is a rule
   *  and a blank line saying nothing. */
  it('draws no blockquote when the chip is saying the whole quote', () => {
    draw('**AC-2.1**')
    expect(screen.getByTestId('plan-note-anchor-n1').textContent).toBe('AC-2.1')
    expect(screen.queryByTestId('plan-note-quote-n1')).toBeNull()
  })

  /** AN EMPHASIZED WORD IS NOT AN IDENTIFIER, and hoisting one would put a
   *  sentence fragment where a label belongs. The markers still come off. */
  it('leaves a bolded word inside a sentence in the quote', () => {
    draw('**Never** ship this on a Friday')
    expect(screen.queryByTestId('plan-note-anchor-n1')).toBeNull()
    expect(screen.getByTestId('plan-note-quote-n1').textContent).toBe(
      'Never ship this on a Friday',
    )
  })

  /** A note with no quote at all — the common case — gains nothing and loses
   *  nothing. */
  it('draws neither half for a note that quotes nothing', () => {
    draw('')
    expect(screen.queryByTestId('plan-note-anchor-n1')).toBeNull()
    expect(screen.queryByTestId('plan-note-quote-n1')).toBeNull()
  })
})

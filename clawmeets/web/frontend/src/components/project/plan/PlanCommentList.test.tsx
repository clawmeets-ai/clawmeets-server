import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlanNote } from '../../../api/endpoints/projectPlans'
import { PlanCommentList } from './PlanCommentList'
import { commentList, noteSummary, type TrayRow } from './planTrayLogic'

/**
 * THE ONE-LINER, AS A PURE FUNCTION.
 *
 * The layout half of this change is not assertable in jsdom — there is no
 * layout engine, so "the tray is on screen" has no answer here and
 * `PlanEditor.mounts.test.tsx` asserts the invariant on the source instead.
 * What IS assertable is the input to that invariant: whatever a comment says,
 * the row's text is short. These are the cases that keep it short.
 *
 * IT WAS `deviationSummary` AND THE BODY DID NOT CHANGE, which is the point of
 * the rename: a deviation comment was never a different KIND of prose from an
 * ordinary one, only the longest. Every case below was written about a
 * deviation and passes unaltered about any comment.
 */
describe('noteSummary', () => {
  it('takes the FIRST SENTENCE, not the whole comment', () => {
    expect(
      noteSummary(
        'The deck ships four slides. The plan says six, and the reason we cut two is that the client moved the date.',
      ),
    ).toBe('The deck ships four slides.')
  })

  it('CAPS a first sentence that never ends — the case the bug was made of', () => {
    const s = noteSummary('x'.repeat(6000))
    expect(s.length).toBeLessThanOrEqual(120)
    expect(s.endsWith('…')).toBe(true)
  })

  it('skips leading blank lines and takes the first line with text in it', () => {
    expect(noteSummary('\n\n  shipped 4 slides\nand more below\n')).toBe('shipped 4 slides')
  })

  it('trims bullet and quote decoration, and the inline `**` / backtick noise', () => {
    expect(noteSummary('- **scope** grew past the `milestones` clause')).toBe(
      'scope grew past the milestones clause',
    )
    expect(noteSummary('> the plan says six')).toBe('the plan says six')
  })

  it('LEAVES A LEADING `#` ALONE — this reads no Markdown grammar', () => {
    // There is ONE grammar in this system and it is the server's. A client that
    // strips a heading mark is a second parser, which `planTransport.test.ts`
    // fails on and is right to: a plan documenting its own grammar has code
    // samples a client scanner would eat.
    expect(noteSummary('# off contract')).toContain('# off contract')
  })

  it('does not cut on a decimal or a version number', () => {
    expect(noteSummary('we shipped 4.5 slides of 6 and stopped')).toBe(
      'we shipped 4.5 slides of 6 and stopped',
    )
  })

  it('collapses internal whitespace so a wrapped comment is still one line', () => {
    expect(noteSummary('the   deck\tships four')).toBe('the deck ships four')
  })

  it('TOTAL — an empty comment is an empty summary, never a throw', () => {
    expect(noteSummary('')).toBe('')
    expect(noteSummary('\n \n')).toBe('')
  })
})


function note(over: Partial<PlanNote> = {}): PlanNote {
  return {
    id: 'n1',
    section: 'goal',
    to: 'user',
    by: 'keeper',
    at: '2026-08-23T10:00:00Z',
    status: 'open',
    kind: 'note',
    layer: 'spec',
    comment: 'who decided this?',
    proposal: '',
    base_section: '',
    quote: '',
    reply_to: '',
    round: '',
    conflict: false,
    resolved_by: '',
    resolved_at: '',
    resolution: '',
    revision: 3,
    has_proposal: false,
    bootstrap: false,
    proposes_delete: false,
    sent: false,
    replies: [],
    section_missing: false,
    section_new: false,
    section_changed: false,
    display_diff: '',
    ...over,
  }
}

function row(over: Partial<TrayRow> = {}): TrayRow {
  return {
    id: 'r1',
    kind: 'reject',
    section: 'goal',
    text: '',
    base: '',
    note_id: 'n1',
    comment: '',
    to: '',
    at: '2026-08-23T11:00:00Z',
    ...over,
  }
}

function mount(notes: PlanNote[], rows: TrayRow[] = [], pending: PlanNote[] = []) {
  const onShow = vi.fn()
  const onUnstage = vi.fn()
  render(
    <PlanCommentList
      items={commentList(notes, rows, pending)}
      keeper="keeper"
      onShow={onShow}
      onUnstage={onUnstage}
    />,
  )
  return { onShow, onUnstage }
}

afterEach(cleanup)

/**
 * THE LIST, AS THE NAVIGATOR IT BECAME.
 *
 * The cases below are about the change of SUBJECT rather than the change of
 * name: this box used to hold open deviations and nothing else, so the fastest
 * thing in the editor was unavailable on every plan that had none. It now holds
 * every open comment, and each row carries the batch state of that comment plus
 * the one way to take it back.
 */
describe('PlanCommentList', () => {
  it('RENDERS ON AN ORDINARY COMMENT — the case the alarm could not cover', () => {
    mount([note({ comment: 'why six slides?' })])
    expect(screen.getByTestId('plan-comment-list')).toBeTruthy()
    expect(screen.getByText('why six slides?')).toBeTruthy()
    // Neutral, because nothing here has gone off contract. Painting the box red
    // for an ordinary question is how an alarm stops meaning anything.
    expect(screen.getByTestId('plan-comment-list').className).not.toContain('plan-cl--alarm')
  })

  it('PRESENCE IS THE PREDICATE — nothing open, nothing rendered', () => {
    mount([])
    expect(screen.queryByTestId('plan-comment-list')).toBeNull()
  })

  it('A DEVIATION STILL COMES FIRST AND STILL TURNS THE BOX RED', () => {
    mount([
      note({ id: 'n1', comment: 'ordinary question' }),
      note({ id: 'n2', kind: 'deviation', comment: 'the deck ships four slides' }),
    ])
    expect(screen.getByTestId('plan-comment-list').className).toContain('plan-cl--alarm')
    const rows = screen.getAllByTestId('plan-comment-row')
    expect(rows[0].textContent).toContain('the deck ships four slides')
    expect(rows[1].textContent).toContain('ordinary question')
  })

  it('ROUTES ON A CLICK AND DECIDES NOTHING', () => {
    const { onShow, onUnstage } = mount([note()])
    fireEvent.click(screen.getByTestId('plan-comment-row'))
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }))
    expect(onUnstage).not.toHaveBeenCalled()
    // The two controls the band's old callout carried resolved the note on the
    // click. They are gone, not re-pointed: a comment is decided in exactly one
    // place, its own card, and putting them back here re-opens the second door.
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull()
  })

  it('SHOWS THE DECISION AND OFFERS THE UNDO — the tray’s ✕, on the comment', () => {
    const { onUnstage } = mount([note()], [row({ kind: 'ask' })])
    // The DISPLAY word, off the one map the tray read, so `ask` never reads
    // `ask` to a human on any surface.
    expect(screen.getByText('reply')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove reply row' }))
    expect(onUnstage).toHaveBeenCalledWith('r1')
  })

  it('A PENDING NOTE SAYS SO AND CARRIES NO ✕ — a filed note cannot be unwritten', () => {
    const mine = note({ id: 'n1', by: 'user', to: 'backend' })
    mount([mine], [], [mine])
    expect(screen.getByText('waiting to send')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Remove|Discard/ })).toBeNull()
    // And the reason is on screen exactly once, where the rows it explains are.
    expect(screen.getByTestId('plan-comment-list-pending').textContent).toContain(
      'A filed note cannot be unwritten',
    )
  })

  it('A SUPERSEDED ROW IS DRAWN, NOT DROPPED — it still rides the submit', () => {
    // Joining on `stagedFor` instead of the raw rows would hide it here while it
    // still went out, which is worse than either showing it or removing it.
    mount([note()], [row({ kind: 'accept', superseded_by: 'r2' })])
    expect(screen.getByText('superseded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove accept row' })).toBeTruthy()
  })

  it('A FOLDED ROW SAYS SO AND IS NOT DIMMED — its text is in the write that lands', () => {
    // The badge moved here with the row it describes. It has to be its own word
    // and not `superseded` reused: the two markers are the same shape and
    // opposite news, and a folded row's text IS in the document. The row also
    // keeps its ✕ — ✕ on the winner is what un-folds it, and ✕ here takes back
    // this half of the fold.
    mount([note()], [row({ kind: 'accept', folded: true })])
    const item = document.querySelector('[data-folded="yes"]')!
    expect(item).toBeTruthy()
    expect(screen.getByText('folded in')).toBeTruthy()
    // NOT the discarding marker, and not the dimming class that goes with it.
    expect(screen.queryByText('superseded')).toBeNull()
    expect(item.className).not.toContain('plan-cl-item--superseded')
    expect(screen.getByRole('button', { name: 'Remove accept row' })).toBeTruthy()
  })

  it('A STAGED EDIT IS A ROW LIKE ANY OTHER — chip, author, and its own undo', () => {
    const { onShow, onUnstage } = mount(
      [],
      [
        row({
          id: 'e1',
          kind: 'edit',
          note_id: '',
          section: 'milestones',
          base: '## Milestones\nold\n',
          text: '## Milestones\nfour milestones now\n',
        }),
      ],
    )
    const listRow = screen.getByTestId('plan-comment-row')
    // Its summary is the first line of what you wrote — what the tray's own
    // edit row printed.
    expect(listRow.textContent).toContain('## Milestones')
    // THE CHIP READS `accept`, not `edit`: writing a section is proposing text
    // and accepting it in the same gesture, and that framing is what leaves this
    // list one row type. The author line is what still says whose rewrite it is.
    expect(within(listRow).getByText('accept')).toBeTruthy()
    expect(listRow.textContent).toContain('by you')
    // ✕ MEANS SOMETHING SLIGHTLY DIFFERENT HERE and the label says so:
    // unstaging a decision leaves its comment open, discarding an edit removes
    // the comment too, because the comment WAS the edit.
    fireEvent.click(screen.getByRole('button', { name: 'Discard this edit' }))
    expect(onUnstage).toHaveBeenCalledWith('e1')
    // And it routes through the SAME callback a real note does — one contract.
    fireEvent.click(listRow)
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
  })

  /**
   * THE DIRECTION SPLIT — the list says which comments are waiting on YOU.
   *
   * The list shows every open comment and always did, which is what makes it a
   * complete navigator. What it did not do is say which way each one points, so
   * a question you asked and had already been answered sat in the same column
   * as the coordinator's inbound one, chip and ✕ and all, and the box read as a
   * list of chores you owed.
   *
   * NOTHING IS FILTERED AND NOTHING IS REORDERED, which is the property these
   * cases actually pin — a split that dropped a row would break the navigator
   * it exists to make legible.
   */
  describe('it groups by who each comment is waiting on', () => {
    it('heads each group with its own addressee, `Waiting on you` first', () => {
      mount([
        note({ id: 'n1', to: 'keeper', by: 'user', comment: 'why six weeks?' }),
        note({ id: 'n2', to: 'user', by: 'keeper', comment: 'pick a store' }),
      ])
      const labels = screen
        .getAllByTestId(/^plan-comment-group-label-/)
        .map((el) => el.textContent)
      expect(labels).toEqual(['Waiting on you', 'Waiting on @keeper'])
      // Every row survived the split — the navigator is as complete as it was.
      expect(screen.getAllByTestId('plan-comment-row')).toHaveLength(2)
      expect(
        within(screen.getByTestId('plan-comment-group-user')).getByTestId('plan-comment-row')
          .textContent,
      ).toContain('pick a store')
    })

    /* THE REPORTED BUG. A desk card reading `2 for you` above a tray listing
       three rows under `Waiting on you`. Both numbers were right — the pill is
       `open_notes_for_you`, spec-layer only, which is exactly what the
       execution gate reads, and this list filters by nothing so it stays a
       complete navigator — and under one label they read as a contradiction.
       The heading now names the subset; nothing is filtered and no second
       count exists. */
    it('says how many of your rows hold the work when not all of them do', () => {
      mount([
        note({ id: 'n1', to: 'user', by: 'keeper', comment: 'pick a store' }),
        note({ id: 'n2', to: 'user', by: 'keeper', comment: 'which segment?' }),
        note({
          id: 'n3',
          to: 'user',
          by: 'keeper',
          layer: 'detail',
          comment: 'a sample opportunity, if you have one',
        }),
      ])
      expect(screen.getByTestId('plan-comment-group-label-user').textContent).toBe(
        'Waiting on you · 2 of 3 hold the work',
      )
      // STILL A COMPLETE NAVIGATOR — the third row is listed, not filtered.
      expect(screen.getAllByTestId('plan-comment-row')).toHaveLength(3)
    })

    it('badges the row that is not holding the project, and only that one', () => {
      mount([
        note({ id: 'n1', to: 'user', by: 'keeper', comment: 'pick a store' }),
        note({
          id: 'n2',
          to: 'user',
          by: 'keeper',
          layer: 'detail',
          comment: 'a sample opportunity',
        }),
      ])
      const rows = screen.getAllByTestId('plan-comment-row')
      const badged = rows.filter((r) => r.textContent?.includes('hold the work'))
      expect(badged).toHaveLength(1)
      expect(badged[0].textContent).toContain('a sample opportunity')
    })

    it('stays silent when every row addressed to you holds the work', () => {
      // A qualifier that is always there stops being read. The ordinary plan is
      // all-spec, and its heading is the one it always was.
      mount([
        note({ id: 'n1', to: 'user', by: 'keeper' }),
        note({ id: 'n2', to: 'user', by: 'keeper', comment: 'and this' }),
      ])
      expect(screen.getByTestId('plan-comment-group-label-user').textContent).toBe(
        'Waiting on you',
      )
      expect(screen.queryByText(/hold the work/)).toBeNull()
    })

    it('never badges a row in somebody else\'s group', () => {
      // `holdsTheWork`'s first term is `to === "user"`, so every row in a
      // keeper group would qualify for the badge on the layer test alone. The
      // badge is scoped to your own group because "does not hold the work" is a
      // statement about YOUR queue, and on a note you are waiting to hear back
      // about it would be noise on every row.
      mount([
        note({ id: 'n1', to: 'keeper', by: 'user', layer: 'detail', comment: 'why six weeks?' }),
      ])
      expect(screen.queryByText(/hold the work/)).toBeNull()
    })

    it('a note addressed to nobody says what it is, never who is waiting', () => {
      // `''` is `add_note`'s *recorded, never sent* — a real and deliberate
      // thing to file, and the one group nobody is waiting on. This is the
      // shape a two-way `mine`/`theirs` split has to guess a label for, and
      // guessing is how a header comes to contradict the row under it.
      mount([note({ id: 'n1', to: '', by: 'user' })])
      expect(screen.getByTestId('plan-comment-group-label-nobody').textContent).toBe(
        'Recorded, not sent',
      )
    })

    it('a deviation is still the first row on screen', () => {
      // `commentList` puts alarms first and this only partitions that order. A
      // deviation is a keeper note to the user, so it is `to === "user"` by
      // construction and lands at the top of the group that is itself first —
      // the split cannot bury it.
      mount([
        note({ id: 'n1', to: 'keeper', by: 'user', comment: 'why six weeks?' }),
        note({ id: 'n2', to: 'user', by: 'keeper', kind: 'deviation', comment: 'scope grew' }),
      ])
      expect(screen.getAllByTestId('plan-comment-row')[0].textContent).toContain('scope grew')
    })
  })

  it('IT IS A NAVIGATOR, NEVER A DESTINATION — no `data-note-id` on a row', () => {
    // `PlanEditor`'s scroll effect finds its target by `[data-note-id]`. A
    // second element carrying a note's id ABOVE the pane is how that query lands
    // on the list instead of the card it is routing to.
    mount([note()])
    expect(document.querySelectorAll('[data-note-id]')).toHaveLength(0)
    expect(screen.getByTestId('plan-comment-row').getAttribute('data-comment-id')).toBe('n1')
  })
})

/**
 * WHICH QUESTION A REPLY ANSWERS. Two replies reading "follow your
 * recommendation" were indistinguishable in this list; the `re:` line names the
 * question each one answers.
 */
describe('PlanCommentList — reply rows', () => {
  it('names the question a reply answers, and only on a reply', () => {
    const q1 = note({ id: 'q1', comment: 'Secrets: list with a lock icon? More detail.' })
    const q2 = note({ id: 'q2', comment: 'Size limits: 1 MB preview?' })
    const r1 = note({ id: 'r1', by: 'user', to: 'keeper', comment: 'follow your recommendation', reply_to: 'q1' })
    const r2 = note({ id: 'r2', by: 'user', to: 'keeper', comment: 'follow your recommendation', reply_to: 'q2' })
    const plain = note({ id: 'p1', comment: 'unrelated' })
    const all = [q1, q2, r1, r2, plain]
    render(
      <PlanCommentList
        items={commentList([r1, r2, plain], [], [])}
        keeper="keeper"
        onShow={vi.fn()}
        onUnstage={vi.fn()}
        parentOf={(n) => all.find((p) => p.id === n.reply_to) ?? null}
      />,
    )
    expect(screen.getByTestId('plan-cl-re-r1').textContent).toContain('Secrets: list with a lock icon?')
    expect(screen.getByTestId('plan-cl-re-r2').textContent).toContain('Size limits: 1 MB preview?')
    expect(screen.queryByTestId('plan-cl-re-p1')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import type { PlanNote } from '../../../api/endpoints/projectPlans'
import { baseIsCurrent, collideSeries, diffSeries, foldProposal, renderDiff } from './planDiffs'

/**
 * THE SECOND DIFF GENERATOR, AND THE TESTS THAT MAKE A SECOND ONE SAFE.
 *
 * `models/plan_markdown.render_diff` is the repository's only `difflib` call
 * site and `planDiffs.renderDiff` deliberately mirrors it, because two of the
 * three comparisons a note's series needs have a left-hand side the server has
 * never seen — the text the TRAY is holding, and text the user typed a moment
 * ago. Two generators is a real cost; what stops it becoming two ANSWERS is the
 * first describe below, whose fixtures were captured by running the real
 * `render_diff` and pasting what it printed.
 */

const MILESTONES_BASE =
  '## Milestones\n' +
  '\n' +
  '- [ ] **M1** — spec, owned by @backend\n' +
  '- [ ] **M2** — build\n' +
  '- [ ] **M3** — unassigned\n' +
  '- [ ] **M4** — ship\n' +
  '\n' +
  'Acceptance: every box ticked.\n'

/** @frontend ticks M3. */
const M3_DONE = MILESTONES_BASE.replace(
  '- [ ] **M3** — unassigned',
  '- [x] **M3** — frontend (delivered 2026-09-07)',
)

/** @backend ticks M1 — a DIFFERENT line of the same section. This pair is the
 *  case the whole feature is about. */
const M1_DONE = MILESTONES_BASE.replace(
  '- [ ] **M1** — spec, owned by @backend',
  '- [x] **M1** — backend (delivered 2026-09-06)',
)

/** @devops renames M3 — the SAME line @frontend ticked. */
const M3_RENAMED = MILESTONES_BASE.replace(
  '- [ ] **M3** — unassigned',
  '- [ ] **M3** — deploy pipeline',
)

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n1',
    section: 'milestones',
    to: 'user',
    by: 'frontend',
    at: 't',
    status: 'open',
    kind: 'proposal',
    layer: 'spec',
    comment: '',
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
    has_proposal: true,
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

describe('the drift guard — this client prints what the server prints', () => {
  /**
   * THE TEST THAT LICENSES A SECOND GENERATOR. Every fixture below is the
   * literal output of `render_diff(base, text, label=…)` run against this
   * repository's `models/plan_markdown.py`, pasted verbatim. Byte equality, not
   * "the same hunks modulo formatting": a guard that has to forgive a
   * difference cannot tell forgiveness from drift.
   */
  it('matches `render_diff` byte for byte on a one-line edit inside a section', () => {
    expect(renderDiff(MILESTONES_BASE, M3_DONE, 'milestones')).toBe(
      '--- milestones (base)\n' +
        '+++ milestones (proposed)\n' +
        '@@ -2,7 +2,7 @@\n' +
        ' \n' +
        ' - [ ] **M1** — spec, owned by @backend\n' +
        ' - [ ] **M2** — build\n' +
        '-- [ ] **M3** — unassigned\n' +
        '+- [x] **M3** — frontend (delivered 2026-09-07)\n' +
        ' - [ ] **M4** — ship\n' +
        ' \n' +
        ' Acceptance: every box ticked.',
    )
  })

  /** THE ONE BYTE THE TWO GENERATORS DISAGREE ON, NORMALISED RATHER THAN
   *  EXCUSED. The unified-diff convention prints a one-line range as a bare
   *  start (`-1`, not `-1,1`); `difflib._format_range_unified` follows it and
   *  jsdiff does not. `unifyHunkHeaders` closes that, and this is the fixture
   *  that would catch its removal. */
  it('matches on a single-line section, where the range form differs', () => {
    expect(renderDiff('Ship six slides.\n', 'Ship four slides.\n', 'goal')).toBe(
      '--- goal (base)\n+++ goal (proposed)\n@@ -1 +1 @@\n-Ship six slides.\n+Ship four slides.',
    )
  })

  /** A SECTION CREATE — the empty base is zero lines, not one empty line, which
   *  is what `str.splitlines()` says and what makes the range read `-0,0`. */
  it('matches on a create, where the base is empty', () => {
    expect(renderDiff('', '## New\n\nbody\n', 'new')).toBe(
      '--- new (base)\n+++ new (proposed)\n@@ -0,0 +1,3 @@\n+## New\n+\n+body',
    )
  })

  /** A PROPOSED DELETE, for the same reason from the other end. */
  it('matches on a delete, where the proposal is empty', () => {
    expect(renderDiff('## Gone\n\nbody\n', '', 'gone')).toBe(
      '--- gone (base)\n+++ gone (proposed)\n@@ -1,3 +0,0 @@\n-## Gone\n-\n-body',
    )
  })

  /** A TRAILING NEWLINE IS NOT A CHANGE, because `render_diff` compares
   *  `splitlines()` and cannot see one. jsdiff compares strings and CAN — it
   *  would print `\ No newline at end of file` — so the normalisation that hides
   *  it is pinned here rather than left to be discovered as a phantom diff. */
  it('reports no change when only the trailing newline differs', () => {
    expect(renderDiff('a\nb\n', 'a\nb')).toBe('')
  })
})

describe("a note's series", () => {
  /** THE COMPATIBILITY PROMISE. A lone proposal on a section nobody else has
   *  touched produces ONE step, and `PlanDiffSeries` renders one step bare — so
   *  the ~95% case draws exactly what it drew before any of this existed. */
  it('is one step for a lone proposal against an unmoved section', () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE })
    const steps = diffSeries(n, [n], MILESTONES_BASE)
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe('self')
    expect(steps[0].diff).toBe(renderDiff(MILESTONES_BASE, M3_DONE, 'milestones'))
  })

  /** A plain comment draws nothing, exactly as `{note.display_diff && …}` did. */
  it('is empty for a note with no proposal and no server diff', () => {
    const n = note({ has_proposal: false, kind: 'note', comment: 'looks fine' })
    expect(diffSeries(n, [n], MILESTONES_BASE)).toEqual([])
  })

  /**
   * THE CLAIM THE WHOLE FEATURE RESTS ON, and it should fail loudly if the
   * direction is ever flipped.
   *
   * @frontend ticked M3, @backend ticked M1. Two independent cards each show a
   * small, clean, plausible-looking diff and NOTHING says they are mutually
   * exclusive. On @frontend's card the rival step draws @backend's proposal
   * against @frontend's — so @frontend's own tick appears as a RED line, which
   * is the fact two cards hide: taking @backend's would undo it.
   */
  it("draws a rival's change AND the reversion of this one", () => {
    const mine = note({ id: 'a', by: 'frontend', proposal: M3_DONE, base_section: MILESTONES_BASE })
    const theirs = note({ id: 'b', by: 'backend', proposal: M1_DONE, base_section: MILESTONES_BASE })
    const steps = diffSeries(mine, [mine, theirs], MILESTONES_BASE)

    expect(steps.map((s) => s.kind)).toEqual(['self', 'rival'])
    const rival = steps[1]
    expect(rival.by).toBe('backend')
    expect(rival.noteId).toBe('b')
    // @backend's tick, added…
    expect(rival.diff).toContain('+- [x] **M1** — backend (delivered 2026-09-06)')
    // …and @frontend's own, taken away. This is the line the old surface hid.
    expect(rival.diff).toContain('-- [x] **M3** — frontend (delivered 2026-09-07)')
    expect(rival.hint).toContain("the red lines are @frontend's change, undone")
  })

  /** Symmetry, so neither card is the privileged one: @backend's card says the
   *  same thing about @frontend's proposal. */
  it('says the same thing from the other card', () => {
    const mine = note({ id: 'a', by: 'frontend', proposal: M3_DONE, base_section: MILESTONES_BASE })
    const theirs = note({ id: 'b', by: 'backend', proposal: M1_DONE, base_section: MILESTONES_BASE })
    const steps = diffSeries(theirs, [mine, theirs], MILESTONES_BASE)
    expect(steps[1].by).toBe('frontend')
    expect(steps[1].diff).toContain('-- [x] **M1** — backend (delivered 2026-09-06)')
  })

  /** Only OPEN proposals are rivals. A resolved note is not a live alternative
   *  and its effect is already inside the text step [1] compares against. */
  it('ignores a rival that is already resolved', () => {
    const mine = note({ id: 'a', proposal: M3_DONE, base_section: MILESTONES_BASE })
    const closed = note({
      id: 'b',
      by: 'backend',
      status: 'rejected',
      proposal: M1_DONE,
      base_section: MILESTONES_BASE,
    })
    expect(diffSeries(mine, [mine, closed], MILESTONES_BASE)).toHaveLength(1)
  })

  /** A note on ANOTHER section is not a rival, however similar its text. */
  it('ignores a proposal on a different section', () => {
    const mine = note({ id: 'a', proposal: M3_DONE, base_section: MILESTONES_BASE })
    const elsewhere = note({
      id: 'b',
      section: 'goal',
      by: 'backend',
      proposal: M1_DONE,
      base_section: MILESTONES_BASE,
    })
    expect(diffSeries(mine, [mine, elsewhere], MILESTONES_BASE)).toHaveLength(1)
  })

  /**
   * THE COMPARISON THE AMBER WARNING ASKS FOR, DRAWN. When the section no
   * longer reads the way the author saw it, step [1] puts the proposal against
   * what it says NOW — which is the comparison "this section changed since @x
   * wrote this" has always left the reader to do in their head.
   */
  it('adds a step against the current text when the section has moved', () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE, section_changed: true })
    const steps = diffSeries(n, [n], M1_DONE)
    expect(steps.map((s) => s.kind)).toEqual(['self', 'current'])
    // Its LEFT-hand side is the live text: @backend's tick is what would be lost.
    expect(steps[1].diff).toContain('-- [x] **M1** — backend (delivered 2026-09-06)')
  })

  /**
   * THE STACKING CASE, AND THE REASON THE `current` GATE IS A STRING COMPARISON
   * RATHER THAN `note.section_changed`.
   *
   * Accept @backend's and the tray holds `M1_DONE` while the SERVER still has
   * `MILESTONES_BASE` — so `section_changed` is `false` on every note, which is
   * precisely when this comparison is most worth drawing. Passing the tray's
   * text re-heads the series with no request and no refetch.
   */
  it("re-heads on the TRAY's text, which the server's `section_changed` cannot see", () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE, section_changed: false })
    const steps = diffSeries(n, [n], M1_DONE)
    expect(steps.map((s) => s.kind)).toEqual(['self', 'current'])
    expect(steps[1].diff).toBe(renderDiff(M1_DONE, M3_DONE, 'milestones'))
  })

  /** ONE COMPARISON, NOT TWO. Once a rival's proposal IS the current text, step
   *  [1] already draws that pair and better oriented — its left-hand side is
   *  what the document will say. A rival step would be the same comparison
   *  inverted. */
  it('drops a rival whose proposal is already what the tray holds', () => {
    const mine = note({ id: 'a', proposal: M3_DONE, base_section: MILESTONES_BASE })
    const theirs = note({ id: 'b', by: 'backend', proposal: M1_DONE, base_section: MILESTONES_BASE })
    const steps = diffSeries(mine, [mine, theirs], M1_DONE)
    expect(steps.map((s) => s.kind)).toEqual(['self', 'current'])
  })

  /**
   * AN APPLIED NOTE FALLS BACK TO THE SERVER'S DIFF, and its series is length 1
   * so it renders pixel-identically to what it rendered before.
   *
   * Both apply paths blank `proposal` into `applied_text`, which is
   * `Field(exclude=True)` and never ships — so this client has nothing to
   * regenerate from and does not pretend otherwise. It is never a rival either
   * (that enumerates open proposals with text), and its effect is already
   * inside the current text.
   */
  it("uses the server's diff verbatim for an applied note", () => {
    const applied = note({
      status: 'applied',
      has_proposal: false,
      proposal: '',
      display_diff: '--- milestones (base)\n+++ milestones (applied)\n@@ -1 +1 @@\n-old\n+new',
    })
    const steps = diffSeries(applied, [applied], MILESTONES_BASE)
    expect(steps).toHaveLength(1)
    expect(steps[0].diff).toBe(applied.display_diff)
  })

  /** The same one rule covers a proposed DELETE: `proposal` is legitimately
   *  `''`, and the server rendered the section against nothing. */
  it("uses the server's diff verbatim for a proposed delete", () => {
    const del = note({
      proposes_delete: true,
      proposal: '',
      display_diff: '--- milestones (base)\n+++ milestones (proposed)\n@@ -1 +0,0 @@\n-gone',
    })
    const steps = diffSeries(del, [del], MILESTONES_BASE)
    expect(steps).toHaveLength(1)
    expect(steps[0].diff).toBe(del.display_diff)
  })

  /** A section that is no longer in the document has no "plan as it stands" to
   *  be read against, and `section_missing` already says so in words. Drawing
   *  the whole proposal as an insertion would be noise on top of that. */
  it('draws no `current` step for a section that is gone', () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE, section_missing: true })
    expect(diffSeries(n, [n], '')).toHaveLength(1)
  })
})

/**
 * THE PREDICATE BEHIND THE SNAPSHOT QUOTE — "is the note's `base_section` still
 * what the reader is looking at?"
 *
 * Three claims, and each one is a way the obvious implementation gets it wrong:
 * `===` on the raw strings, or `note.section_changed` off the wire.
 */
describe('is the snapshot still what the document says', () => {
  it('true when the section has not moved — the quote would repeat the pane', () => {
    const n = note({ base_section: MILESTONES_BASE })
    expect(baseIsCurrent(n, MILESTONES_BASE)).toBe(true)
  })

  it('false once anybody edits the section — the quote is the only record left', () => {
    const n = note({ base_section: MILESTONES_BASE })
    expect(baseIsCurrent(n, M3_DONE)).toBe(false)
  })

  /** A MISSING FINAL NEWLINE IS NOT AN EDIT — `===` would call it one and show
   *  the same text twice over a byte no reader can see. `renderDiff` normalises
   *  it because `forDiff` does, in BOTH directions: it is the snapshot that
   *  arrives without one as often as the section does. (A SECOND trailing
   *  newline is a real blank line and stays a change — `forDiff` drops one
   *  empty final line, not every one.) */
  it('a missing final newline is not a change, from either side', () => {
    const unterminated = MILESTONES_BASE.replace(/\n$/, '')
    expect(baseIsCurrent(note({ base_section: MILESTONES_BASE }), unterminated)).toBe(true)
    expect(baseIsCurrent(note({ base_section: unterminated }), MILESTONES_BASE)).toBe(true)
  })

  /** THE CASE THE WIRE'S `section_changed` CANNOT ANSWER. While the tray holds
   *  an accepted proposal the server still has the OLD text stored, so
   *  `section_changed` is `false` — and a gate reading it would hide the
   *  snapshot at the exact moment the pane stopped saying it. The caller passes
   *  the tray's text, so this says `false`. */
  it("reads the text passed in, not the wire's `section_changed`", () => {
    const n = note({ base_section: MILESTONES_BASE, section_changed: false })
    expect(baseIsCurrent(n, M1_DONE)).toBe(false)
  })

  /** A section that no longer resolves has no text at all, and that is the one
   *  card where the snapshot exists nowhere else on screen. */
  it('false on a section that is gone', () => {
    const n = note({ base_section: MILESTONES_BASE, section_missing: true })
    expect(baseIsCurrent(n, '')).toBe(false)
  })
})

describe('the fold — both proposals, as one text', () => {
  /**
   * THE CASE THAT MOTIVATES STACKING: two agents editing DIFFERENT milestones
   * inside one `## Milestones`. A proposal is a whole-section replacement, so
   * staging @frontend's directly would revert @backend's; re-applying its
   * CHANGE keeps both.
   */
  it('fits a proposal onto another that changed a different line', () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE })
    const folded = foldProposal(M1_DONE, n)
    expect(folded).toContain('- [x] **M1** — backend (delivered 2026-09-06)')
    expect(folded).toContain('- [x] **M3** — frontend (delivered 2026-09-07)')
    // …and nothing else moved.
    expect(folded).toContain('- [ ] **M2** — build')
    expect(folded).toContain('Acceptance: every box ticked.')
  })

  /** ORDER IS PART OF THE ANSWER, so the fold composes the other way too and
   *  the surface stacks in the order the user accepted in. */
  it('fits either way round on non-overlapping edits', () => {
    const backend = note({ proposal: M1_DONE, base_section: MILESTONES_BASE })
    expect(foldProposal(M3_DONE, backend)).toBe(
      foldProposal(M1_DONE, note({ proposal: M3_DONE, base_section: MILESTONES_BASE })),
    )
  })

  /**
   * IT REFUSES RATHER THAN GUESSES. Two proposals on the SAME line have no
   * correct automatic answer, and this is exactly where the pick-one control
   * earns its keep — the surface degrades into today's behaviour instead of
   * inventing a merge.
   */
  it('refuses when the two proposals touch the same line', () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE })
    expect(foldProposal(M3_RENAMED, n)).toBeNull()
  })

  /** And when the line it changes has been deleted out from under it. */
  it('refuses when the line it changes is no longer there', () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE })
    const m3Gone = MILESTONES_BASE.replace('- [ ] **M3** — unassigned\n', '')
    expect(foldProposal(m3Gone, n)).toBeNull()
  })

  /** A note with no proposal has no change to re-apply. A delete is not a
   *  patch that can be fitted onto anything. */
  it('refuses a note with no proposal', () => {
    expect(foldProposal(MILESTONES_BASE, note({ proposal: '', proposes_delete: true }))).toBeNull()
  })

  /** THE FOLD PRESERVES THE SECTION'S SHAPE, trailing blank line included — the
   *  string it returns is spliced into the document verbatim, so a lost newline
   *  here is a markdown structure change nobody asked for. */
  it('preserves the section text exactly outside the change', () => {
    const n = note({ proposal: M3_DONE, base_section: MILESTONES_BASE })
    const folded = foldProposal(M1_DONE, n)!
    expect(folded.endsWith('Acceptance: every box ticked.\n')).toBe(true)
    expect(folded.split('\n')).toHaveLength(MILESTONES_BASE.split('\n').length)
  })
})

describe('the collision control asks in both directions', () => {
  /** At a decision point neither side is "the diff": showing only
   *  `held → next` prints the case for one of two buttons. */
  it('renders what taking the incoming one does AND what keeping the held one does', () => {
    const steps = collideSeries(
      { text: M1_DONE, by: 'backend' },
      { text: M3_DONE, by: 'frontend' },
      'milestones',
      false,
    )
    expect(steps).toHaveLength(2)
    expect(steps[0].label).toBe("What taking @frontend's does")
    expect(steps[1].label).toBe("What keeping @backend's does")
    expect(steps[0].diff).toBe(renderDiff(M1_DONE, M3_DONE, 'milestones'))
    expect(steps[1].diff).toBe(renderDiff(M3_DONE, M1_DONE, 'milestones'))
  })

  /** THE `heldIsCurrent` LABEL RULE, which exists because the agent that wrote
   *  the section is usually the agent that filed the note — so naming the held
   *  side by its author would print `@devops's` beside `@devops's` and name no
   *  difference at all. The held side is called what it IS. */
  it('calls the document what it is rather than whose it is', () => {
    const steps = collideSeries(
      { text: M1_DONE, by: 'devops' },
      { text: M3_DONE, by: 'devops' },
      'milestones',
      true,
    )
    expect(steps[1].label).toBe('What keeping what it says now does')
  })

  /** Two identical texts have nothing to say in either direction. */
  it('says nothing when the two sides are the same text', () => {
    const steps = collideSeries(
      { text: M1_DONE, by: 'a' },
      { text: M1_DONE, by: 'b' },
      'milestones',
      false,
    )
    expect(steps).toEqual([])
  })
})

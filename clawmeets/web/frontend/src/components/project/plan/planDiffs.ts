import { applyPatch, createTwoFilesPatch, structuredPatch, FILE_HEADERS_ONLY } from 'diff'
import type { PlanNote } from '../../../api/endpoints/projectPlans'

/* THE ONE PLACE THIS CLIENT GENERATES A DIFF.
 *
 * `PlanDiff` used to say it "is the reason a diff-printing client does not
 * become a second one", and that sentence is retired here rather than quietly
 * broken: this module is the second generator, it is one function wide, and
 * every diff on this surface still renders through `PlanDiff`. What the rule
 * was protecting is intact — `models/plan_markdown.py` keeps the repository's
 * only `difflib` import, and no surface anywhere accepts a diff as INPUT. The
 * write path still sends a section's whole replacement TEXT.
 *
 * The reason it has to be here and cannot be a server field: two of the three
 * comparisons below have a left-hand side the server has never seen. The
 * "against the plan now" step is headed by the text THE TRAY IS HOLDING, so
 * accepting one proposal re-heads every other card on that section instantly,
 * with no request and no refetch; and `collideSeries`'s held side can be a
 * string the user typed into a textarea two seconds ago.
 */

/** Python's `str.splitlines`, for the newline forms a plan document contains.
 *
 * `render_diff` compares `base.splitlines()` against `text.splitlines()`, which
 * drops a single trailing newline and is blind to whether the string had one.
 * jsdiff compares STRINGS and is not blind to it — it emits
 * `\ No newline at end of file`. Normalising both sides to "lines, each newline
 * terminated" is what makes the two generators print the same bytes for the
 * same pair, which is what `planDiffSeries.test.ts`'s drift guard asserts.
 *
 * An empty string is zero lines, not one empty line, so a section CREATE
 * renders `@@ -0,0` exactly as the server renders it. */
function forDiff(s: string): string {
  const lines = s.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** `@@ -4,1 +4,1 @@` → `@@ -4 +4 @@`.
 *
 * The unified-diff convention is that a one-line range prints as a bare start.
 * `difflib._format_range_unified` follows it and jsdiff does not, and that is
 * the ONLY byte on which the two disagree for a well-formed pair — so it is
 * normalised here rather than excused in the test. `diff2html` parses both
 * forms identically; the reason to care is that a drift guard which has to
 * forgive a difference cannot tell forgiveness from drift. */
function unifyHunkHeaders(diff: string): string {
  const bare = (n: string | undefined) => (n === ',1' ? '' : (n ?? ''))
  return diff.replace(
    /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm,
    (_m, a, an, b, bn) => `@@ -${a}${bare(an)} +${b}${bare(bn)} @@`,
  )
}

/**
 * A unified diff of two section texts, for display.
 *
 * MIRRORS `models/plan_markdown.render_diff` DELIBERATELY AND EXACTLY: three
 * lines of context, `{label} (base)` / `{label} (proposed)` file headers, no
 * `Index:` line, no `===` underline, no trailing newline. Same shape in, same
 * shape out — so `PlanDiff` and `diff2html` cannot tell which generator wrote
 * a given step, and a test can assert the server's `display_diff` and this
 * function's step [0] byte for byte.
 *
 * Returns `''` for two identical texts, which is what makes every caller below
 * able to say "skip a step that says nothing" with a truthiness test.
 */
export function renderDiff(base: string, text: string, label = ''): string {
  const a = forDiff(base)
  const b = forDiff(text)
  if (a === b) return ''
  const name = label || 'section'
  const out = createTwoFilesPatch(
    `${name} (base)`,
    `${name} (proposed)`,
    a,
    b,
    undefined,
    undefined,
    { context: 3, headerOptions: FILE_HEADERS_ONLY },
  )
  return unifyHunkHeaders(out.replace(/\n$/, ''))
}

/**
 * ONE LINE OF CONTEXT, AND THE NUMBER IS THE WHOLE SAFETY MARGIN.
 *
 * `foldProposal` re-applies a proposal's CHANGE to a text that proposal never
 * saw, and `applyPatch` refuses whenever the patch's context lines are not
 * where the patch says they are. Context is therefore the dial between "folds
 * too eagerly" and "refuses too often", and it was picked by trying it:
 *
 *   - 3 (what `renderDiff` prints) refuses almost every real fold. On a
 *     five-line `## Milestones` every hunk's context reaches every other
 *     milestone, so two agents ticking different boxes read as a conflict.
 *   - 0 matches on line numbers and the removed lines alone. It folds edits
 *     that are directly adjacent, which is the case with no correct automatic
 *     answer.
 *   - 1 folds two edits with a line between them and REFUSES two edits on
 *     neighbouring lines, on the same line, and a modify-over-a-delete.
 *
 * The direction of the error is the point: this is a control that changes the
 * document, so it must refuse a fold it is unsure of and fall back to the
 * pick-one question, which is always available and always correct.
 */
const FOLD_CONTEXT = 1

/**
 * A PROPOSAL'S CHANGE, RE-APPLIED ON TOP OF A TEXT IT WAS NOT WRITTEN AGAINST.
 *
 * This is what "accept @a, then accept @b as well" means, and it exists because
 * a proposal is a WHOLE-SECTION replacement: `note.proposal` is not @b's edit,
 * it is the entire section as @b would have it, with @a's work absent from it.
 * Staging it directly is how taking the second silently reverts the first.
 *
 * So the fold is @b's PATCH — `base_section → proposal`, the change they
 * actually made — applied to `onto`, which is whatever the tray is holding for
 * that section. Nothing here is a merge algorithm and nothing guesses: jsdiff 8
 * exports no three-way merge (`merge` and `diff3Merge` are gone; `applyPatch`
 * is what is there), and patch application is in any case what "stack" means.
 *
 * Returns `null` when the patch does not fit — the two proposals touch the same
 * lines, or lines close enough together that fitting one over the other would
 * be a guess. That `null` is not a failure: it is the case the pick-one control
 * exists for, and the caller falls back to it.
 *
 * ORDER IS PART OF THE ANSWER. A-then-B need not equal B-then-A for edits near
 * each other, so this composes in the order the user accepted in and the
 * surface says so rather than implying a set.
 */
export function foldProposal(onto: string, note: PlanNote): string | null {
  if (!note.proposal) return null
  const patch = structuredPatch(
    note.section,
    note.section,
    note.base_section,
    note.proposal,
    undefined,
    undefined,
    { context: FOLD_CONTEXT },
  )
  const out = applyPatch(onto, patch)
  return out === false ? null : out
}

/** Which comparison a step is. Drives the label and nothing else — every step
 *  renders through the same `PlanDiff`. */
export type DiffStepKind = 'self' | 'current' | 'rival'

export interface DiffStep {
  kind: DiffStepKind
  /** the heading for this step, already in words. */
  label: string
  /** one line saying what the two sides ARE; `''` when self-evident. */
  hint: string
  /** the OTHER note this step is about; `''` on `self` and `current`. */
  noteId: string
  /** whose text the right-hand side is; `''` when it is the document or yours. */
  by: string
  diff: string
}

/**
 * THE SERIES FOR ONE NOTE — the chain of comparisons that matter to it.
 *
 *   [0] `self`    — `base_section → proposal`, byte-identical to the server's
 *                   `display_diff`. What the author wrote, against what they
 *                   were looking at.
 *   [1] `current` — `currentText → proposal`, when the section no longer reads
 *                   the way the author saw it. This is the comparison the amber
 *                   "this section changed since @x wrote this" warning has
 *                   always asked the reader to perform in their head.
 *   [2…] `rival`  — `proposal → other.proposal`, one per OTHER open proposal on
 *                   the same section, in filing order. Because a proposal is a
 *                   whole-section replacement, this step necessarily draws the
 *                   rival's own change AND the reversion of this one, in red and
 *                   green — which is exactly the fact two independent cards hide
 *                   today, and the reason the user only ever met it as a modal
 *                   after clicking Accept.
 *
 * `currentText` IS THE TRAY'S TEXT WHEN THE TRAY HOLDS ANY, not the persisted
 * body, and the [1] gate is a string comparison here rather than the wire's
 * `note.section_changed`. Those are the same decision made one moment apart:
 * `section_changed` is the server's comparison against what it has STORED, and
 * it stays `false` for the whole time your tray is carrying somebody else's
 * accepted text — which is precisely when the comparison is most worth drawing.
 *
 * STEP [0] FALLS BACK TO THE SERVER'S DIFF WHENEVER THERE IS NO `proposal` TO
 * DIFF, and that is one rule covering two cases rather than a special case.
 * Both apply paths blank `proposal` into `applied_text`, which is
 * `Field(exclude=True)` and never ships — the payload says why, that shipping
 * both "invites a second source of truth for one fact" — so an APPLIED note has
 * nothing here to regenerate from. Neither has a proposed DELETE, whose
 * `proposal` is legitimately `''` and whose `display_diff` is the section
 * against nothing. In both the server rendered from text this client does not
 * have, so this client renders what the server sent. Neither is ever a rival at
 * [2] (that enumerates OPEN proposals with text), so both have a series of
 * length 1 and draw pixel-identically to what they drew before this existed.
 *
 * A RIVAL THAT IS ALREADY THE CURRENT TEXT IS SKIPPED. Accept @a and step [1]
 * becomes `A → this`; a rival step for @a would be `this → A`, the same
 * comparison inverted and worse oriented. One of them is the answer and it is
 * the one whose left-hand side is what the document will say.
 *
 * Returns `[]` when there is nothing to draw, so a plain comment renders
 * nothing, exactly as `{note.display_diff && …}` did.
 */
export function diffSeries(
  note: PlanNote,
  notes: PlanNote[],
  currentText: string,
): DiffStep[] {
  const steps: DiffStep[] = []
  const self = note.proposal
    ? renderDiff(note.base_section, note.proposal, note.section)
    : note.display_diff
  if (self) {
    steps.push({
      kind: 'self',
      label: `As @${note.by || 'the author'} wrote it`,
      hint: '',
      noteId: '',
      by: note.by,
      diff: self,
    })
  }
  if (!note.proposal) return steps

  // BOTH FLAGS, because between them they are the one condition this needs:
  // the section resolves. The server split "the slug does not resolve" into
  // `section_missing` (deleted under the note) and `section_new` (this note
  // would create it), and a step labelled "against the plan as it stands" is
  // nonsense in either case — there is no text as it stands. Reading only the
  // first would draw the base against the proposal under a label claiming it
  // was the current document.
  if (!note.section_missing && !note.section_new && currentText !== note.base_section) {
    const diff = renderDiff(currentText, note.proposal, note.section)
    if (diff) {
      steps.push({
        kind: 'current',
        label: 'Against the plan as it stands',
        hint:
          'The left side is the section as it reads now, including anything your ' +
          'tray is already holding for it.',
        noteId: '',
        by: '',
        diff,
      })
    }
  }

  for (const other of notes) {
    if (other.id === note.id) continue
    if (other.section !== note.section) continue
    if (other.status !== 'open' || !other.proposal) continue
    // Its comparison is already step [1], better oriented — see above.
    if (other.proposal === currentText) continue
    const diff = renderDiff(note.proposal, other.proposal, note.section)
    if (!diff) continue
    steps.push({
      kind: 'rival',
      label: `Then @${other.by || 'theirs'}, on top`,
      hint:
        `Taking @${other.by || 'theirs'} replaces the whole section — the red lines ` +
        `are @${note.by || 'this author'}'s change, undone.`,
      noteId: other.id,
      by: other.by,
      diff,
    })
  }
  return steps
}

/**
 * DOES THE DOCUMENT STILL SAY WHAT THIS NOTE'S AUTHOR WAS LOOKING AT?
 *
 * `base_section` is a SNAPSHOT taken when the note was filed, and the card
 * quotes it back under "The Plan said, when this was raised" — a line worth its
 * space only while the pane beside it says something else. On a section nobody
 * has touched since, that quote IS the section, one column over, and the card
 * is repeating what the reader is already looking at.
 *
 * `currentText` IS THE TRAY'S TEXT WHEN THE TRAY HOLDS ANY, and this is
 * deliberately NOT the wire's `note.section_changed` — for the same reason step
 * [1] above is not. `section_changed` is the server's comparison against what
 * it has STORED, so it stays `false` for the whole time your tray is carrying
 * somebody else's accepted text for that section: precisely the moment the pane
 * is showing something the snapshot does not say, and precisely the moment the
 * quote earns its keep. Answering from the wire would drop the quote exactly
 * when it is the only place the author's text still exists.
 *
 * COMPARED THROUGH `renderDiff` RATHER THAN WITH `===`, so the normalisation is
 * the one every other comparison on this surface already makes: text that
 * arrives without its final newline is not an edit. `===` would call it one and
 * print the whole section twice over a byte no reader can see. It costs nothing
 * that is not already being spent — this is the comparison `diffSeries` makes
 * anyway.
 *
 * FALSE ON A SECTION THAT NO LONGER RESOLVES, where `currentText` is `''` and
 * the snapshot is not. That is the right answer and not an accident: a missing
 * section is the case where the text survives nowhere else on screen at all.
 */
export function baseIsCurrent(note: PlanNote, currentText: string): boolean {
  return renderDiff(currentText, note.base_section, note.section) === ''
}

/**
 * THE SAME SHAPE FOR THE DECISION CONTROL, whose two sides are not always notes:
 * one of them can be the document, or text the user typed into the tray.
 *
 * TWO STEPS, BOTH DIRECTIONS, and that is the difference from a note's series.
 * On a card there is a diff — what this proposal does. At a decision point
 * there is no "the diff": the question is symmetric, and a reader shown only
 * `held → next` has been handed the case for one of two buttons.
 *
 * It replaces two `<pre>` panes and a heuristic that trimmed their common head
 * and tail so a 90-line section differing on line 89 was not shown as two
 * identical screenfuls. A unified diff solves that problem properly — it pairs
 * lines, marks them, and needs no separate trimming pass — which is why
 * `differingBand` went with the panes rather than being kept beside them.
 */
export function collideSeries(
  held: { text: string; by: string },
  next: { text: string; by: string },
  section: string,
  heldIsCurrent: boolean,
): DiffStep[] {
  const heldName = heldIsCurrent
    ? 'what it says now'
    : held.by
      ? `@${held.by}'s`
      : 'the current text'
  const nextName = next.by ? `@${next.by}'s` : 'your text'
  const steps: DiffStep[] = []
  const taking = renderDiff(held.text, next.text, section)
  if (taking) {
    steps.push({
      kind: 'rival',
      label: `What taking ${nextName} does`,
      hint: `Read against ${heldName}.`,
      noteId: '',
      by: next.by,
      diff: taking,
    })
  }
  const keeping = renderDiff(next.text, held.text, section)
  if (keeping) {
    steps.push({
      kind: 'rival',
      label: `What keeping ${heldName} does`,
      hint: `Read against ${nextName}.`,
      noteId: '',
      by: held.by,
      diff: keeping,
    })
  }
  return steps
}

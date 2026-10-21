import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PlanDiff, linesPairUp } from './PlanDiff'

/**
 * THE ONE SUITE THAT LETS `diff2html` ACTUALLY RUN.
 *
 * Every other plan test stubs `PlanDiff` to a `<pre>` of the raw unified diff,
 * because what they are about is which comparisons a note draws, not how a
 * diff is painted. This one is about the painting, so nothing is mocked: the
 * assertions read the real rendered DOM.
 *
 * What it pins is a READING ORDER. A unified diff's contract with its reader is
 * that a change is a block of removals followed by a block of additions —
 * `git diff` prints that, GitHub prints that, and `plan.css` is a hundred lines
 * of making diff2html print that. `matching: 'words'` broke it: diff2html's
 * `Rematch` pass pairs similar lines and emits the pairs one after another, so
 * a rewritten paragraph came out red-green-red-green and the "before" text was
 * in pieces with the "after" wedged between them.
 */

afterEach(cleanup)

/** The shape of the change, in the order the rows appear on screen. */
function rowMarks(container: HTMLElement): string {
  return [...container.querySelectorAll('tr td.d2h-code-linenumber')]
    .map(td =>
      td.classList.contains('d2h-ins')
        ? '+'
        : td.classList.contains('d2h-del')
          ? '-'
          : td.classList.contains('d2h-info')
            ? '@'
            : ' ',
    )
    .join('')
}

/** Three one-line bullets rewritten as prose — the case from the plan surface
 *  that this is all about. Two removals, five additions, no line-for-line
 *  correspondence between them. */
const REWRITE = [
  '--- Decisions (base)',
  '+++ Decisions (proposed)',
  '@@ -1,4 +1,7 @@',
  ' Three questions were open, and each is now closed.',
  ' ',
  '-- Whether the record is a sixth `NOTE_STATUS` or `applied` plus a marker.',
  '-- The reason string the folded-away note carries.',
  '+**The record: a sixth `NOTE_STATUS`, the word `folded`.** `NOTE_STATUSES`',
  '+becomes six, and its docstring commits to the tuple being advisory — never',
  '+a `Literal`, never an `Enum`, never a validator.',
  '+',
  '+**The reason string, verbatim** — `FOLDED_REASON` on a folded row only.',
].join('\n')

/** One line replaced by one line. The pairing is real here, and the word marks
 *  that come with it are the thing worth keeping. */
const ONE_FOR_ONE = [
  '--- Milestones (base)',
  '+++ Milestones (proposed)',
  '@@ -1,3 +1,3 @@',
  ' ## Milestones',
  ' ',
  '-- [ ] **M3** — unassigned',
  '+- [x] **M3** — frontend (delivered 2026-09-07)',
].join('\n')

describe('linesPairUp', () => {
  it('is true when every changed run swaps N lines for N', () => {
    expect(linesPairUp(ONE_FOR_ONE)).toBe(true)
  })

  it('is false when a run replaces two lines with five', () => {
    expect(linesPairUp(REWRITE)).toBe(false)
  })

  it('reads `---`/`+++` as headers, not as a removal and an addition', () => {
    // Without the header test, the file headers alone would count 1 del + 1 ins
    // and this pure-addition diff would come out "paired".
    const created = ['--- goal (base)', '+++ goal (proposed)', '@@ -0,0 +1,2 @@', '+## Goal', '+Ship it.'].join('\n')
    expect(linesPairUp(created)).toBe(false)
  })

  it('does not count `\\ No newline at end of file` as either side', () => {
    const noEol = [
      '--- goal (base)',
      '+++ goal (proposed)',
      '@@ -1 +1 @@',
      '-Ship it.',
      '+Ship it today.',
      '\\ No newline at end of file',
    ].join('\n')
    expect(linesPairUp(noEol)).toBe(true)
  })

  it('judges each run separately, so one rewrite spoils a paired diff', () => {
    const mixed = [ONE_FOR_ONE, ' ', '-a', '-b', '+c'].join('\n')
    expect(linesPairUp(mixed)).toBe(false)
  })
})

describe('PlanDiff', () => {
  it('draws a rewrite as one block of removals then one block of additions', () => {
    const { container } = render(<PlanDiff text={REWRITE} />)
    expect(rowMarks(container)).toBe('@  --+++++')
  })

  it('leaves a rewrite unmarked at word level, since the pairing is not real', () => {
    const { container } = render(<PlanDiff text={REWRITE} />)
    expect(container.querySelectorAll('.d2h-code-line ins, .d2h-code-line del')).toHaveLength(0)
  })

  it('keeps the word marks on a line-for-line edit, where they are the change', () => {
    const { container } = render(<PlanDiff text={ONE_FOR_ONE} />)
    expect(rowMarks(container)).toBe('@  -+')
    expect(
      container.querySelectorAll('.d2h-code-line ins, .d2h-code-line del').length,
    ).toBeGreaterThan(0)
  })

  it('renders nothing for an empty diff', () => {
    const { container } = render(<PlanDiff text="" />)
    expect(container.innerHTML).toBe('')
  })
})

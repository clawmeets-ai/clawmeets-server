import { useMemo, useState } from 'react'
import { PlanDiffSeries } from './PlanDiffSeries'
import { collideSeries } from './planDiffs'

export type CollideChoice = 'held' | 'next' | 'own'

interface PlanCollideProps {
  /** what the tray (or the document) already holds, and whose it is. */
  heldBy: string
  heldText: string
  /** the candidate that would overtake it, and whose it is. */
  nextBy: string
  nextText: string
  /** the section slug both candidates are about — the scope of `Write my own`. */
  section: string
  /** Is the held side the DOCUMENT rather than somebody's proposal?
   *
   *  Both call sites that pass `true` hand this control the section as it
   *  stands now, and on those the author form is worse than useless: when the
   *  same agent wrote the current text and the proposal — the ordinary case,
   *  since the coordinator both keeps the plan and files the notes — the two
   *  buttons render `Keep @devops's` and `Take @devops's` and there is nothing
   *  in the control that says which one is which. The author is still shown,
   *  as attribution above the comparison rather than as the name of a choice. */
  heldIsCurrent?: boolean
  /** why this control is on screen, in one line. */
  reason: string
  /** BOTH CHANGES CAN LAND, and the caller has already proved it by folding
   *  one onto the other — `foldProposal` returned a string, so there is a text
   *  that carries both edits. Absent when the fold did not fit (the two touch
   *  the same lines, which has no correct automatic answer) or when this call
   *  site does not offer stacking at all.
   *
   *  IT IS A CALLBACK AND NOT A TEXT because the fold is only half of the act:
   *  the tray also has to say something honest about the proposal whose text
   *  was folded in, and that is the editor's business, not this control's. */
  onStack?: () => void
  /** Why `Keep both` is not on offer, in one line. `''` when it IS on offer, or
   *  when the question was never about two proposals — an absent button with no
   *  explanation is indistinguishable from a feature that does not exist. */
  stackRefused?: string
  onResolve: (choice: CollideChoice, text?: string) => void
  onCancel?: () => void
}

/**
 * The collision control. ONE decision, rendered as buttons over a diff series.
 *
 * It appears in two places and the shape of the question is identical in both:
 *
 *   - U5, at STAGING time — a second accepted proposal arrives for a section
 *     the tray already carries text for. Nothing has reached the server, so
 *     `base` is untouched and the cross-batch precondition path is neither
 *     consulted nor weakened. It is a different mechanism from a stale write
 *     and the two must not reach into each other.
 *   - AC-6.5, after a REFUSED submit — the document moved under a staged row.
 *     Every row is still here with the user's text; this shows it beside what
 *     the section says now.
 *
 * THE TWO `<pre>` PANES ARE GONE AND A DIFF SERIES IS IN THEIR PLACE. The panes
 * needed `differingBand` — a head/tail trimmer written because "a side-by-side
 * of two 6,000-character sections is not a comparison": both panes scrolled
 * from the top, so a 90-line milestone differing on line 89 showed two
 * identical screenfuls under two buttons. A unified diff answers that properly.
 * It pairs the lines, marks which changed, and needs no separate trimming pass,
 * so the heuristic went with the panes rather than being kept beside them.
 * `collideSeries` renders BOTH directions — what taking the incoming one does,
 * and what keeping the held one does — because at a decision point neither is
 * "the diff" and showing one is printing the case for one of two buttons.
 *
 * The labels are fixed and user-confirmed: `Keep @{held}'s` / `Write my own` /
 * `Take @{new}'s`. "Write my own", not "Edit"; and taking the new one
 * DISCARDS the held one rather than replacing it.
 *
 * `Keep both` IS THE ONE ADDITION AND IT IS NOT A FOURTH OPINION. Everything
 * above still holds — one text row per section, last one wins — because the
 * fold produces ONE text carrying both edits and stages it as one row. It is
 * offered only when the caller has already proved the fold fits, and it takes
 * the primary emphasis from `Take @{new}'s` when it is there, because a user
 * looking at two proposals that compose has not been asking which one to lose.
 *
 * `heldIsCurrent` is the ONE exception to the labels and it is not a second
 * design. On the AC-2.6 path the held side is the document, not a proposal, and
 * the agent that wrote it is usually the agent that filed the note — so the
 * confirmed labels render as `Keep @devops's` beside `Take @devops's` and name
 * no difference at all. There the held side is called what it IS and the author
 * rides along as attribution. Where the two sides really are two people's text,
 * which is what those labels were confirmed against, nothing changes.
 *
 * `Write my own` opens a SECTION-SCOPED textarea seeded with the candidate. It
 * must never route into a whole-document editor: widening the edit past the
 * section in dispute loses both candidates.
 *
 * There is no Esc-to-dismiss. This is a decision point, and dismissing it by
 * accident silently discards one of two accepted proposals — the precise
 * silence the control exists to remove. `onCancel`, when a caller supplies one,
 * is an explicit button and never a keystroke.
 */
export function PlanCollide({
  heldBy,
  heldText,
  nextBy,
  nextText,
  section,
  reason,
  heldIsCurrent = false,
  onStack,
  stackRefused = '',
  onResolve,
  onCancel,
}: PlanCollideProps) {
  const [own, setOwn] = useState<string | null>(null)
  const heldName = heldIsCurrent ? '' : heldBy
  const heldLabel = heldIsCurrent
    ? 'what it says now'
    : heldName
      ? `@${heldName}'s`
      : 'the current text'
  const nextLabel = nextBy ? `@${nextBy}'s` : 'yours'
  const series = useMemo(
    () =>
      collideSeries(
        { text: heldText, by: heldBy },
        { text: nextText, by: nextBy },
        section,
        heldIsCurrent,
      ),
    [heldText, heldBy, nextText, nextBy, section, heldIsCurrent],
  )

  return (
    <div
      role="group"
      aria-label={`Two versions of ${section}`}
      className="rounded-md border border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-sm"
    >
      <div className="font-semibold text-xs uppercase tracking-wider text-amber-700 dark:text-amber-400 mb-1">
        Two versions of <code>{section}</code>
      </div>
      <p className="text-channel mb-3">{reason}</p>

      {own === null ? (
        <>
          {/* THE ATTRIBUTION SURVIVED THE PANE IT USED TO SIT ON. `heldBy` is
              still the answer to "who moved this", and on the `heldIsCurrent`
              path it is the ONLY place the name appears — the buttons
              deliberately do not use it. Dropping it with the panes would have
              deleted the fact rather than moved it. */}
          {heldIsCurrent && heldBy && (
            <p className="text-xs text-channel mb-1">
              The section as it stands was last edited by @{heldBy}.
            </p>
          )}
          <PlanDiffSeries steps={series} expanded />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="plan-btn" onClick={() => onResolve('held')}>
              Keep {heldLabel}
            </button>
            {onStack && (
              <button
                type="button"
                className="plan-btn plan-btn--primary"
                data-testid="plan-collide-stack"
                onClick={onStack}
              >
                {heldIsCurrent ? `Fit ${nextLabel} onto it` : 'Keep both'}
              </button>
            )}
            <button type="button" className="plan-btn" onClick={() => setOwn(nextText)}>
              Write my own
            </button>
            <button
              type="button"
              className={onStack ? 'plan-btn' : 'plan-btn plan-btn--primary'}
              onClick={() => onResolve('next')}
            >
              Take {nextLabel}
            </button>
            {onCancel && (
              <button type="button" className="plan-btn" onClick={onCancel}>
                Decide later
              </button>
            )}
          </div>
          {/* WHAT EACH BUTTON COSTS, AND THE STACKING SENTENCE IS THE HONEST ONE
              RATHER THAN THE FLATTERING ONE. A fold lands both people's lines,
              and the folded-away proposal is still CLOSED — a note that landed
              inside somebody else's write is not left open — but it is closed
              carrying a reason that says so, rather than left to the server's
              `superseded by @x's proposal on the same section`, which would be
              false of a proposal whose text is in the document.
              THE SENTENCE NAMES NO STATUS WORD, AND THAT IS WHAT MAKES IT TRUE
              ON BOTH SERVERS. `NOTE_STATUSES` is six now and the sixth is
              `folded`, so a server that records folds closes the note `folded`
              and writes the reason itself; a server that does not still gets a
              `dismiss` row carrying the reason this client writes. Naming
              either word would be false against the other, so the sentence
              promises exactly their intersection — a close, with a reason, that
              says the text landed. THIS COMPONENT DOES NOT READ
              `records_folds`: taking the flag as a prop to pick a sentence
              would make a second read site of a capability flag, and one read
              is worth more than a sentence tuned per server.
              Saying so here at all is the point: this is the moment the user
              decides. */}
          {onStack && (
            <p className="text-xs text-channel mt-2" data-testid="plan-collide-stack-cost">
              <strong>Keep both</strong> fits {nextLabel} change onto {heldLabel} text, so both
              edits land in one write.{' '}
              {heldIsCurrent
                ? 'Nothing is discarded.'
                : `@${heldBy || 'the other author'}'s note is then closed carrying a reason that ` +
                  'says their text was folded into the section that landed — not that it was ' +
                  'dropped.'}
            </p>
          )}
          {!onStack && stackRefused && (
            <p className="text-xs text-channel mt-2" data-testid="plan-collide-stack-refused">
              {stackRefused}
            </p>
          )}
          <p className="text-xs text-channel mt-2">
            Taking one discards the other. Nothing is sent until you submit the tray, and the
            discarded proposal is closed as rejected with a reason — never as applied.
          </p>
        </>
      ) : (
        <>
          <label className="block text-xs font-semibold mb-1" htmlFor={`collide-own-${section}`}>
            Your reconciled text for <code>{section}</code>
          </label>
          <textarea
            id={`collide-own-${section}`}
            className="w-full h-48 font-mono text-xs rounded border border-border bg-sidebar p-2"
            value={own}
            spellCheck={false}
            onChange={(e) => setOwn(e.target.value)}
          />
          <div className="flex gap-2 mt-2">
            <button type="button" className="plan-btn" onClick={() => setOwn(null)}>
              Back
            </button>
            <button
              type="button"
              className="plan-btn plan-btn--primary"
              onClick={() => onResolve('own', own)}
            >
              Stage my text
            </button>
          </div>
        </>
      )}
    </div>
  )
}

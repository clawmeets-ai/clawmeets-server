import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { PlanDiff } from './PlanDiff'
import type { DiffStep } from './planDiffs'

/**
 * A NOTE'S DIFFS, IN THE ORDER THEY MATTER TO IT.
 *
 * ONE STEP RENDERS BARE, and that is the whole compatibility story. A lone,
 * un-contested, un-moved proposal produces a one-step series and this component
 * emits exactly what `{note.display_diff && <PlanDiff … />}` emitted before it
 * existed: no wrapper, no summary line, no toggle. That is ~95% of notes and
 * nothing about them moves.
 *
 * TWO OR MORE render the first bare and the rest behind ONE disclosure, closed,
 * labelled with what is inside it IN WORDS rather than as a count —
 * "@backend has also proposed a change here", not "2 more". The count is not
 * what a reader needs in order to decide whether to open it; the fact that
 * somebody else wants this same section is.
 *
 * `expanded` is for the collision control, where the comparison IS the question
 * being asked and hiding it behind a click would put the two candidates one
 * interaction further away than the panes it replaced.
 *
 * THE DISCLOSURE IS A `<button>` and not a `<div onClick>`: it is reachable by
 * keyboard, it announces its own state through `aria-expanded`, and it owns the
 * region it opens through `aria-controls`. A surface whose whole job is to stop
 * a decision being made blind cannot be one only a mouse can open.
 */
export function PlanDiffSeries({
  steps,
  expanded = false,
}: {
  steps: DiffStep[]
  expanded?: boolean
}) {
  const [open, setOpen] = useState(expanded)
  const regionId = useId()

  if (steps.length === 0) return null
  /* THE DECISION POINT SHOWS EVERYTHING, LABELLED, AND HAS NO HEAD STEP.
     A card has a diff — what this proposal does — and the rest is context. The
     collision control has no such privileged side: `collideSeries` returns the
     two directions of one question, and rendering either of them bare would be
     printing the case for one of two buttons in a larger font. */
  if (expanded) {
    return (
      <div className="plan-diff-series space-y-2 mb-3" data-testid="plan-diff-series">
        {steps.map((step, i) => (
          <Step key={`${step.kind}-${i}`} step={step} labelled />
        ))}
      </div>
    )
  }
  if (steps.length === 1) return <PlanDiff text={steps[0].diff} />

  const [head, ...rest] = steps
  return (
    <div className="plan-diff-series" data-testid="plan-diff-series">
      <Step step={head} />
      <button
        type="button"
        className="mt-1 flex items-center gap-1 text-xs text-amber-800 dark:text-amber-500 hover:underline"
        aria-expanded={open}
        aria-controls={regionId}
        data-testid="plan-diff-series-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          size={13}
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span>{summary(rest)}</span>
      </button>
      {open && (
        <div id={regionId} className="mt-1 space-y-2">
          {rest.map((step, i) => (
            <Step key={`${step.kind}-${step.noteId}-${i}`} step={step} labelled />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * WHAT IS BEHIND THE DISCLOSURE, SAID RATHER THAN COUNTED.
 *
 * Two facts can be in there and they are not equally surprising, so the rival
 * one is named first when both are: that a second agent wants this same section
 * is news, and it is the fact the old surface withheld until the user had
 * already clicked Accept on one of them.
 */
function summary(rest: DiffStep[]): string {
  const rivals = rest.filter((s) => s.kind === 'rival')
  const moved = rest.some((s) => s.kind === 'current')
  if (rivals.length > 0) {
    const names = rivals.map((s) => `@${s.by || 'someone else'}`)
    const who =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    const verb = names.length === 1 ? 'has' : 'have'
    return `${who} ${verb} also proposed a change to this section — see what taking theirs would do`
  }
  if (moved) return 'This section has moved — see it against the plan as it stands'
  return 'See the other comparisons'
}

/** One step: its heading when it needs one, its hint when it has one, and its
 *  `PlanDiff`. The head step is never labelled — it is the diff this card has
 *  always shown, and a heading over it would be a caption on the status quo. */
function Step({ step, labelled = false }: { step: DiffStep; labelled?: boolean }) {
  return (
    <div data-step-kind={step.kind}>
      {labelled && (
        <div className="text-xs font-semibold text-channel">{step.label}</div>
      )}
      {labelled && step.hint && (
        <p className="text-xs text-channel mb-1">{step.hint}</p>
      )}
      <PlanDiff text={step.diff} />
    </div>
  )
}

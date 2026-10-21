import { AlertTriangle } from 'lucide-react'
import type { PlanDensity } from './PlanEditor'

/**
 * THE ACCEPTANCE STRIP — A READOUT, AND NOTHING ELSE ON IT IS CLICKABLE.
 *
 * IT USED TO OWN BOTH DIRECTIONS AND NOW IT OWNS NEITHER. Confirming a plan is
 * **dismissing its confirm note** — the one note the server files at project
 * creation, addressed to the user, anchored to the document rather than to any
 * section. The user dismisses it in the comment list with the same Dismiss
 * every other note has. Revoking went the same way, one change earlier, and for
 * the same reason: it was a second door onto a decision that lives in the list,
 * three inches away, and the only one left standing after its partner had gone.
 *
 * THE POINTER PARAGRAPH IS GONE TOO, AND THAT IS WHAT THE CONFIRM NOTE'S OWN
 * WORDING BOUGHT. It read *"Work starts when you accept the approval note below
 * — it writes 'User approves the plan.' into this plan's Approval section"*:
 * three sentences of mechanism, above the fold, describing a control the reader
 * could not see from here. The note now says what dismissing it does, in its own
 * row, where the click is — so this strip is a readout with nothing left to
 * point at.
 *
 * SO THERE IS NO UNDO, AND THAT IS THE DESIGN RATHER THAN A GAP. An accepted
 * plan is not un-decided; it is renegotiated. A coordinator that wants to move
 * the spec is refused and its attempt filed as a **deviation note** the owner
 * applies, and applying it re-stamps the acceptance — so the chip below tracks
 * the document instead of freezing at the revision the go-note closed on. One
 * act, one place, in both directions and at every revision.
 *
 * WHICH IS WHY THE WARNING BELOW MEANS SOMETHING NOW. *"The plan changed since
 * approval"* fires on `spec_digest` drift away from `accepted_spec_digest`, and
 * since every owner-applied note re-stamps that digest, the one thing left that
 * can raise it is the owner editing the document directly. It says the plan
 * moved WITHOUT them, and it clears when they next sign something off.
 *
 * IT STATES THE ACCEPTANCE ONCE PER SCREEN, AND THE CALLER IS WHO KNOWS. On the
 * Plan tab this strip is the ONLY place acceptance is written down — the tab
 * header says "revision 4 · keeper · PLAN · N waiting on you" and never the
 * word — so it always renders there. On the desk card the band header one line
 * above has already printed `✓ accepted` AND `rev 4`, and those are the same
 * two numbers by construction: `planPill` answers 'accepted' only when
 * `accepted_revision === revision`. So the band passes `statedAbove` and the
 * chip stands down. The band reports what it rendered rather than this file
 * re-deriving it, because the pill rule lives there and a second copy of it
 * here is a second thing to keep in step.
 *
 * NO `projectId`, DELIBERATELY. It is the tell that this component posts
 * nothing: with no route to call there is no id to call it with, and a future
 * edit that needs one is an edit that is putting a control back.
 */
export function PlanAcceptance({
  accepted,
  acceptedRevision,
  changedSinceAcceptance,
  statedAbove = false,
  density,
}: {
  /** Read off the SAME `PlanIndex` the editor renders from — one query key, one
   *  request, so the label and the document can never disagree. */
  accepted: boolean
  acceptedRevision: number | null
  changedSinceAcceptance: boolean
  /** THE CALLER'S CHROME ALREADY CARRIES THIS FACT — set only by a mount that
   *  prints BOTH the word and the revision one line up, which today is the desk
   *  band and nothing else. Suppresses the ACCEPTED chip alone: in every other
   *  state the band above shows a DIFFERENT pill ('up to date', 'off-contract',
   *  'N for you') and the accepted revision is not up there to be repeated, so
   *  the chip has to survive or the number vanishes from the card entirely.
   *  NOT `density`, and the distinction is the whole point: density is how wide
   *  the mount is, this is what the mount RENDERED. Deriving one from the other
   *  would put "what exists" back in density's hands. */
  statedAbove?: boolean
  /** Layout only, the same contract as `PlanEditor`'s own `density`: the only
   *  reads are className branches. `density` must never decide what EXISTS. */
  density: PlanDensity
}) {
  const echoed = statedAbove && accepted
  // NOTHING LEFT TO SAY -> NO STRIP. `.plan-approve` carries its own padding and
  // a bottom rule, so rendering it childless trades the duplicate chip for a
  // stray horizontal line under the band header. The warning is the one thing
  // the caller above does NOT say, so it alone can keep the strip alive.
  if (echoed && !changedSinceAcceptance) return null

  return (
    <div
      className={'plan-approve' + (density === 'compact' ? ' plan-approve--compact' : '')}
      data-testid="plan-acceptance"
    >
      {/* The row is the chip alone. It keeps its wrapper and its `ml-auto`
          rather than collapsing into the parent, because the compact mount
          lays the strip out as a column and the chip has to stay right-aligned
          against a full-width row on both. */}
      {!echoed && (
        <div className="plan-approve-row">
          <span
            className={'plan-approve-chip ml-auto' + (accepted ? ' on' : '')}
            data-testid="plan-accepted"
          >
            {accepted ? `Accepted at revision ${acceptedRevision}` : 'Not accepted'}
          </span>
        </div>
      )}

      {changedSinceAcceptance && (
        <div className="plan-approve-warn" data-testid="plan-changed-since">
          <AlertTriangle size={13} /> The plan changed since approval.
        </div>
      )}
    </div>
  )
}

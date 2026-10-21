import { AlertTriangle, Shield } from 'lucide-react'
import type { PlanPhase, PlanSummary } from '../../api/endpoints/projectPlans'

/**
 * THE RENAME LIVES HERE AND NOWHERE ELSE.
 *
 * A PRESENTATION MAPPING of the server's stored phase, not a derivation: `id`
 * IS the stored token. It is never written back, never compared against a
 * client-side lifecycle value, and never renamed — step one is LABELLED "PLAN"
 * while the value on the wire and in storage stays `spec-ing`.
 *
 * Nothing computes a fourth vocabulary. The prototype's `window.mdStage` and
 * its "direct" token do not exist here and must not be reintroduced: three of
 * that helper's four inputs were never project lifecycle at all.
 *
 * Both surfaces that print a phase word import this const — the desk card's
 * rail and the Plan tab's chip — so the two cannot drift.
 */
export const PHASE_RAIL = [
  { id: 'spec-ing', label: 'PLAN', hint: 'your review' },
  { id: 'executing', label: 'EXECUTE', hint: 'building to the Plan' },
  { id: 'complete', label: 'REPORT', hint: 'outcome vs the Plan' },
] as const satisfies readonly { id: PlanPhase; label: string; hint: string }[]

/** The rail's label for a stored phase, or null when there is none to show.
 *
 *  `failed` is deliberately absent from `PHASE_RAIL` — it is not a step on the
 *  way to anywhere, it is the run stopping short of the Plan — so this returns
 *  null for it and callers say so in their own words. */
export function phaseLabel(phase: PlanPhase | null | undefined): string | null {
  return PHASE_RAIL.find((s) => s.id === phase)?.label ?? null
}

export interface PhaseRailProps {
  plan: PlanSummary | null
  /** The card's coordinator — the HOST on a front-desk shape. `PlanSummary`
   *  has no `host` member and must not grow one. */
  hostName?: string
  /** An open deviation reddens the EXECUTE hint. PASSED, never re-derived, so
   *  the deviation predicate is written once per card. */
  offContract: boolean
}

/**
 * The phase rail: whenever it renders it is the first element under the byline,
 * and it never moves. That is what makes an absent band read as an omission
 * rather than as a missing card.
 *
 * FIVE BRANCHES, DISJOINT — so no precedence is written, because none is needed:
 *
 *   0a  !plan                      nothing at all
 *   0b  surface === 'frontdesk'    "not yours" + the ownership line
 *   1   phase === 'failed'         "failed — the run stopped short of the Plan"
 *   2/3/4                          three steps off PHASE_RAIL, is-done/now/next
 *
 * `0a` RENDERS NOTHING on purpose. A DM has no plan and never will have one, so
 * there is no omission to report: a rail reading "none — no plan, no report"
 * described the shape of the card rather than anything the user could act on,
 * and every DM card in the feed carried the same dead line. Absence is only
 * worth printing where the thing could have been there — which is `0b`, where
 * a plan DOES exist on a project the requester does not own, so the line names
 * OWNERSHIP, the true thing the card knows, and never "no phase".
 *
 * The host's name comes from `hostName`, never from the summary. When it
 * resolves empty the possessive is DROPPED rather than faked, because
 * "@'s side" is worse than "the host's side".
 */
export function PhaseRail({ plan, hostName, offContract }: PhaseRailProps) {
  if (!plan) return null

  if (plan.surface === 'frontdesk') {
    return (
      <div data-testid="phase-rail" data-rail="frontdesk">
        <div className="md-stage md-stage--direct">
          <Shield size={11} />
          not yours
        </div>
        <div className="md-cs-def">
          {hostName
            ? `This project's plan is kept on @${hostName}'s side.`
            : "This project's plan is kept on the host's side."}
        </div>
      </div>
    )
  }

  if (plan.phase === 'failed') {
    return (
      <div className="md-stage md-stage--direct" data-testid="phase-rail" data-rail="failed">
        <AlertTriangle size={11} />
        failed — the run stopped short of the Plan
      </div>
    )
  }

  // `phase` is nullable on the wire. `findIndex` answers -1 for null and for any
  // token this client has not been taught, which renders every step `is-next` —
  // a rail that says "nothing has happened yet" rather than one that throws or
  // prints `undefined`.
  const at = PHASE_RAIL.findIndex((s) => s.id === plan.phase)

  return (
    <div className="md-stage" data-testid="phase-rail" data-rail={plan.phase ?? 'unknown'}>
      {PHASE_RAIL.map((step, i) => (
        <span
          key={step.id}
          className={'md-stage-s is-' + (i < at ? 'done' : i === at ? 'now' : 'next')}
        >
          <i />
          {step.label}
          {i === at && (
            <em className={offContract ? 'md-stage-warn' : undefined}>
              {offContract ? 'off-contract — your call' : step.hint}
            </em>
          )}
        </span>
      ))}
    </div>
  )
}

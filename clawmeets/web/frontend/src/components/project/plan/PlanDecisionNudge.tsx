import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  postPlanNudgeEvent,
  type PlanIndex,
  type PlanNudgeEvent,
} from '../../../api/endpoints/projectPlans'
import { useMyAgents } from '../../../hooks/useMyAgents'
import { useAuthStore } from '../../../stores/authStore'
import { agentDraftUrl } from '../../sidebar/dmPrefill'
import { findThoughtPartner } from '../../../utils/thoughtPartner'

/** Does this plan qualify for the nudge, before the roster is consulted? The
 *  flag must be exactly `true` (`null`, `false` and absent all mean no), the
 *  plan unaccepted, and the nudge not dismissed on this project. Exported so
 *  the Plan tab mounts the nudge — and fetches the roster — only when it can
 *  matter. */
export function isNudgeEligible(index: PlanIndex): boolean {
  return (
    index.accepted === false && index.decision === true && index.nudge?.dismissed_at === ''
  )
}

export const NUDGE_COPY = 'This looks like a decision. Want the thought_partner to grill you first?'

/**
 * The one-line decision nudge above the plan.
 *
 * SHOWN ONLY WHEN ALL OF: the coordinator flagged the request as a decision
 * (`decision === true` — `null`, `false` and absent all mean no), the plan is
 * not yet accepted, the user has not dismissed it on this project, and the user
 * owns an agent named exactly `thought_partner`. Everything else renders
 * nothing.
 *
 * IT NEVER TOUCHES THE PLAN FLOW. Grill me only opens the thought_partner's DM
 * with the project request typed into the composer — `?draft=`, never sent —
 * and the line stays up so a user who grilled and came back can go again.
 * Event posts are fire-and-forget; a failure is a console warning, never a
 * blocked plan.
 *
 * Events are first-occurrence stamps server-side, so `shown` / `held_back` go
 * out at most once per mount and only while their stamp is still empty.
 */
export function PlanDecisionNudge({
  projectId,
  request,
  index,
}: {
  projectId: string
  request: string
  index: PlanIndex
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const { data: myAgents, isLoading: agentsLoading } = useMyAgents()
  const [dismissed, setDismissed] = useState(false)
  const sent = useRef(new Set<PlanNudgeEvent>())

  const nudge = index.nudge
  const eligible = isNudgeEligible(index) && !dismissed
  /* Undecided until the roster has loaded: an empty list mid-fetch would read
     as "no thought_partner" and stamp `held_back` on a user who has one. */
  const rosterKnown = !!user && !agentsLoading
  const tp = rosterKnown ? findThoughtPartner(myAgents, user) : undefined

  const send = (event: PlanNudgeEvent) => {
    sent.current.add(event)
    postPlanNudgeEvent(projectId, event)
      .then((stamps) => {
        qc.setQueryData<PlanIndex | null>(['project-plan', projectId], (prev) =>
          prev ? { ...prev, nudge: stamps } : prev,
        )
      })
      .catch((e) => console.warn(`plan nudge: '${event}' event not recorded`, e))
  }

  useEffect(() => {
    if (!eligible || !rosterKnown || !nudge) return
    if (tp) {
      if (nudge.shown_at === '' && !sent.current.has('shown')) send('shown')
    } else if (nudge.held_back_at === '' && !sent.current.has('held_back')) {
      send('held_back')
    }
    // `send` is recreated each render; the `sent` guard makes re-runs a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, rosterKnown, tp, nudge?.shown_at, nudge?.held_back_at])

  if (!eligible || !tp) return null

  const grill = () => {
    send('accepted')
    navigate(agentDraftUrl(tp.name, request))
  }

  const dismiss = () => {
    setDismissed(true)
    send('dismissed')
  }

  return (
    <div
      className="mx-6 mt-3 flex items-center gap-3 rounded-md border border-accent-soft bg-accent-softer px-3 py-2 text-sm text-ink-1"
      role="note"
      data-testid="plan-decision-nudge"
    >
      <span className="flex-1">{NUDGE_COPY}</span>
      <button
        type="button"
        className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-accent-on hover:bg-accent-deep"
        onClick={grill}
        data-testid="plan-decision-nudge-grill"
      >
        Grill me
      </button>
      <button
        type="button"
        className="px-1 text-channel hover:text-ink-1"
        onClick={dismiss}
        aria-label="Dismiss"
        data-testid="plan-decision-nudge-dismiss"
      >
        ✕
      </button>
    </div>
  )
}

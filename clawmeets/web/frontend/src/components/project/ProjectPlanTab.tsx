import { useProjectPlan } from '../../hooks/useProjectPlan'
import { useProject } from '../../hooks/useProjects'
import Loading from '../common/Loading'
import { PlanEditor } from './plan/PlanEditor'
import { PlanDecisionNudge, isNudgeEligible } from './plan/PlanDecisionNudge'
import { openDeviation, openForYou } from './plan/planTrayLogic'
import './plan/plan.css'
import { phaseLabel } from '../desk/PhaseRail'
import IsolationUnavailablePanel from '../common/IsolationUnavailablePanel'
import { isIsolationUnavailable } from '../../utils/agentAccessCopy'

/**
 * The Plan tab — THE HEADER, and the editor mounted under it at `density="full"`.
 *
 * The body this file used to carry is now `plan/PlanEditor.tsx`, mounted here
 * and, at `density="compact"`, inside the desk card's PLAN band. ONE COMPONENT,
 * TWO MOUNTS: the two differ by `density` and nothing else, so the seven plan
 * routes, the one write funnel (`POST …/plan/review`) and the one status path
 * (`POST …/plan/notes/{id}/resolve`) are the same code on both surfaces rather
 * than two implementations kept in step by review.
 *
 * WHAT STAYS HERE IS THE HEADER'S NUMBERS — revision, keeper, phase,
 * waiting-on-you. The acceptance status strip USED to stay here too, as "the
 * one plan route the desk card deliberately does not offer", and it has moved
 * into `PlanEditor` (`plan/PlanAcceptance.tsx`). Two things overturned that
 * argument: the plan editor is where the plan is READ, and deleting the desk
 * card's `Open the full Plan` button took away its one-click route to this tab —
 * so a reader there could edit a plan, comment on it and submit a review batch
 * but not see whether it was accepted.
 *
 * The old reasoning is answered rather than erased. Deciding on a plan IS an act
 * on the project rather than an edit inside it — which is exactly why the strip
 * sits outside the tray and outside the note action bar, not why it had to live
 * on a different screen.
 *
 * NEITHER HALF IS ANYWHERE ANY MORE. Accepting a plan is accepting its go-note,
 * in the tray, with the same Accept every other proposal note has; changing an
 * accepted plan is applying the next note, which re-signs it. The strip carries
 * the readout and nothing else — it posts nothing at all.
 *
 * THE HEADER'S ACCEPTANCE COPY WENT WITH IT — the chip, the button and the
 * "changed since approval" warning — so that the acceptance state is stated
 * ONCE on any one screen. The editor mounts directly below this header, and two
 * readings of the same fact one above the other is worse than none.
 *
 * EVERY NUMBER HERE IS READ, NEVER DERIVED TWICE. `useProjectPlan` is the same
 * query key the editor below uses, so the header and the body share one cache
 * entry and one request — and both move together when a resolve invalidates it,
 * which is what `PlanBand.test.tsx`'s C1 parity assertion drives through.
 *
 * It reads two payloads, and that is not an accident of implementation: the
 * document and its notes are `PlanIndex`, and the lifecycle `phase` is on
 * `PlanSummary`, which hangs on the project record. Two payloads, one screen.
 */
export function ProjectPlanTab({ projectId, active }: { projectId: string; active: boolean }) {
  const { data: index, isLoading, error } = useProjectPlan(projectId)
  const { data: project } = useProject(projectId)

  if (isLoading) return <Loading />
  if (isIsolationUnavailable(error)) return <IsolationUnavailablePanel />
  if (error) {
    return <div className="p-6 text-sm text-channel">The plan could not be loaded.</div>
  }
  if (!index) {
    return (
      <div className="p-6 text-sm text-channel">
        This project has no plan. A plan lives in <code>PLAN.md</code> in
        <code> shared-context</code>; the coordinator writes the first one.
      </div>
    )
  }

  const forYou = openForYou(index.notes)
  /* OFF THE SAME ARRAY the line above reads, so the header's own claim — every
     number here is READ, never derived twice — stays literally true and this
     tab does not start reading `PlanSummary` for a fact `PlanIndex` already
     carries. `openDeviation` is written to the rule the server uses to build
     `PlanSummary.deviation`, which is what the desk card's chip reads, so the
     two surfaces cannot disagree about whether the work is off-contract. */
  const offContract = !!openDeviation(index.notes)
  const phase = project?.plan?.phase
  const rail = phaseLabel(phase)

  return (
    <div className="plan-tab flex flex-col h-full" data-testid="project-plan-tab">
      {/* Header — every number here is READ, never derived twice. */}
      <div className="px-6 pt-4 pb-3 border-b border-border">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-extrabold uppercase tracking-wider text-xs text-channel">
            Plan
          </span>
          <span className="text-channel" data-testid="plan-revision">
            revision {index.revision}
          </span>
          {index.keeper && <span className="text-channel">keeper @{index.keeper}</span>}
          {/* `phase` lives on the project record, not on this payload, and it
              is null on a front-desk shape — so it is null-CHECKED, never
              switched on as though it were always a string.
              THE LABEL COMES FROM `PHASE_RAIL`, the desk rail's const, so this
              chip and the card's rail cannot drift into two words for one
              phase. The stored token is never printed and never written back:
              `spec-ing` reads "PLAN" here and stays `spec-ing` on the wire.

              N3 — `failed` IS NOT AN ABSENT PHASE. `phaseLabel` answers null
              for it deliberately: `failed` is not a step on the way anywhere,
              so it is not in `PHASE_RAIL`, and callers "say so in their own
              words". This chip previously said nothing at all, so the one
              lifecycle state the user most needs to see on the Plan tab was the
              one that rendered as blank space — mitigated only by the project
              status badge two components away in `ProjectView`. It now has its
              own copy and its own tone, matching `PhaseRail`'s failed branch in
              meaning without importing its sentence: the rail is a rail, this
              is a chip. Only a phase that is genuinely absent — no plan, or a
              front-desk shape — still renders nothing. */}
          {rail && (
            <span className="text-xs text-channel" data-testid="plan-phase">
              {rail}
            </span>
          )}
          {phase === 'failed' && (
            <span
              className="text-xs rounded-full px-2 py-0.5 bg-rose-500/15 text-rose-700 dark:text-rose-400"
              data-testid="plan-phase-failed"
            >
              FAILED — the run stopped short of the Plan
            </span>
          )}
          {/* OFF-CONTRACT AND THE COUNT ARE BOTH SHOWN when both are true,
              the same way the desk card shows them: they say different things,
              and collapsing them would hide the integer the execution gate
              reads behind an alarm word. Two chips, never one sum — and this
              chip adds NOTHING to `forYou`, because the deviation it names is
              already one of the notes that count.
              The alarm itself is the editor's, below, where the note that
              needs deciding is; this is the header's word for the same fact. */}
          <span className="ml-auto flex items-center gap-3">
            {offContract && (
              <span
                className="text-xs rounded-full px-2 py-0.5 bg-rose-500/15 text-rose-700 dark:text-rose-400"
                data-testid="plan-tab-offcontract"
              >
                off-contract
              </span>
            )}
            <span className="text-xs text-channel" data-testid="plan-open-for-you">
              {forYou} waiting on you
            </span>
          </span>
        </div>
      </div>

      {/* The decision nudge — Plan tab only, never the desk card's band. It
          renders nothing unless the plan is an unaccepted decision AND the
          user owns a thought_partner, and it posts nothing the plan reads. */}
      {project && isNudgeEligible(index) && (
        <PlanDecisionNudge projectId={projectId} request={project.request} index={index} />
      )}

      {/* MOUNT ONE OF TWO. The other is the desk card's PLAN band, at
          `density="compact"`. Nothing else differs between them. */}
      <PlanEditor projectId={projectId} density="full" active={active} />
    </div>
  )
}

export default ProjectPlanTab

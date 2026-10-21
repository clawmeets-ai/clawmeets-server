import { Check } from 'lucide-react'
import { type PlanSummary } from '../../api/endpoints/projectPlans'
import { isGated, planPill } from './deskBands'
import { PlanEditor, type PlanSendState } from '../project/plan/PlanEditor'
import '../project/plan/plan.css'

/**
 * The PLAN band's contents — what renders inside `CardBand` when the band is
 * expanded. The band SHELL (fold row, label, tone) is `CardBand`'s; the plan's
 * status, its deviation and its release control are this component's, so there
 * is one owner for everything the plan says about itself.
 *
 * THE ONE INTEGER. `plan.open_notes_for_you` is READ, not derived, and nothing
 * is added to it. The open deviation is ALREADY INSIDE IT — the server's one
 * filter counts every open note addressed to the user and a deviation is one of
 * those — so a `+ (deviation ? 1 : 0)` here double-counts the number the
 * execution gate reads. That is a defeated guard, not a miscount, which is why
 * there is deliberately no expression in this file combining `deviation` with
 * `openForYou` arithmetically.
 *
 * THE DEVIATION CALLOUT IS NO LONGER THIS FILE'S. It moved into `PlanEditor`
 * as `PlanDeviation`, mounted below, so the project Plan tab — which mounts the
 * same editor — gets the alarm too. The tab had none: its header said
 * `N waiting on you` and nothing said one of those N was the work going
 * off-contract or where it pointed. Copying the callout into the tab would have
 * been two implementations of one alarm; moving it down gives both mounts the
 * alarm, and the open-on-its-section behaviour beside it, from one piece of
 * code. This band stops reading `plan.deviation` entirely — the `off-contract`
 * chip below goes through `planPill`, which already reads it — and sheds the
 * `coordinatorName` prop that existed only to name the raiser of a note whose
 * author was blank. The editor answers that from `index.keeper`, which it
 * already holds.
 *
 * PRESENCE IS THE PREDICATE, wherever the fact is read. The server only ever
 * puts an open deviation on the summary and `Deviation` carries no `status`, so
 * `plan.deviation.status === 'open'` is `undefined === 'open'` — an alarm that
 * silently never renders. `openDeviation`, the editor's selector, is written to
 * the same rule the server uses.
 *
 * Renders NOTHING on a front-desk shape: there is no user in the accepting role
 * there, four of `PlanSummary`'s seven members are null in consequence, and the
 * requester sees no plan surface at all.
 *
 * The raw `spec-ing` token is no longer printed here. The phase word the user
 * reads is the rail's, one line up, from `PHASE_RAIL` — one rename site, and
 * the stored token is untouched on the wire and in storage.
 *
 * MOUNT TWO OF TWO. The editor below is the SAME COMPONENT the project Plan tab
 * renders, at `density="compact"`. Not a desk variant and not a subset: every
 * write path, every route and every guard is the same code, so the desk adds no
 * second write funnel and no second status path — there is no second code path
 * for one to be added to. `density` changes layout and nothing else.
 *
 * IT MOUNTS ONLY WHILE THE BAND IS EXPANDED. `CardBand` renders no children
 * while folded, and `expanded` is threaded down so the editor is genuinely
 * unmounted rather than merely hidden. THE BOUND IS PER CARD, not per desk: a
 * folded band costs no `GET …/plan` and an expanded one costs at most one, so
 * the desk's cost is one request per card whose PLAN band is open — not one per
 * plan-bearing card rendered. Each card is a distinct project and therefore a
 * distinct query key, so twelve `spec-ing` projects do fire twelve requests,
 * because `defaultOpenBands` answers `'plan'` for every one of them. What the
 * unmount buys is that the folded eleven-twelfths cost nothing, and that is the
 * whole of the mitigation. `useProjectPlan` also sets `staleTime: 0`, so each
 * mount refetches: fold and unfold three times and that is three requests.
 * That invariant is also why `openSignal` is a counter.
 */
export function PlanBand({
  plan,
  projectId,
  expanded = true,
  openSignal,
  onSendState,
}: {
  plan: PlanSummary | null | undefined
  projectId: string
  /** The band is expanded — and therefore the editor MOUNTS. A folded band
   *  costs no `GET …/plan`, which is the whole request-cost design. Defaults
   *  true so the component stays renderable on its own, as `PlanBand.test.tsx`
   *  renders it. */
  expanded?: boolean
  /** A COUNTER, forwarded to the editor, which reads it on mount. */
  openSignal?: number
  /** PASSED STRAIGHT THROUGH TO THE EDITOR, and its presence is what tells the
   *  editor the CARD is drawing the Send. This band adds nothing to it and
   *  reads none of it: the batch belongs to the editor and the action row
   *  belongs to `UpdateCard`, and this component sits between them without
   *  becoming a third owner of either. Omitted ⇒ the editor keeps its own Send,
   *  which is what `PlanBand.test.tsx` renders. */
  onSendState?: (state: PlanSendState | null) => void
}) {
  if (!plan) return null
  if (plan.surface === 'frontdesk') return null

  const openForYou = plan.open_notes_for_you
  const pill = planPill(plan)
  const gated = isGated(plan)

  /* N9 / C1 — AND THERE IS NO STATUS PATH ON THIS FILE AT ALL NOW.
   *
   * `resolve` used to live here: the deviation callout's two buttons POSTed
   * `…/plan/notes/{id}/resolve` on the click, then invalidated and refetched.
   * It was the last place in the tree where something about a note reached a
   * route before `Send review`, and change 9's rule — nothing about a note
   * happens on the click — did not have an exception for it. M2 emptied the
   * note row; this empties the card.
   *
   * WHAT REPLACED IT IS NOT A SECOND STAGING PATH, AND THAT IS THE DESIGN. The
   * tray lives inside `PlanEditor`, which this band mounts twenty lines below;
   * for these buttons to STAGE they would have had to reach `PUT /plan/draft`
   * from here, and a second write funnel from the card is the one thing this
   * component's own header forbids ("the desk adds no second write funnel …
   * there is no second code path to police"). So the callout stopped being a
   * control and went back to being an ALARM: it says a deviation is open and
   * where it is, and the note itself — already rendered by the editor below,
   * already carrying `Accept`, `Reject`, `Reply` and `Dismiss`, all of which
   * stage — is where it is decided. `initialSection` was ALREADY the
   * deviation's own section, so the editor already opens on it; the note the
   * user is sent to is on screen when they arrive rather than a scroll away —
   * and now on the Plan tab as well, because the editor seeds its own pane from
   * the deviation instead of being told which section to open by this caller.
   *
   * WHAT THIS COSTS, STATED RATHER THAN GLOSSED: two clicks become three, and
   * `apply` with `force` is no longer reachable from the desk. Neither is a
   * capability loss. `Accept` stages the same proposal and `submit_review`
   * applies it in the same transaction as the write (AC-2.10's finding, which
   * this is the last instance of), and the stale case surfaces as a tray row
   * and a 409 on submit exactly as it does for every other note. The button
   * that is gone was in one way strictly worse than what replaced it: it was
   * rendered unconditionally, while the server 409s `apply` on a note carrying
   * no proposal — so "Accept — move the contract" on a proposal-less deviation
   * was an error message with a label on it. The staged path offers `Accept`
   * only when there is a proposal to accept.
   */

  return (
    <div className="plan-band text-xs" data-testid="plan-band" data-project-id={projectId}>
      <div className="md-cs-h">
        {/* Off-contract and the count are BOTH shown when both are true: they
            say different things, and collapsing them would hide the integer
            the execution gate reads behind an alarm word. They are two chips,
            never one sum. */}
        {pill.kind === 'deviation' && (
          <span className="md-cs-tag md-cs-tag--warn" data-testid="plan-band-offcontract">
            off-contract
          </span>
        )}
        {openForYou > 0 && (
          <span className="md-cs-tag" data-testid="plan-band-count">
            {openForYou} for you
          </span>
        )}
        {pill.kind === 'accepted' && (
          <span className="md-cs-ok">
            <Check size={10} />
            accepted
          </span>
        )}
        {pill.kind === 'uptodate' && <span className="md-cs-ok md-cs-ok--neutral">up to date</span>}
        <span className="md-cs-line" />
        {/* `revision` is null on a front-desk shape — where this component has
            already returned — but it is still null-CHECKED rather than printed,
            because the wire types it nullable and a client that prints it raw
            renders "rev null" the day the shape widens. */}
        {plan.revision !== null && <span className="md-cs-rev mono">rev {plan.revision}</span>}
      </div>

      {/* The held line. It names the USER'S OBLIGATION and does not assert that
          the server is refusing work: this card's `isGated` is deliberately a
          superset of the server's execution gate, which carries a fourth
          conjunct (`_shared_context_has_peer`) reading state the desk payload
          does not carry. Saying "work is held" here was wrong inside that
          window; saying what is waiting on whom is true in all of it. */}
      {gated && (
        <div className="md-cs-held" data-testid="plan-band-gated">
          Waiting on your answer.
        </div>
      )}

      {/* THE EDITOR, AND NOW THE WHOLE OF WHAT THIS BAND OFFERS. `Open the full
          Plan` used to sit above it and NAVIGATE to `…?tab=plan`, unmounting the
          card and taking the user out of the desk. It was redundant on every
          card that could invoke it — its own condition was `'spec-ing' || gated`
          and `defaultOpenBands` answers `'plan'` for both, so the editor was
          already mounted directly below the button on 100% of them — and the one
          thing the tab still had that this band did not was the acceptance
          strip, which now renders inside `PlanEditor` at both densities.
          Same component as the Plan tab's, one prop different — `density`, and
          `density` alone now that `initialSection` is gone. The editor renders
          the deviation alarm and opens on the deviation's own section itself,
          off the notes it already holds, so this band neither passes that
          section down nor re-derives it. */}
      {expanded && (
        <PlanEditor
          projectId={projectId}
          density="compact"
          openSignal={openSignal}
          /* WHAT THIS HEADER ALREADY SAID, HANDED DOWN AS A FACT RATHER THAN
             RE-DERIVED. `planPill` answers 'accepted' only when
             `accepted_revision === revision`, and the row above prints
             `rev {revision}` beside it — so the strip inside the editor would be
             repeating BOTH numbers, one line down. It is passed only in that
             state: under every other pill ('up to date', 'off-contract',
             'N for you') the accepted revision is nowhere in this header and the
             strip is the only thing on the card that carries it. */
          acceptanceStatedAbove={pill.kind === 'accepted'}
          /* ONE SEND PER CARD. When the card gives us a reporter it is because
             its own footer draws the primary, so the tray's Send stands down —
             see `PlanEditor`'s `sendHostedByCaller`, and note that it is keyed
             on what the caller RENDERS and not on `density`. */
          sendHostedByCaller={!!onSendState}
          onSendState={onSendState}
        />
      )}
    </div>
  )
}

import type { PlanSummary } from '../../api/endpoints/projectPlans'

/**
 * The desk card's band layout, as pure functions.
 *
 * No JSX, no hooks, no fetches — so the decision table this file implements is
 * unit-testable without a DOM, and the invariants live in ONE place rather than
 * scattered through a render tree.
 */

export type BandId = 'report' | 'plan' | 'response'
export type BandTone = 'plain' | 'attn' | 'warn'

/**
 * The user's FIXED order, top to bottom, and the only place it is written.
 *
 * Fixed means fixed RELATIVE order — report above plan above response. An
 * absent band is an OMITTED ROW, never a placeholder: not-yet-complete is the
 * majority state of every card on the desk, so a placeholder would cost a row
 * of vertical space on nearly every card permanently while saying nothing the
 * rail's third step (`is-next`, grey, un-filled) does not already say one line
 * up. The rail is the fixed thing; that is what makes an omission read as an
 * omission rather than as a broken card.
 */
export const BAND_ORDER = ['report', 'plan', 'response'] as const satisfies readonly BandId[]

/**
 * What the band layout reads off a desk update. Structural, so `DeskUpdate`
 * satisfies it without this module importing the hook's whole surface — and so
 * the test can state a case in two members instead of fifteen.
 *
 * `reportPublishedAt` is a PASS-THROUGH of a value the project list already
 * carries (`useDeskUpdates`' `Candidate`), forwarded onto `DeskUpdate` so the
 * report band can be present without a per-card request. It is not a new field
 * on the wire and nothing here derives it.
 */
export interface BandInput {
  plan: PlanSummary | null
  reportPublishedAt: string | null
  /** The newest message is the user's own (`DeskUpdate.quoteIsYours`). Absent ⇒
   *  the agent spoke last. */
  quoteIsYours?: boolean
}

/**
 * Which bands EXIST on this card, in `BAND_ORDER`.
 *
 *   report   iff  a real completion report exists
 *   plan     iff  the project has a plan AND the shape is not front-desk
 *   response iff  always — which is what makes `defaultOpenBands` never empty
 *
 * A front-desk shape gets no plan band, no pill, no count and no primary, and
 * that is tested on `surface` DIRECTLY. Never through a shared "is this
 * DM-shaped" helper: that predicate answers true for BOTH `dm` and `frontdesk`,
 * so a branch built on it would look like it named the two shapes while
 * actually collapsing them into one — the exact defect the reconciled design
 * was written to remove.
 *
 * The report band gates on `reportPublishedAt` ALONE, which is the same fact
 * the shipped report lane gates on (`useDeskUpdates`). It deliberately does NOT
 * also require `phase === 'complete'`: a real report implies a completed
 * project, so on a plan-bearing card the extra conjunct is redundant — and on a
 * plan-LESS one (a pre-feature project with no PLAN.md) it is worse than
 * redundant, because it would hide a report the desk renders today.
 */
export function bandsPresent(item: BandInput): BandId[] {
  const plan = item.plan
  return BAND_ORDER.filter((id) => {
    if (id === 'report') return item.reportPublishedAt != null
    if (id === 'plan') return plan != null && plan.surface !== 'frontdesk'
    return true
  })
}

/**
 * Which bands open on first render — AT MOST ONE FETCHING band (report or
 * plan), plus RESPONSE whenever a report is present. Position is the user's
 * (fixed); attention still chooses what is open.
 *
 *   deviation, any phase          -> plan               the alarm; the ONE override
 *   phase 'spec-ing', for you     -> plan               the plan is what is waiting on you
 *   phase 'spec-ing', you spoke   -> plan               the response band would only echo you
 *   phase 'spec-ing', agent spoke -> response           0 for you: the agent's message is the question
 *   phase 'executing', gated      -> plan               the release control is in that band
 *   phase 'executing', 0 for you  -> response           the agent's message is the live thing
 *   phase 'complete'              -> report + response  the outcome, and the agent's last word on it
 *   phase 'failed'                -> response           the last message says what stopped
 *   no plan (a DM)                -> response           the only band present
 *   surface 'frontdesk'           -> response           no plan band renders at all
 *
 * The cap is on FETCHING bands, not on bands: report and plan each fire a
 * request when expanded, and a desk of cards each opening two would double the
 * load. RESPONSE renders the message text the card already holds, so opening it
 * alongside the report costs nothing — and a freshly published report is new
 * information the user wants next to the message that announced it.
 * `deskBands.test.ts` asserts across every row above that every id returned is
 * in `bandsPresent` and that report and plan never open together. Every
 * plan-side arm is therefore guarded on the plan band actually being present:
 * an open deviation on a front-desk summary must not open a band that does not
 * render.
 *
 * Never empty: `response` is always present, so there is no empty arm to handle.
 */
export function defaultOpenBands(item: BandInput): BandId[] {
  const present = bandsPresent(item)
  const plan = item.plan
  const hasReport = present.includes('report')

  if (present.includes('plan') && plan) {
    if (plan.deviation) return ['plan']
    if (plan.phase === 'spec-ing') {
      // Nothing for you on the plan and the agent spoke last: its message is the open question.
      return plan.open_notes_for_you === 0 && !item.quoteIsYours ? ['response'] : ['plan']
    }
    if (plan.phase === 'executing') return isGated(plan) ? ['plan'] : ['response']
    if (plan.phase === 'complete') return hasReport ? ['report', 'response'] : ['plan']
    if (plan.phase === 'failed') return ['response']
  }
  return hasReport ? ['report', 'response'] : ['response']
}

/**
 * THE GATED STATE, NAMED ONCE.
 *
 *     surface === 'regular' && phase === 'executing' && open_notes_for_you > 0
 *
 * There is no `halted` member on the wire and this file must not invent one: a
 * third name for one fact is how two names for it drift apart. The caller uses
 * it for exactly two things — suppress the live meter, and show the release
 * control.
 *
 * IT IS THE CARD'S DISPLAY PREDICATE, NOT THE SERVER'S REFUSAL.
 * `clawmeets/models/agent.py::_plan_execution_blocked` carries a FOURTH
 * conjunct, `_shared_context_has_peer` — Q12's stand-down window, which lets a
 * project whose `shared-context` still holds the coordinator alone open ONE
 * workroom while otherwise blocked. That conjunct reads a chatroom's
 * participant list, which `PlanSummary`'s seven members do not carry and which
 * this file must not go looking for: deriving a fact the server owns is the
 * defect this whole surface was rewritten to remove, and THIS is the derivation
 * that would gate whether work may start.
 *
 * So the predicate here is deliberately a SUPERSET of the server's, and the
 * copy it drives is written to stay true across the difference: the card states
 * the user's obligation ("Waiting on your answer") and never asserts that the
 * server is currently refusing work. `deskBands.test.ts` pins that divergent
 * window by name.
 */
export function isGated(plan: PlanSummary | null): boolean {
  if (!plan) return false
  return plan.surface === 'regular' && plan.phase === 'executing' && plan.open_notes_for_you > 0
}

/** Which status the Plan band's pill reports. Disjoint, in this precedence. */
export type PlanPillKind = 'deviation' | 'count' | 'accepted' | 'uptodate'

/**
 * The Plan band's status pill. FOUR outcomes:
 *
 *   deviation                                  -> 'off-contract'  warn  (red)
 *   open_notes_for_you > 0                     -> `${n} for you`  attn
 *   accepted && accepted_revision === revision -> 'accepted'      plain
 *   otherwise                                  -> 'up to date'    plain
 *
 * The third arm is the whole reason `accepted_revision` is on the wire: without
 * it you cannot tell accepted from accepted-then-edited.
 *
 * NOTHING IN THIS FUNCTION ADDS TO `open_notes_for_you`. The open deviation is
 * ALREADY INSIDE that integer — it is a note, addressed to the user, drawn from
 * the same set — so a `+ (deviation ? 1 : 0)` double-counts the number the
 * server's execution gate reads. That is a defeated guard, not a mis-drawn
 * badge, which is why there is deliberately no expression anywhere in this file
 * combining `deviation` with the count arithmetically.
 *
 * `kind` rather than a matched string is what lets the band render the count
 * chip ALONGSIDE the off-contract pill: with a deviation open, both facts are
 * true and the count is still the count.
 */
export function planPill(plan: PlanSummary): { kind: PlanPillKind; text: string; tone: BandTone } {
  if (plan.deviation) return { kind: 'deviation', text: 'off-contract', tone: 'warn' }
  if (plan.open_notes_for_you > 0) {
    return { kind: 'count', text: `${plan.open_notes_for_you} for you`, tone: 'attn' }
  }
  if (plan.accepted === true && plan.accepted_revision === plan.revision) {
    return { kind: 'accepted', text: 'accepted', tone: 'plain' }
  }
  return { kind: 'uptodate', text: 'up to date', tone: 'plain' }
}

/**
 * The FOLDED Plan row: the one meta line, its CTA, and its tone.
 *
 *   warn  -> 'the work deviates from what was agreed'        · 'Review deviation'
 *   attn  -> `${n} changes waiting on you`                   · 'Review'
 *   attn  -> `rev ${n} · awaiting your acceptance`           · 'Review & accept'
 *   plain -> `rev ${n} · accepted — agents are held to it`   · 'Open contract'
 *         -> `rev ${n} · up to date — agents are held to it`
 *
 * The acceptance arm exists because the Accept button lives INSIDE the band: when
 * `defaultOpenBands` folds an unaccepted plan in favour of the response, this row
 * is the only thing left saying work cannot start yet — and "agents are held to
 * it" would be false before acceptance.
 *
 * `revision` is null on a front-desk shape — where no plan band renders at all —
 * so it is null-CHECKED here rather than interpolated, because the wire types it
 * nullable and a client that prints it raw renders "rev null" the day the shape
 * widens.
 */
export function planFoldMeta(plan: PlanSummary): { meta: string; cta: string; tone: BandTone } {
  const pill = planPill(plan)
  if (pill.kind === 'deviation') {
    return { meta: 'the work deviates from what was agreed', cta: 'Review deviation', tone: 'warn' }
  }
  if (pill.kind === 'count') {
    const n = plan.open_notes_for_you
    return { meta: `${n} change${n === 1 ? '' : 's'} waiting on you`, cta: 'Review', tone: 'attn' }
  }
  const rev = plan.revision !== null ? `rev ${plan.revision} · ` : ''
  if (plan.phase === 'spec-ing' && plan.accepted !== true) {
    return { meta: `${rev}awaiting your acceptance`, cta: 'Review & accept', tone: 'attn' }
  }
  return {
    meta: `${rev}${pill.text} — agents are held to it`,
    cta: 'Open contract',
    tone: 'plain',
  }
}

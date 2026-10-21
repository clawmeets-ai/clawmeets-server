import { PLAN_LIMITS, type PlanNote } from '../../../api/endpoints/projectPlans'
import { addressees, type TrayRow } from './planTrayLogic'

/**
 * THE SEND BAR. Everything staged, nothing sent — and it no longer draws the
 * items, because a decision belongs on the comment it decides.
 *
 * IT USED TO DRAW THE BATCH TWICE. Every staged row was a line here, and the
 * comment that row was about was a card in the pane; deciding a note meant
 * reading it in one place and undoing it in another. The rows moved up into
 * `PlanCommentList`, where each one sits on its own comment with the chip that
 * names the decision and the ✕ that takes it back. What is left here is what is
 * genuinely BATCH-level and belongs to no single comment: the count, who it
 * reaches, the two caps, Discard, and — on the mount that has nowhere else to
 * put it — the one Send.
 *
 * THE BATCH-COMMENT TEXTAREA IS GONE, AND THE SPACE IS THE POINT. *"A word to
 * go with the batch (optional)"* asked for a covering note on a surface where
 * the user can already edit the plan inline and comment on any paragraph, so
 * everything it could carry had a better home one row up. It cost 64px of a
 * footer that eats most of the list's height budget — dropping it is what let
 * `--cl-max` come down to 256px and still show MORE rows than before.
 *
 * `batch_comment` STAYS ON THE WIRE and `plan review --batch-comment` keeps
 * working: an agent's round can still carry a covering line, and that line is
 * still what renders under a revision in Plan History. Only the browser stops
 * offering to write one — so the history line is conditional and renders
 * nothing rather than an empty row on a round the user sent.
 *
 * `showSend` IS WHO RENDERS THE PRIMARY, AND IT IS NOT `density`. On the Plan
 * tab this bar is the bottom of the screen and owns the Send. On the desk card
 * the card's own footer is the only place a primary action ever appears, so the
 * card hosts it and this bar renders none — two Sends on one card is the thing
 * that rule exists to prevent. It is a statement about what the CALLER
 * RENDERED, in the same spirit as `PlanAcceptance`'s `statedAbove`, and
 * deliberately not a width branch.
 *
 * IT STILL READS `rows` AND `pending`, and it must. The count is one number
 * over both, the addressees are computed from both, and the row cap is a fact
 * about `rows` — those are questions about the BATCH, which is this component's
 * subject, not questions about any one item.
 *
 * The count of rows is not the count of revisions: one submit is ONE revision
 * regardless of how many rows carry text, and a submit of only rejections and
 * asks increments the revision by ZERO and appends no write at all. This
 * component predicts neither — the number it shows after a submit comes back
 * from the server, because the batch IS the revisioning act and a client that
 * guesses the next number is wrong exactly when it matters.
 */
export function PlanTray({
  rows,
  pending,
  notes,
  openNotes,
  room,
  submitting,
  showSend = true,
  onSubmit,
  onDiscard,
}: {
  rows: TrayRow[]
  /** Comments you filed that have not gone out. NOT rows: no `base`, no section
   *  text, nothing to supersede. They ride the same Send. */
  pending: PlanNote[]
  notes: PlanNote[]
  /** How many notes on this plan are OPEN right now. Read off the index, not
   *  recounted from anything this component holds. */
  openNotes: number
  room: string
  submitting: boolean
  /** Render the Send button here. False on a mount whose own chrome carries
   *  the primary — the desk card's footer — so there is exactly one Send per
   *  card. Defaults true: the Plan tab has nowhere else to put it. */
  showSend?: boolean
  onSubmit: () => void
  onDiscard: () => void
}) {
  if (rows.length === 0 && pending.length === 0) return null
  const to = addressees(rows, notes, pending)
  const count = rows.length + pending.length
  // A ROW cap, still. It is the server's `draft.entries` limit and a note is
  // not an entry — a tray holding only notes can never be full.
  const full = rows.length >= PLAN_LIMITS.draftEntries
  /** THE OPEN-NOTE CEILING, PRE-EMPTED RATHER THAN DISCOVERED — the same thing
   *  `PLAN_LIMITS` does for every other cap, and change 9 is why this one needs
   *  it now. Every other limit is checked PER ITEM; this is the only budget the
   *  server sums across the whole transaction, and it refuses the batch WHOLE.
   *
   *  A staged reply is the row that costs against it: it files a new open note
   *  while the parent deliberately stays open, so it ADDS one where a
   *  resolve-as-you-reply subtracted one. Nothing is subtracted here for the
   *  decisions that close notes, and that is deliberate rather than lazy — it is
   *  what the server counts, so a warning that netted them off would promise
   *  room the submit will not find. The `413` handler upstream stays as the
   *  backstop for the race where someone else's batch lands first. */
  const wouldOpen = rows.filter((r) => r.kind === 'ask' && !r.superseded_by).length
  const overOpenCap = openNotes + wouldOpen > PLAN_LIMITS.openNotes

  return (
    // `shrink-0` SO THE SEND ROW IS NEVER THE THING THAT GIVES WAY. It is a
    // child of a flex column — `.plan-cl`'s, now, rather than `.plan-editor`'s,
    // which changes the parent and not one word of the reason. Without it, any
    // negative free space in that column is taken partly from here, the tray
    // renders shorter than its content, and what spills past the bottom is the
    // row at the end of this file. It is safe against the opposite failure because
    // NOTHING HERE GROWS WITH THE BATCH any more: the item list — the one part
    // that did, capped at `max-h-56` for exactly that reason — is now
    // `PlanCommentList` above the pane, bounded there. What is left is fixed
    // copy, two conditional warnings and an `h-14` textarea, so a tray holding
    // two hundred rows is the same height as one holding one.
    // It is also no longer true that nothing here is variable-height: the
    // `h-14` textarea went with the batch comment, so what is left is fixed
    // copy, two conditional warnings and one row — SHORTER than the version
    // this paragraph was written about, never taller.
    // AND NO BACKGROUND OF ITS OWN any more: `.plan-cl` supplies one, and under
    // `--alarm` it supplies a red one. See `.plan-cl-foot .plan-tray` in
    // `plan.css` for why this bar stays neutral even then — the red belongs to
    // the deviation ROW, and a red Send bar reads as a warning about sending.
    <div
      className="plan-tray shrink-0 border-t border-border p-3"
      data-testid="plan-tray"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-extrabold uppercase tracking-wider text-channel">
          Ready to send · {count} item{count === 1 ? '' : 's'}
        </div>
        {/* DISABLED WHILE A SUBMIT IS IN FLIGHT, for the same reason Send is.
            Discard clears the rows locally and fires `DELETE …/plan/draft`; run
            underneath the `PUT …/plan/draft` that a submit opens with, it
            deletes the tray the submit is mid-way through writing, and the two
            requests race for the last word on the server's copy. */}
        {rows.length > 0 && (
          <button type="button" className="plan-btn" disabled={submitting} onClick={onDiscard}>
            Discard tray
          </button>
        )}
      </div>

      {full && (
        <p className="text-xs text-amber-700 dark:text-amber-400 mb-2">
          The tray holds {PLAN_LIMITS.draftEntries} rows. Send this batch before staging more.
        </p>
      )}

      {overOpenCap && (
        <p
          className="text-xs text-amber-700 dark:text-amber-400 mb-2"
          data-testid="plan-tray-open-cap"
        >
          This plan is at its limit of {PLAN_LIMITS.openNotes} open notes, and this batch would
          file {wouldOpen} more. The whole review would be refused. Dismiss some open notes
          first — nothing you have staged is lost.
        </p>
      )}

      {/* WHERE THIS BATCH IS ABOUT TO GO. It survives on BOTH mounts, and it
          is the only line on either screen that says a chat message is about to
          be posted into a room — the Send button says what happens to the
          notes, not where they land.
          THE NO-ADDRESSEE CASE IS THE ONE THAT MUST NEVER BE DROPPED: a batch
          that reaches nobody still writes the plan, and that is a genuine
          surprise rather than a location. It reads as a warning because it is
          one. */}
      <div className="flex flex-wrap items-center gap-2">
        {showSend && (
          <button
            type="button"
            className="plan-btn plan-btn--primary"
            disabled={submitting}
            onClick={onSubmit}
          >
            {submitting ? 'Sending…' : `Send review · ${count}`}
          </button>
        )}
        <span className="text-xs text-channel" data-testid="plan-tray-where">
          {to.length
            ? `to ${to.map((n) => (n === 'user' ? 'you' : `@${n}`)).join(', ')}`
            : 'no addressee — this writes the plan and sends nothing'}
          {room ? ` in #${room}` : ''}
        </span>
      </div>
    </div>
  )
}

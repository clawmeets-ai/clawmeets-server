import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { PLAN_LIMITS } from '../../../api/endpoints/projectPlans'

/**
 * THE COMPOSER A COMMENT BUBBLE OPENS: a text box, a Cancel and a file button.
 *
 * Commenting on a document is a gesture every editor people already use has
 * taught them, so this one does not explain itself. Four things came off, and
 * each is worth naming once here because each looks like an omission until you
 * know it was a deletion:
 *
 *   - THE QUOTE IS NOT REPRINTED. It used to sit in italics at the top,
 *     duplicating words that are on screen two inches away. The one thing it
 *     was actually telling the user — WHICH block this is about — moved to the
 *     document, which lights the block while this composer stands. That is why
 *     `quote` is no longer a prop: the parent still puts the quote on the wire,
 *     this component simply has nothing to say about it.
 *   - THE ADDRESSEE IS NOT STATED. It was a sentence answering a question
 *     nobody asked, with one possible answer. The answer has not changed —
 *     `onPost` still sends the coordinator, and `[]` on a plan with no
 *     coordinator — so `to` is still a prop and still the only recipient. What
 *     went is the row that said so.
 *   - THERE IS NO PROPOSAL SURFACE. See below; it is the one real capability
 *     change on this surface.
 *   - THERE IS NO FOOTER. It said filing was immediate and named the quote cap.
 *     Filing behaves the way it does everywhere else, so the sentence taught
 *     nothing and cost a line. The over-length warning is NOT that sentence and
 *     stays: it is a refusal a user can actually hit and act on.
 *
 * A USER CANNOT AUTHOR A PROPOSAL HERE ANY MORE, AND AGENTS STILL CAN. The
 * expandable replacement textarea, its open and drop controls, and the
 * `proposal` / `base_section` fields this component contributed are gone: a
 * user who wants different words edits the block inline, and that editor is one
 * click away on the block itself — a better tool than a second textarea that
 * rewrites the whole section to change a word in it. NOTHING ELSE ABOUT
 * PROPOSALS MOVED. `clawmeets plan note --proposal` still files one,
 * `POST …/plan/notes` still accepts `proposal` + `base_section` (both default
 * to `""` server-side, which is why this component can simply stop sending
 * them), and every surface that RENDERS one — the diff, the diff series, the
 * collision view, the note row's Accept and Reject — is untouched. What was
 * removed is one browser-side WRITER, not the feature.
 *
 * ESCAPE BELONGS TO THE POPOVER ROOT; one handler covers every child by
 * bubbling, so nothing added here may `stopPropagation` on keydown. It carries
 * less weight with every control that leaves — the addressee picker's search
 * field and roster rows were the ones most in need of it, and now the proposal
 * textarea has gone too — but the rule is unchanged for what remains.
 */
export function PlanQuotePop({
  at,
  to,
  busy,
  failure,
  onPost,
  onClose,
}: {
  at: { top: number; left: number }
  /** THE ONE LEGAL ADDRESSEE: the coordinator, which is the plan's `keeper`.
   *  `''` on a plan that names no keeper — the note is then recorded against
   *  the line and sent to nobody, which is the only way this surface produces
   *  `to: []`.
   *
   *  IT SURVIVED THE DELETION OF THE ROW THAT DISPLAYED IT, and that is the
   *  whole point of the removal: who the note reaches did not change, only
   *  whether the surface spends a line saying so. */
  to: string
  /** A note post already in flight, as the PARENT sees it — one render behind
   *  this component's own `pending`, and kept for what it can still see that
   *  `pending` cannot: a request left over from an earlier composer. It is NOT
   *  the double-submit guard and must not be read as one; see `submit`. */
  busy: boolean
  /** The parent's last write failure, verbatim. Rendered only once THIS
   *  composer's own post has come back failed — see `failed` — so a batch
   *  refusal raised elsewhere while the popover happens to be open never
   *  appears here wearing the composer's alert. */
  failure: string | null
  /** RESOLVES WHEN THE POST HAS SETTLED, either way. It does not report which:
   *  the parent closes this popover on success by clearing the selection, so
   *  the only code path that reaches the far side of the `await` still mounted
   *  is the failing one. */
  onPost: (n: {
    comment: string
    /** The addressee, as a one-element list — or `[]` when there is no
     *  coordinator to address. Still a list because `POST /plan/notes` still
     *  fans one into sibling notes for the CLI; this surface never sends two. */
    to: string[]
  }) => Promise<void>
  onClose: () => void
}) {
  const [comment, setComment] = useState('')
  /** THIS post is in flight. Set SYNCHRONOUSLY inside `submit`, which is the
   *  entire reason it exists rather than the `busy` prop: `busy` is the
   *  parent's state and arrives a render later, so two clicks in the same tick
   *  both see it `false`. */
  const [pending, setPending] = useState(false)
  /** This composer's own post came back failed. Reaching this state at all is
   *  the proof that the parent did NOT close us, so it is also the flag that
   *  says the parent's `failure` belongs to us. */
  const [failed, setFailed] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const errorId = useId()
  const inFlight = pending || busy

  useEffect(() => {
    taRef.current?.focus()
  }, [])

  // ONE FIELD, SO ONE LENGTH. The limit is unchanged and it is still the
  // server's own `noteChars`; what left the sum is the proposal, which no
  // longer exists to contribute characters to it.
  const tooLong = comment.length > PLAN_LIMITS.noteChars
  const valid = !tooLong && comment.trim().length > 0

  /**
   * FILE THE NOTE, AND STAY ON SCREEN WHILE IT GOES.
   *
   * `onClose()` USED TO RUN HERE, ON THE SAME TICK, and it was doing two jobs
   * by accident. It closed the popover on success, which is right — and it
   * unmounted this component before the request resolved, which was the ENTIRE
   * double-submit protection and also destroyed the user's text on failure. A
   * failed post left `setQuoted(null)` already run: an error banner at the top
   * of the pane, a typed comment gone, and no way back. That is the defect this
   * fixes; the pending state is what makes it possible to fix.
   *
   * THE GUARD REPLACES WHAT THE UNMOUNT WAS DOING, and it has to be
   * synchronous to do it. `pending` is set here rather than read off the
   * parent's `busy`, because `busy` is the parent's state and arrives a render
   * later — two clicks in one tick would both pass it. `busy` stays in the
   * condition anyway: it catches a post left in flight by an earlier composer,
   * which `pending` cannot see. The ⌘/Ctrl+Enter path routes through this same
   * function, so it is covered by the same line.
   *
   * CLOSING IS THE PARENT'S CALL AND ONLY ON SUCCESS. `onPostNote` clears the
   * selection after the post resolves and not in the catch, so success unmounts
   * this component and failure leaves it standing with every character intact.
   * Which is why the two lines after the `await` need no success check: they
   * are only ever reached mounted, and only ever after a failure.
   *
   * AND THE HIGHLIGHT ON THE DOCUMENT FOLLOWS THIS EXACTLY, because it is drawn
   * off the very state the parent clears: success takes the block's mark down
   * with the popover, and a failure leaves it lit on the block whose words the
   * user is still fixing.
   */
  const submit = async () => {
    if (!valid || inFlight) return
    setPending(true)
    setFailed(false)
    await onPost({ comment: comment.trim(), to: to ? [to] : [] })
    setPending(false)
    setFailed(true)
  }

  return (
    <div
      className="plan-pop"
      style={{ top: at.top, left: at.left }}
      // The popover sits inside the document host, whose mousedown clears the
      // pending selection. Without this, opening it closes it.
      onMouseDown={(e) => e.stopPropagation()}
      // ESCAPE BELONGS TO THE POPOVER, NOT TO THE TEXTAREA. It was on the
      // textarea, which is where focus starts — so it worked until the user
      // tabbed off it, and then the only way out was the mouse. A keydown
      // bubbles from any child to here, so one handler covers every control
      // inside, which is why nothing below stops keydown propagation.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
      data-testid="plan-quote-pop"
      role="dialog"
      aria-label="Write a note on the selected text"
    >
      <textarea
        ref={taRef}
        className="plan-pop-in"
        rows={3}
        value={comment}
        aria-label="What do you want to say about this?"
        placeholder="What should they change, or what do you want to know?"
        // The refusal is tied to the FIELD, not left as a sentence floating
        // near it: a screen-reader user who lands back in the textarea to fix
        // their note hears why it was refused.
        aria-describedby={failed && failure ? errorId : undefined}
        aria-invalid={failed && !!failure}
        onChange={(e) => setComment(e.target.value)}
        // Escape is handled on the popover root, which this bubbles to.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      />

      {tooLong && (
        <p className="plan-pop-hint plan-pop-warn">
          A note carries at most {PLAN_LIMITS.noteChars} characters.
        </p>
      )}

      {/* THE REFUSAL, WHERE THE TEXT IT REFUSED STILL IS. It used to render as a
          red line at the top of the editor pane — potentially a full scroll
          away from a popover that had already unmounted with the user's words
          inside it. `role="alert"` because it is the outcome of something the
          user just did, and it carries the `id` the textarea points at. */}
      {failed && failure && (
        <p id={errorId} role="alert" className="plan-pop-hint plan-pop-warn">
          {failure}
        </p>
      )}

      <div className="plan-pop-bar">
        <div className="plan-pop-acts">
          <button type="button" className="plan-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="plan-btn plan-btn--primary"
            // NOT `disabled` while the post is in flight, deliberately, and the
            // rule is this frontend's own: a disabled element cannot hold
            // focus, and this composer autofocuses its textarea on mount, so
            // disabling the primary button mid-request drops a keyboard user
            // onto <body> for the duration. `aria-busy` states the condition
            // and `submit`'s first line is what actually refuses to re-enter.
            // `disabled` on invalid input stays — that is not a transient state
            // a user is standing in, it is one they can see and fix.
            disabled={!valid}
            aria-busy={inFlight}
            onClick={() => void submit()}
          >
            {/* `File note` rather than a bare `Note`, which is not a button
                label — and `note` is the item's name while `comment` survives
                as the verb, so the label has to carry both. It outlived the
                hint it used to pair with: the footer went because it explained
                a gesture that explains itself, and the button still has to say
                what pressing it does. */}
            File note
            {inFlight && <Loader2 size={12} className="animate-spin" aria-hidden />}
          </button>
        </div>
      </div>
      {/* No delay threshold: the popover is already on screen, so there is no
          layout to shift and nothing to debounce. */}
      <span role="status" aria-live="polite" className="sr-only">
        {inFlight ? 'Filing your note…' : failed && failure ? failure : ''}
      </span>
    </div>
  )
}

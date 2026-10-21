import { type ReactNode } from 'react'
import { AlertTriangle, MessageSquare, X } from 'lucide-react'
import { type PlanNote } from '../../../api/endpoints/projectPlans'
import {
  type CommentGroup,
  type CommentItem,
  draftKindWord,
  groupComments,
  holdsTheWork,
  isAlarming,
  noteSummary,
} from './planTrayLogic'

/** THE WORD IN THE CHIP.
 *
 *  `draftKindWord` is the one map, and this is its ONE call-site override: an
 *  `edit` row reads `accept`. That is the owner's framing carried all the way
 *  through — writing a section is proposing text and accepting it in the same
 *  gesture — and it is done HERE rather than in the map because the map is also
 *  read by the note bar's staged badge, where a row's raw kind is the answer.
 *  What it costs is one distinction: the list no longer says at a glance which
 *  rows are your own rewrites. The author line pays it back — an edit reads
 *  `you`, an agent's decided proposal reads `@keeper`. */
function chipWord(item: CommentItem): string | null {
  if (item.staged) return item.staged.kind === 'edit' ? 'accept' : draftKindWord(item.staged.kind)
  return item.pending ? 'waiting to send' : null
}

/** THE HEADING, AND THE ONE NUMBER THAT MAKES IT HONEST.
 *
 *  `Waiting on you` lists every open note addressed to you — deliberately, so
 *  the box stays a complete navigator — but the desk card's pill and the
 *  execution gate count only the ones in the SPEC layer. Two correct numbers
 *  under labels that read like one claim is how a card saying `2 for you` came
 *  to sit over a list of three rows, which reads as a counting bug.
 *
 *  So the heading says both: the group, and how much of it is actually holding
 *  the project. NOT A SECOND COUNT — `group.holding` is `holdsTheWork` applied
 *  to these rows, the same predicate `openForYou` sums and the server's
 *  `open_notes_for_you` mirrors. Making the pill say three instead would have
 *  been the second count, and the gate reads the first one.
 *
 *  Silent when every row holds the work, which is the ordinary case: a
 *  qualifier that is always there stops being read. */
function groupLabel(group: CommentGroup): string {
  if (group.to !== 'user') return group.to ? `Waiting on @${group.to}` : 'Recorded, not sent'
  if (group.holding === group.items.length) return 'Waiting on you'
  return `Waiting on you · ${group.holding} of ${group.items.length} hold the work`
}

/**
 * THE COMMENT LIST. IT ROUTES AND IT UNDOES; IT NEVER DECIDES.
 *
 * It was `PlanDeviation`, and the fast red navigator above the plan body was
 * wasted on a note kind that is usually absent: on a plan with no deviation and
 * one open question there was no navigator at all. It now appears whenever ANY
 * comment is open, and the routing behaviour is carried across verbatim —
 * clicking a row selects the note's section, focuses it and scrolls it into
 * view.
 *
 * ONE ROW RENDERER, NO KIND BRANCH, and that is the owner's framing paying for
 * itself. A staged text edit arrives here already projected into a `PlanNote`
 * by `editAsNote` — a comment you wrote with a diff and accepted in the same
 * gesture — so there is no `source: 'note' | 'edit'` union, no second click
 * contract and no second chip vocabulary. `derived` changes two strings (the
 * ✕'s label and the author word) and nothing else; if it ever gates layout or
 * behaviour the projection has failed and should be reverted rather than
 * patched.
 *
 * IT SHOWS EVERY OPEN COMMENT, not only the ones addressed to you. That matches
 * the section rail's dot (`openNotesOn` counts every open note on a section)
 * and makes the list a complete navigator. It is therefore a LARGER number than
 * the header's `N waiting on you` (`open_notes_for_you`, addressed-to-user
 * only), which is why nothing here reuses that phrase.
 *
 * AND IT NOW SAYS WHICH ONES THOSE ARE, WHICH IS WHAT THAT COMPLETENESS COST.
 * One flat column of every open comment, each with a chip and a ✕, reads as a
 * list of chores you owe — including the questions you asked and have already
 * been answered. `groupComments` splits it on `note.to` and this draws one
 * headed group per addressee, `Waiting on you` first. Nothing is filtered and
 * nothing is reordered: the navigator is as complete as it was, and every group
 * keeps `commentList`'s order, so a deviation is still the first row on screen.
 *
 * THE HEADER STATES ITS GROUP'S OWN ADDRESSEE and has no fallback, because
 * `groupComments` keys on the field rather than on a two-way guess — see it for
 * why the two shapes a `mine`/`theirs` split gets wrong (`''`, and a legacy
 * note to a specialist) are the reason.
 *
 * AND IT SAYS HOW MANY OF YOUR ROWS ARE HOLDING THE PROJECT, because listing
 * every open note to you under one heading is what made the desk card's
 * `N for you` look wrong. Both numbers were right — the pill counts spec-layer
 * notes because that is what the execution gate reads, and this list filters by
 * nothing — so the repair is the heading saying which subset it means, not a
 * second count. `groupLabel` carries it, `holdsTheWork` is the predicate, and
 * the matching per-row badge says which rows those are.
 *
 * IT OFFERS NO DECISION OF ITS OWN. `Accept — move the contract` /
 * `Reject — hold the contract` were on the band's old callout and resolved the
 * note on the click; they are gone, not re-pointed, so a note is decided in
 * exactly ONE place — its own card, next to its diff. What this row carries is
 * the decision already made (the chip) and the way to take it back (the ✕),
 * which is the tray's ✕ moved onto the comment it is about.
 *
 * THE BOX IS RED ONLY WHEN IT HOLDS A DEVIATION (`.plan-cl--alarm`). Painting
 * the whole thing urgent for an ordinary question is how an alarm stops meaning
 * anything.
 *
 * IT IS BOUNDED AND NOT FLEXIBLE — `flex: none`, a hard `max-height`, and it
 * CLIPS — because it is a child above the pane row. See the invariant declared
 * at `PlanEditor`'s root className; `PlanEditor.mounts.test.tsx` asserts it on
 * the source, because jsdom has no layout engine to ask.
 *
 * IT CLIPS RATHER THAN SCROLLS, and the difference is `Send review`. The box
 * used to scroll as a whole; it now holds the send bar as its footer, and a box
 * that scrolls as a whole scrolls its own footer away with its rows — the same
 * failure this box was built to end, re-entered from the other side. So the
 * rows (`.plan-cl-rows`) are the one scroller and the footer
 * (`.plan-cl-foot`) is `flex: none`.
 *
 * IT ENDS IN THE ONE SEND, AND STILL DECIDES NOTHING ITSELF. Hosting the batch
 * control is not the same as offering a per-comment decision: Send commits the
 * whole review at once, which is exactly the act that belongs to no single
 * comment and therefore to the container they share.
 */
export function PlanCommentList({
  items,
  keeper,
  onShow,
  onUnstage,
  footer,
  parentOf,
}: {
  items: CommentItem[]
  keeper: string
  /** The note a reply answers, so a reply row can say WHICH question it is
   *  answering — two "follow your recommendation" rows are otherwise
   *  indistinguishable. Optional: absent, rows render as before. */
  parentOf?: (note: PlanNote) => PlanNote | null
  /** Route to a comment: select its section, focus it, scroll it into view.
   *  ONE callback, real note and projected edit alike — `PlanBody`'s `anchorOf`
   *  is what gives the projected one a landing target, which is what let the
   *  second `onShowSection` callback disappear from this interface. */
  onShow: (note: PlanNote) => void
  /** Unstage ONE tray row. Removal, never a decision — the same call the tray's
   *  ✕ made. */
  onUnstage: (rowId: string) => void
  /** THE BATCH-LEVEL BAR, RENDERED AS THIS BOX'S FOOTER — outside the rows'
   *  scroller, so it cannot scroll away with them. That is the failure this box
   *  was built to end, re-opened from the other side the moment `Send review`
   *  moved inside it; `.plan-cl-foot` being `flex: none` in a clipping flex
   *  column is what keeps it shut. See the note on `.plan-cl` in `plan.css`.
   *
   *  A SLOT RATHER THAN TEN PROPS, deliberately. The batch — its count, its
   *  addressees, its caps, its Discard and its one Send — is `PlanTray`'s
   *  subject, not this list's; this list's subject is the individual comment.
   *  Folding those props in here would move that ownership for a layout reason,
   *  and layout is the one thing a slot can change without touching it.
   *
   *  IT IS RENDERED UNCONDITIONALLY AND MAY SELF-NULL. Safe because this box is
   *  never absent while the bar has something to say: `commentList` emits an
   *  item for every open note AND every unclaimed row (every raw edit carries
   *  `note_id: ''`, so it is never claimed), and pending notes are a subset of
   *  the open ones. The `items.length === 0` return below therefore cannot hide
   *  a live Send. */
  footer?: ReactNode
}) {
  // PRESENCE IS THE PREDICATE, as it was on the alarm — the caller does not
  // have to spell the emptiness test at the call site.
  if (items.length === 0) return null
  // ONE PREDICATE, SHARED WITH THE SERVER'S `_open_deviation` — see
  // `isAlarming`. Not `kind === 'deviation'`, which is a record and true
  // forever: this box goes red to say the project is STOPPED, and a
  // detail-layer departure does not stop it (the keeper could have made that
  // edit with `plan update` and no refusal, so the server does not count it in
  // `open_notes_for_you`). The row still renders and still says `deviation`.
  const alarm = items.some((i) => isAlarming(i.note))
  const anyPending = items.some((i) => i.pending)
  const groups = groupComments(items)
  return (
    <div
      className={'plan-cl' + (alarm ? ' plan-cl--alarm' : '')}
      data-testid="plan-comment-list"
    >
      <div className="plan-cl-rows">
        {groups.map((group) => (
          <div key={group.to} data-testid={`plan-comment-group-${group.to || 'nobody'}`}>
            {/* THE HEADING IS THE ONLY THING THIS SPLIT ADDS, and it is a
                heading rather than a filter: every row that was on this list
                is still on it, in the same order, one group down.
                THREE SENTENCES AND NO FALLBACK — the group key IS `note.to`,
                so each is a statement about the group rather than a guess at
                one. `''` is `add_note`'s *recorded, never sent*, which is a
                real and deliberate thing to file and the one group nobody is
                waiting on; saying "waiting on" about it would be false, so it
                says what it is instead. */}
            <div className="plan-cl-grp" data-testid={`plan-comment-group-label-${group.to || 'nobody'}`}>
              {groupLabel(group)}
            </div>
            {group.items.map((item) => {
          const { note, staged, derived } = item
          /* `by` is who WROTE the comment; `keeper` is the coordinator and the
             fallback when a note carries no author. A derived row is always
             yours, and says so in the second person the rest of this app speaks
             in — the wire's token is the literal `'user'`. */
          const mine = derived || note.by === 'user'
          const by = mine ? 'you' : `@${note.by || keeper || 'someone'}`
          const chip = chipWord(item)
          return (
            <div
              key={item.key}
              className={
                'plan-cl-item' + (staged?.superseded_by ? ' plan-cl-item--superseded' : '')
              }
              data-row-id={staged?.id}
              data-row-kind={staged?.kind}
              data-superseded={staged?.superseded_by ? 'yes' : 'no'}
              data-folded={staged?.folded ? 'yes' : 'no'}
            >
              {/* THE ROW IS A BUTTON THAT ROUTES, and NOT one that decides.
                  It carries `data-comment-id` and deliberately NOT
                  `data-note-id`: that attribute means "a scroll target inside
                  the pane" and `PlanEditor`'s scroll effect queries it, so a
                  second element carrying a note's id ABOVE the pane is how a
                  query lands on the navigator instead of the card. This list is
                  a navigator, never a destination. */}
              <button
                type="button"
                className="plan-cl-row"
                data-testid="plan-comment-row"
                data-comment-id={note.id}
                onClick={() => onShow(note)}
              >
                {/* The urgent triangle is the alarm at row scale, so it takes
                    the alarm's predicate and not the record's — same reason the
                    container above does. */}
                <span className={'plan-cl-ic' + (isAlarming(note) ? ' on' : '')}>
                  {note.kind === 'deviation' ? (
                    <AlertTriangle size={14} />
                  ) : (
                    <MessageSquare size={14} />
                  )}
                </span>
                <span className="plan-cl-b">
                  {/* ONE LINE. `title` carries the untruncated comment so the
                      summary being short costs nothing on a pointer — the full
                      text is one click away either way. */}
                  <span className="plan-cl-t" title={note.comment}>
                    {noteSummary(note.comment)}
                  </span>
                  {(() => {
                    const parent = parentOf?.(note)
                    return parent?.comment ? (
                      <span
                        className="plan-cl-re"
                        title={parent.comment}
                        data-testid={`plan-cl-re-${note.id}`}
                      >
                        ↩ re: {noteSummary(parent.comment)}
                      </span>
                    ) : null
                  })()}
                  {/* THE LOCATOR AND THE AUTHOR, and NOT `base_section`. The
                      band's old callout quoted the clause a deviation is
                      measured against; at one line that quote would be the
                      section's heading and nothing else, and getting past the
                      heading to the claim means reading Markdown structure —
                      which this client does not do, deliberately (see
                      `noteSummary`). Nothing is lost: clicking selects this
                      section, so the Plan's own text for it is IN THE PANE, in
                      full, beside the note. */}
                  {/* `§—` WAS A SLUG-SHAPED PLACEHOLDER FOR A REAL ANSWER.
                      `note.section === ''` means *the document as a whole* —
                      it always has, and the note detail view has always said
                      "on the document" for one — but this row printed a dash
                      where a section name goes, which reads as *we could not
                      work out where this is*. The confirm note is section-less
                      by construction, so the shape stopped being rare. */}
                  <span className="plan-cl-s">
                    {note.section ? `§${note.section}` : 'the plan'} · by {by}
                    {/* THE FACT, NOT THE OUTCOME — the two badges the tray row
                        carried, moved with the row they describe. `missing`
                        deliberately does not say "will be re-created": whether
                        the submit re-creates the section or refuses depends on
                        the note's `base_section`, which the server owns
                        (`_row_creates`) and predicting it here would be a
                        second copy of that rule in the browser. */}
                    {staged?.stale && <span className="plan-cl-warn">the document moved</span>}
                    {staged?.missing && (
                      <span className="plan-cl-warn">the section is gone</span>
                    )}
                    {staged?.superseded_by && <span className="plan-cl-sup">superseded</span>}
                    {/* THE SAME SHAPE AS `superseded`, THE OPPOSITE NEWS —
                        which is exactly why it is a badge of its own and not
                        that one reused. `.plan-cl-item--superseded` dims a
                        superseded row because its text is being discarded; a
                        folded row's text is IN the write that lands, so dimming
                        it would say the one thing that is false about it. It
                        reads at full strength and says only where its text
                        went. Both rows are still individually undoable, and ✕
                        on the winner un-folds this one — see `removeRow`. */}
                    {staged?.folded && <span className="plan-cl-fold">folded in</span>}
                    {/* WHICH OF *YOUR* ROWS IS NOT THE ONE STOPPING THE
                        PROJECT. Same predicate as the heading's count, per row,
                        so the reader does not have to work out which two of
                        three the header means. Only in the `user` group: for
                        every other addressee `holdsTheWork` is false by its
                        first term and the badge would be noise on every row.
                        It reads as a fact, not as a verdict — the note still
                        wants an answer; it just does not hold the work
                        (`layer === 'detail'`: the keeper could have made that
                        edit with `plan update` and no refusal). */}
                    {group.to === 'user' && !holdsTheWork(note) && (
                      <span className="plan-cl-quiet">doesn&rsquo;t hold the work</span>
                    )}
                  </span>
                </span>
                {chip && <span className="plan-cl-chip">{chip}</span>}
              </button>
              {/* THE ✕ IS OUTSIDE THE ROUTING BUTTON, because a button inside a
                  button is invalid HTML and the browser un-nests it — which is
                  how a click on `Remove` came to route AND unstage. It is named
                  in the same vocabulary as the chip beside it, so a screen
                  reader never hears `Remove ask row` about a row that reads
                  `reply`.
                  THERE IS NO ✕ ON A PENDING NOTE, and that is the one asymmetry
                  worth keeping: a filed note cannot be unwritten, so there is
                  nothing of yours to take back. The paragraph below says so.
                  ON A DERIVED ROW IT MEANS SOMETHING SLIGHTLY DIFFERENT and the
                  label says so: unstaging a decision returns its comment to
                  undecided and the comment STAYS listed; discarding an edit
                  removes the row and the comment goes with it, because the
                  comment WAS the edit. */}
              {staged && (
                <button
                  type="button"
                  className="plan-cl-x plan-btn plan-btn--icon"
                  aria-label={
                    derived && staged.kind === 'edit'
                      ? 'Discard this edit'
                      : `Remove ${draftKindWord(staged.kind)} row`
                  }
                  onClick={() => onUnstage(staged.id)}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
            })}
          </div>
        ))}
      </div>
      {/* WHY A PENDING NOTE HAS NO ✕, AND WHAT DISMISSING ONE ACTUALLY DOES.
          Moved here from `PlanTray` with the rows it explains — it is the only
          place the app states either half. The drop from THIS batch is
          immediate: a `dismiss` row carries the note's id, `decidedNotes`
          collects those ids and `isPendingNote` ends on `!decided.has(n.id)`,
          so the note leaves `note_ids` on the click. The CLOSE waits for the
          submit, because nothing in this browser moves a note's status before
          then. */}
      {/* THE FOOTER — EVERYTHING THAT IS ABOUT THE BATCH RATHER THAN A ROW, and
          the one part of this box that must never scroll. `flex: none` in a
          clipping flex column, with `.plan-cl-rows` above it as the only
          scroller. */}
      <div className="plan-cl-foot">
        {anyPending && (
          <div className="plan-cl-s plan-cl-where" data-testid="plan-comment-list-pending">
            A filed note cannot be unwritten. Dismissing one drops it from this batch straight
            away; it closes on your next send.
          </div>
        )}
        {/* WHERE IT IS DECIDED, said in the same words the note bar uses one
            component down, so the two surfaces make the reader one promise
            rather than two. It is the CONTAINER's line, once, rather than each
            row's: the sentence is about the review batch, which the rows share.
            IT NO LONGER OPENS WITH `Click one to open its note below — decide
            it there`. That sentence was routing instruction written for a
            screen where Send was somewhere else entirely; with the send bar now
            four lines under it, the shape of the box says the same thing and
            the words were costing ~28px of a header that this change already
            grows. What is left is the half that no layout can say — the promise
            that clicking has not yet sent anything. */}
        <div className="plan-cl-s plan-cl-where" data-testid="plan-comment-list-where">
          A decision goes in your review batch, and nothing reaches the plan or its addressees
          until you submit.
        </div>
        {footer}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { AlertTriangle, MessageSquare } from 'lucide-react'
import type { PlanNote } from '../../../api/endpoints/projectPlans'
import { splitQuoteLabel } from './planAnchor'
import { PlanDiffSeries } from './PlanDiffSeries'
import type { DiffStep } from './planDiffs'
import { draftKindWord, isPendingNote, noteSummary } from './planTrayLogic'

/** THE CHIP IS THE WIRE WORD, AND THERE IS NO LOOKUP TABLE ANY MORE.
 *
 * There used to be a `KIND_LABEL` map here, and its whole job was to translate:
 * the server stored `comment` where the card wanted to say "note", and stored
 * `question` where the button said "Reply" — it named the MECHANISM
 * (`submit_review`'s `ask` arm) where the user had named the act. Worse, it
 * only ever caught the notes the user typed themselves; an agent's
 * `plan note --reply-to` stored `comment` and printed as an unprompted note.
 *
 * `PlanNote.kind` is now derived server-side on every read from the note's own
 * fields — `deviation` / `proposal` / `reply` / `note` — so the word that
 * arrives is the word to print, a reply is a reply whoever filed it, and a
 * translation layer that could drift from the server has nothing left to do. */

/** THE ONLY STATUS-KEYED LOOKUP IN THE APP, and the reason `PlanNote.status` is
 *  a closed union: widening the union is what makes `tsc` walk the author to
 *  this map. Every other status test in the tray and the editor asks `open` vs
 *  not-`open` and enumerates nothing.
 *
 *  KEYED `Record<string, string>` AND READ WITH `?? note.status`, so an unknown
 *  word DEGRADES to itself rather than rendering blank. `NOTE_STATUSES` is
 *  advisory on the server — never a `Literal`, never an `Enum`, never a
 *  validator — so a seventh word can arrive from a newer server than this
 *  bundle, and printing it raw is strictly better than printing nothing. */
const STATUS_LABEL: Record<string, string> = {
  open: 'open',
  answered: 'answered',
  applied: 'applied',
  rejected: 'rejected',
  dismissed: 'dismissed',
  /** NOT the bare word. `folded` alone reads as the direction-free fact and is
   *  already this app's word for a collapsed diff band; `folded in` says the
   *  text went INTO something, which is the whole news — this is the one
   *  terminal status that means the work landed. */
  folded: 'folded in',
}

export interface NoteActions {
  /** stage an accept — writes ZERO bytes. */
  onAccept: (note: PlanNote) => void
  onReject: (note: PlanNote, reason: string) => void
  onDismiss: (note: PlanNote) => void
  /** STAGES, like everything else on this row. It puts one `ask` row in the
   *  tray carrying the parent's `note_id` and a COMPUTED `to`; the server files
   *  it as a `question` note and derives `quote` from that id. The client
   *  therefore needs no new `DraftEntry` field, which is why this is not a wire
   *  change.
   *
   *  WHAT HAPPENS TO THE PARENT IS THE SERVER'S CALL AND IT MOVED. It used to
   *  stay open — "a question is not a resolution" — and under the two-party
   *  channel a reply CLOSES it `answered` in the same transaction that files
   *  the outgoing question (AC-5.9). Nothing here holds or predicts that: the
   *  row reads `note.status` off the refetch, and the editor draws only open
   *  notes, so a parent that closed simply leaves the screen.
   *
   *  DO NOT SEND AN EMPTY `to` AND LET THE SERVER DEFAULT IT. Its fallback is
   *  `or parent.by`, and on a reply to your OWN note `parent.by` is the literal
   *  `"user"` — so the fallback addresses your reply back to you. `askRow`
   *  computes the addressee instead.
   *
   *  IT ABSORBED `onAsk`, WHICH WAS THE SAME CALL UNDER A SECOND NAME. `Ask`
   *  staged the identical `ask` row, differing only in leaving `to` empty for
   *  the server to derive — and it rendered ONLY on `!mine`, where the server's
   *  `_reply_addressee` returns `parent.by`, which is what `askRow` computes. So
   *  the two derivations agreed everywhere both were reachable. `Reply` is the
   *  strict superset: `!mine` implies `mayReply`, and `Reply` additionally
   *  survives your own sent notes and notes you have already staged a decision
   *  on. Removing it the other way round would have lost both. */
  onReply: (note: PlanNote, text: string) => void
  /** is there already a tray row for this note? */
  staged: (note: PlanNote) => string | null
  /** is this note waiting to go out with the next batch? Asked of the editor,
   *  not recomputed here — the answer depends on the tray as well as the note,
   *  and the row cannot see the tray. */
  pending: (note: PlanNote) => boolean
  canDecide: boolean
}

/** Which textarea, if any, is open on this row. One at a time: they occupy the
 *  same space and mean two different things. */
type Compose = 'reject' | 'reply' | null

/**
 * One note, and everything you can do about it — WITHOUT LEAVING THE LINE IT IS
 * ABOUT.
 *
 * IT IS NEVER A PARENT, AND THREADING WAS DELETED RATHER THAN FIXED. The note
 * channel is a two-party channel between the user and the coordinator, and a
 * response note may answer a question about one section with a note on ANOTHER.
 * "Under its parent" therefore has no single correct place to be — a reply
 * nested under a note about `goal` would be a reply about `milestones` drawn in
 * the wrong section — so a response is a NEW ROOT on whatever section it
 * belongs to, and the editor's own partition already puts it there.
 *
 * `PlanNote.reply_to` and `PlanNote.replies` SURVIVE ON THE PAYLOAD as
 * provenance: which note this one answers is worth knowing and the server keeps
 * saying it. Neither drives LAYOUT, and that is still the whole of the removal
 * — no `depth`, no indent, no recursion, and no parent-vs-revision diff (a
 * response note carrying a proposal already renders
 * `base_section -> proposal` through `PlanDiffSeries` below, which needs
 * nothing from threading).
 *
 * `reply_to` IS NOW READ, FOR ONE LINE OF TEXT. It used to be read by nothing
 * at all, which made a reply indistinguishable from an unprompted new note on
 * the same line. The `parent` prop resolves it and the row says "Answering
 * your question"; it moves no note, nests no note, and changes no status. Text
 * is the correct weight for it precisely because placement is not available:
 * placement belongs to `section` and `quote`, which is the property that let
 * the threading go.
 *
 * ONE GROUP NOW, AND THAT IS THE CHANGE. The row carried two labelled groups —
 * "Goes in your batch" and "Happens now" — because `Dismiss` and `Dismiss now`
 * sat side by side, one word apart and irreversibly different. `Apply now`,
 * `Resolve` and `Dismiss now` have gone; every control here STAGES, and
 * `Send review` is the only thing that reaches an agent. A label that splits a
 * set into one group and an empty one is noise, so the labels went with them
 * and the bar keeps ONE help line.
 *
 * NO EXCEPTIONS, NOT EVEN REPLY. Reply used to POST a note record on the click.
 * It now stages an `ask` row carrying the parent's `note_id` and a computed
 * `to`, and the server derives the quote from that id — so the one help line,
 * "nothing reaches the plan or its addressees until you submit", is literally
 * true of every control here. That sentence is why the labels could go, and it
 * is deliberately not the older "nothing is written": staging DOES write, to
 * the draft tray. What it does not do is reach the plan or the person.
 *
 * `ASK` IS GONE, COLLAPSED INTO `REPLY`, AND NO CAPABILITY WENT WITH IT. They
 * were one act with two labels — the same `ask` tray row, the same `question`
 * note on the server, the same parent closed `answered` — and `Reply` renders
 * strictly wherever `Ask` did and in cases it did not. What is lost is one
 * placeholder that framed the act as a question; the no-proposal help line
 * below carries that framing instead, which is where a user wants to ask for a
 * proposal anyway. The `ask` DRAFT KIND STAYS: it is what `Reply` stages, so
 * the wire is untouched.
 *
 * A SECTION THAT MOVED UNDER A NOTE is warned about HERE, before the decision,
 * and reconciled at submit if it was staged anyway — the batch is refused whole
 * with your text beside what the section says now, and the reconciliation's
 * "keep my text" branch re-bases onto the current text. That is what replaced
 * `Apply now`'s `force` flag, and it is strictly better than it was: `force`
 * substituted the current text as `base` without ever showing the user what
 * they were overwriting. `section_changed` is a string comparison the server
 * already did; it drives a warning, never a block, because what a note blocks
 * is execution rather than authorship. `section_missing` and `section_new` are
 * the two things "the advisory slug no longer resolves" can mean — the section
 * was deleted under the note, or the note is what would create it — and both
 * are display states rather than errors. The server guarantees at most one of
 * them is set, so neither branch below has to defer to the other.
 *
 * NOTHING HERE HOLDS A NOTE'S STATUS. There is no local flag and no optimistic
 * decrement of `open_notes_for_you`: the integer the execution gate reads must
 * not be one only this component believes in.
 */
export function PlanNoteRow({
  note,
  actions,
  series,
  baseIsCurrent = false,
  focused = false,
  parent = null,
  sectionHeading = '',
}: {
  note: PlanNote
  actions: NoteActions
  /** THIS NOTE'S DIFFS, IN THE ORDER THEY MATTER TO IT — what its author wrote,
   *  the same text against the plan as it stands, and what each OTHER open
   *  proposal on this section would do on top of it.
   *
   *  PASSED IN RATHER THAN DERIVED HERE, and that is the point of the prop. A
   *  row that went looking for its own siblings would be the second place in
   *  this file tree that decides what "the same section" means, and it would
   *  have to reach for the tray to know what the section currently READS as —
   *  which is a thing a note row has no business holding. `PlanEditor` already
   *  has both (`notes`, `pendingText`) and memoizes one series per note.
   *
   *  A ONE-STEP SERIES RENDERS EXACTLY WHAT `{note.display_diff && <PlanDiff/>}`
   *  RENDERED, which is what makes this swap invisible on the ~95% of notes
   *  that are a lone proposal on a section nobody else has touched. */
  series: DiffStep[]
  /** DOES THE DOCUMENT STILL SAY WHAT THIS NOTE'S AUTHOR SAW — asked of the
   *  editor for the same reason `series` is. The honest answer is against the
   *  TRAY's text rather than the wire's `note.section_changed`, and the tray is
   *  a thing a note row has no business reaching for; `PlanEditor` holds it and
   *  memoizes one answer per note beside the series.
   *
   *  DEFAULTS TO `false`, WHICH KEEPS THE QUOTE. A caller that cannot answer
   *  gets the harmless failure — the same text twice on one card — rather than
   *  the lossy one, a snapshot deleted off the only card that carries it. */
  baseIsCurrent?: boolean
  /** Clicking the note's highlight in the document lights up the note. Display
   *  only — it changes no status and stages nothing. */
  focused?: boolean
  /** The note this one answers, resolved by the caller off the UNFILTERED note
   *  list, or `null`. Drives ONE LINE OF TEXT and nothing else — see the
   *  provenance line below. `null` on a dangling `reply_to`, which draws
   *  nothing rather than a broken reference. */
  parent?: PlanNote | null
  /** The heading text of `note.section`, from the server's section index —
   *  used only to drop a quote that merely repeats it. */
  sectionHeading?: string
}) {
  const [compose, setCompose] = useState<Compose>(null)
  const [text, setText] = useState('')
  const stagedAs = actions.staged(note)
  const open = note.status === 'open'

  /* WHO WROTE THIS NOTE — read for the first time by a CONDITION rather than by
     a label. `note.by` was read five times on this row and reached no button
     anywhere, which is why the owner's own note, the owner's own SENT note and
     an agent's note all offered the identical set of verbs.
     THE IDENTITY CONVENTION IS THE FILE'S OWN AND NEEDS NO NEW PROP. The
     literal `'user'` is the owner — `note.to === 'user' ? 'you'` two dozen
     lines below, `parent.by === 'user' ? 'your'` below that — and the wire
     declares it: "an agent name, or the literal `'user'`". No auth-store read,
     no wire change. */
  const mine = note.by === 'user'
  /** Your own note, still in your tray. NOT recomputed here: this is the
   *  editor's own answer, and it is the same one the pending chip a few lines
   *  below is drawn from — so the label and the verbs can never disagree about
   *  whether a note has gone out. */
  const unsent = actions.pending(note)
  /** WAS THIS NOTE IN YOUR BATCH — asked WITHOUT the tray, which is the whole
   *  point of it. `actions.pending` answers "is it in the batch RIGHT NOW",
   *  and `pendingNotes` subtracts `decidedNotes(rows)`: a note you have staged
   *  a decision on is already in the batch AS that decision and must not also
   *  ride as a named id. Correct there, and useless to the staged line, which
   *  renders only once a row exists — so `unsent` is false there for EVERY
   *  note, yours or not, sent or not.
   *
   *  So this is the same question one moment earlier, and it is recomputed
   *  rather than read off `actions` deliberately — the one case where NOT
   *  reusing the editor's answer is what makes the row self-consistent. It is
   *  the predicate the Dismiss button's `mine && unsent` already applies, at
   *  the only time that button renders — `!stagedAs`, where the two coincide.
   *  `!stagedAs` is NOT "nothing is decided", and the gap is real rather than
   *  theoretical: `stagedFor` skips superseded rows (`&& !r.superseded_by`)
   *  while `decidedNotes` deliberately counts them, so a note whose accept row
   *  was overtaken by a `Take @{new}'s` has `stagedAs === null` AND
   *  `unsent === false`. There the button understates — it offers `Dismiss`
   *  where the note is in fact still in the batch — and the staged line does
   *  not render at all, so nothing on the row says anything false. Stated
   *  because the narrower claim is the true one; using it for the staged line
   *  is what makes the label and the sentence agree in every case rather than
   *  in most.
   *
   *  `isPendingNote` already requires `by === 'user'`, which is `mine`'s
   *  definition verbatim, so no author rule is duplicated or forked here. */
  const wasInBatch = isPendingNote(note)

  /**
   * MAY YOU REPLY TO THIS NOTE?
   *
   * Replying to an agent is always meaningful. Replying to YOUR OWN note is
   * meaningful once it has gone out — you are adding to a thread an agent can
   * see — and meaningless while it is still sitting in your tray, where the
   * thing to do is edit the batch rather than answer yourself.
   *
   * THE THIRD CLAUSE IS NOT REDUNDANT AND MUST NOT BE FOLDED BACK INTO
   * `!unsent`. The trap is that `unsent` is false in TWO unrelated situations
   * and only one of them means "this note went out": `isPendingNote` requires
   * `!!n.to && n.to !== 'user'`, so a note of your own addressed to NOBODY was
   * never pending to begin with and reports `unsent === false` while sitting
   * unsent in front of you. Read `!unsent` as "has gone out" and that note
   * slips straight through the gate.
   *
   * What it would slip through INTO is the reason the clause exists: reply to
   * it and the computed addressee is `''`, so the server's fallback fires and
   * resolves to the OWNER — you send YOURSELF a real message and a real to-do.
   * That was live behaviour, pinned rather than discovered, and the plan owner
   * ruled it off the surface (AC-2.1). The assertion that pinned it is
   * INVERTED alongside this clause, not deleted: `PlanInlineNotes.test.tsx`,
   * "a reply to a never-sent note of your own is not offered".
   */
  const mayReply = !mine || (!unsent && !!note.to && note.to !== 'user')

  /** THE QUOTE, CUT INTO THE NAME OF THE THING AND THE THING ITSELF.
   *
   *  The card used to print `note.quote` verbatim into a blockquote, and the
   *  quote is stored as RAW MARKDOWN — whatever the document said, markers and
   *  all. So the one line whose job is to orient the reader was the one line
   *  that rendered as source: a note anchored on `**AC-2.1** — …` printed the
   *  asterisks. Nothing parsed them, because nothing on this card parses
   *  markdown at all (`NoteComment` below is plain text by the same rule), and
   *  the fix is not to start: the quote is an inline FRAGMENT, frequently a
   *  prefix cut at `PLAN_QUOTE_CHARS`, so a block parser would happily read a
   *  leading `-` as a list and an unclosed `**` as literal anyway. Dropping the
   *  markers says exactly what the document says, and says nothing the document
   *  doesn't.
   *
   *  THE LABEL IS LIFTED RATHER THAN REPEATED. A quote that opens with its own
   *  identifier is carrying two facts at once — WHICH clause this note is about,
   *  and WHAT that clause says — and only the first is worth a header chip's
   *  width. The chip takes the identifier, the blockquote keeps the sentence,
   *  and neither prints the other's half, so the row gains the identification at
   *  no vertical cost and the quote below stops stuttering the same token twice.
   *
   *  DISPLAY ONLY. `splitQuoteLabel` never touches what was stored and never
   *  feeds `blockCarries`, so the highlight this note paints in the document is
   *  computed off the whole verbatim quote exactly as before. */
  const { label: anchorLabel, body: quoteBody } = splitQuoteLabel(note.quote)
  /** A quote that is only the heading of the section the card already sits
   *  under (a note on "Goal" stores `Goal`) says nothing the page does not —
   *  and printed as a quote it read like a second message. Compared against
   *  the server's own heading text (`sectionHeading`), display only. */
  const quoteIsHeading =
    !!sectionHeading && quoteBody.trim() === sectionHeading.trim()

  const close = () => {
    setText('')
    setCompose(null)
  }

  const send = () => {
    const body = text.trim()
    if (!body) return
    if (compose === 'reject') actions.onReject(note, body)
    else if (compose === 'reply') actions.onReply(note, body)
    close()
  }

  return (
    <div
      className={
        'plan-note rounded-md border p-3 text-sm ' +
        (focused ? 'plan-note--focused ' : '') +
        (note.kind === 'deviation'
          ? 'border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20'
          : 'border-border bg-sidebar')
      }
      data-note-id={note.id}
      data-note-status={note.status}
    >
      {/* WHICH NOTE THIS ANSWERS, AND IT IS TEXT RATHER THAN PLACEMENT.
          `reply_to` has ridden the payload as provenance since the threading
          deletion and been read by nothing, so a reply looked exactly like an
          unprompted new note. This says the relation out loud without
          reintroducing any of what was deleted: no nesting, no indent, no
          recursion, no `depth`. The partition in `PlanEditor` still places this
          row on its own `section` and `quote`, which is the whole reason a
          response that answers a question about one section with a note on
          ANOTHER has a correct home at all.
          In the ordinary case the two now share a section AND a quote, so
          `PlanBody` has already drawn them under the same block and this line
          only names what the adjacency implies. When they DIFFER the adjacency
          is gone and the line carries the parent's section, which is then the
          only thing on screen tying them together.

          IT NOW QUOTES THE PARENT, AND THAT IS WHAT PAID FOR THE STATUS CHANGE
          BEHIND IT. A reply closes its parent `answered` from BOTH doors now —
          the tray always did, and `plan note --reply-to` does since the
          coordinator's answers stopped leaving the user's questions open. The
          objection that kept the second door from closing was exactly this
          surface: the editor draws only OPEN notes, so a closed question leaves
          the screen and the answer is left standing alone saying "Answering
          your question" about a question nobody can see. So the answer carries
          the question. `noteSummary` is the same one-line cut the comment list
          makes — one function, so the two surfaces cut a note the same way.

          THE `parent` PROP IS RESOLVED OFF THE UNFILTERED NOTE LIST, which is
          what makes this possible at all and is stated at the prop rather than
          assumed here: a parent that just closed is gone from the OPEN list and
          still resolvable from the raw one. The prop's contract did not change;
          it is only now load-bearing.

          IT IS STILL NOT PLACEMENT — no recursion, no `depth`, and nothing here
          moves a note or reads a status. The threading deletion is untouched.

          IT SITS ABOVE THE HEADER, AS ITS OWN STRIP. It used to sit under the
          header as a second blockquote styled exactly like the anchor quote
          below it, so a reply read as two stacked quotes and the reader could
          not tell which was the question and which the excerpt. Now the
          question comes first, attributed, and the reply hangs under it on a
          rail (`.plan-note--reply`): one level, drawn once, read top-down as
          "they asked → you said". */}
      {parent && (
        <div
          className="plan-note-parent"
          data-testid={`plan-note-answering-${note.id}`}
        >
          <div className="plan-note-parent-head">
            <span aria-hidden="true">↩</span> In reply to{' '}
            {parent.by === 'user' ? 'your' : `@${parent.by || 'someone'}'s`}{' '}
            {parent.kind}
            {parent.section !== note.section &&
              ` on ${parent.section || 'the document'}`}
          </div>
          {/* GATED ON THE STRING, not on the kind or the status — the same
              rule `note.resolution` above is gated by, and for the same
              reason. A parent with no comment (a bare proposal) has nothing to
              quote and the strip is its one line. */}
          {parent.comment && (
            <div
              className="plan-note-parent-body whitespace-pre-wrap"
              title={parent.comment}
              data-testid={`plan-note-answering-quote-${note.id}`}
            >
              {noteSummary(parent.comment)}
            </div>
          )}
        </div>
      )}
      <div className={parent ? 'plan-note-reply-body' : undefined}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="font-semibold">@{note.by || 'someone'}</span>
        <span className="text-xs uppercase tracking-wider text-channel">
          {note.kind}
        </span>
        {/* WHICH CLAUSE THIS IS ABOUT, IN ONE TOKEN. Lifted off the head of the
            quote (see `anchorLabel` above), so it costs the card no line of its
            own and the blockquote below is left carrying only the sentence.
            It is monospace because it is an IDENTIFIER — `AC-2.1`, `M2`, `G2` —
            and the one thing a reader does with it is match it character for
            character against the document; a proportional face is where `1` and
            `l` stop being distinguishable at 11px.
            The `title` is the WHOLE quote, markers and all. This chip is a cut
            of it, and the full string is then never more than a hover away. */}
        {anchorLabel && (
          <span
            className="plan-note-anchor"
            title={note.quote}
            data-testid={`plan-note-anchor-${note.id}`}
          >
            {anchorLabel}
          </span>
        )}
        {note.to && (
          <span className="text-xs text-channel">
            → {note.to === 'user' ? 'you' : `@${note.to}`}
          </span>
        )}
        {!note.to && <span className="text-xs text-channel italic">recorded, not sent</span>}
        <span className="text-xs text-channel">{STATUS_LABEL[note.status] ?? note.status}</span>
        {/* THE REASON, RENDERED FOR THE FIRST TIME. `note.resolution` has been
            on the wire since the field was added and NO surface in this repo
            has ever drawn it — which is why a folded-away author, a rejected
            author and an asked author were all told nothing on screen. The
            server guarantees it is non-empty on a folded note and names the
            winning author in it, so THIS is where the chip's object comes from.
            The client does not build that sentence and must not: it has no
            stable knowledge of who won, which is the same reason it sends no
            name on the wire.
            GATED ON THE STRING, NOT ON THE STATUS, and that is deliberate. A
            `status === 'folded'` test would be a SECOND status-keyed site in a
            component whose one rule is that `STATUS_LABEL` above is the only
            one. Gating on the string also means a plain reject's reason and an
            `ask`'s question render here too — with no extra code, no extra
            branch, and no new word to teach when the server grows one. */}
        {note.resolution && (
          <span className="text-xs text-channel" data-testid={`plan-note-resolution-${note.id}`}>
            {note.resolution}
          </span>
        )}
        {note.revision > 0 && (
          <span className="text-xs text-channel">at revision {note.revision}</span>
        )}
        {note.sent && <span className="text-xs text-channel">sent</span>}
        {/* A filed note is not a delivered one: `POST /plan/notes` records it
            and stops, and only a submit that NAMES it puts it in front of the
            addressee. Saying so on the row is what keeps an undelivered comment
            from reading as a delivered one — the same predicate AND the same
            tray the pending list is derived from, so the two can never
            disagree. */}
        {unsent && (
          <span
            className="text-xs text-amber-700 dark:text-amber-400"
            data-testid={`plan-note-waiting-${note.id}`}
          >
            waiting to send
          </span>
        )}
      </div>


      {/* GATED ON THE BODY RATHER THAN ON `note.quote`, and the difference is a
          real card: a note anchored on a bare heading stores `**AC-2.1**` and
          NOTHING else, so the chip above is now saying the whole of it and this
          would be an empty rule with an empty line beside it. */}
      {quoteBody && !quoteIsHeading && (
        <blockquote
          className="plan-note-on whitespace-pre-wrap"
          data-testid={`plan-note-quote-${note.id}`}
        >
          <span className="plan-note-on-label" aria-hidden="true" data-label="on" />
          {quoteBody}
        </blockquote>
      )}

      {note.comment && <NoteComment comment={note.comment} />}

      {/* WHAT THE PLAN SAID WHEN THIS NOTE WAS RAISED, and it renders HERE
          because this is the note that owns it.
          The alarm above used to quote it, on a callout that printed the whole
          comment; the alarm is one line per deviation now and cannot. That
          would have DELETED the fact rather than moved it, and it is not
          recoverable from the pane beside it: `base_section` is a SNAPSHOT
          taken when the note was filed, so on a section that has moved since —
          exactly the case the "This section changed" line one div down is
          about — the document no longer says it anywhere. This is the sentence
          that line was missing.

          TWO GATES, AND EACH CATCHES A DUPLICATE THE OTHER CANNOT SEE. This
          block is a second copy of text already on screen unless BOTH are
          false:
            - a `self` step is drawn. Its left-hand side IS `base_section`
              (`diffSeries` step [0] renders `base_section -> proposal`, and
              the server's `display_diff` renders the same pair), changed or
              not — so ANY card carrying a diff has already printed the whole
              snapshot a few lines above this one.
            - `baseIsCurrent`. The section still reads the way the author saw
              it, so the document pane is saying it verbatim one column over.
          What survives is the one case this block was built for: no diff, and
          a document that has moved on — which is exactly when the amber line
          below fires. The warning says the section changed; this says what it
          changed FROM. They are one thought, and now they arrive together.

          IT IS NO LONGER GATED ON `kind`, AND THE CHECK IT LOST WAS DOING THE
          WRONG JOB IN BOTH DIRECTIONS. It read `kind === 'deviation'`, on the
          reading that only a deviation carries a base without a proposal. But
          `kind` is picked server-side BY PRECEDENCE, deviation first
          (`note_kind`), so a post-acceptance coordinator note that ALSO
          carries replacement text is labelled `deviation` — and printed its
          snapshot twice, above its own diff, which is the duplicate this gate
          exists to stop. In the other direction a STALE PLAIN COMMENT has the
          identical missing sentence and the identical amber warning, and was
          the one card that could never have it. Asking whether the text is
          already on screen answers both; asking which word the server's
          precedence chose answers neither. */}
      {note.base_section && !baseIsCurrent && !series.some((s) => s.kind === 'self') && (
        <div className="mb-2" data-testid="plan-note-base">
          <div className="text-xs text-channel mb-1">The Plan said, when this was raised:</div>
          <blockquote className="border-l-2 border-border pl-2 text-xs text-channel whitespace-pre-wrap plan-note-clamp">
            {note.base_section}
          </blockquote>
        </div>
      )}

      {/* ONE STEP DARKER THAN EVERY OTHER AMBER ON THIS SURFACE, AND THE STEP IS
          NOT A PREFERENCE. An anchored note now has a real background
          (`plan.css`, `.plan-anchored .plan-note`), and a fill under text can
          only ever LOWER its contrast — no background darker than the page can
          raise it. amber-700/400 against the new fill measures 4.52:1 and
          1.50:1, where against the bare page it measured 5.02:1 and 1.67:1, so
          shipping the fill alone would have made the one line inside a note that
          has to be read the one line the fill made quieter.
          amber-800/500 pays that back with interest: 6.38:1 and 1.93:1 on the
          anchored note, and 6.17:1 and 1.87:1 in the list below it, where the
          `bg-sidebar` card had already been costing this warning contrast
          nobody had measured. It gets louder everywhere and quieter nowhere.
          It also stays the LOUDEST amber in the note: "waiting to send" two
          divs up is still amber-700/400 deliberately, so the two no longer
          compete at the same weight for the same eye.
          `planContrast.test.ts` computes all four of those numbers from this
          file's own class names and Tailwind's own palette, so neither the
          class nor the token can move without the arithmetic being redone. */}
      {note.section_changed && (
        <div className="flex items-start gap-1 text-xs text-amber-800 dark:text-amber-500 mb-2">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span>
            This section changed since @{note.by || 'the author'} wrote this. Read it against what
            it says now.
          </span>
        </div>
      )}
      {/* TWO SENTENCES BECAUSE THERE ARE TWO FACTS, and they are not each
          other's negation. A slug that does not resolve means the section was
          DELETED under an old note, or that this very note is what would
          CREATE it — and this row spent its whole life reporting the first
          about both, which told a reader a deletion had happened on notes
          whose entire purpose was to add the section. The server splits them
          (`section_missing` / `section_new`) precisely so this file does not
          have to; the two flags are never both true. */}
      {note.section_new && (
        <div className="text-xs text-channel mb-2">
          This proposes a new section <code>{note.section}</code>.
        </div>
      )}
      {note.section_missing && (
        <div className="text-xs text-channel mb-2">
          The section <code>{note.section}</code> is no longer in the document.
        </div>
      )}

      {/* THE DIFF IS GATED ON THE DIFF, AND `has_proposal` IS NO LONGER PART OF
          THE CONDITION — that is the whole of change C2, and it is a bug fix
          rather than a simplification. `has_proposal` goes FALSE the moment a
          proposal is applied, so the pair `has_proposal && display_diff` would
          suppress exactly the diff the server now takes trouble to preserve:
          `display_diff` is rendered from `proposal or applied_text`, so an
          APPLIED note still carries the record of what was applied. Gating on
          the text itself renders whatever the server chose to keep and nothing
          when it kept nothing — a comment filed against no section renders no
          diff because its `display_diff` is `''`, not because a second flag
          said so.
          IT IS LATENT ON EVERY SURFACE THAT EXISTS TODAY, AND DELIBERATELY
          FIXED BEFORE ONE ARRIVES. `PlanEditor` filters its notes to
          `status === 'open'` in ONE `useMemo`, so no surface in this browser
          draws an applied note at all; the day one does, this line must
          already be right, because the failure mode is a silent absence rather
          than an error. `PlanNoteRow.test.tsx` mounts this component directly
          with an applied note for exactly that reason — driving it through the
          editor would prove nothing, since the editor would never hand one
          over.
          `has_proposal` STILL GATES `Accept`/`Reject` below, and must: there,
          it asks "is there replacement text to apply?", which is a different
          question from "is there a record to show?". */}
      <PlanDiffSeries steps={series} />

      {open && (
        <div className="plan-note-acts" data-testid={`plan-note-acts-${note.id}`}>
          {/* The decision controls disappear once this note is IN the batch —
              the row then says what it was staged as, which is the same fact
              from the other end. `Reply` survives that, because answering a
              note you have already decided on is still a thing to want. */}
          {stagedAs && (
            <div className="plan-note-staged text-xs text-channel">
              {/* ONE KIND GETS A SENTENCE INSTEAD OF A WORD, AND ONLY ON YOUR
                  OWN NOTE. `Staged as dismiss` reports the row and hides the
                  half that already happened: dismissing your own note takes it
                  out of this batch ON THE CLICK — it leaves `pending`, leaves
                  `note_ids`, and loses its chip — while the CLOSE waits for the
                  submit. Two different times in one act, and the old word named
                  neither.
                  GATED ON `mine` AS WELL AS ON THE KIND, WHICH IS ONE CLAUSE
                  MORE THAN THE SPEC'S CONDITION COLUMN. A dismiss staged on an
                  AGENT's note is not a drop from anything: that note was never
                  in your batch — only notes you wrote are — so the row IS the
                  batch entry and "dropped from this batch" would be a sentence
                  the user can see is false. Those rows keep `Staged as
                  dismiss`, which is exactly what they are.
                  `wasInBatch` CARRIES THAT AUTHOR RULE AND THE REST OF IT, on
                  the axis `mine` alone misses. The Dismiss button fifty lines
                  below already gates its label on `mine && unsent`, and the
                  two must agree: a note of yours that has already GONE OUT was
                  never in this batch either, so "dropped from this batch" is
                  just as checkably false there as on an agent's note — as it
                  is on a note addressed to nobody, and on a reply. All three
                  are shapes `isPendingNote` excludes and `mine` does not.
                  NOT `mine && unsent` COPIED DOWN HERE, which is the reading
                  that looks right and is not: `unsent` subtracts the tray's
                  own decisions, and this line renders only once a decision is
                  staged, so `unsent` is false here for every note alive and
                  the sentence would never appear at all. See `wasInBatch`.
                  Nothing is folded into `!unsent`, whose two meanings
                  `mayReply` warns about; this reads the predicate forwards.
                  EVERY OTHER KIND GETS ITS WORD FROM `draftKindWord` AND NOT
                  FROM THE ROW. This line used to print `stagedAs` raw, which
                  made it the last surface saying `ask` about the act the button
                  beside it calls `Reply` — the badge and the button report the
                  same staged row from two ends, so they cannot disagree about
                  what it is. The wire is still readable and still read: it is
                  `data-row-kind` on the tray row, never this sentence. */}
              {stagedAs === 'dismiss' && wasInBatch ? (
                <span data-testid={`plan-note-dropped-${note.id}`}>
                  Dropped from this batch — closes on your next send
                </span>
              ) : (
                <>
                  Staged as <strong>{draftKindWord(stagedAs)}</strong>
                </>
              )}
            </div>
          )}
          <div className="plan-note-grp-b">
            {!stagedAs && (
              <>
                {note.has_proposal && actions.canDecide && (
                  <button type="button" className="plan-btn" onClick={() => actions.onAccept(note)}>
                    Accept
                  </button>
                )}
                {/* NO `Reject` ON THE CONFIRM NOTE, AND IT IS NOT A STYLE
                    CHOICE. The execution gate counts notes that are OPEN, so
                    every way of closing this note releases the coordinator —
                    but only one of them means yes. A reject would leave the
                    plan unconfirmed AND unblocked, i.e. work starting on a plan
                    the user just turned down, so the server refuses that close
                    by name. Rendering the button anyway would be an affordance
                    that always 409s.
                    `has_proposal` is false on this note and would withhold the
                    button on its own; the flag stays because the reason is the
                    gate rather than the absent diff, and a note that later
                    grew one must not grow a Reject with it.
                    WHAT IS LEFT IS `Dismiss` — WHICH NOW MEANS YES ON THIS ONE
                    ROW — AND `Reply`, WHICH IS HOW YOU SAY NO: it reaches the
                    coordinator and leaves the gate up while the plan is
                    revised. Dismiss used to be withheld here too, back when
                    saying yes meant Accepting a one-line diff into an
                    `## Approval` section; that section is gone and so is the
                    diff, so the verb the row already had is the verb the act
                    needs. */}
                {note.has_proposal && actions.canDecide && !note.bootstrap && (
                  <button
                    type="button"
                    className="plan-btn"
                    onClick={() => setCompose((c) => (c === 'reject' ? null : 'reject'))}
                  >
                    Reject
                  </button>
                )}
                {/* THE SAME ACT, NAMED FOR WHAT IT DOES — THREE READINGS, ONE
                    HANDLER, ONE `dismiss` KIND ON THE WIRE. Nothing about the
                    act changes here; only which of its three true sentences
                    the button says.
                    `Dismiss` reads as "make this go away", which is right on
                    an agent's note and wrong on both of your own shapes. On a
                    note you wrote and have NOT sent it is over- and
                    under-promising at once: it does not unwrite the note
                    (nothing can), and it DOES take it out of this batch
                    immediately — `Drop from this batch`.
                    `WITHDRAW` IS THE THIRD, AND IT IS WHY THE BUTTON IS STILL
                    HERE AT ALL. Your own note that has already gone out is a
                    request sitting with its addressee; closing it is retracting
                    what you asked for, not disposing of something someone sent
                    you. It reads as a chore under the old word, which is
                    exactly the complaint the direction split in
                    `PlanCommentList` answers — and a chore is what it looked
                    like precisely because it was named for the wrong act.
                    WITHHOLDING IT INSTEAD WAS THE OTHER CANDIDATE AND IS
                    WRONG. A reply now closes its parent, so the ordinary end of
                    your request is the coordinator answering it — but the
                    coordinator may also just act on it and close it with
                    `plan resolve`, and nothing forces either. Take the button
                    away and a note whose addressee never comes back is open
                    forever with no control on any surface that can close it;
                    that is worse than a button named for the wrong verb, and
                    it is strictly worse than one named for the right one. */}
                {/* AND IT IS RENDERED ON THE CONFIRM NOTE TOO — the one place
                    `Dismiss` is not "make this go away" but "yes, start". The
                    note's own comment is what says so ("dismiss this note and
                    I'll start", or before the coordinator has offered the plan,
                    "dismiss now only if you want work to start on the draft as
                    it stands"), which is why the label is not special-cased
                    here: a second word for the same button would be a second
                    thing to keep true, and the server accepts exactly one verb
                    on this note either way — in both wordings. `mine` is false on it — the keeper
                    wrote it — so it reads `Dismiss`, like every agent's note. */}
                <button type="button" className="plan-btn" onClick={() => actions.onDismiss(note)}>
                  {!mine ? 'Dismiss' : unsent ? 'Drop from this batch' : 'Withdraw'}
                </button>
              </>
            )}
            {/* `Reply` sits OUTSIDE the `!stagedAs` fragment deliberately —
                answering a note you have already decided on is still a thing to
                want — and `mayReply` is the author axis, not the staging one.
                Its third clause is the one that looks redundant and is not;
                see its definition before touching it. */}
            {mayReply && (
              <button
                type="button"
                className="plan-btn"
                data-testid={`plan-note-reply-${note.id}`}
                onClick={() => setCompose((c) => (c === 'reply' ? null : 'reply'))}
              >
                <MessageSquare size={12} /> Reply
              </button>
            )}
          </div>
          <span className="plan-note-grp-h">
            nothing reaches the plan or its addressees until you submit
          </span>
          {/* WHY `Accept` AND `Reject` ARE NOT HERE — TWO SENTENCES, NEVER ONE
              HEDGE. The verbs are withheld by two unrelated conditions and the
              card used to state neither, so the reader saw one absence and
              could not tell which cause produced it: the note carries no
              replacement text, or this identity may not decide at all.
              Collapsing them into a single hedge would under-report both, and
              this surface already has the precedent and the reasoning for
              refusing that — `PlanBody`'s `looseReason` prints two different
              sentences rather than one, because "the two cases are
              distinguishable here". They are distinguishable here too.
              THEY ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION — the first requires
              `!has_proposal`, the second `has_proposal` — so at most one ever
              renders and no ordering between them is being relied on.
              Both live in the existing help slot's group: no new layout, no new
              class, no CSS.
              THE REMEDY CLAUSE IS GATED ON `mayReply`, WHICH IS NEW AND IS NOT
              COSMETIC. This line used to say "Ask for one" while `Ask` was a
              button of its own, withheld by its own condition (`!mine`) that
              this line never consulted — so on your own note it named a verb
              that was not on screen. Now that the verb is `Reply`, pointing at
              a button that is not rendered is the same fault made checkable,
              and `mayReply` is exactly the predicate that renders it. When it
              is false — your own note, never sent — the sentence keeps the half
              that is still true and stops. */}
          {!stagedAs && !note.has_proposal && (
            <span className="plan-note-grp-h" data-testid={`plan-note-why-none-${note.id}`}>
              No proposed text on this note — nothing to accept or reject.{' '}
              {mayReply
                ? 'Reply to ask for one, or edit the section yourself.'
                : 'Edit the section yourself.'}
            </span>
          )}
          {note.has_proposal && !actions.canDecide && (
            <span className="plan-note-grp-h" data-testid={`plan-note-why-not-you-${note.id}`}>
              Only the plan&apos;s owner can accept or reject a proposal.
            </span>
          )}
        </div>
      )}

      {compose && (
        <div className="mt-2">
          <textarea
            className="w-full h-20 text-xs rounded border border-border bg-transparent p-2"
            aria-label={
              compose === 'reject'
                ? 'Why are you rejecting this?'
                : `Reply to @${note.by || 'this note'}`
            }
            placeholder={
              compose === 'reject'
                ? 'Why are you rejecting this?'
                : 'Say it here — ask for something or answer it. It hangs under the same line.'
            }
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="flex gap-2 mt-1">
            <button
              type="button"
              className="plan-btn plan-btn--primary"
              data-testid={`plan-note-send-${note.id}`}
              disabled={!text.trim()}
              onClick={send}
            >
              {/* `Stage` on every branch, because every branch stages. Naming
                  Reply differently is what made it read as the immediate one. */}
              Stage
            </button>
            <button type="button" className="plan-btn" onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

/** THE COMMENT BODY, CLAMPED UNTIL ASKED.
 *
 * A deviation comment is an agent explaining itself and routinely runs to
 * thousands of characters. Rendered whole it buries the note's own `Accept` /
 * `Reject` / `Reply` / `Dismiss` bar under a screenful of prose — the reader
 * has to scroll past the argument to reach the decision it is asking for,
 * every time, on every note in the list.
 *
 * CLAMPED, NOT TRUNCATED, and the difference is that nothing is lost: `Show
 * all` reveals the same text in place, and `line-clamp` only ever hides what
 * the reader chose not to open. This is display state and nothing else — the
 * note, the wire and the tray are untouched by it.
 *
 * THE THRESHOLD IS THE PARAGRAPH'S LENGTH, NOT ITS RENDERED HEIGHT. Measuring
 * height would mean a layout read after paint, and would make the toggle appear
 * and disappear as the pane is resized. `CLAMP_CHARS` is a proxy chosen to sit
 * comfortably above `MAX_LINES` worth of text at this width, so a note the
 * clamp would not have shortened never grows a control that does nothing.
 */
const MAX_LINES = 12
const CLAMP_CHARS = 900

function NoteComment({ comment }: { comment: string }) {
  const [open, setOpen] = useState(false)
  const long = comment.length > CLAMP_CHARS || comment.split('\n').length > MAX_LINES
  return (
    <div className="mb-2">
      <p
        className={'whitespace-pre-wrap' + (long && !open ? ' plan-note-clamp' : '')}
        data-testid="plan-note-comment"
        data-clamped={long && !open ? 'true' : 'false'}
      >
        {comment}
      </p>
      {long && (
        <button
          type="button"
          className="plan-btn mt-1"
          data-testid="plan-note-comment-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}


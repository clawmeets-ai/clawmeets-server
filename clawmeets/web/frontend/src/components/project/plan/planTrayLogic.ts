import type {
  DraftEntry,
  PlanIndex,
  PlanNote,
  PlanSection,
  PlanVersion,
} from '../../../api/endpoints/projectPlans'

/* The tray's logic, as pure functions, so the rules AC-6.3 / 6.4 / 6.6 state
 * can be asserted without mounting a component.
 *
 * NOTHING HERE PARSES MARKDOWN. Every heading, slug, depth, box count and
 * character offset arrives from the server's one grammar; this module only ever
 * *consumes* `char_start`/`char_end`, which §6.B ships for exactly that purpose.
 * A client-side scanner would reintroduce the bug the server's fence-awareness
 * rule prevents — a plan document that documents this grammar parses its own
 * code samples as structure. */

/** A tray row plus the one display state that is NOT a wire kind.
 *
 * `superseded_by` labels a row whose text was overtaken by a later accept on
 * the same section. It stays `kind: 'accept'` on the wire — `DraftEntry.kind`
 * is five values and `PUT /plan/draft` rejects a sixth — and the row stays in
 * the tray, individually undoable. */
export interface TrayRow extends DraftEntry {
  superseded_by?: string
  /** `superseded_by`'s TWIN, FOR THE OUTCOME THAT DISCARDS NOTHING — the id of
   *  the row this one's text was folded INTO.
   *
   *  Local, like its twin, and for a sharper reason. `DraftEntry.folded` is one
   *  bit precisely so the client never names a winner on the wire; this names
   *  one in the TRAY, which is a different claim with a different lifetime. It
   *  answers two questions nothing else can once a folded row stays live: which
   *  row `heldTextRow` must skip when a THIRD proposal arrives on the section,
   *  and which rows `✕` on the winner has to un-fold. Both are about the tray
   *  as it stands, both are re-derived on every stage, and neither survives
   *  `toWire`.
   *
   *  NOT `superseded_by` REUSED, though the mechanics are identical:
   *  `PlanCommentList` prints the literal word *superseded* beside such a row
   *  and dims it, and both are false of text that is in the document. Same
   *  shape, opposite news. */
  folded_by?: string
}

/** Strip the client-side markers before anything reaches the wire.
 *
 *  `folded` is NOT stripped — it is the one member of this pair the server
 *  reads, and the whole point of the change. `folded_by` is, for the same
 *  reason `superseded_by` is: it is a row id, local to this tray and reset on
 *  every page load, and the server keys decisions on `note_id` and edits on
 *  `section`, never on it. */
export function toWire(rows: TrayRow[]): DraftEntry[] {
  return rows.map(({ superseded_by: _dropped, folded_by: _local, ...entry }) => entry)
}

/** THE DISPLAY WORD FOR A DRAFT KIND, WHICH IS NOT THE WIRE VALUE.
 *
 * `ask` reads `reply`, and only `reply`. Change 9 collapsed `Ask` into `Reply`
 * and deliberately left the kind alone — `Reply` still stages `kind: 'ask'`
 * (`askRow`) because `DRAFT_KINDS` is server-persisted in `plan.json` and an
 * in-flight tray on disk holds the old word. So the two vocabularies have to
 * meet somewhere, and this is the somewhere: ONE map, read by the tray row and
 * by the note bar's staged badge, so a user who clicked `Reply` is never told
 * they staged something else.
 *
 * NOT A RENAME OF THE KIND, AND THE DIFFERENCE IS CHECKABLE. `data-row-kind`
 * and everything `toWire` emits keep the raw `DraftEntryKind`; only text a
 * human reads comes through here. Every other kind is already its own word and
 * is listed anyway, so an unmapped kind is visible as an omission rather than
 * as a silent fallthrough — which is what the `?? kind` guard covers. */
const DRAFT_KIND_WORD: Record<string, string> = {
  edit: 'edit',
  accept: 'accept',
  reject: 'reject',
  ask: 'reply',
  dismiss: 'dismiss',
}

export function draftKindWord(kind: string): string {
  return DRAFT_KIND_WORD[kind] ?? kind
}

/**
 * THE ONE-LINE FORM OF A COMMENT.
 *
 * TWO READERS NOW, WHICH IS WHY IT LIVES HERE RATHER THAN IN THE LIST. It
 * was `PlanCommentList`'s private helper while the comment list was the only
 * surface that had to say a note in one line. `PlanNoteRow`'s "Answering your
 * question" line is the second: with a reply now CLOSING its parent, the
 * question leaves the screen, and the answer has to carry enough of it to
 * still read as an answer. Both want the identical cut, so there is one.
 *
 * First non-empty line -> cut at the first sentence end -> trim the leading
 * bullet / quote decoration and the inline `**` and backticks that are noise at
 * 12.5px -> collapse whitespace -> cap at 120 characters.
 *
 * IT READS NO MARKDOWN GRAMMAR, and a leading `#` is deliberately left alone
 * rather than stripped as a heading mark. There is ONE grammar in this system
 * and it is the server's (`models/plan_markdown.py`); a second one in the
 * client is the thing `planTransport.test.ts` exists to fail on, and it is
 * right to — a client scanner reads a plan's own `## Goal` code sample as
 * structure. What is trimmed here is DECORATION on one line of prose, not
 * structure derived from a document.
 *
 * KIND-AGNOSTIC, WHICH IS THE ONLY THING THAT CHANGED WHEN THE LIST STOPPED
 * BEING THE DEVIATION ALARM. It was `deviationSummary`; the body is untouched,
 * because a deviation comment was never a different KIND of prose from an
 * ordinary one — it was only the longest.
 *
 * IT IS NEVER THE WHOLE COMMENT, and that is the point. A deviation comment is
 * written by an agent explaining itself and runs to thousands of characters;
 * the note card below renders it in full, inside the pane's own scroller, and
 * this row's job is to ROUTE to that card rather than to reproduce it. The old
 * alarm printed the comment whole, and on a long one it took the height the
 * tray needed — `Send review` left the screen entirely (`plan.css`,
 * `.plan-cl`, for the bound that now makes that impossible).
 *
 * TOTAL: '' in, '' out; a comment with no sentence break returns the capped
 * first line. The CSS clamps to one line as well, so a summary that somehow
 * gets long still cannot grow the box — the cap here is for the READER, the
 * clamp there is for the LAYOUT, and neither is the other's guarantee.
 */
export function noteSummary(comment: string): string {
  const first = comment.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  // Sentence end = terminator followed by a space, so `4.5 slides` and
  // `v1.2` do not read as the end of anything.
  const end = first.search(/[.?!]\s/)
  const sentence = end === -1 ? first : first.slice(0, end + 1)
  const clean = sentence
    .replace(/^[-*+>\s]+/, '')
    // THE BACKTICK IS `\u0060` AND NOT A LITERAL ONE, WHICH IS A REAL
    // CONSTRAINT AND NOT A STYLE TIC. `planTransport.test.ts` strips string
    // and template literals before it looks for code, with a naive
    // `/`(?:[^`\\]|\\.)*`/` — so a lone backtick ANYWHERE in this file opens
    // a template literal to that scanner and swallows every line until the
    // next one. `sectionText`'s `body.slice(` is below, and it is the exact
    // call site that test exists to pin. Same character, same behaviour, no
    // hole in the check.
    .replace(/\*\*|\u0060/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > 120 ? `${clean.slice(0, 119).trimEnd()}…` : clean
}

/** A section's current text, located by the offsets the SERVER derived.
 *
 * This is the one place the client indexes into `body`, and it does so with
 * numbers it did not compute. Everything downstream — the raw editor's seed,
 * an accept row's `base`, the collision candidates — comes through here. */
export function sectionText(body: string, section: PlanSection): string {
  return body.slice(section.char_start, section.char_end)
}

/** Is `inner` nested inside `outer`?
 *
 * OFFSET CONTAINMENT, NOTHING ELSE — `depth` is never consulted, so a document
 * that skips a heading level (`##` straight to `####`) nests the same way the
 * server's extents already say it does. A section is not inside itself, and two
 * sections sharing a `char_start` cannot nest either way. */
function contains(outer: PlanSection, inner: PlanSection): boolean {
  return inner.char_start > outer.char_start && inner.char_end <= outer.char_end
}

/**
 * THE SECTIONS THE DOCUMENT BODY ACTUALLY DRAWS.
 *
 * Every section still arrives from the server and none is invented here. The
 * one thing this drops is a section nested inside one whose text the tray has
 * STAGED: staged text is the parent's whole extent, descendants included, so
 * drawing the children beside it would print them twice again — the same bug,
 * one edit later. Their notes fall to the rail for the life of the edit, which
 * is the mechanism that already handles a section the pane does not show.
 *
 * Offsets only, in source order. No Markdown is read.
 */
export function visibleSections(
  sections: PlanSection[],
  hasStagedText: (slug: string) => boolean,
): PlanSection[] {
  const staged = sections.filter((s) => hasStagedText(s.id))
  if (staged.length === 0) return sections
  return sections.filter((s) => !staged.some((parent) => contains(parent, s)))
}

/**
 * A SECTION'S TEXT AS IT SHOULD BE DRAWN — its extent truncated at the first
 * VISIBLE section nested inside it, its whole extent when none is.
 *
 * `parse_sections` returns a nested heading TWICE: as its own section, and
 * inside its parent's extent. Whoever draws both has to draw the overlap once,
 * and the parent is the one that gives it up — so `## Milestones` prints its
 * heading line and `### M1`…`### M4` print themselves, instead of every
 * milestone appearing under both.
 *
 * TRUNCATED AT THE FIRST *VISIBLE* CHILD, not the first child, and that word is
 * the whole rule: focus `## Milestones` alone and no child is drawn, so it must
 * render its milestones in full. Same function, both panes.
 *
 * The split is ONE offset because every descendant is contiguous at the tail of
 * an extent — the server's own invariant (`_section_texts`), not a guess made
 * here.
 *
 * Returns a PREFIX of `sectionText(body, section)`. That is what keeps
 * click-to-edit correct: remark reports a block range against the string it was
 * handed, and a range inside a prefix is the same range inside the whole
 * string, so `spliceBlock` keeps seeding from the full text and the descendant
 * tail is carried across verbatim.
 *
 * The truncation is expressed as a NARROWED EXTENT handed to `sectionText`,
 * the way `preambleText` expresses the title block, so `sectionText` remains
 * the one place this client slices the document.
 */
export function sectionOwnText(
  body: string,
  section: PlanSection,
  visible: PlanSection[],
): string {
  let stop = section.char_end
  for (const other of visible) {
    if (contains(section, other) && other.char_start < stop) stop = other.char_start
  }
  return sectionText(body, { ...section, char_end: stop })
}

/**
 * The document's title block — everything before the first section.
 *
 * A leading `# ` heading on a document that also has deeper headings is the
 * TITLE and the server never sends it as a section, so it has no `char_start`
 * of its own. Its extent is nonetheless an extent, and it is expressed as one
 * here rather than as a second index into `body`: the preamble runs from 0 to
 * where the first section begins, and `sectionText` remains the ONE place this
 * client slices the document.
 */
export function preambleText(body: string, sections: PlanSection[]): string {
  if (sections.length === 0) return body
  return sectionText(body, { ...sections[0], char_start: 0, char_end: sections[0].char_start })
}

/**
 * The word a section is called in a list.
 *
 * A section with NO heading is the document's opening prose — the server sends
 * one when a plan has text between its title line and its first heading — and
 * an empty string is not a label. No slug vocabulary is declared here: the
 * empty heading is the whole predicate, so this stays true of whatever the
 * server decides to call that section.
 */
export function sectionLabel(section: PlanSection): string {
  return section.heading.trim() || 'Overview'
}

export function findSection(index: PlanIndex, slug: string): PlanSection | undefined {
  return index.sections.find((s) => s.id === slug)
}

let seq = 0
/** Row ids are client-side and local to a tray; the server keys decisions on
 *  `note_id` and edits on `section`, never on this. */
function rowId(kind: string): string {
  seq += 1
  return `r-${kind}-${seq}`
}

/**
 * AC-6.6 — raw editing IS section changes, and the count of rows is the count
 * of sections whose text actually moved.
 *
 * Returns the row for one edited section, or `null` when the text is
 * byte-identical to what the document says. That `null` is the trap this
 * function exists to close: an editor that emits a row on every blur produces a
 * phantom write — a revision, a changelog entry and a `FILE_UPDATED` for a
 * section nobody changed.
 *
 * `base` is the text as the document reads NOW, which is what makes the write
 * land. It is captured here and never recomputed: if the document moves
 * afterwards the submit is refused with this row's `base` beside the current
 * text, which is AC-6.5's reconciliation and not a silent overwrite.
 */
export function editRow(section: PlanSection, base: string, next: string): TrayRow | null {
  if (next === base) return null
  return {
    id: rowId('edit'),
    kind: 'edit',
    section: section.id,
    text: next,
    base,
    note_id: '',
    comment: '',
    to: '',
    at: new Date().toISOString(),
  }
}

/** An accepted proposal, staged. Writes zero bytes (AC-6.3): the note stays
 *  `open` until the batch is submitted, because a staged accept is a PROPOSAL
 *  to accept and the note's status only ever changes through the resolve
 *  route. */
export function acceptRow(note: PlanNote, currentText: string): TrayRow {
  return {
    id: rowId('accept'),
    kind: 'accept',
    section: note.section,
    text: note.proposal,
    base: currentText,
    note_id: note.id,
    comment: '',
    to: '',
    at: new Date().toISOString(),
  }
}

/** A REPLY, STAGED — the same `ask` row `decisionRow` builds, with the one
 *  thing a reply needs that a bare Ask does not: an addressee it computed
 *  itself.
 *
 *  IT IS AN `ask` ROW AND NOT A SIXTH KIND. The server files it as an ordinary
 *  note with `reply_to = parent.id` and a `quote` DERIVED from `note_id` — so
 *  the row carries neither, and this is not a wire change. `DraftEntryKind`
 *  stays five values. The note reads back with `kind: 'reply'`, which the
 *  server derives from `reply_to` alone: there is no stored kind to stamp any
 *  more, and an agent's `plan note --reply-to` now prints as a reply too, which
 *  the old stamped `"question"` never managed.
 *
 *  `to` IS COMPUTED HERE RATHER THAN LEFT TO THE SERVER'S `or parent.by`
 *  FALLBACK, and the difference is not cosmetic: on a reply to YOUR OWN note
 *  `parent.by` is the literal `"user"`, so the fallback addresses your reply
 *  back to you. The rule is the one the editor already used — reply to an
 *  agent's note and it goes to that agent, reply to your own and it goes to
 *  whoever you originally addressed. The fallback stays what it is, reached
 *  only when the computed answer is empty.
 *
 *  THE PARENT DOES NOT STAY OPEN, AND THIS COMMENT USED TO SAY IT DID.
 *  Submitting an `ask` row closes the parent `answered` in the same
 *  transaction (AC-5.9, `submit_review`) — replying IS answering on this door.
 *  What is unchanged is the arithmetic this note exists for: the reply is
 *  still a NEW open note, so `Reply` still costs one against
 *  `PLAN_LIMITS.openNotes` and the tray still watches it. The parent's close
 *  lands after the budget is counted and buys the row nothing.
 *
 *  `plan note --reply-to` — the agents' door — closes the parent `answered` too.
 *  The question does not vanish with it: `PlanNoteRow` draws the closed parent
 *  above the reply, resolved off the unfiltered note list. */
export function askRow(note: PlanNote, comment: string, to: string): TrayRow {
  return { ...decisionRow('ask', note, comment), to }
}

/** A decision that moves no bytes: reject / ask / dismiss. A submit of only
 *  these appends no `FILE_UPDATED` and leaves `revision` unchanged — the
 *  converse half of AC-6.4, and the server's to enforce, not this client's to
 *  predict. */
export function decisionRow(
  kind: 'reject' | 'ask' | 'dismiss',
  note: PlanNote,
  comment = '',
): TrayRow {
  return {
    id: rowId(kind),
    kind,
    section: note.section,
    text: '',
    base: '',
    note_id: note.id,
    comment,
    to: '',
    at: new Date().toISOString(),
  }
}

/**
 * U5 — is there already a row carrying text for this section?
 *
 * Two ACCEPTED proposals on one section is a collision, and it exists at all
 * only because a proposal is a WHOLE-SECTION replacement: under a per-block
 * model two accepts composed and both landed, so there was nothing to decide.
 *
 * This is a STAGING-TIME question on an UNSENT tray, and it is a different
 * mechanism from the cross-batch one. It consults neither `section_changed` nor
 * any force flag and does not touch `base` — nothing has reached the server, so
 * there is no stale write to weaken.
 *
 * A FOLDED ROW IS SKIPPED FOR THE SAME REASON A SUPERSEDED ONE IS, and adding
 * that arm is what keeps a stack of THREE composing. On a server that records
 * folds the overtaken row STAYS a live `accept` row — that is the whole change
 * — so `.find()` would return the FIRST proposal on the section rather than the
 * text currently standing, and the third fold would be computed against text
 * that is no longer the winner. The two markers mean opposite things about
 * whether the text landed and the identical thing about whether this row is the
 * one to collide against.
 */
export function heldTextRow(rows: TrayRow[], section: string): TrayRow | undefined {
  return rows.find(
    (r) =>
      r.section === section &&
      (r.kind === 'edit' || r.kind === 'accept') &&
      !r.superseded_by &&
      !r.folded,
  )
}

/**
 * THE ROW THE SERVER WILL ACTUALLY APPLY to this section — the SUBMIT-time
 * question, which is not the staging-time one `heldTextRow` answers.
 *
 * `_collapse_text_rows` keeps the LAST text row per section and resolves every
 * earlier one `rejected`. A settled collision leaves the tray holding TWO text
 * rows for one section — the superseded loser, kept on purpose so `✕` can undo
 * the choice, and the winner appended after it — and `toWire` sends both,
 * because `superseded_by` is a label this client never puts on the wire. So the
 * row a refusal is ABOUT is the last one, and reaching for the first is how the
 * post-refusal panel comes to re-base a proposal the user already discarded:
 * the winner keeps its stale `base` and the next Send earns the identical
 * `409`, forever.
 *
 * KEYED ON `kind`, EXACTLY AS THE SERVER IS, and not on `text` being non-empty.
 * An accepted DELETE is an `accept` row whose `text` is `''` — a truthiness
 * test skips it, and a section whose only staged row is a delete then has no
 * row for the refusal panel to offer at all.
 */
export function appliedTextRow(rows: TrayRow[], section: string): TrayRow | undefined {
  let found: TrayRow | undefined
  for (const r of rows) {
    if (r.section === section && (r.kind === 'edit' || r.kind === 'accept') && !r.superseded_by) {
      found = r
    }
  }
  return found
}

/**
 * EVERY staged text row for one section, dropped.
 *
 * "Keep what it says now" on a refused submit means the section keeps the
 * DOCUMENT's text, and that has to include the superseded loser. `removeRow` is
 * the wrong tool here and deliberately so: its `✕` semantics un-supersede the
 * row a `Take @{new}'s` overtook — correct when the user is undoing that
 * choice, wrong here, where it resurrects a proposal they already discarded and
 * stages it, unreviewed, against the very section they just said to leave
 * alone.
 *
 * Decisions that write no bytes — reject / ask / dismiss — are untouched. They
 * are not what the document moved under.
 */
export function dropTextRows(rows: TrayRow[], section: string): TrayRow[] {
  return rows.filter(
    (r) => !(r.section === section && (r.kind === 'edit' || r.kind === 'accept')),
  )
}

/**
 * The three-way outcome, applied to the tray.
 *
 * - `held` — the second candidate is never staged. Nothing you typed is lost
 *   because nothing was typed.
 * - `next` — the held row is MARKED superseded and STAYS, individually
 *   undoable. Its note resolves `rejected` with a server-written reason at
 *   submit, never `applied`: its text did not reach the document, and the agent
 *   whose work was dropped must not be told it landed.
 * - `own` — ONE `edit` row carrying the user's reconciled text, scoped to the
 *   section in dispute. Never a whole-document edit, which would lose both
 *   candidates by widening past the section being argued about.
 */
export function resolveCollision(
  rows: TrayRow[],
  held: TrayRow,
  next: TrayRow,
  choice: 'held' | 'next' | 'own',
  ownText = '',
): TrayRow[] {
  if (choice === 'held') return rows
  if (choice === 'next') {
    return [
      ...rows.map((r) => (r.id === held.id ? { ...r, superseded_by: next.id } : r)),
      next,
    ]
  }
  return [
    ...rows.map((r) => (r.id === held.id ? { ...r, superseded_by: 'own' } : r)),
    {
      ...next,
      id: rowId('edit'),
      kind: 'edit' as const,
      note_id: '',
      text: ownText,
    },
  ]
}

/**
 * THE SENTENCE THE FOLDED-AWAY AUTHOR IS TOLD WHEN THE SERVER CANNOT SAY IT
 * ITSELF — the `records_folds: false` branch of `stackRows` and nothing else.
 *
 * DEAD ON THE CAPABLE BRANCH, AND THE COMMENT THAT STOOD HERE WAS WRONG TWICE.
 * It said `NOTE_STATUSES` is "a closed set of five with no `merged` in it": it
 * is SIX now, and the sixth is `folded`. And it said `_close_note` "delivers to
 * the agent", which was false when it was written — `_close_note` stored the
 * reason on `note.resolution` and no surface in this repo read the field back
 * out, so the folded-away author was told nothing at all. Delivery arrived with
 * the batch-message change that shipped beside the fold record; the sentence is
 * true today and was not, and saying which is the difference between a comment
 * that documents the code and one that flatters it.
 *
 * IT ALSO CARRIES A BUG THAT IS NOT FIXED HERE. `into` is the winner's author
 * as it stood at STAGING time, so fold A→B and then B→C and A is still told it
 * was folded into @B's change — which is not what landed. On the capable branch
 * the question cannot arise, because the server derives the winner from its own
 * collapse and this function is never called. Fixing it on the else-branch
 * would be a third code path in a branch whose entire job is to be exactly what
 * shipped, so it stays, deliberately, and it goes when the branch goes.
 */
export function foldedReason(into: string): string {
  const who = into ? `@${into}'s` : 'the'
  return `Folded into ${who} change — your text is in the section that landed.`
}

/**
 * BOTH PROPOSALS, STAGED AS ONE WRITE.
 *
 * `folded` is the text the caller already produced with `foldProposal`: the
 * held text with the incoming proposal's CHANGE applied on top of it. This
 * function does not compute it and must not — whether two proposals compose is
 * a question about diffs, and this module's first rule is that it reads
 * offsets and never parses.
 *
 * `recordsFolds` SELECTS WHAT HAPPENS TO THE ROW THAT LOST THE SECTION, AND IT
 * IS THE ONLY THING IT SELECTS. Everything else — the winner appended last, the
 * held row with no note dropped, the fold text itself — is identical either
 * way, which is what makes this one conditional rather than two functions
 * standing beside each other.
 *
 *   TRUE  — the held row STAYS the `accept` row it already is and gains
 *           `folded: true` plus the local `folded_by`. Same `note_id`, same
 *           `base`, same text. Two text rows reach the wire, loser first;
 *           `_collapse_text_rows` collapses it exactly as it collapses a
 *           `Take @{new}'s` loser, and the superseded loop reads the boolean
 *           and closes the note `folded` with "your text is in the section that
 *           landed" instead of `rejected` with "superseded by @{by}". `reason`
 *           IS UNUSED ON THIS BRANCH, and that is the fix rather than a
 *           side-effect: no sentence and no author name crosses the wire, so
 *           there is nothing for a third proposal to make stale.
 *
 *   FALSE — the held row is REPLACED by a `dismiss` row carrying `reason`,
 *           unchanged from what shipped, bug for bug. A `dismiss` is not a text
 *           row, so `_collapse_text_rows` never sees it and the server never
 *           writes its own superseded sentence over it. It is the truest thing
 *           a five-status server allows, it is still not the status the work
 *           deserves, and it is here for ONE release — see below.
 *
 * FOLLOWUP, ONE RELEASE LATER AND DELIBERATELY NOT IN THIS CHANGE: delete the
 * else-branch, delete `foldedReason`, delete the `reason` parameter, and let
 * `recordsFolds` become a precondition rather than a selector. The flag exists
 * because production serves a new bundle to an old server for about a minute on
 * every public-UI deploy, and unboundedly after a rollback that reverts the
 * Python and forgets the bundle; one release is how long that has to be
 * tolerated, not forever. Deleting it in THIS change is precisely what the flag
 * was chosen instead of.
 *
 * A HELD ROW WITH NO NOTE IS SIMPLY DROPPED, ON BOTH BRANCHES, and that covers
 * two callers without a branch for either: the user's own `edit` row (its text
 * is already inside `folded`, and there is no note to close) and the SYNTHETIC
 * current-text row the `section_changed` path builds, which is in no tray at
 * all — so the filter matches nothing and the fold is staged against the
 * document. Keeping such a row on the capable branch would leave a live text
 * row with no `note_id`, which the server would collapse and read `folded` off
 * on behalf of nobody.
 *
 * THE WINNER IS APPENDED LAST because that is the row the server applies, and
 * `appliedTextRow` reads the same end of the array for the same reason. IT
 * NEVER CARRIES `folded`: the contract sets the bit on the rows being folded
 * away and on no other, because the bit is what tells the server which notes to
 * close, not which text to write.
 */
export function stackRows(
  rows: TrayRow[],
  held: TrayRow,
  heldNote: PlanNote | undefined,
  next: TrayRow,
  folded: string,
  reason: string,
  recordsFolds: boolean,
): TrayRow[] {
  const winner: TrayRow = { ...next, text: folded }
  const kept = rows.flatMap<TrayRow>((r) => {
    if (r.id !== held.id) return [r]
    if (!heldNote) return []
    return [
      recordsFolds
        ? { ...r, folded: true, folded_by: winner.id }
        : decisionRow('dismiss', heldNote, reason),
    ]
  })
  return [...kept, winner]
}

/** Undo one row. `✕` removes exactly one — never the section's other rows and
 *  never a note's status, which no client path touches. Un-superseding the row
 *  a `Take @{new}'s` overtook is the same operation from the other end.
 *
 *  UN-FOLDING IS THAT SAME OPERATION AGAIN, and it is not optional once a
 *  folded row stays live. `✕` on the WINNER of a fold has to give the section
 *  its text row back; without this it leaves an ORPHAN still carrying
 *  `folded: true` — the only text row on the section, so the server collapses
 *  to it and APPLIES it, while its own boolean asks for the note to be closed
 *  as folded away into a row that no longer exists. The author would be told
 *  their text was folded into a change that was never written.
 *
 *  BOTH KEYS ARE DELETED RATHER THAN SET FALSE, so `folded` reaches the wire
 *  only ever as `true` and is omitted otherwise. That is the JSON shape the
 *  contract names, and it is the shape that reproduces the old behaviour byte
 *  for byte on a server that has never heard of the field. */
export function removeRow(rows: TrayRow[], id: string): TrayRow[] {
  const dropped = rows.find((r) => r.id === id)
  return rows
    .filter((r) => r.id !== id)
    .map((r) => {
      if (!dropped) return r
      if (r.superseded_by === id) return { ...r, superseded_by: undefined }
      if (r.folded_by === id) {
        const { folded: _wasFolded, folded_by: _into, ...live } = r
        return live
      }
      return r
    })
}

/**
 * Is this note waiting to go out with the next batch?
 *
 * The client's mirror of the server's `pending_notes()`, and the ONE predicate
 * behind both the tray's pending list and the note row's own label — two
 * answers to "is this out yet?" is how a note comes to say `sent` in one place
 * and `waiting` in another.
 *
 * `to === ''` is "recorded, never sent" and is excluded for the same reason the
 * server excludes it: naming such a note in `note_ids` makes the server address
 * it to the KEEPER, which is not what "recorded" was asked to mean. A note
 * addressed to yourself is excluded too — sending it posts to your own desk and
 * reaches nobody new.
 *
 * `by === 'user'` is the authorship half of the double-send rule and it is NOT
 * the whole of it. An agent's note TO you is inbound: your decision on it is a
 * tray ROW carrying its `note_id`, and a note that were both a row's subject
 * and a pending note would be sent twice by one submit. But authorship alone
 * only covers the INBOUND direction. Staging a decision on your OWN outbound
 * note — which the row allows, and which is the only way to withdraw a filed
 * comment — puts that note in the batch as a row while it is still `open` and
 * unsent, i.e. still pending. `decided` closes that side: a note the tray
 * already carries a decision for is in the batch once, as that decision.
 *
 * Withdrawing a comment must not deliver it. `Dismiss` on your own note is the
 * ONLY dismissal affordance the row offers, and after change 9 that is true for
 * a simpler reason than it used to be: there is no second, immediate dismissal
 * beside it to be gated differently. EVERY control on a note stages, and the
 * submit is the only thing that reaches an agent — so without `decided` the
 * instruction the tray prints ("dismiss it on the note itself") would send the
 * comment to the very person you were withdrawing it from.
 *
 * `sent` is the server's ledger — `any(note.id in round.sends)` — and this
 * reads it rather than recomputing it. It is deliberately the coarser of the
 * two tests the server can make: the server also re-offers a note whose TEXT
 * moved after it went out, which no surface here can do, so `!sent` errs
 * towards never re-sending.
 *
 * A REPLY IS NEVER PENDING, AND `sent` IS EXACTLY WHY IT HAS TO BE SAID OUT
 * LOUD. Change 9 made `Reply` stage an `ask` row, and the submit that carries
 * that row FILES the reply and DELIVERS it in the same transaction. But
 * `round.sends` is keyed on the PARENT's `note_id` for an `ask` row, never on
 * the new reply's own id — the reply carries `round == ""` and never appears in
 * `sends` under its own id — so `sent` comes back FALSE on a reply that was
 * delivered. Without this clause every staged reply reappears in the tray the
 * moment the submit refetches, and pressing Send again delivers it a SECOND
 * time: the double-send the batch rule exists to prevent, re-entering through
 * the one control that used to POST on the click.
 *
 * The discriminator is `reply_to` rather than `sent`, because there is nothing
 * on the wire that tells a delivered reply from an undelivered one. What that
 * costs, stated rather than glossed: a reply the user filed from their own CLI
 * with `--reply-to` is no longer offered for delivery in the browser. That is
 * narrow — every reply the browser can produce is delivered by the submit that
 * created it, and every reply anyone else writes has `by !== 'user'` and was
 * already excluded — and it errs in the direction this predicate already errs
 * in: never re-sending.
 */
export function isPendingNote(n: PlanNote, decided?: ReadonlySet<string>): boolean {
  return (
    n.by === 'user' &&
    n.status === 'open' &&
    !!n.to &&
    n.to !== 'user' &&
    !n.sent &&
    !n.reply_to &&
    !decided?.has(n.id)
  )
}

/** Every note THIS TRAY already carries a decision for.
 *
 *  Superseded rows count. A row that a `Take @{new}'s` overtook stays in the
 *  tray and still rides the submit with its `note_id` — the server resolves it
 *  `rejected` — so it is just as much "already in the batch" as a live one, and
 *  reading only live rows would let its note ride a second time as a named id.
 *
 *  The ONE set behind both the tray's pending list and the note row's own
 *  `waiting to send` label, for the same reason `isPendingNote` is one
 *  predicate: two answers to "is this out yet?" is how a note comes to say
 *  `waiting` in one place and be absent from the batch in another. */
export function decidedNotes(rows: TrayRow[]): Set<string> {
  return new Set(rows.map((r) => r.note_id).filter(Boolean))
}

/** The batch's note half: every note you wrote that is addressed, still open,
 *  not yet out, and NOT already in the batch as a decision of its own. Derived
 *  from the notes payload and the tray on every render and never held in state
 *  — a note's sent-ness is the server's fact, and a local "I sent this" flag is
 *  the same defect as an optimistic `open_notes_for_you` decrement. */
export function pendingNotes(notes: PlanNote[], rows: TrayRow[] = []): PlanNote[] {
  const decided = decidedNotes(rows)
  return notes.filter((n) => isPendingNote(n, decided))
}

/** Who a batch will reach, in the order the tray staged them. Derived from the
 *  rows' server-supplied `to`, never re-derived from the notes: `to` is a
 *  decision's reply address and the server owns the rule.
 *
 *  Pending notes contribute the addressee they were written TO, not their
 *  author — they are outbound — which is the same split the server makes
 *  between a decision's `DraftEntry.to` and a named note's own `to`. */
export function addressees(
  rows: TrayRow[],
  notes: PlanNote[],
  pending: PlanNote[] = [],
): string[] {
  const byId = new Map(notes.map((n) => [n.id, n]))
  const out: string[] = []
  for (const r of rows) {
    if (r.superseded_by) continue
    const who = r.to || byId.get(r.note_id)?.by || ''
    if (who && !out.includes(who)) out.push(who)
  }
  for (const n of pending) {
    if (n.to && !out.includes(n.to)) out.push(n.to)
  }
  return out
}

/**
 * §6.C.2 — `proposed_by` is a LIST and the empty case is a fact, not a gap.
 *
 * `[]` renders as the one-name form with NO proposer clause at all: that is a
 * keeper's own edit, a checkbox tick or a coordinator write, and it is also
 * what every pre-migration round reads as. Rendering it as absence is what
 * makes the zero-migration claim true on screen and not only in the datastore.
 */
export function proposerClause(proposedBy: string[]): string {
  const names = proposedBy.filter(Boolean).map((n) => `@${n}`)
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]}'s proposal`
  const last = names[names.length - 1]
  return `${names.slice(0, -1).join(', ')} and ${last}'s proposals`
}

/**
 * One history row, in words.
 *
 * ⚠ THE MAPPING IS INVERTED. Wire `by` is who wrote the BYTES — the applier —
 * and wire `proposed_by` is whose proposals they were. Wiring `by` to "proposed
 * by" reads plausibly on every row, because the only appliers are ever the
 * owner and the keeper, and is wrong about the specialist whose work it was.
 */
export function versionLine(v: PlanVersion): string {
  const clause = proposerClause(v.proposed_by)
  const applied = v.by ? `applied by @${v.by}` : 'applied'
  return clause ? `${clause}, ${applied}` : applied
}

/** The unresolved notes addressed to the user, off ONE array and ONE filter.
 *
 *  It must equal `PlanSummary.open_notes_for_you`, which the desk card reads —
 *  §6.B pins the two as the same number and the execution gate reads it. The
 *  addressee token is the literal `'user'`, not `'you'`: the second person is a
 *  register the prototype speaks in, and the wire does not.
 *
 *  `layer === 'spec'` IS THE THIRD TERM AND IT IS NOT OPTIONAL. The server's
 *  `open_notes_for_you` grew it, so dropping it here would put a bigger number
 *  on this surface than on the desk card and the gate — the exact drift the
 *  paragraph above forbids. A detail-layer note is one about a section the
 *  keeper was free to rewrite without asking; it still shows, it just does not
 *  count as something waiting on you. */
export function openForYou(notes: PlanNote[]): number {
  return notes.filter(holdsTheWork).length
}

/** DOES THIS ONE NOTE HOLD THE WORK? The three terms above, per note.
 *
 *  EXTRACTED BECAUSE THE COUNT AND THE LIST NEEDED THE SAME ANSWER AND DID NOT
 *  HAVE IT. The desk card's pill reads `open_notes_for_you` — addressed to you,
 *  open, spec layer — and the tray's `Waiting on you` group is `groupComments`
 *  splitting on `note.to` and filtering by nothing else. Both were RIGHT and
 *  they printed different numbers under labels that read like the same claim:
 *  a card saying `2 for you` over a list of three rows.
 *
 *  The fix is not a second count — the server's own file says *"a second count
 *  anywhere is the defect rather than a shortcut"*, and the execution gate reads
 *  the first one. It is this predicate, so the list can SAY which of its rows
 *  are the two the pill means.
 *
 *  `layer === 'detail'` is the row that does not: a detail-layer section is one
 *  the keeper may rewrite with `plan update` and no refusal, so a note filed
 *  against it is a remark about work the plan has already delegated. It still
 *  shows, it still needs an answer eventually, and it stops nothing. Mirrors
 *  `open_notes_for_you` in `models/project_plan.py` term for term — the same
 *  reason `isAlarming` mirrors `_open_deviation`. */
export function holdsTheWork(n: PlanNote): boolean {
  return n.to === 'user' && n.status === 'open' && n.layer === 'spec'
}

/** THE ALARM'S PREDICATE, and the ONE place the red is decided.
 *
 *  `kind === 'deviation'` says the work went off-contract and is a RECORD: it
 *  is true forever and the chip keeps printing it. This says the record is
 *  also SHOUTING, which needs two more things — the note is unresolved, and it
 *  is in the spec layer, so the server counts it in `open_notes_for_you` and
 *  the project really is stopped.
 *
 *  Mirrors `_open_deviation` (`server/routes/project_plans.py`) term for term,
 *  including its deliberate absence of a `to` filter: a deviation raised
 *  against someone else is still the work going off-contract.
 *
 *  Extracted rather than repeated because it now has four readers — the box's
 *  red, the row's triangle, the row's sort position, and the desk chip — and
 *  four copies of a three-term predicate is how a chip comes to say
 *  `off-contract` over a project nothing is blocking. */
export function isAlarming(n: PlanNote): boolean {
  return n.kind === 'deviation' && n.status === 'open' && n.layer === 'spec'
}

/** THE OPEN DEVIATION, selected by the SAME RULE the server uses.
 *
 *  Mirrors `_open_deviation` (`server/routes/project_plans.py`) through the
 *  shared `isAlarming` predicate, and DELIBERATELY applies no `to` filter.
 *  `kind` is derived server-side now, so this reads the answer rather than
 *  recomputing it — the `status` and `layer` halves stay here because a note is
 *  a deviation forever and only the ALARM is about the unresolved, blocking
 *  ones — a deviation raised against someone else is still the work going
 *  off-contract, and the card has always shown it.
 *
 *  It is not a second derivation of a fact the server owns. The server builds
 *  `PlanSummary.deviation` by scanning the very array `GET …/plan` ships
 *  unfiltered as `PlanIndex.notes`, so this is the same selection over the same
 *  input. It must agree with `PlanSummary.deviation`; if the two ever disagree
 *  that is a defect, in exactly the sense `openForYou` above must equal
 *  `open_notes_for_you`.
 *
 *  PRESENCE IS THE PREDICATE at the call site, as it is on the wire: `Deviation`
 *  carries no `status`, so a caller testing one would compare `undefined`. */
export function openDeviation(notes: PlanNote[]): PlanNote | undefined {
  return openDeviations(notes)[0]
}

/** EVERY open deviation, NEWEST FIRST — the alarm's list.
 *
 *  Same predicate as `openDeviation` above, which is now literally this list's
 *  head, so the alarm's rows and the desk card's `off-contract` chip cannot
 *  drift into two selections of one fact.
 *
 *  IT EXISTS BECAUSE THE ALARM IS A LIST AND THE CHIP IS A BOOLEAN, and those
 *  are different questions over the same scan. The alarm used to render
 *  `openDeviation` alone, so a second deviation raised while the first was
 *  still open appeared NOWHERE — the chip said `off-contract`, the count
 *  included it, and the only surface that names deviations showed one. */
export function openDeviations(notes: PlanNote[]): PlanNote[] {
  const out: PlanNote[] = []
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const n = notes[i]
    if (isAlarming(n)) out.push(n)
  }
  return out
}

/** Unresolved notes on one section — the dot on its tab. Every note counts
 *  here, not only the user's: a specialist's open question is still unfinished
 *  business on that section. */
export function openNotesOn(notes: PlanNote[], slug: string): number {
  return notes.filter((n) => n.section === slug && n.status === 'open').length
}

/** §5.2's `--sections` warning, derived rather than carried.
 *
 *  Two sections sharing a heading with slugs `x` / `x-2` IS the warning;
 *  `PlanIndex` has no `warning` member and will not grow one, because a second
 *  name for a fact already on the wire is how two names for one fact drift. */
export function duplicateHeadings(sections: PlanSection[]): Set<string> {
  const seen = new Map<string, number>()
  for (const s of sections) seen.set(s.heading, (seen.get(s.heading) ?? 0) + 1)
  return new Set([...seen].filter(([, n]) => n > 1).map(([h]) => h))
}

/** Who last moved this section, for the `Keep @{held}'s` label on a refused
 *  row. Read out of the activity log rather than invented: the `409` carries
 *  `{section, base, current}` and no author, and naming the wrong person on a
 *  decision control is worse than naming nobody. */
export function lastToucherOf(index: PlanIndex | null | undefined, slug: string): string {
  if (!index) return ''
  for (let i = index.history.length - 1; i >= 0; i -= 1) {
    const h = index.history[i]
    if (h.section === slug && h.by) return h.by
  }
  return index?.keeper ?? ''
}

/** ONE ROW SHAPE FOR THE COMMENT LIST, and the reason there is only one is the
 *  owner's framing: a text edit is a comment you wrote WITH a diff and accepted
 *  in the same gesture. So an edit is not a second kind of item to be branched
 *  on — it is a comment whose decision happens to be its own row.
 *
 *  `derived` LABELS THE PROJECTION AND MUST NEVER GATE LAYOUT OR BEHAVIOUR. It
 *  changes two strings in the list (the ✕'s label and the author word) and
 *  nothing else. The moment it decides what a row DOES, the projection has
 *  failed and should be reverted rather than patched — the whole return on it
 *  is that everything downstream stops caring. */
export interface CommentItem {
  /** Stable React key. Equal to `note.id` today; a separate member so a future
   *  projection cannot collide two rows into one key by accident. */
  key: string
  /** A real note off the wire, or `editAsNote(row)` — DISPLAY ONLY. */
  note: PlanNote
  /** The tray row that decides it, INCLUDING a superseded one. `null` when the
   *  comment carries no decision yet. An edit's row is its own. */
  staged: TrayRow | null
  /** Filed, not yet delivered. Never true for a derived item — an edit has not
   *  been filed anywhere. */
  pending: boolean
  /** `note` is a projection of `staged`, not a fetched note. */
  derived: boolean
}

/** A TRAY ROW, AS THE COMMENT IT IS.
 *
 *  The owner's framing made literal, for the row kind it was written about:
 *  writing a section is filing a proposal on it and accepting it in the same
 *  gesture. Nothing is invented — `base` IS `base_section`, `text` IS
 *  `proposal`, `section` is the same field under the same name, and the author
 *  is the owner.
 *
 *  IT RENDERS THROUGH THE EXISTING DIFF PATH WITH NOTHING ADDED. `diffSeries`
 *  draws `note.proposal ? renderDiff(note.base_section, note.proposal,
 *  note.section) : note.display_diff` (`planDiffs.ts`), so `display_diff: ''`
 *  here is correct rather than missing: the branch that consumes it is never
 *  taken while `proposal` is set.
 *
 *  `comment` IS THE FIRST NON-EMPTY LINE OF THE ROW — `row.comment` when it has
 *  one, the first line of the new text otherwise, which is exactly what the
 *  tray's own row printed. It is display prose derived from text the user
 *  typed, not a comment they wrote, and that is only safe because of the
 *  containment rule below.
 *
 *  IT ALSO COVERS THE ORPHANED DECISION — a row whose note is no longer among
 *  the open notes, because someone else resolved it while the row sat staged.
 *  That row still rides the submit, so it must still be on screen and still be
 *  individually undoable; the tray drew it and the list has to. It is the same
 *  projection with `has_proposal` off, not a second kind, and it is the same
 *  defect class as dropping a superseded row.
 *
 *  DISPLAY ONLY, AND IT NEVER ENTERS `notes`. `id` is the TRAY ROW's id, so
 *  `removeRow` takes it unchanged and `PlanBody`'s `anchorOf` can hang it on
 *  the rewritten section as `data-note-id` — one landing target for both kinds
 *  of row. It must not reach two places, both of which key on a REAL note id:
 *  the submit's `note_ids`, where the server has no note to fan out to, and
 *  `openNotesOn`, which paints the section rail's dot and speaks its count.
 *  Building it inside `commentList` and returning it inside a `CommentItem` is
 *  what keeps it out of both, and `planTrayLogic.test.ts` asserts it. */
export function editAsNote(row: TrayRow): PlanNote {
  const writes = row.kind === 'edit' || row.kind === 'accept'
  const firstLine = row.text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  return {
    id: row.id,
    section: row.section,
    to: row.to,
    by: 'user',
    at: row.at,
    status: 'open',
    kind: writes ? 'proposal' : 'note',
    // A projected row is YOUR staged edit and never a deviation, so this is
    // inert — `isAlarming` fails on `kind` first. `'spec'` matches the server's
    // default for a note that never went through `add_note`, which is what this
    // is: nothing filed it.
    layer: 'spec',
    comment: row.comment || firstLine,
    proposal: writes ? row.text : '',
    base_section: row.base,
    quote: '',
    reply_to: '',
    round: '',
    conflict: false,
    resolved_by: '',
    resolved_at: '',
    resolution: '',
    revision: 0,
    has_proposal: writes,
    bootstrap: false,
    proposes_delete: writes && row.text === '',
    sent: false,
    replies: [],
    section_missing: !!row.missing,
    // A ROW NEVER CREATES A SECTION, so this is constant here rather than
    // derived. `_row_creates` decides that server-side off the NOTE the row
    // accepts, and a row does not carry one — the tray comment on `missing`
    // makes the same point about predicting the submit's outcome.
    section_new: false,
    section_changed: !!row.stale,
    display_diff: '',
  }
}

/** THE ONE ORDER AND THE ONE JOIN, so the list and the send bar cannot disagree
 *  about what is in the batch.
 *
 *  ORDER: every open deviation first, newest-first (the alarm's order today,
 *  carried across unchanged), then every other open note newest-first, then the
 *  projected rows newest-first. Order is the only place an edit is still
 *  treated as its own thing, and it is a READING decision rather than a type:
 *  an alarm belongs at the top and your own uncontroversial rewrite does not.
 *
 *  `staged` IS JOINED ON `note_id` INCLUDING SUPERSEDED ROWS — deliberately not
 *  `stagedFor`, which skips them (`&& !r.superseded_by`). A superseded accept
 *  still rides the submit under its `note_id` and is still individually
 *  undoable, so the list must draw it or the tray's one-undoable-row guarantee
 *  is lost in the move. The LAST matching row wins, for the reason
 *  `appliedTextRow` reads the same end of the array: that is the row the server
 *  applies.
 *
 *  `pending` IS PASSED IN, NOT RECOMPUTED. `pendingNotes` already subtracts
 *  `decidedNotes(rows)`, and a second call here would be a second answer to
 *  "is it out yet?".
 *
 *  EVERY ROW NOT CLAIMED BY A NOTE BECOMES ITS OWN ITEM — every `edit` (which
 *  carries `note_id: ''` by construction) and any decision whose note has left
 *  the open set underneath it. `staged: row` is what puts the decision word in
 *  the chip and the row's own id under the ✕, so the projection needs no
 *  special-casing downstream. That is the whole return on it. */
export function commentList(
  notes: PlanNote[],
  rows: TrayRow[],
  pending: PlanNote[],
): CommentItem[] {
  const pendingIds = new Set(pending.map((n) => n.id))
  const rowFor = new Map<string, TrayRow>()
  for (const r of rows) if (r.note_id) rowFor.set(r.note_id, r)

  const claimed = new Set<string>()
  const item = (note: PlanNote): CommentItem => {
    const staged = rowFor.get(note.id)
    if (staged) claimed.add(staged.id)
    return {
      key: note.id,
      note,
      staged: staged ?? null,
      pending: pendingIds.has(note.id),
      derived: false,
    }
  }

  const devs: CommentItem[] = []
  const rest: CommentItem[] = []
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const n = notes[i]
    if (n.status !== 'open') continue
    // `isAlarming` AND NOT `kind === 'deviation'`, so the top of the list is
    // the things that are actually stopping the project. A detail-layer
    // departure still renders, still says `deviation`, and sits in date order
    // with the rest — it is a record, and the record was never what earned the
    // top slot. (`status` is already filtered above; the term is harmless and
    // keeping the whole predicate in one place is the point of it.)
    ;(isAlarming(n) ? devs : rest).push(item(n))
  }

  const derived: CommentItem[] = []
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]
    if (claimed.has(r.id)) continue
    derived.push({ key: r.id, note: editAsNote(r), staged: r, pending: false, derived: true })
  }

  return [...devs, ...rest, ...derived]
}

/** ONE GROUP OF COMMENTS: everything waiting on the SAME person. */
export interface CommentGroup {
  /** The addressee every item in this group is `to`. The literal `'user'` is
   *  the owner; `''` is *recorded, never sent*. */
  to: string
  items: CommentItem[]
  /** HOW MANY OF `items` ACTUALLY HOLD THE WORK — `holdsTheWork`, counted.
   *
   *  Zero on every group but `'user'`, because the predicate's first term is
   *  `to === 'user'`; it is computed for all of them anyway rather than special-
   *  cased, so there is no branch here to disagree with the predicate.
   *
   *  It exists so the header can be honest about a group it does not filter.
   *  `Waiting on you` lists every open note addressed to you and always did;
   *  this is the subset the desk card's `N for you` pill and the execution gate
   *  are counting, and printing it beside the rows is what reconciles the two
   *  numbers without inventing a third.
   *
   *  A projected tray row goes through the same predicate as a real note and
   *  needs no case of its own: `editAsNote` stamps `layer: 'spec'` — nothing
   *  filed it, so that is the server's own default — and the `to` it carries is
   *  the row's. So a staged row addressed to you counts, which is right: it is
   *  a decision you have made and not yet sent. */
  holding: number
}

/**
 * THE COMMENT LIST, SPLIT BY WHO IT IS WAITING ON.
 *
 * WHY THE FLAT LIST WAS THE PROBLEM. The list shows every OPEN comment, not
 * only the ones addressed to you — deliberately, so it matches the section
 * rail's dot and is a complete navigator, and that is unchanged. What it did
 * not do is say which direction each one points, so your own outbound question
 * sat in the same undifferentiated column as the coordinator's inbound one,
 * each with a chip and a ✕, and the whole box read as a list of chores you
 * owed. On a plan where you had asked three questions and been answered, every
 * one of them was still on that list.
 *
 * IT PARTITIONS, IT DOES NOT REORDER. `commentList` owns the order — alarms
 * first, then the rest newest-first, then the projected rows — and this walks
 * that sequence once and keeps every relative position. So a deviation is still
 * the first thing you see: a deviation is a keeper note to the user, so it is
 * `to === 'user'` by construction and lands at the top of the group that is
 * itself first.
 *
 * THE KEY IS `note.to`, WHICH IS THE EXACT ANSWER AND NOT AN APPROXIMATION OF
 * ONE. A two-way `mine`/`theirs` split would have to guess a label for the two
 * shapes that are neither — a note addressed to nobody (`''`, *recorded, never
 * sent*) and a legacy note addressed to a specialist — and guessing is how a
 * header comes to say something the row under it contradicts. Grouping on the
 * field means each header states its group's own addressee and there is no
 * fallback to be wrong about.
 *
 * `'user'` FIRST, ALWAYS, and the rest in first-appearance order. That one
 * group is the only thing on this surface you can act on right now; the others
 * are what you have already said and are waiting to hear back about. Everything
 * else keeps `commentList`'s order because there is no second reading rule
 * worth inventing.
 */
export function groupComments(items: CommentItem[]): CommentGroup[] {
  const groups = new Map<string, CommentItem[]>()
  for (const item of items) {
    const to = item.note.to || ''
    const bucket = groups.get(to)
    if (bucket) bucket.push(item)
    else groups.set(to, [item])
  }
  const group = (to: string, groupItems: CommentItem[]): CommentGroup => ({
    to,
    items: groupItems,
    holding: groupItems.filter((i) => holdsTheWork(i.note)).length,
  })
  const mine = groups.get('user')
  groups.delete('user')
  const rest = [...groups].map(([to, groupItems]) => group(to, groupItems))
  return mine ? [group('user', mine), ...rest] : rest
}

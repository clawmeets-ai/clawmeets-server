import { ApiError, del, get, post, put } from '../client'

/* The §6 wire contract, transcribed from what the server ships — not inferred
 * from the prototype. Every type below has a named counterpart in
 * `clawmeets/api/responses.py` or `clawmeets/server/routes/project_plans.py`;
 * a member this file does not name does not exist for the tab.
 *
 * The tab is TRANSPORT. It sends section text and note text; it parses no
 * Markdown, derives no headings and slices no document. Every heading, slug,
 * box count and extent below arrives from the server's one grammar
 * (`models/plan_markdown.py`), which skips fenced code blocks — a client-side
 * scanner would reintroduce exactly the bug that rule prevents, on a plan
 * document that quotes the grammar it uses. */

/** The open deviation note a project's plan carries, if it carries one.
 *
 *  FIVE members. There is no `status`: the server only ever puts an OPEN
 *  deviation here, so presence IS the predicate. `plan.deviation.status ===
 *  'open'` is `undefined === 'open'` against this payload — a callout that
 *  silently never renders. */
export interface Deviation {
  id: string
  by: string
  comment: string
  section: string
  base_section: string
}

export type PlanPhase = 'spec-ing' | 'executing' | 'complete' | 'failed'

/** What a project record tells the desk about its plan. SEVEN members.
 *
 *  Four of them are `null` EXACTLY when `surface === 'frontdesk'`: there is no
 *  user in the accepting role on that shape, so `phase`, `revision`, `accepted`
 *  and `accepted_revision` have nothing to say. Null-check them; never switch
 *  on `plan.phase` as though it were always a string.
 *
 *  `accepted_revision` is additionally `null` on a regular project BEFORE
 *  acceptance, and is never `0` — `0` is a sentinel the sidecar keeps
 *  internally, and revisions start at 1.
 *
 *  `open_notes_for_you` is the one member never null on any shape. It is the
 *  integer the execution gate reads.
 *
 *  There is no `halted: boolean` and this interface must not grow one: the
 *  gated state is the conjunction `surface === 'regular' && phase ===
 *  'executing' && open_notes_for_you > 0`, computed at exactly one call site. */
export interface PlanSummary {
  surface: 'regular' | 'frontdesk'
  phase: PlanPhase | null
  revision: number | null
  accepted: boolean | null
  accepted_revision: number | null
  open_notes_for_you: number
  deviation: Deviation | null
}

/** One derived section. `boxes` is `[done, total]` and DISPLAY ONLY — there is
 *  no checkbox state machine anywhere, client or server; ticking a box is an
 *  ordinary section edit.
 *
 *  A leading `# ` heading on a document that also has deeper headings is the
 *  document TITLE and is not a section — it never appears in this array, and
 *  its extent would span the whole document if it did. Slugs de-duplicate as
 *  `x` / `x-2` (hyphen). */
export interface PlanSection {
  id: string
  heading: string
  depth: number
  boxes: [number, number]
  char_start: number
  char_end: number
}

/** One note. Notes are never deleted — the status ladder closes them.
 *
 *  The last six members are DERIVED per request and are never inputs.
 *  `display_diff` in particular is render-only: no surface anywhere accepts a
 *  diff, and the write path sends `proposal` TEXT. */
export interface PlanNote {
  id: string
  section: string
  /** an agent name, or the literal `'user'`; `''` = recorded, never sent. */
  to: string
  by: string
  at: string
  /** THE SIXTH MEMBER IS `folded`, AND IT IS THE ONE THAT SAYS WORK LANDED.
   *  Every other terminal word means the text did NOT reach the document;
   *  `folded` means it did, inside somebody else's write. It arrives only from
   *  the server, which derives the winner from its own collapse — this client
   *  never sends a status.
   *
   *  WIDENING THIS UNION IS A COMPILE-TIME BREAK ON PURPOSE. The set is closed
   *  here so that `tsc` names every site that enumerates the terminal words
   *  when the server grows one; the only such site is `STATUS_LABEL` in
   *  `PlanNoteRow`, which is why that map is the one place a new word has to be
   *  taught and why it falls back to the raw string rather than blanking. */
  status: 'open' | 'answered' | 'applied' | 'rejected' | 'dismissed' | 'folded'
  /** DERIVED SERVER-SIDE ON EVERY READ, AND NEVER AN INPUT. There is no stored
   *  `kind`: a note is a comment, with or without a diff (`proposal`), with or
   *  without a parent (`reply_to`). The server computes this word from those
   *  fields plus one timestamp comparison and ships it, so nothing here has to
   *  re-derive it — which is how the old chip came to print `question` where
   *  the button said Reply.
   *
   *  `deviation` — the keeper wrote to the user after the plan was FIRST
   *    accepted. `proposal` — carries replacement text, carried it before it
   *    was applied, or proposes a delete. `reply` — names a parent.
   *    `note` — none of those. */
  kind: 'note' | 'proposal' | 'reply' | 'deviation'
  /** WHICH LAYER `section` WAS IN WHEN THIS NOTE WAS FILED. Stored on the note
   *  server-side, stamped once at filing, never recomputed — so it is a fact
   *  about the past and NOT a lookup against today's `PlanSection.layer`.
   *
   *  `'detail'` means the keeper could have made this edit with `plan update`
   *  and no refusal, so the note is a remark about work the plan has already
   *  delegated: the server does not count it in `open_notes_for_you` and the
   *  project is not stopped by it. Everything alarm-coloured here follows that
   *  same test through `isAlarming` in `planTrayLogic` — one predicate, so this
   *  box and the desk's `off-contract` chip cannot drift.
   *
   *  The word `deviation` is unaffected: `kind` is a record of what happened
   *  and stays true forever. Only the RED does. */
  layer: 'spec' | 'detail'
  comment: string
  proposal: string
  base_section: string
  quote: string
  reply_to: string
  round: string
  conflict: boolean
  resolved_by: string
  resolved_at: string
  resolution: string
  revision: number
  // derived
  has_proposal: boolean
  /** THE CONFIRM NOTE. The one note the server files itself, addressed to the
   *  user, anchored to the document rather than to a section and carrying no
   *  proposal. **Dismissing it IS accepting the plan.**
   *
   *  It is on the wire so a surface can stop OFFERING the closes the server
   *  refuses. Rejecting it — or accepting it, which would close it `applied`
   *  without stamping anything — would leave the plan unapproved *and*
   *  unblocked, because the execution gate counts notes that are OPEN. So the
   *  server refuses every close but Dismiss, and a Reject button here would be
   *  a control that always 409s. Wanting changes is a Reply, which reaches the
   *  coordinator and leaves the gate up.
   *
   *  It used to be a PROPOSAL against an `## Approval` section, closed by
   *  Accept. The section is gone, so the flag no longer withholds Dismiss —
   *  Dismiss is the act now — and `has_proposal` is false, which is what
   *  withholds Accept and Reject without any flag being consulted.
   *
   *  **THE ROW HAS TWO WORDINGS AND `comment` IS THE ONLY PLACE THEY SHOW.**
   *  A project is born with it before the coordinator has taken a turn, so it
   *  starts by saying the keeper is still drafting and has the plan out with
   *  the agents — *"nothing to do yet"* — and the keeper's review send rewrites
   *  it into the confirm. Same row, same id, same open count, so nothing here
   *  branches on which one it is; the user reads the comment. */
  bootstrap: boolean
  /** THIS NOTE PROPOSES REMOVING ITS SECTION, and it is on the wire so nothing
   *  here has to infer a delete from an empty string.
   *
   *  `has_proposal` already carries the decision — the server folds this flag
   *  into it — so `PlanNoteRow` needs no delete branch and does not have one:
   *  `Accept` and `Reject` render exactly as they do for a text proposal, and
   *  `display_diff` arrives as the section against nothing. This field is here
   *  for a surface that wants to LABEL the act (the tray could say "remove"
   *  rather than "accept"), never to gate a control a second time. */
  proposes_delete: boolean
  sent: boolean
  replies: string[]
  section_missing: boolean
  /** derived on read: this note PROPOSES the section it names, so the slug not
   *  resolving is the point of the note rather than a fault in it.
   *
   *  MUTUALLY EXCLUSIVE WITH `section_missing` BY CONSTRUCTION — the server's
   *  `section_missing` returns false wherever this is true — so a surface
   *  renders whichever one arrived and never arbitrates between two banners.
   *  Together they are "the slug does not resolve"; apart they are the two
   *  different things that can mean, which need two different sentences. */
  section_new: boolean
  section_changed: boolean
  display_diff: string
}

/** FIVE kinds. `superseded` is NOT one of them: a row whose text was overtaken
 *  by a later accept is staged, sent and stored as `accept`, and carries a
 *  CLIENT-SIDE marker for its label only. Sending a sixth kind is a 400. */
export type DraftEntryKind = 'edit' | 'accept' | 'reject' | 'ask' | 'dismiss'

export interface DraftEntry {
  id: string
  kind: DraftEntryKind
  section: string
  text: string
  base: string
  note_id: string
  comment: string
  to: string
  at: string
  /** derived on read: the document moved under this row since it was staged. */
  stale?: boolean
  /** derived on read: the row's section is no longer in the document, so a
   *  submit carrying it is a 409 and not a write.
   *
   *  A SEPARATE MEMBER FROM `stale`, for the reason the server keeps
   *  `section_changed` and `section_missing` separate: "the text moved, re-read
   *  it" and "there is nothing left to write to" are different answers with
   *  different remedies, and `section_changed` reports FALSE here by design
   *  rather than shadowing this one. Only `edit`/`accept` rows can carry it —
   *  a reject / ask / dismiss writes no bytes, so a vanished section costs it
   *  nothing. */
  missing?: boolean
  /** THIS ROW'S TEXT WAS FOLDED INTO ANOTHER ROW ON THE SAME SECTION, and it is
   *  an INPUT — the only member here the client sets and the server reads.
   *
   *  Set on the row(s) being folded AWAY and NEVER on the winner. It carries no
   *  author and no id, deliberately: the winner is not decided until submit, by
   *  the server's own collapse over the whole tray, so any name this client put
   *  on the wire would be a snapshot that a third proposal on the same section
   *  makes stale. One bit is the most this side can honestly say.
   *
   *  OMITTED ENTIRELY WHEN FALSE, which is the shape the contract names and the
   *  shape that reproduces the old behaviour byte for byte against a server that
   *  ignores it — and it is why `removeRow` DELETES the key rather than setting
   *  it false. Sending it to a server that does not record folds is silent: the
   *  model ignores unknown fields, so the write returns 200 and the note closes
   *  `rejected` on text that landed. `PlanIndex.records_folds` is what stops
   *  this row ever being built against such a server. */
  folded?: boolean
}

export interface PlanReviewDraft {
  by: string
  entries: DraftEntry[]
  batch_comment: string
  room: string
  updated_at: string
}

/** One row of the sidecar's activity log. Capped at 200 and trimmed from the
 *  FRONT, so render it as "recent activity" and never derive a count or a
 *  first-event date from it. `seq` is a display counter, never a precondition.
 *  This is NOT `/plan/versions`: it is everything that happened, including
 *  refusals and notes that moved no bytes. */
export interface PlanHistoryEntry {
  seq: number
  at: string
  by: string
  verb: string
  section: string
  detail: string
}

export interface PlanIndex {
  body: string
  sections: PlanSection[]
  notes: PlanNote[]
  /** the owner's tray; `null` for every other identity. */
  draft: PlanReviewDraft | null
  /** MAY THIS IDENTITY RESOLVE NOTES ON THIS PLAN? The same predicate the
   *  `POST /plan/review` guard enforces, computed server-side — never derived
   *  from anything else on this payload.
   *
   *  IT REPLACES A PROXY, AND THE DISTINCTION IS THE WHOLE POINT. The client
   *  used to read `draft !== null`, which is not a permission check: it happens
   *  to be owner-only because the route returns no tray to anyone else, so the
   *  browser was inferring authority from the presence of a scratch pad. Two
   *  things that agree today and were never the same question.
   *
   *  NO FALLBACK, DELIBERATELY. Absent ⇒ `false`, and it must NOT fall back to
   *  `draft !== null`. A fallback is precisely the state the constraint
   *  forbids — a client that looks permissioned against a server that is not —
   *  and it would silently restore the proxy on exactly the version mismatch
   *  that is worth seeing. Failing closed makes the mismatch a missing button
   *  rather than a button that 403s.
   *
   *  This field is REQUIRED rather than optional for the same reason. Marking
   *  it `?` would compile against a payload that does not carry it, which is
   *  the fallback wearing a type. */
  can_decide: boolean
  /** DOES THE SERVER ON THE OTHER END RECORD A FOLD? A capability flag, and the
   *  only thing in this payload the tray consults before choosing what to send.
   *
   *  IT EXISTS BECAUSE A NEW BUNDLE CAN MEET AN OLD SERVER. `dist/` is built on
   *  the box and written BEFORE the process restarts, and the SPA is served
   *  per-request off disk — so every public-UI deploy runs the new browser code
   *  against the old Python for about a minute, and a rollback that reverts the
   *  Python and forgets the bundle leaves that state open indefinitely. That is
   *  the dangerous direction and it is the one that happens every time.
   *
   *  WHAT MAKES IT NECESSARY RATHER THAN TIDY is that the mismatch is SILENT.
   *  `DraftEntry.folded` on a server that predates it is dropped with a 200 —
   *  no 422, no log line, nothing to alert on — and the folded-away note then
   *  closes `rejected` on a document its text is in, which is strictly worse
   *  than the dismissal the client used to write itself. So the client asks
   *  first and keeps the old mitigation for the `false` answer.
   *
   *  ABSENT READS AS FALSE, and required rather than optional for
   *  `can_decide`'s reason: a `?` compiles against a payload that omits it,
   *  which is the fallback wearing a type. Failing closed costs one release of
   *  a dead branch; failing open costs an author being told their work was
   *  thrown away. */
  records_folds: boolean
  sha: string
  revision: number
  keeper: string
  /** THE SAME NUMBER as `PlanSummary.open_notes_for_you`. If they ever disagree
   *  that is a defect, not a rounding difference. */
  open_notes_for_you: number
  spec_digest: string
  accepted: boolean
  accepted_revision: number | null
  changed_since_acceptance: boolean
  history: PlanHistoryEntry[]
  /** IS THIS PROJECT'S REQUEST A DECISION? Set once by the coordinator while
   *  drafting (`clawmeets plan decision <project> yes|no`), kept on the plan
   *  sidecar and never in the plan text. `null` = never set, which reads as
   *  "no".
   *
   *  OPTIONAL, UNLIKE `can_decide`, and for the opposite reason: absent here
   *  already fails closed. A new bundle meeting a server that predates the flag
   *  shows no nudge, which is exactly the "missing flag" behaviour — nothing a
   *  `?` could compile into is worse than that. */
  decision?: boolean | null
  /** First-occurrence stamps for the decision nudge; absent on an old server. */
  nudge?: PlanNudge
}

export type PlanNudgeEvent = 'shown' | 'accepted' | 'dismissed' | 'held_back'

/** The nudge's first-occurrence ISO timestamps; `''` = never. The server
 *  stamps each one only if empty, so these count projects, not renders. */
export interface PlanNudge {
  shown_at: string
  accepted_at: string
  dismissed_at: string
  held_back_at: string
}

/** One row of `GET /plan/versions`.
 *
 *  ⚠ THE MAPPING IS INVERTED against the obvious reading. `by` is who wrote the
 *  BYTES — the applier. `proposed_by` is whose proposals they were. A straight
 *  `by`-means-proposer port reads "@coordinator's proposal, applied by
 *  @coordinator" on every specialist-originated revision, and looks plausible,
 *  because the only appliers are ever the owner and the keeper.
 *
 *  `proposed_by` is a LIST and is EMPTY when the writer was also the originator
 *  (a keeper's own edit, a checkbox tick). Empty renders as the one-name form
 *  with no proposer clause — an empty list is a fact about authorship, not
 *  missing data. */
export interface PlanVersion {
  revision: number
  sha: string
  by: string
  at: string
  version: number
  proposed_by: string[]
  note: string
}

export interface SectionEdit {
  section: string
  /** `''` deletes the section. */
  text: string
  /** `''` creates it. */
  base: string
}

export interface WriteResult {
  ok: boolean
  revision: number
  sections: string[]
  sha: string
  note_ids: string[]
  /** the spliced result was byte-identical: a landed write moved nothing. */
  noop: boolean
}

/** One stale section out of a refusal: your text beside what it says now, with
 *  no second request. */
export interface StaleSection {
  section: string
  base: string
  current: string
}

/** A refused write, unpacked. `note_ids` is a LIST — the refusal files one
 *  conflict note per stale section, and a singular id cannot represent what
 *  happens the moment two sections are stale. */
export class PlanStaleError extends Error {
  constructor(
    public revision: number,
    public stale: StaleSection[],
    public noteIds: string[],
    message: string,
  ) {
    super(message)
    this.name = 'PlanStaleError'
  }
}

/** Recognise the §6 `409` body and re-throw it as a `PlanStaleError`. Anything
 *  else propagates untouched, so a 403/413/400 still reads as itself.
 *
 *  FastAPI wraps a dict detail as `{detail: {...}}`, and `ApiError.message`
 *  stringifies that object — so the human text comes out of `error`, not out of
 *  the message the client built. */
function asStale(e: unknown): never {
  if (e instanceof ApiError && e.status === 409) {
    const detail = (e.data as { detail?: unknown })?.detail
    if (detail && typeof detail === 'object' && 'stale' in detail) {
      const d = detail as {
        error?: string
        revision?: number
        stale?: StaleSection[]
        note_ids?: string[]
      }
      throw new PlanStaleError(
        d.revision ?? 0,
        d.stale ?? [],
        d.note_ids ?? [],
        d.error || 'The plan moved under this change.',
      )
    }
  }
  throw e
}

/** The size limits the server enforces, mirrored so the client PRE-EMPTS rather
 *  than discovers. The body cap is UTF-8 BYTES, not characters.
 *
 *  `openNotes` is the ODD ONE OUT and is here because change 9 made it reachable
 *  from a control that used to cost nothing. Every other limit above is checked
 *  PER ITEM inside the server's loop; this one is the only budget SUMMED across
 *  the whole transaction (`open_count + incoming > MAX_OPEN_NOTES`). A staged
 *  reply files a new open note while its parent DELIBERATELY stays open — a
 *  question is not a resolution — so it costs TWO against this ceiling where a
 *  resolve-as-you-reply cost none, and the refusal moved from the click to the
 *  submit of the whole batch. The tray pre-empts it; the `413` handler is the
 *  backstop for the race where someone else's batch lands first. */
export const PLAN_LIMITS = {
  draftEntries: 100,
  editChars: 32 * 1024,
  noteChars: 32 * 1024,
  bodyBytes: 512 * 1024,
  openNotes: 200,
} as const

/** Fetch the plan index. Returns `null` when the project has no PLAN.md at all
 *  (server 404) — a DM, or a pre-feature project. That is an empty state, not
 *  an error, and it is the same case `PlanSummary` signals by being absent. */
export async function getProjectPlan(projectId: string): Promise<PlanIndex | null> {
  try {
    return await get<PlanIndex>(`/projects/${projectId}/plan`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

/** Revision history, newest first. `404` when there is no plan — the same
 *  answer `GET /plan` gives, so "no plan" and "a plan nobody wrote to" stay
 *  different responses. Normalised to `[]` for the caller. */
export async function getPlanVersions(projectId: string): Promise<PlanVersion[]> {
  try {
    return await get<PlanVersion[]>(`/projects/${projectId}/plan/versions`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return []
    throw e
  }
}

/** All-or-nothing. One stale section refuses the whole list and writes nothing;
 *  the refusal arrives as `PlanStaleError` carrying every stale row's current
 *  text and the ids of the conflict notes it filed. */
export async function putPlanSections(
  projectId: string,
  edits: SectionEdit[],
): Promise<WriteResult> {
  try {
    return await put<WriteResult>(`/projects/${projectId}/plan`, { edits })
  } catch (e) {
    return asStale(e)
  }
}

export interface NewNote {
  section?: string
  /** repeat an addressee to get N SIBLING notes with independent statuses. */
  to?: string[]
  comment?: string
  proposal?: string
  base_section?: string
  quote?: string
  reply_to?: string
}

export async function postPlanNote(
  projectId: string,
  note: NewNote,
): Promise<{ note_ids: string[] }> {
  return post<{ note_ids: string[] }>(`/projects/${projectId}/plan/notes`, note)
}

export type Resolution = 'apply' | 'reject' | 'answered' | 'dismiss'

/** THE ONLY WAY A NOTE'S STATUS CHANGES (constraint C1) — AND NOTHING IN THIS
 *  BROWSER CALLS IT ANY MORE.
 *
 *  That is not an oversight and it is not dead code awaiting a delete. Change 9
 *  ended with zero click-time status writes in the client: the note row's
 *  `Apply now` / `Resolve` / `Dismiss now` went in M2, and the desk band's
 *  deviation callout — the last holdout — went in M4. A note is closed by a
 *  staged `Dismiss` and answered by a staged `Ask`, and `submit_review` applies
 *  both server-side in the same transaction as the write.
 *
 *  IT STAYS BECAUSE THIS MODULE DECLARES THE SERVER'S PLAN SURFACE, not the
 *  subset of it today's components happen to reach. `POST …/plan/notes/{id}/
 *  resolve` is a live route with a live CLI caller (`clawmeets plan note`), and
 *  `PlanEditor.mounts.test.tsx` reads this export twice: once to assert the
 *  desk hand-rolls no plan URL of its own, and once to assert that no component
 *  calls THIS. Delete it and the second assertion passes for the wrong reason.
 *
 *  There is no client-side status write, no local flag and no optimistic
 *  decrement of `open_notes_for_you`. A client-side clear would drop that
 *  integer to zero on the client while the server still counts the note — and
 *  the integer the execution gate reads is the one nobody is looking at. That
 *  is a defeated guard, not a rendering bug. Every caller invalidates and
 *  refetches; the server's count is the count. */
export async function resolvePlanNote(
  projectId: string,
  noteId: string,
  action: Resolution,
  opts: { reason?: string; force?: boolean } = {},
): Promise<WriteResult> {
  try {
    return await post<WriteResult>(
      `/projects/${projectId}/plan/notes/${noteId}/resolve`,
      { action, reason: opts.reason ?? '', force: opts.force ?? false },
    )
  } catch (e) {
    return asStale(e)
  }
}

/** Replace the whole tray. Server-side, so two tabs share one tray. Never
 *  validated against the document: a row records `base` and nothing more, and
 *  staging is refused only for the 100-row cap. */
export async function putPlanDraft(
  projectId: string,
  draft: PlanReviewDraft,
): Promise<PlanReviewDraft> {
  return put<PlanReviewDraft>(`/projects/${projectId}/plan/draft`, { draft })
}

export async function deletePlanDraft(projectId: string): Promise<void> {
  await del(`/projects/${projectId}/plan/draft`)
}

/** One transaction: the write and every message share one atomic append. A
 *  stale row refuses the whole submit — nothing applied, nothing sent, TRAY
 *  UNTOUCHED — and arrives as `PlanStaleError`. */
export async function submitPlanReview(
  projectId: string,
  opts: { batch_comment?: string; room?: string; note_ids?: string[]; desk?: boolean } = {},
): Promise<{
  round_id: string
  revision: number
  room: string
  addressees: string[]
  /** ADDRESSEES THE BATCH COULD NOT REACH — a `200` that partly went nowhere.
   *  Delivery resolves every addressee against the review room's MEMBERSHIP and
   *  deletes anyone who is not in it, so the note is filed, counted, and then
   *  dropped behind a success. `clawmeets plan consult` reconciles membership
   *  (idempotent per participant, so an agent registered after the last consult
   *  is seated by the next one) — but a submit that runs BEFORE any consult, or
   *  that names an agent outside the project's invitable roster, still resolves
   *  to nobody. This list is the ONLY signal the UI has, so it is rendered
   *  rather than swallowed.
   *  Sorted names, `OWNER` excluded, `[]` on a clean submit. It has always been
   *  on this response — this file just never named it. */
  unresolved: string[]
}> {
  try {
    return await post(`/projects/${projectId}/plan/review`, {
      batch_comment: opts.batch_comment ?? '',
      room: opts.room ?? '',
      note_ids: opts.note_ids ?? [],
      desk: opts.desk ?? true,
    })
  } catch (e) {
    return asStale(e)
  }
}

/** Record one decision-nudge event. Idempotent server-side: a repeat returns
 *  200 and the unchanged stamps. The server then publishes PROJECT_PLAN_SYNC,
 *  so `useProjectPlan` refetches on its own. */
export async function postPlanNudgeEvent(
  projectId: string,
  event: PlanNudgeEvent,
): Promise<PlanNudge> {
  return post<PlanNudge>(`/projects/${projectId}/plan/nudge`, { event })
}

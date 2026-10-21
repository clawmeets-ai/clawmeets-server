import { ApiError } from '../../../api/client'
import type {
  DraftEntry,
  PlanIndex,
  PlanNote,
  PlanSection,
  PlanSummary,
  PlanVersion,
  SectionEdit,
} from '../../../api/endpoints/projectPlans'

/** The mirror of `plan_markdown.extent_key`. A section extent reduced to what a
 *  splice can actually preserve: `replace_section` throws away the caller's
 *  trailing newline run and re-attaches the document's own, so two extents
 *  differing only in that run are the same section.
 *
 *  Newlines only — trailing SPACES are a markdown hard break the splice keeps
 *  verbatim, so they stay a real difference here too. */
const extentKey = (text: string) => text.replace(/\n+$/, '')

/**
 * A fake plan server, standing in for the routes at the HTTP seam.
 *
 * It is deliberately NOT a per-endpoint mock. The one property phase 6 has to
 * prove — that `PlanIndex.open_notes_for_you` and `PlanSummary.open_notes_for_you`
 * are THE SAME NUMBER — is only meaningful if there is exactly one place the
 * number comes from, which is how the real server is built: one
 * `open_notes_for_you` implementation, read by the index route, by the desk
 * summary and by the execution gate, with an AST test forbidding a second count
 * in the route module.
 *
 * So this fake has ONE filter too (`openForYou` below), and both payloads read
 * it. If a client ever derives its own count, the assertion that the two
 * rendered integers agree stops being a tautology and starts failing.
 *
 * It also enforces the parts of the contract the client must not fake:
 * a `base` that no longer matches refuses the WHOLE submit and writes nothing;
 * a submit of only decisions appends no write and leaves `revision` alone;
 * a note's status changes only through the resolve route.
 */
export class FakePlanServer {
  body: string
  notes: PlanNote[] = []
  draft: DraftEntry[] = []
  batchComment = ''
  revision = 1
  sha = 'sha-1'
  keeper = 'coordinator'
  accepted = false
  acceptedRevision: number | null = null
  /** The project's owner. The browser's Approve control is owner-or-coordinator,
   *  and a coordinator is an agent rather than a browser principal, so this is
   *  the id the control compares the effective principal against. */
  createdBy = 'u-1'
  /** `PlanIndex.can_decide` — may THIS identity resolve notes? The real server
   *  computes it with the same predicate the `POST …/plan/review` guard calls;
   *  here it is a switch, because the fake has no identity of its own and the
   *  thing worth faking is the two ANSWERS rather than the derivation.
   *
   *  It is a field of its own rather than `draft !== null` on purpose: the fake
   *  hands out a tray unconditionally, so deriving it here would rebuild in the
   *  double the very proxy the client just stopped reading, and a suite that
   *  did that could never see the flag go false. */
  canDecide = true
  /** `PlanIndex.records_folds` — does THIS server close a folded-away note as
   *  `folded` rather than force-closing it `rejected`? A switch, for exactly
   *  `canDecide`'s reason: the fake has no deployment of its own, and the thing
   *  worth faking is the two ANSWERS rather than the derivation.
   *
   *  DEFAULTS TRUE, because that is what this build's server returns and the
   *  suites that say nothing about folds should run against the shipping
   *  behaviour. A suite that could not flip it could never reach the mitigation
   *  branch, which is precisely the branch that exists for the servers this
   *  bundle will actually meet in the deploy window. */
  recordsFolds = true
  specDigest = 'digest-1'
  /** Names that are on the project but NOT in the review room. Delivery deletes
   *  them from the fan-out and reports them on the round: a 200 that partly went
   *  nowhere. */
  notMembers: string[] = []
  /** `Project.participating_agents` — the project's own roster, and the SCOPE of
   *  the addressee picker. Empty by default, which is the degraded shape every
   *  suite but the picker's runs against: the roster then falls back to the
   *  keeper and whoever has written a note, exactly as the chip row it replaced
   *  always did. */
  participating: string[] = []
  /** `GET /agents` — the account's agents, used by the picker as a LOOKUP for
   *  role and live status rather than as the list itself. Empty by default; a
   *  name with no card still gets a row, with no role line and no dot. */
  agents: { id: string; name: string; description: string; status: string }[] = []
  surface: 'regular' | 'frontdesk' = 'regular'
  phase: string | null = 'executing'
  history: PlanIndex['history'] = [
    { seq: 1, at: 't0', by: 'coordinator', verb: 'create', section: '', detail: '' },
  ]
  versions: PlanVersion[] = []
  /** every message the fake posted, one per addressee per round. */
  messages: { to: string; round: string }[] = []
  rounds = 0
  /** set to fail the next submit for a reason other than staleness. */
  failNextSubmit: ApiError | null = null
  /** set to fail the next `POST /plan/notes` — the OTHER write this surface
   *  can be refused on, and the one whose refusal belongs to the composer
   *  rather than to the pane. Distinct from `failNextSubmit` on purpose: which
   *  of the two failed is exactly what the editor now gates its top-of-pane
   *  alert on, so a test cannot pin that with one knob. */
  failNextNote: ApiError | null = null

  constructor(body: string, sections: PlanSection[]) {
    this.body = body
    this._sections = sections
  }

  private _sections: PlanSection[]

  /** The server's grammar, stubbed: extents are recomputed from the section
   *  headings the fixture declared, so a replaced section keeps the rest of the
   *  document byte-identical. The client never does this — that is the point. */
  sections(): PlanSection[] {
    const out: PlanSection[] = []
    for (const s of this._sections) {
      const start = this.body.indexOf(s.heading === '' ? '\n' : headingLine(s))
      if (start < 0) continue
      out.push({ ...s, char_start: start, char_end: 0 })
    }
    for (let i = 0; i < out.length; i += 1) {
      const next = out.slice(i + 1).find((o) => o.depth <= out[i].depth)
      out[i].char_end = next ? next.char_start : this.body.length
    }
    return out
  }

  sectionText(slug: string): string {
    const s = this.sections().find((x) => x.id === slug)
    return s ? this.body.slice(s.char_start, s.char_end) : ''
  }

  /** The slug does not resolve. A DIFFERENT ANSWER from `section_changed`,
   *  which reports `false` here by design, and the two must stay apart in the
   *  fake for the same reason they do on the server.
   *
   *  THE RAW FACT, AND NO LONGER A FLAG. It used to be one — `section_missing`
   *  was this and nothing else — and the wire now splits it in two:
   *  `section_missing` for a section that was DELETED under a note and
   *  `section_new` for one this note would CREATE. `index()` does that split;
   *  the submit path below wants the undivided fact and keeps reading it here,
   *  which is why `rowCreates` sits beside every call rather than inside this. */
  missing(slug: string): boolean {
    return !!slug && !this.sections().some((x) => x.id === slug)
  }

  /** Would this note CREATE the section it names? The server's own predicate
   *  (`section_new`), and the same rule `rowCreates` applies to a tray row —
   *  asked of the NOTE, because only the note's captured `base_section` tells
   *  "there was nothing there when this was written" apart from "there was, and
   *  it is gone now". */
  private noteCreates(n: PlanNote): boolean {
    return !!n.proposal && !n.base_section
  }

  /** ONE filter. Both payloads read it; nothing else counts. */
  openForYou(): number {
    return this.notes.filter((n) => n.status === 'open' && n.to === 'user').length
  }

  summary(): PlanSummary {
    const fd = this.surface === 'frontdesk'
    const dev = [...this.notes]
      .reverse()
      .find((n) => n.kind === 'deviation' && n.status === 'open')
    return {
      surface: this.surface,
      phase: fd ? null : (this.phase as PlanSummary['phase']),
      revision: fd ? null : this.revision,
      accepted: fd ? null : this.accepted,
      accepted_revision: fd || !this.accepted ? null : this.acceptedRevision,
      open_notes_for_you: this.openForYou(),
      deviation: dev
        ? {
            id: dev.id,
            by: dev.by,
            comment: dev.comment,
            section: dev.section,
            base_section: dev.base_section,
          }
        : null,
    }
  }

  index(): PlanIndex {
    return {
      body: this.body,
      sections: this.sections(),
      notes: this.notes.map((n) => ({
        ...n,
        // Mirrors the server: a refused DELETE is a proposal whose
        // replacement text is empty, and the OPEN clause is on that arm
        // alone because a flag cannot blank itself the way a string can.
        has_proposal: !!n.proposal || (n.proposes_delete && n.status === 'open'),
        replies: this.notes.filter((r) => r.reply_to === n.id).map((r) => r.id),
        // THE SPLIT MIRRORED, not simplified. The server answers "the slug does
        // not resolve" with TWO flags — a note carrying a proposal and no
        // captured base is CREATING the section, and `section_missing` returns
        // false for it — so a fake that folded them back into one would certify
        // the deletion sentence on notes the real read labels as creates.
        section_missing: this.missing(n.section) && !this.noteCreates(n),
        section_new: this.missing(n.section) && this.noteCreates(n),
        // Gated on `base_section`, not on `proposal`: that is the server's own
        // predicate (`models/project_plan.py::section_changed`). A comment or a
        // question is stored with `base_section: ''` and has nothing to compare
        // against, so it is never `changed` — the two happen to agree for every
        // note this fake builds, and disagreeing here is how a green suite comes
        // to certify a banner the real read would not show.
        // `extentKey` for the same reason the server has `extent_key`: a splice
        // discards the caller's trailing newline run and re-takes the
        // document's, so that run is never an edit. Mirror it or this fake
        // certifies the exact bug it was blind to — a go-note that can never be
        // accepted because a section was appended after `## Approval`.
        section_changed:
          !!n.base_section && extentKey(this.sectionText(n.section)) !== extentKey(n.base_section),
        display_diff: n.proposal ? `--- ${n.section} (base)\n+++ ${n.section} (proposed)\n` : '',
      })),
      draft: { by: 'user', entries: this.draft, batch_comment: this.batchComment, room: '', updated_at: '' },
      can_decide: this.canDecide,
      records_folds: this.recordsFolds,
      sha: this.sha,
      revision: this.revision,
      keeper: this.keeper,
      open_notes_for_you: this.openForYou(),
      spec_digest: this.specDigest,
      accepted: this.accepted,
      accepted_revision: this.accepted ? this.acceptedRevision : null,
      changed_since_acceptance: false,
      history: this.history,
    }
  }

  /** MIRRORS `_splice`, INCLUDING ITS `create` ARM. An unresolvable slug is a
   *  refusal — unless the caller means to create the section, in which case it
   *  is appended at the end of the document (§15.4: a create lands where a
   *  human can see it and move it, never where a stale slug happened to point).
   *
   *  The server derives `create` from the accepting NOTE's `base_section`, not
   *  from the row's own `base`: the row carries `base: ''` both for a proposal
   *  written against a section that was already absent (a restore) and for one
   *  whose section was deleted underneath it (a conflict). This fake asks the
   *  same question of the same field, so a suite here cannot certify a create
   *  the real submit would refuse — or a refusal it would now honour. */
  private applyEdit(e: SectionEdit & { create?: boolean }): void {
    const s = this.sections().find((x) => x.id === e.section)
    if (!s) {
      if (!e.create) throw conflict('no such section', this.revision, [])
      this.body = `${this.body.replace(/\n*$/, '')}\n\n${e.text.replace(/\n*$/, '')}\n`
      return
    }
    this.body = this.body.slice(0, s.char_start) + e.text + this.body.slice(s.char_end)
  }

  /** Does this staged row mean to CREATE the section it names? The note's
   *  `base_section`, and never the row's `base` — see `applyEdit`. */
  private rowCreates(r: DraftEntry): boolean {
    if (r.kind !== 'accept' || !r.note_id) return false
    return !this.notes.find((n) => n.id === r.note_id)?.base_section
  }

  /** All-or-nothing: every `base` is checked against the body AS STORED before
   *  one byte moves. One stale row refuses the whole submit.
   *
   *  `noteIds` is the batch's OTHER half and the fake honours it for the same
   *  reason it honours `base`: a fake that accepted the ids and dropped them
   *  would let a client claiming to send a note pass without ever sending one.
   *  A named note goes to whoever it is ADDRESSED to (the row path goes to the
   *  note's AUTHOR — two directions, two rules), is marked `sent`, and naming
   *  one that is already out is the server's `409`. */
  submit(
    noteIds: string[] = [],
  ): {
    round_id: string
    revision: number
    room: string
    addressees: string[]
    unresolved: string[]
  } {
    if (this.failNextSubmit) {
      const err = this.failNextSubmit
      this.failNextSubmit = null
      throw err
    }
    const live = this.draft.filter((r) => r.kind === 'edit' || r.kind === 'accept')
    // MIRRORS `_collapse_text_rows` FOR THE ROWS THIS CLIENT CAN PRODUCE, AND
    // THE STALE CHECK RUNS ON THE WINNERS ONLY.
    //
    // The server keys on what `_edit_for_row` says a row WRITES, which for an
    // `accept` naming no section is derived from the note. `acceptRow` copies
    // `note.section` onto every row the browser stages, so no row reaching this
    // fake has an empty `section` and keying on the field is the same answer.
    // If that ever stops being true, this has to derive too. `apply_edits` splices one replacement per section, so the server
    // builds its `edits` from the LAST text row per section and asks staleness
    // of those alone. A fake that asked it of every row would report the same
    // section twice the moment a collision has been settled — two panels, two
    // React keys the same — and would let a client pass that re-bases a
    // superseded row the real submit never looks at.
    const applied = [...new Map(live.map((r) => [r.section, r])).values()]
    const staleRows = applied
      // `extentKey`, mirroring `_splice` — and it has to move with the
      // `section_changed` line above it or the fake reproduces the split the
      // server no longer has: a row that renders `stale: false` and then earns
      // a 409 from the submit it was cleared for.
      // A row whose section is GONE is not stale-by-comparison — both sides are
      // `''` — so it is asked separately, and only refused when the note it
      // accepts was written against a section that existed.
      .filter(
        (r) =>
          (this.missing(r.section) && !this.rowCreates(r)) ||
          (!this.missing(r.section) &&
            extentKey(this.sectionText(r.section)) !== extentKey(r.base)),
      )
      .map((r) => ({ section: r.section, base: r.base, current: this.sectionText(r.section) }))
    if (staleRows.length) {
      // Nothing applied, nothing sent, TRAY UNTOUCHED — and one conflict note
      // per stale section, so a refusal is never a dead end.
      const gone = staleRows.filter((r) => this.missing(r.section)).map((r) => r.section)
      throw conflict(
        gone.length
          ? `Section ${gone.map((g) => `'${g}'`).join(', ')} no longer exists; the ` +
              'proposal cannot be applied; nothing was applied or sent'
          : 'the plan moved under this change',
        this.revision,
        staleRows,
        staleRows.map((s) => `n-conflict-${s.section}`),
      )
    }
    for (const r of live) {
      this.applyEdit({
        section: r.section,
        text: r.text,
        base: r.base,
        create: this.rowCreates(r),
      })
    }

    // Two different (append, increment) pairs through one submit: a batch that
    // carries text is one revision; a batch of only decisions is none.
    if (live.length) {
      this.revision += 1
      this.sha = `sha-${this.revision}`
      this.history = [
        ...this.history,
        { seq: this.history.length + 1, at: 't', by: 'user', verb: 'submit', section: '', detail: '' },
      ]
      this.versions = [
        {
          revision: this.revision,
          sha: this.sha,
          by: 'user',
          at: 't',
          version: this.revision,
          proposed_by: [...new Set(live.map((r) => this.notes.find((n) => n.id === r.note_id)?.by).filter((x): x is string => !!x))],
          note: this.batchComment,
        },
        ...this.versions,
      ]
    }

    // Resolve every decided note, server-side. This is the only place a note's
    // status moves in this fake, exactly as it is the only place on the server.
    //
    // THE COLLAPSE IS MIRRORED HERE TOO, AND WITHOUT IT THIS FAKE COULD NOT
    // PRODUCE THE STATE UNDER TEST. `applied` above is already the LAST text
    // row per section — the winners. Every OTHER text row is a row the server
    // collapsed away, and it used to be closed `applied` here beside the winner
    // — a state the real server cannot reach, so any assertion about a settled
    // collision was green against a fiction. A loser closes `folded` when its
    // own row carries the bit AND this server records folds, and `rejected`
    // otherwise, which is the superseded loop.
    const winners = new Set(applied.map((r) => r.id))
    const to = new Set<string>()
    const filed: PlanNote[] = []
    for (const r of this.draft) {
      const n = this.notes.find((x) => x.id === r.note_id)
      if (!n) continue
      const collapsed = (r.kind === 'edit' || r.kind === 'accept') && !winners.has(r.id)
      const foldedAway = collapsed && this.recordsFolds && r.folded === true
      // THE TRAY IS A NOTE-CLOSING PATH TOO, and it is a different code path
      // from the resolve route — which is exactly why the rule lives in one
      // method that both call rather than being written out twice.
      //
      // A FOLD IS NOT AN APPLY, and the fake needs to know that independently
      // of the client. A folded-away row is an `accept` row, so without this
      // arm the call below would hand `closeGoNote` an `'apply'` and a fold
      // would APPROVE THE PLAN — the hole the server closed in its own guard.
      // `PlanEditor` already refuses to stage the fold; asserting the server
      // half through a client that cannot reach it would assert nothing.
      // Everything else keeps the call it always made — INCLUDING a genuine
      // supersede against the go-note, which is the recorded approval-gate
      // followup and is deliberately left exactly as it behaves today.
      if (foldedAway) this.closeGoNote(n, 'fold')
      else if (r.kind !== 'ask') this.closeGoNote(n, r.kind === 'accept' ? 'apply' : r.kind)
      if (collapsed) {
        // The winner is the server's own, derived from the collapse rather than
        // from anything the client said — which is why the client sends no name.
        const won = applied.find((w) => w.section === r.section)
        const by = (won && this.notes.find((x) => x.id === won.note_id)?.by) || ''
        n.status = foldedAway ? 'folded' : 'rejected'
        n.resolution = foldedAway
          ? `folded into @${by}'s change on the same section — your text is in the section that landed`
          : `superseded by @${by}'s proposal on the same section`
      } else {
        n.status =
          r.kind === 'accept'
            ? 'applied'
            : r.kind === 'reject'
              ? 'rejected'
              : r.kind === 'dismiss'
                ? 'dismissed'
                : 'open'
      }
      if (r.kind === 'ask') {
        // AN `ask` ROW FILES A REAL NOTE, and the parent STAYS OPEN — a question
        // is not a resolution. `quote` and `section` are DERIVED from `note_id`
        // here exactly as the route derives them, which is why the client sends
        // neither and why this is not a wire change. `to` is the row's when it
        // has one and falls back to the parent's AUTHOR when it does not — and
        // that fallback is `"user"` on your own note, which is precisely the
        // case the client computes `to` itself to avoid.
        const addressee = r.to || n.by
        filed.push({
          ...n,
          id: `n-ask-${this.notes.length + filed.length}`,
          // DERIVED, as it is on the real server: this note carries `reply_to`,
          // and that is the whole of what makes it a reply. It used to be
          // stamped `'question'` here, which named the mechanism rather than
          // the act and missed every reply filed through the ordinary door.
          kind: 'reply',
          status: 'open',
          by: 'user',
          to: addressee,
          comment: r.comment,
          proposal: '',
          reply_to: n.id,
          sent: false,
          // `round` is keyed on the PARENT's id for an ask row, never on the
          // reply's own — the reply carries `''` and never appears in `sends`
          // under its own id.
          round: '',
          replies: [],
          has_proposal: false,
        })
        if (addressee) to.add(addressee)
        continue
      }
      if (n.by) to.add(n.by)
    }
    this.notes.push(...filed)
    for (const nid of noteIds) {
      const n = this.notes.find((x) => x.id === nid)
      if (!n) throw new ApiError(404, `no such note ${nid}`)
      // The send ledger, applied BEFORE the messages go out — filtering after
      // the fact is what re-sends a note and records nothing.
      if (n.sent) {
        throw conflict(`Note ${n.id} is already out`, this.revision, [])
      }
      n.sent = true
      if (n.to) to.add(n.to)
    }

    this.rounds += 1
    const roundId = `r-${this.rounds}`
    // ROOM MEMBERSHIP IS RESOLVED BEFORE THE FAN-OUT, and a name that is not a
    // member is DELETED from it rather than failing the submit. The round
    // records it; the response carries it. `OWNER` is never in this sweep.
    const unresolved = [...to].filter((a) => a !== 'user' && this.notMembers.includes(a)).sort()
    for (const who of to) {
      if (unresolved.includes(who)) continue
      this.messages.push({ to: who, round: roundId })
    }
    this.draft = []
    this.batchComment = ''
    return {
      round_id: roundId,
      revision: this.revision,
      room: 'shared-context',
      addressees: [...to].filter((a) => !unresolved.includes(a)),
      unresolved,
    }
  }

  /** THE GO-NOTE the server files at project creation — a proposal against
   *  `## Approval`, addressed to the user, whose whole content is *replace this
   *  section's body with "User approves the plan."*.
   *
   *  Minted on demand rather than seeded into `notes`, because most suites here
   *  are about something else and an extra always-present row would change
   *  every count they assert. The suites that care about acceptance push one
   *  in. Exactly one is ever filed, as on the server: acceptance is one-way. */
  goNote(): PlanNote {
    // **IT SEEDS NO SECTION ANY MORE, AND THAT IS THE CHANGE.** This used to
    // append `## Approval` to the fixture body, because the note was a proposal
    // LOCATED BY HEADING: against a document without it the note had nothing to
    // apply to, the editor read the section as having moved, and a fixture that
    // forgot it failed with a collision dialog that looked like a bug in the
    // control under test. The confirm note carries no proposal and names no
    // section — `section: ''` is *the document as a whole* — so there is
    // nothing to seed and nothing for a fixture to forget.
    return {
      id: `n-go-${this.notes.length}`,
      section: '',
      to: 'user',
      by: 'server',
      at: 't',
      status: 'open',
      kind: 'proposal',
      // `## Approval` carries no layer marker, so it is spec — and the go-note
      // has to be, or accepting the plan would stop gating the project.
      layer: 'spec',
      comment: 'Work on this project does not start until you accept the plan.',
      proposal: '',
      base_section: '',
      quote: '',
      reply_to: '',
      round: '',
      conflict: false,
      resolved_by: '',
      resolved_at: '',
      resolution: '',
      revision: this.revision,
      has_proposal: false,
      bootstrap: true,
      proposes_delete: false,
      sent: false,
      replies: [],
      section_missing: false,
      section_new: false,
      section_changed: false,
      display_diff: '',
    }
  }

  /** APPLYING A PROPOSAL IS ACCEPTING THE PLAN, and it happens wherever a note
   *  is closed — the tray's submit and the resolve route both land here. One
   *  home for the rule, because the server has one too.
   *
   *  ON THE CONFIRM NOTE that is the FIRST acceptance, and every close but
   *  `dismiss` is REFUSED: the gate counts notes that are open, so a reject —
   *  or an `apply`, which would close it without stamping anything — would
   *  leave the plan unapproved *and* unblocked, the coordinator starting on a
   *  plan the user just turned down.
   *
   *  ON EVERY LATER NOTE, once the plan is accepted, it RE-STAMPS. There is no
   *  revoke any more, so without this the fake would freeze `acceptedRevision`
   *  at the go-note's revision while the document moved on under it — and a
   *  suite driving the owner's own applied deviation would be asserting against
   *  a staleness the server does not have. Mirrors
   *  `_stamp_acceptance_locked`'s `note.bootstrap or plan.accepted_at`. */
  closeGoNote(n: PlanNote, action: string): void {
    if (n.bootstrap) {
      if (action !== 'dismiss') {
        throw new ApiError(
          409,
          'dismissing this note is what approves the plan; reply to it instead if you want changes',
        )
      }
      this.accepted = true
      this.acceptedRevision = this.revision
      return
    }
    // Every LATER note re-stamps on apply, once the plan is accepted.
    if (action !== 'apply' || !this.accepted) return
    this.accepted = true
    this.acceptedRevision = this.revision
  }

  resolve(noteId: string, action: string): void {
    const n = this.notes.find((x) => x.id === noteId)
    if (!n) throw new ApiError(404, 'no such note')
    this.closeGoNote(n, action)
    n.status =
      action === 'apply'
        ? 'applied'
        : action === 'reject'
          ? 'rejected'
          : action === 'dismiss'
            ? 'dismissed'
            : 'answered'
    this.history = [
      ...this.history,
      {
        seq: this.history.length + 1,
        at: 't',
        by: 'user',
        verb: 'resolve',
        section: n.section,
        detail: action,
      },
    ]
  }

  /** A third-party write, for the sync-arrives-mid-tray case. */
  foreignWrite(slug: string, text: string, by = 'clawmeets-backend'): void {
    this.applyEdit({ section: slug, text, base: '' })
    this.revision += 1
    this.sha = `sha-${this.revision}`
    this.history = [
      ...this.history,
      { seq: this.history.length + 1, at: 't', by, verb: 'write', section: slug, detail: '' },
    ]
  }
}

function headingLine(s: PlanSection): string {
  return `${'#'.repeat(s.depth)} ${s.heading}`
}

function conflict(
  message: string,
  revision: number,
  stale: { section: string; base: string; current: string }[],
  noteIds: string[] = [],
): ApiError {
  // FastAPI wraps a dict detail as `{detail: {...}}` — the shape the client
  // unpacks into `PlanStaleError`.
  return new ApiError(409, '[object Object]', {
    detail: { error: message, revision, note_ids: noteIds, stale },
  })
}

/** Wire the fake into the low-level client so the REAL endpoint module runs —
 *  including its `404 -> null` and `409 -> PlanStaleError` translations. */
export function routeTo(server: FakePlanServer, projectId: string) {
  const plan = `/projects/${projectId}/plan`
  return {
    get: async (path: string) => {
      if (path === `${plan}/versions`) return server.versions
      if (path === plan) return server.index()
      if (path === `/projects/${projectId}`) {
        return {
          id: projectId,
          name: 'demo',
          created_by: server.createdBy,
          participating_agents: server.participating,
          plan: server.summary(),
        }
      }
      // ACCOUNT-SCOPED, AND THE PICKER USES IT AS A LOOKUP RATHER THAN AS THE
      // ROSTER. The scope is `participating_agents` above; this supplies the
      // role line and the live dot for the names that appear there. It is a
      // real route the sidebar already calls, so it is routed here rather than
      // left to 404 — a 404 is also a supported state (the picker degrades to
      // bare names) and every suite that does not set `server.agents` still
      // exercises the empty-lookup path.
      if (path === '/agents') return server.agents
      throw new ApiError(404, `unrouted GET ${path}`)
    },
    post: async (path: string, body?: unknown) => {
      if (path === `${plan}/review`) {
        return server.submit((body as { note_ids?: string[] })?.note_ids ?? [])
      }
      const resolveMatch = path.match(/\/plan\/notes\/([^/]+)\/resolve$/)
      if (resolveMatch) {
        server.resolve(resolveMatch[1], (body as { action: string }).action)
        return { ok: true, revision: server.revision, sections: [], sha: server.sha, note_ids: [], noop: true }
      }
      if (path === `${plan}/notes`) {
        if (server.failNextNote) {
          const err = server.failNextNote
          server.failNextNote = null
          throw err
        }
        // `quote` and `reply_to` ride the real route (`NewNote`) and are
        // stored on the note. The fake used to drop both, which made a quoted
        // note indistinguishable from an unquoted one at the seam the client
        // is tested against.
        const b = body as {
          to?: string[]
          section?: string
          comment?: string
          proposal?: string
          quote?: string
          reply_to?: string
        }
        const ids = (b.to?.length ? b.to : ['']).map((to, i) => {
          const id = `n-new-${server.notes.length}-${i}`
          server.notes.push({
            id,
            section: b.section ?? '',
            to,
            by: 'user',
            at: 't',
            status: 'open',
            // The server derives this; the mock reproduces the same
            // precedence over the fields this door can set. There is no
            // `deviation` arm because that needs an accepted plan, which
            // this mock never has.
            kind: b.proposal ? 'proposal' : b.reply_to ? 'reply' : 'note',
            // The real `add_note` stamps this off the document's layer markers.
            // This mock's body carries none, so every section in it is spec —
            // reproducing the same answer without parsing for it. A fixture
            // that needs a detail-layer note sets it on the pushed note.
            layer: 'spec',
            comment: b.comment ?? '',
            proposal: b.proposal ?? '',
            base_section: '',
            quote: b.quote ?? '',
            reply_to: b.reply_to ?? '',
            round: '',
            conflict: false,
            resolved_by: '',
            resolved_at: '',
            resolution: '',
            revision: server.revision,
            has_proposal: !!b.proposal,
            bootstrap: false,
            proposes_delete: false,
            sent: false,
            replies: [],
            section_missing: false,
            section_new: false,
            section_changed: false,
            display_diff: '',
          })
          return id
        })
        return { note_ids: ids }
      }
      throw new ApiError(404, `unrouted POST ${path}`)
    },
    put: async (path: string, body?: unknown) => {
      if (path === `${plan}/draft`) {
        const b = body as { draft: { entries: DraftEntry[]; batch_comment: string } }
        server.draft = b.draft.entries
        server.batchComment = b.draft.batch_comment
        return { by: 'user', entries: server.draft, batch_comment: server.batchComment, room: '', updated_at: '' }
      }
      throw new ApiError(404, `unrouted PUT ${path}`)
    },
    del: async () => {
      server.draft = []
      return { status: 'discarded' }
    },
  }
}

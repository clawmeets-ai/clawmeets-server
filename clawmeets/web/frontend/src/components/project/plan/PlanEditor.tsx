import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../../api/client'
import {
  deletePlanDraft,
  PLAN_LIMITS,
  PlanStaleError,
  postPlanNote,
  putPlanDraft,
  submitPlanReview,
  type NewNote,
  type PlanNote,
  type PlanSection,
  type StaleSection,
} from '../../../api/endpoints/projectPlans'
import { useProjectPlan, useProjectPlanVersions } from '../../../hooks/useProjectPlan'
import Loading from '../../common/Loading'
import { PlanAcceptance } from './PlanAcceptance'
import { PlanBody, type QuoteTarget } from './PlanBody'
import { PlanCollide, type CollideChoice } from './PlanCollide'
import { PlanCommentList } from './PlanCommentList'
import { PlanHistory } from './PlanHistory'
import { PlanNoteRow } from './PlanNoteRow'
import { baseIsCurrent, diffSeries, foldProposal, type DiffStep } from './planDiffs'
import { PlanQuotePop } from './PlanQuotePop'
import { PlanTray } from './PlanTray'
import { capQuote } from './planAnchor'
import { spliceBlock, type BlockRange } from './planBlocks'
import {
  acceptRow,
  appliedTextRow,
  askRow,
  decisionRow,
  dropTextRows,
  duplicateHeadings,
  editRow,
  findSection,
  heldTextRow,
  lastToucherOf,
  commentList,
  openDeviations,
  openNotesOn,
  pendingNotes,
  preambleText,
  removeRow,
  resolveCollision,
  foldedReason,
  stackRows,
  sectionLabel,
  sectionOwnText,
  sectionText,
  toWire,
  visibleSections,
  type TrayRow,
} from './planTrayLogic'
import './plan.css'

/** Layout only. Every write path, every route and every guard below is the SAME
 *  CODE on both mounts — this prop is consulted in exactly three places (the
 *  section rail's form, whether History is offered, and the outer box's
 *  height), and it must never be consulted for a fourth. The moment `density`
 *  reaches a handler, the two mounts have forked and the desk has grown a
 *  second write path. */
export type PlanDensity = 'full' | 'compact'

export interface PlanEditorProps {
  projectId: string
  /** 'full' — the Plan tab: two-pane layout, section rail, History pane.
   *  'compact' — the desk card: the rail collapses to a <select>, History is
   *  hidden, and the tray docks inline at the end of the band instead of
   *  against the viewport.
   *  THIS PROP CHANGES LAYOUT AND NOTHING ELSE. */
  density?: PlanDensity
  /** A COUNTER, NOT A BOOLEAN. The compact mount is UNMOUNTED while the PLAN
   *  band is folded, so the seeding effect reads the signal ON MOUNT; a boolean
   *  would need a reset and could not fire twice. */
  openSignal?: number
  /** Mounted but not visible — gates the versions query only. */
  active?: boolean
  /** Set by a mount whose OWN chrome already states the acceptance and its
   *  revision — the desk band, and nothing else today. Forwarded verbatim to
   *  `PlanAcceptance`, which drops its chip rather than repeat the band header
   *  one line up. Defaults false, so the Plan tab — where the strip is the only
   *  place acceptance appears at all — is untouched.
   *  IT IS NOT `density` AND MUST NOT BECOME IT: density says how wide the mount
   *  is, this says what the caller already rendered. Collapsing them would put
   *  `density` in charge of what EXISTS, which is the one thing it may never
   *  decide. */
  acceptanceStatedAbove?: boolean
  /** THE CALLER HOSTS THE PRIMARY. Set by a mount that renders its own action
   *  row below this editor — the desk card, and nothing else today. Two things
   *  follow, and they are one decision: the tray stops drawing `Send review`
   *  (so a card never shows two Sends), and `onSendState` starts reporting, so
   *  the caller's row can drive the very submit this component owns.
   *
   *  IT IS NOT `density`, for the reason `acceptanceStatedAbove` is not: width
   *  says how much room there is, this says what the caller RENDERED. Deriving
   *  it from density would put density in charge of what exists, which is the
   *  one thing it may never decide — and the Plan tab would lose its Send the
   *  day someone gave it a narrow layout. */
  sendHostedByCaller?: boolean
  /** Reports the batch this editor is holding, whenever it moves, so a caller
   *  that set `sendHostedByCaller` can render the Send. `null` means *there is
   *  no batch* — no rows, no pending notes — and is also what a caller receives
   *  when this component unmounts, which the desk relies on: folding the PLAN
   *  band unmounts the editor, and a stale count on the card's footer would
   *  offer to send a tray nobody is holding. */
  onSendState?: (state: PlanSendState | null) => void
}

/** What the caller needs to draw a Send it does not own. Deliberately small:
 *  the count and whether a submit is in flight — everything the label says —
 *  plus the two calls. No rows, no notes, no index: a caller that could read
 *  the batch could start deciding it, and this editor is the one write funnel. */
export interface PlanSendState {
  count: number
  submitting: boolean
  submit: () => void
  discard: () => void
}

/**
 * THE ONE PLAN EDITOR. Two mounts, one component: the project Plan tab and the
 * desk card's PLAN band. Not a copy, not a fork, not a desk variant — this file
 * IS `ProjectPlanTab`'s former body, lifted whole, and the tab now renders it.
 *
 * THE EDITOR IS TRANSPORT, ON BOTH MOUNTS. Every write goes through a §6 plan
 * route; the client constructs no document body of its own, parses no Markdown,
 * derives no heading, slug or box count, and knows nothing about fenced code
 * blocks — because it never scans. The only place it indexes into `body` is
 * `sectionText`, using the `char_start`/`char_end` the server derived and ships
 * for exactly that purpose.
 *
 * ONE WRITE FUNNEL AND NO STATUS PATH AT ALL, AND THE DESK ADDS NEITHER.
 * `submitPlanReview` (`POST …/plan/review`) is the only call that applies a
 * batch, and it is now also the only call that moves a note's status: the last
 * click-time `resolvePlanNote` in the tree — the desk band's deviation callout
 * — went in M4, so a note's status changes on a SUBMIT and on nothing else in
 * this browser. Because the desk mounts THIS component
 * rather than a variant, a second write path from the card is not something
 * that has to be policed — there is no second code path to police. A route
 * added here for the compact mount alone would defeat a guard the server
 * enforces.
 *
 * NOTHING DECREMENTS `open_notes_for_you`. No local flag, no component state
 * holding a note's status, no optimistic decrement. All three are the same
 * defect: the integer the execution gate reads would be the one nobody is
 * looking at.
 *
 * It reads two payloads, and that is not an accident of implementation: the
 * document and its notes are `PlanIndex`, and the lifecycle `phase` is on
 * `PlanSummary`, which hangs on the project record. The editor needs only the
 * first; the phase word is the tab header's and the desk rail's business.
 *
 * REQUEST COST. Both mounts call `useProjectPlan(projectId)` on the same query
 * key, so the tab and a card for the same project share one cache entry and one
 * request. The desk's protection is upstream and is the design rather than an
 * optimisation: `UpdateCard` mounts the compact editor ONLY while the PLAN band
 * is expanded. THE BOUND THAT BUYS IS PER CARD — a folded band costs no
 * `GET …/plan` and an expanded one costs at most one — and not per desk: two
 * cards are two projects and therefore two query keys, so a desk of twelve
 * `spec-ing` projects issues twelve, because each of them opens its PLAN band.
 * `useProjectPlan` also sets `staleTime: 0`, so every mount refetches rather
 * than reusing the cache: three unfolds are three requests. That is defensible
 * and it is what the code does. That invariant is also why `openSignal` is a
 * counter.
 *
 * Refresh is push-driven. `PROJECT_PLAN_SYNC` invalidates the query and this
 * refetches; it never patches its model from the envelope, because after a
 * refetch the previous body is gone and `sections` was a highlight hint rather
 * than a delta.
 */
export function PlanEditor({
  projectId,
  density = 'full',
  openSignal,
  active = true,
  acceptanceStatedAbove = false,
  sendHostedByCaller = false,
  onSendState,
}: PlanEditorProps) {
  const qc = useQueryClient()
  const { data: index, isLoading, error } = useProjectPlan(projectId)
  // Starts on the whole document and is SEEDED FROM THE OPEN DEVIATION once
  // the index lands — see the effect below. An unknown slug is not
  // special-cased: `findSection` answers undefined and the pane says the
  // section is no longer in the document — the same thing that happens when a
  // section is deleted under an open pane, and the same code doing it.
  const [pane, setPane] = useState<string>('all')
  // `density` gates the QUERY as well as the pane, not just the button: the
  // compact mount hides History, so leaving the fetch reachable would be a
  // second per-card request behind a control that cannot be clicked.
  const showHistory = density === 'full'
  const { data: versions } = useProjectPlanVersions(
    projectId,
    active && showHistory && pane === 'history',
  )

  // Tray rows are LOCAL for the session and mirrored to the server tray, which
  // is what lets two tabs share one plate. Until this client stages something
  // of its own they MIRROR that tray rather than copying it once — see `mine`.
  const [rows, setRows] = useState<TrayRow[]>([])
  /** WHOSE ROWS ARE ON SCREEN: this client's, or the server's.
   *
   *  It used to be `hydrated`, a one-shot latch — hydrate from `index.draft` on
   *  the first payload, then never look at the server tray again. That made the
   *  tray a WRITE-ONCE COPY of a server-owned resource, so it could never learn
   *  the original had been CONSUMED, and the submit itself is what consumed it:
   *
   *  `POST …/plan/review` opens the `PendingWork` batch inside `submit_review`,
   *  which pushes `ACTIVE_WORK_CHANGE`; `useDeskUpdates` flips the card's lane
   *  to `progress` on that envelope alone; `DeskPage` renders Review and Working
   *  as two separate lists, so the card is a NEW element and this whole editor
   *  unmounts — all of it before the POST's own response comes back. The
   *  success branch's `setRows([])` then lands on a dead component, and the
   *  fresh mount hydrates off the react-query CACHE, which still holds the
   *  pre-submit draft. Result: three rows and a live `Send review · 3` sitting
   *  under a plan whose review had already gone out, with no way back.
   *
   *  So the latch is on the OTHER fact. While `mine` is false the rows are the
   *  server's and every payload is adopted, the empty draft included — that is
   *  the line that clears the tray after a submit, from whichever mount is alive
   *  to see it. `stage` sets it true, and from then on nothing the server says
   *  replaces what the user typed.
   *
   *  AC-6.7 ("reloading never discards a row") is unaffected: a reload is a
   *  fresh mount with `mine` false, and what it adopts is the row. */
  const mine = useRef(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /** WHICH WRITE THE STANDING `failure` CAME OUT OF — the ownership the
   *  top-of-pane block gates on. Only meaningful while `failure` is non-null,
   *  and written in the SAME catch that writes the message, so the two can
   *  never disagree about whose refusal is on screen.
   *
   *  It replaces `!quoted` — "is a composer open" — which was a proxy for this
   *  and was wrong in the one case the proxy does not cover: a BATCH refusal
   *  raised while the composer happens to be open. `PlanQuotePop` renders a
   *  refusal only when its OWN post failed, deliberately, so under `!quoted`
   *  that batch refusal rendered in neither place and the user pressed Send
   *  review to complete silence. Asking whose failure it is answers the
   *  double-render question and that one together. */
  const [failureFrom, setFailureFrom] = useState<'batch' | 'note' | null>(null)

  // A block offered as a quote. Null whenever the composer is closed; it holds
  // no note and reaches no route until the user submits.
  const [quoted, setQuoted] = useState<QuoteTarget | null>(null)
  /** The note the comment list is pointing at. Display only.
   *
   *  ONE ROUTE INTO IT NOW, and that is a simplification rather than a loss.
   *  The document used to be a second one: a `<mark>` around a quoted phrase
   *  carried a click that focused its note. Notes are block-scoped and there is
   *  no mark to click any more — a note renders directly beneath the block it
   *  is about, so the highlight no longer has to point at anything. `showNote`
   *  below is the surviving setter, from the comment list. */
  const [focusNote, setFocusNote] = useState<string | null>(null)
  /** THE NOTE THE PANE OWES A SCROLL, and it is separate state from `focusNote`
   *  rather than a second reading of it. `focusNote` is a STANDING highlight —
   *  it stays lit while you read — whereas a scroll is a ONE-SHOT act that has
   *  to be consumed, or every later re-render (a keystroke in the tray, a sync
   *  arriving) would yank the pane back to the same note. This clears itself in
   *  the effect that performs it. */
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  /** The pane's own scroll container, so the scroll below is scoped to THIS
   *  mount. `document.querySelector` would be wrong rather than merely broad:
   *  the desk card and the Plan tab can both have a `PlanEditor` alive at once,
   *  and a bare query finds whichever mounted first. */
  const paneRef = useRef<HTMLDivElement | null>(null)

  // Raw editing, per section. The seed is the section's current text and the
  // row is emitted only when the text actually moved.
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')

  // A staging-time collision, and a post-refusal reconciliation. Same control,
  // two callers.
  const [collision, setCollision] = useState<{
    held: TrayRow
    next: TrayRow
    heldBy: string
    nextBy: string
    section: string
    reason: string
    /** THE TEXT THAT CARRIES BOTH EDITS, computed at the moment the question is
     *  asked and carried rather than recomputed at the click — the tray does not
     *  move while this control is open, and a `Keep both` button that offered
     *  itself on one string and staged another would be a different act from the
     *  one the diff above it drew.
     *
     *  `null` is the ordinary case AND the refusal: the two proposals touch the
     *  same lines (or lines close enough that fitting one over the other would be
     *  a guess), or the held note is one the server will not let anybody close.
     *  `stackRefused` says which. */
    fold: string | null
    stackRefused: string
  } | null>(null)
  const [stale, setStale] = useState<{ rows: StaleSection[]; noteIds: string[] } | null>(null)
  /** Addressees the last submit could not reach. A `200` that partly went
   *  nowhere: delivery resolves every name against the review room's MEMBERSHIP
   *  and deletes anyone who is not a member, so the note is filed, counted, and
   *  then dropped behind a success. `clawmeets plan consult` reconciles membership
   *  (it is idempotent per participant, so an agent registered after the last
   *  consult is seated by the next one) — but a submit that runs BEFORE any
   *  consult, or that names an agent outside the project's invitable roster,
   *  still resolves to nobody. This list is the ONLY signal this surface has,
   *  so it is rendered rather than swallowed. */
  const [unresolved, setUnresolved] = useState<string[]>([])

  // AC-6.7 — the refresh signal is proportionate. `sha` moving is the document
  // moving; with an empty tray and nothing being typed the reload is silent,
  // and otherwise a non-blocking banner appears. It names the revision and the
  // author off the REFETCHED index, never off the envelope.
  const [banner, setBanner] = useState<{ revision: number; by: string } | null>(null)
  const lastSha = useRef<string | null>(null)
  const dirty = rows.length > 0 || editingSlug !== null

  useEffect(() => {
    if (!index) return
    if (lastSha.current === null) {
      lastSha.current = index.sha
      return
    }
    if (lastSha.current === index.sha) return
    lastSha.current = index.sha
    if (!dirty) return
    const last = index.history[index.history.length - 1]
    setBanner({ revision: index.revision, by: last?.by ?? '' })
  }, [index, dirty])

  /** THE MIRROR, AND THE EMPTY CASE IS THE POINT OF IT.
   *
   *  Every payload is adopted while the rows are the server's, including one
   *  whose `draft` is gone: `submit_review` nulls the tray in the same
   *  transaction it sends the batch, so adopting `null` is how a mount that did
   *  not run the submit — or one that unmounted mid-flight and came back —
   *  finds out the review went out.
   *
   *  GATED ON `busy` as well as on `mine`, for the window this component cannot
   *  otherwise see. `refresh()` fires while the submit is still awaited, and a
   *  `GET …/plan` that lands before the sidecar is saved answers with the draft
   *  still on it. Adopting THAT would put the rows back a beat after they were
   *  cleared. `busy` covers the whole of `onSubmit`, refetch included, and the
   *  payload that arrives after it drops is the post-submit one. */
  useEffect(() => {
    if (!index || mine.current || busy) return
    setRows((prev) => {
      const next = (index.draft?.entries ?? []) as TrayRow[]
      // The overwhelmingly common payload is "no draft, and there never was
      // one". Returning the array we already hold keeps that case from
      // re-rendering the tray — and re-deriving `pending` — on every
      // PROJECT_PLAN_SYNC the project sees.
      return prev.length === 0 && next.length === 0 ? prev : next
    })
    // NO `setComment` HERE ANY MORE. The tray's batch-comment textarea is gone
    // (`PlanTray`), so this client neither writes nor adopts `batch_comment` —
    // it mirrors rows and nothing else. The field is still on the wire and an
    // agent's `plan review --batch-comment` still fills it; the browser simply
    // sends `''`, which is what an empty textarea sent anyway.
  }, [index, busy])

  /** EVERY LOCAL EDIT COMES THROUGH HERE, which is why this is where ownership
   *  flips. `persist` is called by `stage`, and staging is now the only way
   *  anything the user did reaches the tray — the batch-comment keystroke was
   *  the second caller and went with the textarea — so one line here covers it,
   *  and the mirror above stops adopting from the moment the user has staged
   *  anything at all.
   *
   *  It flips BEFORE the request rather than in its `.then`, deliberately: the
   *  rows are the user's the instant they exist, and a `PUT` that fails still
   *  must not let a refetch overwrite them (the swallow below is written to
   *  keep exactly that text). */
  const persist = useCallback(
    (next: TrayRow[]) => {
      mine.current = true
      if (!index) return
      // Mirror to the server tray. The wire kinds are the five stored ones —
      // `superseded_by` is a label and never leaves this client.
      void putPlanDraft(projectId, {
        by: 'user',
        entries: toWire(next),
        batch_comment: '',
        room: index.draft?.room ?? '',
        updated_at: new Date().toISOString(),
      }).catch(() => {
        /* The tray is a convenience mirror; a failed sync must not take the
           user's staged text with it. The rows stay local and the next change
           retries. */
      })
    },
    [index, projectId],
  )

  const stage = useCallback(
    (next: TrayRow[]) => {
      setRows(next)
      persist(next)
    },
    [persist],
  )

  /**
   * RETURNS THE PLAN INDEX'S REFETCH, AND ONLY THAT ONE OF THE FIVE.
   *
   * The five keys are invalidated together but they do NOT land together, and
   * the gap between them was a bug the user could click through. `user-projects`
   * is a short list and comes back first — the desk card's phase rail flips to
   * EXECUTE off it. `project-plan` carries the whole document, sections and
   * notes, and comes back after. `pending` is derived from THAT payload
   * (`isPendingNote` tests `!n.sent`), so in the window between the two the tray
   * still renders notes the server has already sent, with a live Send that
   * re-submits them and earns a `409`.
   *
   * So the success path in `onSubmit` awaits this and the button stays
   * `Sending…` until the payload the tray READS has actually arrived. The other
   * four stay un-awaited: nothing on this surface is derived from them, and
   * waiting on the slowest of five would hold the button past the point the
   * screen is already correct.
   *
   * AWAITING IT CANNOT STRAND THE BUTTON, and the absence of a `.catch` here is
   * deliberate rather than an omission. `invalidateQueries` delegates to
   * `refetchQueries`, which swallows each query's error itself
   * (`promise.catch(noop)` unless `throwOnError`) and resolves an
   * offline-paused query immediately — so this settles whatever the refetch
   * does, and a rejection never reaches `onSubmit`. Were one to, there would be
   * no Send left to disable anyway: a plan query in `error` replaces this whole
   * component with "The plan could not be loaded." A catch would be dead code
   * implying a hazard that is closed twice over.
   */
  const refresh = useCallback(() => {
    const planIndex = qc.invalidateQueries({ queryKey: ['project-plan', projectId] })
    void qc.invalidateQueries({ queryKey: ['project-plan-versions', projectId] })
    void qc.invalidateQueries({ queryKey: ['project', projectId] })
    void qc.invalidateQueries({ queryKey: ['user-projects'] })
    void qc.invalidateQueries({ queryKey: ['all-projects'] })
    return planIndex
  }, [qc, projectId])

  const sections = index?.sections ?? []
  /**
   * EVERY NOTE THIS EDITOR DRAWS, AND ONLY THE OPEN ONES.
   *
   * THE FILTER IS HERE AND NOWHERE ELSE, WHICH IS THE WHOLE POINT OF THE LINE.
   * `bodyRoots`, `roots`, `inBody`, `pending`, `byId` and the section rail's
   * dot all derive from this one array, so filtering at the source is what
   * keeps them from each growing a filter of their own and drifting apart. A
   * note that has been accepted, rejected, answered or dismissed is DONE: it
   * leaves the screen rather than sitting there with its controls gone, which
   * is what it did before — resolved notes rendered forever.
   *
   * IT IS A `useMemo` RATHER THAN A BARE `.filter()`, and that is not style.
   * `index.notes` is a stable reference from the query; a bare filter mints a
   * new array on every render and would defeat the `pending` and `byId` memos
   * that take `notes` as a dependency.
   *
   * IT COSTS THE DOWNSTREAM PREDICATES NOTHING. `isPendingNote` and
   * `openNotesOn` already test `status === 'open'` themselves, so this narrows
   * their input to exactly what they already accepted — no behaviour of theirs
   * moves. `PlanTray`'s `openNotes` was re-filtering this same array and now
   * reads its length.
   */
  const notes = useMemo(
    () => (index?.notes ?? []).filter((n) => n.status === 'open'),
    [index],
  )
  /** EVERY OPEN DEVIATION, off the ALREADY-NARROWED `notes` above (`status ===
   *  'open'`), so the selector's own status test is a no-op here rather than a
   *  second opinion. Selected by the SAME RULE the server uses to build
   *  `PlanSummary.deviation` — see `openDeviations` — so the alarm below and the
   *  desk card's `off-contract` chip cannot disagree about whether the work has
   *  gone off-contract.
   *
   *  THE ALARM TAKES THE LIST, NOT THE HEAD. A second deviation raised while
   *  the first was still open used to render nowhere at all, while the chip and
   *  the `N waiting on you` count both counted it. */
  const deviations = useMemo(() => openDeviations(notes), [notes])
  /** The NEWEST open deviation — still what seeds the pane, and still the same
   *  note the desk card's `off-contract` chip is about, because `openDeviation`
   *  is now literally this list's head. Reading it as `deviations[0]` rather
   *  than calling the singular selector a second time is what makes that
   *  identity structural instead of a promise two scans keep. */
  const deviation = deviations[0]

  /** OPEN ON THE CLAUSE IN QUESTION, on BOTH mounts. This was `initialSection`,
   *  a prop whose only caller passed the deviation's own `section` — so the
   *  Plan tab always opened on `all` and the note that needed a decision was
   *  several scrolls down on a plan of any length. The editor can see the
   *  deviation for itself now, so the prop is gone rather than left as a second
   *  way to answer a question with one owner.
   *
   *  ONCE PER MOUNT, AND AGAIN ON EACH `openSignal`. The ref holds the signal
   *  we last seeded for, which buys three properties at once: the first index
   *  that arrives selects the deviation's section; unfolding the desk band
   *  re-selects it (the counter moves, so the ref no longer matches); and a
   *  deviation ARRIVING mid-read over `PROJECT_PLAN_SYNC` does NOT yank the
   *  pane out from under someone who has navigated. The prop-driven effect
   *  could not tell those three apart.
   *
   *  THE OPEN SIGNAL IS STILL A COUNTER, NOT A BOOLEAN, and the reason is
   *  unchanged and structural: `UpdateCard` unmounts the compact editor
   *  whenever the PLAN band is folded, so this effect runs on MOUNT and the
   *  signal has to still be readable then. A boolean would need someone to
   *  reset it and could not fire a second time. */
  const seededFor = useRef<number | null>(null)
  useEffect(() => {
    if (!deviation) return
    const signal = openSignal ?? 0
    if (seededFor.current === signal) return
    seededFor.current = signal
    setPane(deviation.section)
  }, [deviation, openSignal])

  /** ROUTE TO A NOTE — what a click on an alarm row does, and the only thing it
   *  does. Three separate facts, deliberately: the section may ALREADY be the
   *  selected one (so `setPane` changes nothing) while the note is still a
   *  screen away, and the highlight is worth having whether or not the pane
   *  moved. It posts nothing and stages nothing.
   *
   *  IT ALWAYS SELECTS THE SECTION, including out of the whole-document view.
   *  "Decide it on the note below" is the alarm's promise, and on a plan of any
   *  length `all` puts that note several scrolls down — which is the state the
   *  pane seeding already exists to avoid on arrival. */
  const showNote = useCallback((n: PlanNote) => {
    // `|| 'all'` — A SECTION-LESS NOTE IS ABOUT THE DOCUMENT, and `''` is not a
    // slug. Selecting it would put the pane on a section that does not exist
    // and print *"no longer in the document"* about a note that never named
    // one; `all` renders every note (`paneNotes`), so the row still lands on
    // its card. The confirm note is the shape that made this reachable.
    setPane(n.section || 'all')
    setFocusNote(n.id)
    setScrollTo(n.id)
  }, [])

  /** THE SCROLL, AFTER THE PANE HAS COMMITTED — never inside the click handler.
   *  Switching `pane` re-renders the whole document body, so at click time the
   *  target element does not exist yet and a query would find nothing (or, on a
   *  `pane` that happened not to change, the RIGHT element by luck — which is
   *  worse, because it works in the case you test by hand).
   *
   *  Scoped to `paneRef`, not `document`, for the two-mounts reason above.
   *  `scrollIntoView` is optional-called because jsdom does not implement it —
   *  the tests that render this would throw on an unguarded call, and this is
   *  display-only behaviour that must never be able to take the tab down.
   *  `prefers-reduced-motion` decides `behavior`; a smooth scroll is motion. */
  useEffect(() => {
    if (!scrollTo) return
    // Attribute COMPARISON rather than an attribute SELECTOR: a note id is
    // server-generated and would need `CSS.escape` to be safe in a selector,
    // and `CSS` does not exist in jsdom — so the escaped form would throw in
    // every test that renders this, for a quoting problem this side-steps.
    const el = [...(paneRef.current?.querySelectorAll('[data-note-id]') ?? [])].find(
      (n) => n.getAttribute('data-note-id') === scrollTo,
    )
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    // A NOTE CARD IS ROUTINELY TALLER THAN THE PANE, and `block: 'center'` on an
    // element taller than the scrollport centres its BOX — so the card's heading,
    // its question and its Accept/Reject controls all land above the fold and the
    // reader arrives in the MIDDLE OF A DIFF. Reported from the field on the
    // compact mount, whose pane is 420px; a diff of any size clears that.
    // The first row looked exempt only because its target sits near the top and
    // the computed offset clamps at 0 — right by accident, not by rule.
    // So: CENTRE ONLY WHAT FITS. Otherwise put the top of the card at the top of
    // the pane, which is where the thing you clicked says what it is.
    // Both heights are 0 in jsdom, so `fits` is true there and every existing
    // test sees today's `'center'` unchanged.
    const fits =
      (el?.getBoundingClientRect().height ?? 0) <= (paneRef.current?.clientHeight ?? 0)
    el?.scrollIntoView?.({
      block: fits ? 'center' : 'start',
      behavior: reduced ? 'auto' : 'smooth',
    })
    // Consumed either way: a note that is not on screen (its section is staged
    // as raw text, say) must not leave a standing debt the next render pays.
    setScrollTo(null)
  }, [scrollTo, pane])

  /** THE QUESTION HAS TO BE WHERE THE READER IS LOOKING.
   *
   *  Accepting a proposal whose section has moved does not stage — it opens
   *  `PlanCollide` and asks which text wins. That control renders at the TOP of
   *  this pane, and the note whose `Accept` opened it is somewhere below: at
   *  `density="compact"` the pane is a 420px scroller inside a desk card, so the
   *  owner clicked a button, the control mounted off-screen above them, and the
   *  visible outcome was that `Accept` did nothing at all. Reported from the
   *  field on a plan where BOTH open notes carried `section_changed`, so every
   *  Accept on that card was inert.
   *
   *  The unit tests could not have caught it and are not wrong for that: they
   *  render at `full` and assert the control is in the DOM, which it always was.
   *  jsdom has no viewport, so "mounted" and "visible" are the same fact there
   *  and are two different facts here.
   *
   *  Same shape as the note scroll above, and for the same reasons — after the
   *  commit rather than in the handler, scoped to `paneRef` because this editor
   *  has two mounts, `scrollIntoView` optional-called because jsdom does not
   *  implement it, and `prefers-reduced-motion` deciding `behavior`. Nothing is
   *  consumed on the way out: unlike `scrollTo` this reads state that stays set
   *  until the control is answered or cancelled, so there is no standing debt to
   *  clear. */
  useEffect(() => {
    if (!collision) return
    const el = paneRef.current?.querySelector('[data-plan-collide]')
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    el?.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }, [collision])
  const dupes = useMemo(() => duplicateHeadings(sections), [sections])
  /** The batch's OTHER half. `POST …/plan/notes` records a note and delivers
   *  nothing; delivery happens only when a submit NAMES it in `note_ids`, so
   *  every comment you wrote is waiting here until one does. Derived from the
   *  query on every render — see `isPendingNote` for why it is never state.
   *
   *  THE TRAY IS PART OF THE DERIVATION. A note you have staged a decision on
   *  is already in the batch as that decision, and naming it as well would send
   *  the very comment the decision withdraws — see `decidedNotes`. */
  const pending = useMemo(() => pendingNotes(notes, rows), [notes, rows])
  const pendingIds = useMemo(() => new Set(pending.map((n) => n.id)), [pending])
  /** THE BATCH, AS ONE NUMBER — staged rows plus filed-but-unsent notes, which
   *  is the count `PlanTray` prints and the count the Send button names. Lifted
   *  to this level so `onSendState` can report it without the tray's render
   *  being in the path; the tray still computes its own from the same two
   *  arrays, and the two cannot drift because there is only one definition of
   *  either array. */
  const count = rows.length + pending.length

  /** EVERY OPEN COMMENT, IN ONE LIST, WITH THE BATCH JOINED ONTO IT.
   *
   *  The navigator above the plan body used to be the deviation alarm and
   *  nothing else, so on a plan with no deviation and one open question there
   *  was no navigator at all — the fastest thing in the editor was reserved for
   *  the note kind that is usually absent. Deviations stay first and stay red;
   *  everything else is a neutral row underneath.
   *
   *  IT ALSO CARRIES THE TRAY'S ITEMS, because a decision belongs on the
   *  comment it decides. A staged text edit arrives as the comment it is —
   *  written with a diff and accepted in the same gesture — which is what
   *  leaves this list ONE row type and `PlanTray` a send bar.
   *
   *  ITS PROJECTED ITEMS NEVER JOIN `notes`, and the two places that would
   *  break are one line each: the submit's `note_ids` (below), where the server
   *  has no note to fan out to, and `openNotesOn`, which paints the section
   *  rail's dot and speaks its count. Neither reads `items` and neither may. */
  const items = useMemo(() => commentList(notes, rows, pending), [notes, rows, pending])
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])
  /* THE ADDRESSEE ROSTER IS GONE, AND WITH IT `useProject`, `useAgents`,
     `involved` and `planRoster` — thirty lines of derivation that existed to
     answer one question the two-party rule has made a constant.

     A NOTE CONNECTS THE USER AND THE COORDINATOR. Nobody else is ever an end
     of it, in either phase, and the writer on this surface is always the
     owner — so the one legal addressee is the coordinator, which is
     `index.keeper`, which this component already holds. There is nothing to
     look up, nothing to rank and nothing to search. See `PlanQuotePop`.

     WHAT WENT WITH IT, SO THE REMOVAL IS NOT MISREAD AS AN OVERSIGHT: the
     project's `participating_agents` (the roster's scope) and `GET /agents`
     (its role and status lookup) are no longer read here. `PlanAcceptance` keeps
     its own `useProject` on the same query key, so the approve strip is
     untouched; this mount simply stopped making two requests it no longer has
     a question for. `project.plan?.phase` remains one line away on that same
     cached payload if a later change needs it — the composer does not, because
     the owner's one addressee is the coordinator during `spec-ing` and during
     `executing` alike. */

  const textOf = useCallback(
    (slug: string) => {
      if (!index) return ''
      const s = findSection(index, slug)
      return s ? sectionText(index.body, s) : ''
    },
    [index],
  )

  /**
   * THE SECTION AS THE USER SHOULD SEE IT — the tray's staged text when a row
   * carries text for this section, the document's own text otherwise.
   *
   * ONE FUNCTION FOR BOTH what `PlanBody` renders and what a splice seeds from,
   * which is the whole reason it exists. A second block edit in a section has
   * to compose with the first or the first is silently lost, and a block's
   * offsets only line up with the string that was actually rendered. Deriving
   * both from here makes those two facts the same fact.
   *
   * `textOf` stays the PRISTINE text and is what an edit row's `base` is
   * captured from — see `onBlockEdit`.
   */
  const pendingText = useCallback(
    (slug: string) => heldTextRow(rows, slug)?.text ?? textOf(slug),
    [rows, textOf],
  )

  /**
   * ONE SERIES PER NOTE, and it is a MAP rather than a function because a
   * function would regenerate every diff on every render.
   *
   * `pendingText` IS THE HEAD OF IT, NOT `textOf`, AND THAT IS THE WHOLE REASON
   * THIS IS CLIENT-SIDE. The series' second step compares a proposal against
   * the section as it READS — which, while the tray carries an accepted
   * proposal, is that proposal's text and not the document's. Accept @a's and
   * every other card on that section re-heads against it on the next render,
   * with no request and no refetch. A server-generated series could not: the
   * server does not have the tray's text until the next PUT, and would still be
   * comparing against what it has stored.
   *
   * Keyed on `notes` and `pendingText`, which is keyed on `rows` and `textOf` —
   * so it recomputes when a note arrives, when the document moves, and when the
   * tray changes, and at no other time.
   */
  const seriesByNote = useMemo(() => {
    const out = new Map<string, DiffStep[]>()
    for (const n of notes) out.set(n.id, diffSeries(n, notes, pendingText(n.section)))
    return out
  }, [notes, pendingText])

  /**
   * ONE BOOLEAN PER NOTE — "does the document still say what this author saw?"
   * — MEMOIZED BESIDE THE SERIES AND FOR THE SAME REASON: `baseIsCurrent` runs
   * a real diff, so computing it inline in `renderNote` would run one per note
   * per render.
   *
   * `pendingText` IS THE HEAD OF IT HERE TOO, and that is the whole reason this
   * lives in the editor rather than on the row. The question the note card is
   * really asking is "is the snapshot I am about to quote already on the screen
   * beside me" — and what is on the screen is what `PlanBody` renders, which is
   * the TRAY's text whenever the tray holds any. The wire's `section_changed`
   * answers a different question (against what the server has STORED) and would
   * be wrong for the entire time a staged accept is sitting in the tray.
   *
   * Same deps as the series, so the two can never disagree about what the
   * section currently reads as.
   */
  const baseIsCurrentByNote = useMemo(() => {
    const out = new Map<string, boolean>()
    for (const n of notes) out.set(n.id, baseIsCurrent(n, pendingText(n.section)))
    return out
  }, [notes, pendingText])

  const stagedFor = useCallback(
    (note: PlanNote) => rows.find((r) => r.note_id === note.id && !r.superseded_by)?.kind ?? null,
    [rows],
  )

  /** `waiting to send`, answered off THE LIST THE TRAY RENDERS rather than by
   *  re-running the predicate. The label and the tray are then the same fact
   *  read twice and not two computations that agree until they don't. */
  const pendingFor = useCallback((note: PlanNote) => pendingIds.has(note.id), [pendingIds])

  /* -- decisions: all of them stage, none of them writes ------------------ */

  const onAccept = useCallback(
    (note: PlanNote) => {
      if (!index) return
      /**
       * THE ONE ACCEPT THAT DESTROYS SOMETHING, AND THE ONLY GUARD IN FRONT OF
       * IT. `proposes_delete` has been on the wire since the flag was added and
       * read nowhere: the server folds it into `has_proposal`, so a refused
       * DELETE renders exactly the same `Accept` as a text proposal and one
       * click removed a whole section — on the incident this was written for, a
       * 17,705-character `## Milestones` with four milestones and 27 acceptance
       * criteria in it — with no confirmation and nothing that puts it back.
       *
       * FIRST, ABOVE THE TWO COLLISION BRANCHES, AND DELIBERATELY. Both of them
       * hand the row to `PlanCollide` and can stage it later through
       * `resolveCollision` without passing back through here, so a check placed
       * after either is skippable. It is also the right order to ask in: "do you
       * mean to delete this section" is prior to "whose text wins".
       *
       * NOTHING IS COMPUTED HERE. The server owns the predicate (`_row_deletes`,
       * the same one that turns this button on and writes the note's sentence);
       * the browser reads the boolean. `window.confirm` is the door every other
       * destructive act in this app uses, and it defaults to Cancel on Esc,
       * which is the safe direction.
       */
      if (note.proposes_delete) {
        const size = note.base_section.length.toLocaleString()
        if (
          !window.confirm(
            `Accepting this DELETES the section "${note.section}" (${size} characters) ` +
              `from PLAN.md. There is no replacement text and this cannot be undone.\n\n` +
              `Reply to @${note.by || 'the author'} instead if you want it kept.`,
          )
        ) {
          return
        }
      }
      const current = textOf(note.section)
      const next = acceptRow(note, current)
      const held = heldTextRow(rows, note.section)
      if (held) {
        /* CAN BOTH LAND? Asked here, once, and carried on the state — the fold
           is `note`'s CHANGE re-applied to whatever the tray is holding, which
           is what "accept @a, then accept @b as well" means when a proposal is
           a whole-section replacement. `foldProposal` returns `null` when the
           patch does not fit, and the control then asks the pick-one question
           it has always asked.
           THE HELD NOTE'S OWN STATUS DECIDES WHETHER IT MAY BE OFFERED AT ALL
           — AND THE OLD REASON FOR THIS GUARD HAS STOPPED BEING TRUE, WHICH IS
           WHY THE REASON IS NOW WRITTEN OUT RATHER THAN LEFT IMPLIED. It used
           to read: folding closes the held note `dismissed`, and
           `_refuse_go_note_close` refuses every close but Accept. The first
           half is false on a server that records folds — the note closes
           `folded`, not `dismissed` — and someone reading the old comment
           beside the new status would conclude the guard is obsolete.
           IT IS NOT, AND THE REAL REASON IS STRONGER THAN THE ONE IT REPLACES.
           The execution gate counts notes that are OPEN, so EVERY way of
           closing the go-note releases it, and `folded` is a new way. Only the
           user applying it may release that gate, because applying it IS
           approving the plan. The server refuses the fold too, in the same
           guard that refuses the dismissal — so this is not the only thing
           standing between a fold and an approved plan. It is what keeps the
           refusal from arriving as a button that always 409s, which is the
           defect `bootstrap` was put on the wire to prevent. A guard whose
           server-side twin exists is still worth its four characters when the
           alternative is a control the user can press and cannot use. */
        const heldNote = byId.get(held.note_id)
        const fold = heldNote?.bootstrap ? null : foldProposal(held.text, note)
        // U5 — two accepted proposals on one section. Decided BEFORE the second
        // row is staged, on an unsent tray, so nothing about the cross-batch
        // precondition path is consulted or weakened.
        setCollision({
          held,
          next,
          heldBy: heldNote?.by ?? '',
          nextBy: note.by,
          section: note.section,
          reason: fold
            ? 'Your tray already carries text for this section. These two change different ' +
              'lines, so both can land — or pick one.'
            : 'Your tray already carries text for this section. Two accepted proposals cannot ' +
              'both land — pick one, or write the reconciliation yourself.',
          fold,
          stackRefused: heldNote?.bootstrap
            ? 'The plan-approval note can only be accepted, so it cannot be folded into another change.'
            : fold
              ? ''
              : 'These two change the same lines, so there is no way to keep both without ' +
                'choosing between them — pick one, or write the reconciliation yourself.',
        })
        return
      }
      /**
       * THE SECTION MOVED UNDER THE PROPOSAL, AND THE SIGNAL WAS ALREADY ON THE
       * PAYLOAD. `PlanCollide` has always fired for this — but only AFTER a
       * submit was refused: the owner accepted, staged, batched, pressed
       * `Send review`, the server refused the whole batch, and only then were
       * the two texts put side by side. `section_changed` was sitting on the
       * note the whole time; `heldTextRow` says so in its own comment, that it
       * "consults neither `section_changed` nor any force flag". This consults
       * it, one decision earlier, and opens the SAME control.
       *
       * NOTHING IS COMPUTED HERE. This is not a quote predicate and it is not a
       * second definition of anything: the server did the string comparison, the
       * browser reads the boolean. The one new literal is the reason string.
       * (`PlanNote.conflict` is NOT this. It is the stale-write flag the server
       * sets when a keeper's write is refused, nothing in this frontend reads
       * it, and reaching for it here would be wrong.)
       *
       * AFTER the `held` branch deliberately. If the tray already carries text
       * for this section then the document's own text is being replaced anyway,
       * and the conflict worth showing first is the one between two things the
       * user staged. Resolve that, then accept again and meet this.
       *
       * `held` IS SYNTHETIC AND IS IN NO TRAY. It exists to give `PlanCollide`
       * the current section text to show on the left, and `resolveCollision`
       * handles it without a special case: `held` returns the rows untouched
       * (the accept is simply not staged), `next` maps over a row id that
       * matches nothing and appends the accept, and `own` appends the
       * reconciled `edit` row. The marker id is there so it can never collide
       * with a real one.
       */
      if (note.section_changed) {
        /* THE SAME FOLD, AGAINST THE DOCUMENT INSTEAD OF AGAINST A PROPOSAL,
           and it needs no branch of its own: the held side is the section as it
           reads now, so fitting this proposal's change onto it re-bases the
           proposal rather than overwriting whatever moved. Nothing is closed on
           this path — the held side is nobody's note — so there is no
           `dismissed` to explain and no go-note guard to make. */
        const fold = foldProposal(current, note)
        setCollision({
          held: {
            ...next,
            id: 'synthetic-current-text',
            kind: 'edit',
            note_id: '',
            text: current,
          },
          next,
          heldBy: lastToucherOf(index, note.section),
          nextBy: note.by,
          section: note.section,
          reason:
            `This section changed since @${note.by || 'the author'} proposed this. ` +
            'Their text was written against an older version.',
          fold,
          stackRefused: fold
            ? ''
            : 'Their change cannot be fitted onto the current text — it touches lines that ' +
              'have since moved.',
        })
        return
      }
      stage([...rows, next])
    },
    [index, rows, textOf, byId, stage],
  )

  const onReject = useCallback(
    (note: PlanNote, reason: string) => stage([...rows, decisionRow('reject', note, reason)]),
    [rows, stage],
  )
  const onDismiss = useCallback(
    (note: PlanNote) => stage([...rows, decisionRow('dismiss', note)]),
    [rows, stage],
  )

  /**
   * ONE BLOCK, COMMITTED — and it becomes an ordinary section edit.
   *
   * The splice runs against `pendingText`, which is exactly the string
   * `PlanBody` rendered and therefore exactly the string `range` indexes into.
   * What comes back is a whole section, handed to the SAME `editRow` the
   * raw-Markdown editor uses, so a block edit is not a new kind of write and
   * the tray's arithmetic is untouched.
   *
   * ONE SECTION, ONE ROW, no matter how many blocks are touched: the row is
   * REPLACED in place rather than appended to, which is what `heldTextRow`'s
   * collision rule already assumes. It keeps the held row's `id` so the tray's
   * `✕` does not jump under the cursor between edits.
   *
   * `base` IS CAPTURED ONCE, from the pristine document, and carried across
   * every later block edit in that section. Re-basing it on each commit would
   * quietly defeat AC-6.5: the submit would stop noticing that the document had
   * moved underneath, and a stale write would land silently instead of being
   * refused with both texts on screen.
   *
   * Editing a block back to what the document says REMOVES the row rather than
   * leaving a no-op behind — the same rule as the section editor's blur, one
   * level down.
   */
  const onBlockEdit = useCallback(
    (slug: string, range: BlockRange, next: string) => {
      if (!index) return
      const section = findSection(index, slug)
      if (!section) return
      const held = heldTextRow(rows, slug)
      const spliced = spliceBlock(pendingText(slug), range, next)
      // A section already carrying an ACCEPTED proposal's text is the U5
      // collision, and it goes through the control the section editor already
      // uses. Not new code and not a new rule: two people's text cannot both
      // land, and the user picks which.
      if (held?.note_id) {
        const row = editRow(section, textOf(slug), spliced)
        if (!row) return
        setCollision({
          held,
          next: row,
          heldBy: byId.get(held.note_id)?.by ?? '',
          nextBy: '',
          section: slug,
          reason:
            'Your tray already carries an accepted proposal for this section. Only one of them can land.',
          // NOT A STACK, AND NOT A REFUSAL EITHER. The incoming side here is
          // your own edit, not a proposal with a base to re-apply, so there is
          // no patch to fit onto anything. `stackRefused` stays empty: an
          // explanation for an absent button would be answering a question
          // this control never asked.
          fold: null,
          stackRefused: '',
        })
        return
      }
      const row = editRow(section, held?.base ?? textOf(slug), spliced)
      if (!row) {
        if (held) stage(removeRow(rows, held.id))
        return
      }
      stage(held ? rows.map((r) => (r.id === held.id ? { ...row, id: held.id } : r)) : [...rows, row])
    },
    [index, rows, pendingText, textOf, byId, stage],
  )

  const onCollide = useCallback(
    (choice: CollideChoice, text?: string) => {
      if (!collision) return
      stage(resolveCollision(rows, collision.held, collision.next, choice, text ?? ''))
      setCollision(null)
    },
    [collision, rows, stage],
  )

  /**
   * KEEP BOTH — the one outcome that discards nothing.
   *
   * It stages ONE text row, exactly as every other outcome does, carrying the
   * fold that was computed when the question was asked. `_collapse_text_rows`
   * still keeps the last text row per section and `apply_edits` still splices
   * its text verbatim: the server has no opinion about how that string was
   * built, so nothing about the write path is softened or consulted here.
   *
   * WHETHER IT CAN SAY "YOU BOTH LANDED" IS THE SERVER'S ANSWER, AND THIS IS
   * THE ONE PLACE IN THE APP THAT ASKS. Nothing else reads `records_folds`:
   * not `PlanCollide`, whose sentence is written to be true under both answers
   * rather than selected by one; not `PlanCommentList`, which branches on the
   * ROW's own `folded`; not `PlanNoteRow`, which renders whatever status the
   * server sent and has no opinion about which server sent it. A capability
   * flag read in two places is a capability flag that will one day be read
   * inconsistently.
   *
   * TRUE — the overtaken row keeps its text and gains one bit, and every word
   * the folded-away author reads is the server's, derived from the collapse
   * that actually happened. FALSE OR ABSENT — `stackRows` writes the truest
   * sentence a five-status wire allows, exactly as it shipped, and the
   * limitation is stated on the control at the moment the user chooses.
   *
   * `?? false` IS THE NULL-COALESCE FOR `index` ITSELF, which is null before
   * the first fetch — not a fallback for a payload that omitted the member.
   * The member is required on `PlanIndex` for `can_decide`'s stated reason.
   * Failing closed is the right answer to both questions anyway: the worst a
   * false negative costs is one release of the old mitigation, and the worst a
   * false positive costs is an author told their work was thrown away.
   */
  const onStack = useCallback(() => {
    if (!collision?.fold) return
    stage(
      stackRows(
        rows,
        collision.held,
        byId.get(collision.held.note_id),
        collision.next,
        collision.fold,
        foldedReason(collision.nextBy),
        index?.records_folds ?? false,
      ),
    )
    setCollision(null)
  }, [collision, rows, byId, stage, index])

  /* -- the write paths ---------------------------------------------------- */

  const onSubmit = useCallback(async () => {
    setBusy(true)
    setFailure(null)
    setNotice(null)
    try {
      // The tray as it stands is what the server submits: it holds the rows,
      // this call names no entries. One transaction — the write and every
      // message share one atomic append.
      await putPlanDraft(projectId, {
        by: 'user',
        entries: toWire(rows),
        batch_comment: '',
        room: index?.draft?.room ?? '',
        updated_at: new Date().toISOString(),
      })
      // The notes are NAMED. Without `note_ids` the server fans out nothing
      // but the rows' decisions — it refuses to guess a batch's note half, and
      // said so — and every inline comment stays filed and undelivered.
      const round = await submitPlanReview(projectId, {
        batch_comment: '',
        note_ids: pending.map((n) => n.id),
      })
      // The revision is REPORTED FROM THE WRITE, never predicted. A submit of
      // only rejections and asks lands with the revision unchanged, and a
      // client that guessed "+1" would be wrong exactly there.
      // Back to mirroring the server, whose tray this submit just emptied. Any
      // OTHER mount of this editor is doing the same off its next payload; this
      // one does not have to be the mount that survives to be the one that gets
      // it right.
      mine.current = false
      setRows([])
      setStale(null)
      setBanner(null)
      setUnresolved(round.unresolved ?? [])
      setNotice(
        `Sent · revision ${round.revision}` +
          (round.addressees?.length
            ? ` · ${round.addressees.map((a) => (a === 'user' ? 'you' : `@${a}`)).join(', ')}`
            : '') +
          (round.room ? ` in #${round.room}` : ''),
      )
      // AWAITED, AND THIS IS THE ONE CALL OF THE FOUR THAT IS.
      // `setRows([])` above clears the tray's staged half synchronously, but its
      // other half — `pending` — is derived from the refetched index, so until
      // that lands the tray still shows the notes this submit just sent and
      // `busy` going false re-arms Send on top of them. Holding `busy` across
      // the refetch is what closes that window; see `refresh` for why only the
      // plan index is waited on and why the wait always settles.
      await refresh()
    } catch (e) {
      // EVERY branch below sets a failure, and every one of them is the
      // BATCH's — this is the only surface that can report it.
      setFailureFrom('batch')
      if (e instanceof PlanStaleError && e.stale.length > 0) {
        // AC-6.5 — nothing was applied and nothing was sent. The tray is
        // untouched, here and on the server, and every row still carries the
        // user's text. Show each stale row beside what the section says now.
        setStale({ rows: e.stale, noteIds: e.noteIds })
        setFailure(e.message)
        void refresh()
      } else if (e instanceof PlanStaleError) {
        // A `409` with NO stale row is a different refusal wearing the same
        // status: naming a note the server already sent. There is nothing to
        // reconcile, and the reconciliation panel with zero rows reads as
        // "something moved" when nothing did. Say what happened and refetch —
        // the refetch is what clears the note out of `pending`.
        setFailure(e.message)
        void refresh()
      } else if (e instanceof ApiError && e.status === 413) {
        // THE OPEN-NOTE CEILING, AND CHANGE 9 IS WHY IT CAN FIRE HERE.
        // `_add_notes_locked` validates the whole sequence before it stamps a
        // single id, so an over-cap batch leaves `plan.notes` untouched:
        // nothing written, nothing sent, tray intact — structurally the same
        // recoverable shape as the 409, which is why it gets the same
        // treatment rather than a swallow.
        //
        // A staged Reply is what made it reachable: it files a NEW open note
        // where resolve-as-you-reply opened none, so the refusal moved from
        // the click to the submit of the whole batch. How much it costs
        // against `MAX_OPEN_NOTES` is the SERVER's arithmetic and it moved
        // with AC-5.9 — a reply now closes the parent `answered` in the same
        // transaction, so the pair is net zero rather than +2. Nothing here
        // does that sum: `PlanTray` reads the count off the index and this
        // branch only reports the refusal the server returned. NOT the quote:
        // `MAX_QUOTE_CHARS` is
        // checked per note, so an inherited copy of a quote that already passed
        // passes again by construction, and `MAX_NOTE_CHARS` does not count the
        // quote at all.
        setFailure(
          `This review was refused — the plan is at its limit of ${PLAN_LIMITS.openNotes} open ` +
            'notes. Nothing was sent and your tray is intact. Dismiss some open notes, then ' +
            'submit again.',
        )
      } else {
        setFailure(e instanceof Error ? e.message : 'The batch could not be sent.')
      }
    } finally {
      setBusy(false)
    }
  }, [projectId, rows, pending, index, refresh])

  /** THE TRAY'S OTHER EXIT. Lifted out of the `PlanTray` call site with
   *  `onSubmit`, and for the same reason: the desk card's footer drives both,
   *  and a handler defined inline inside JSX cannot be handed to a caller.
   *
   *  Ownership goes back to the server ON THE DELETE'S RETURN, and not a
   *  statement earlier. `busy` is what holds the mirror off across the submit;
   *  discard has no such barrier, so releasing it up front would leave a window
   *  where a sync arriving before the DELETE lands adopts the draft still on
   *  disk and puts the discarded rows straight back. A DELETE that FAILS
   *  therefore leaves `mine` true, which is the right way round: the user's
   *  empty tray stands, and nothing resurrects rows out of a draft the server
   *  does still hold. */
  const onDiscard = useCallback(() => {
    setRows([])
    void deletePlanDraft(projectId)
      .then(() => {
        mine.current = false
      })
      .catch(() => undefined)
  }, [projectId])

  /** WHAT THE CARD'S FOOTER NEEDS TO DRAW A SEND IT DOES NOT OWN.
   *
   *  Reported through an effect rather than during render, because the caller
   *  stores it — a `setState` fired from a child's render body is the classic
   *  "cannot update a component while rendering a different component" warning,
   *  and on the desk that other component is the whole card.
   *
   *  THE CLEANUP IS NOT TIDINESS. `UpdateCard` unmounts this editor whenever the
   *  PLAN band is folded, and a card left holding the last count would offer
   *  `Send review · 3` for a tray no live component is holding — the click would
   *  reach a dead callback and do nothing, visibly. `null` on unmount is what
   *  makes the card's footer fall back to its no-batch states.
   *
   *  Gated on `sendHostedByCaller` so the Plan tab pays nothing: no caller, no
   *  effect body worth running, and — more importantly — no way for a future
   *  mount to start reading the batch without also declaring that it renders
   *  the Send. */
  useEffect(() => {
    if (!onSendState) return
    if (!sendHostedByCaller) return
    onSendState(
      count === 0 ? null : { count, submitting: busy, submit: onSubmit, discard: onDiscard },
    )
    return () => onSendState(null)
  }, [onSendState, sendHostedByCaller, count, busy, onSubmit, onDiscard])

  /** NOTHING HERE MOVES A NOTE'S STATUS, AND THAT IS CHANGE 9.
   *
   *  `resolvePlanNote` used to be imported into this file and reached from
   *  three controls on the note row. It is gone: a note is CLOSED by a staged
   *  `Dismiss` and ANSWERED by a staged `Ask`, both of which the submit applies
   *  in the same transaction as the write. What that costs, stated rather than
   *  glossed, is the ability to mark a note `answered` as DISTINCT from
   *  `dismissed` — and it costs nothing this client can observe, because
   *  `open_notes_for_you` tests `status == "open"` and the addressee and
   *  nothing else, so the two are the same to every counter and gate the UI
   *  reads. `answered` survives on the CLI, which is where it still means
   *  something a human chose.
   *
   *  A sixth `DraftEntryKind` was the alternative and was declined on both
   *  sides: it would buy a label rather than a behaviour, and it carries a
   *  rollback path — a new client's draft stored by an old server — that loses
   *  a user's decision silently. */
  const onPostNote = useCallback(
    async (n: NewNote) => {
      setBusy(true)
      setFailure(null)
      try {
        // THE ONE PLACE A QUOTE REACHES THE WIRE, so the cap is applied once and
        // covers every path that can produce one — which, after change 1, is the
        // selection popover and the block's comment bubble. (A reply no longer
        // arrives here at all: it stages an `ask` row and the server derives its
        // quote from the parent's id.) The quote is written verbatim into the
        // plan document and no server-side limit counts it, so a client path
        // that does not cap is the F1 blast radius reopened.
        await postPlanNote(projectId, { ...n, quote: capQuote(n.quote ?? '') })
        setQuoted(null)
        void refresh()
      } catch (e) {
        // The composer that produced it is still mounted with the user's text
        // in it, and it renders this itself. See `failureFrom`.
        setFailureFrom('note')
        setFailure(e instanceof Error ? e.message : 'The note could not be filed.')
      } finally {
        setBusy(false)
      }
    },
    [projectId, refresh],
  )

  /**
   * REPLY, WHERE THE ARGUMENT IS — AND IT STAGES NOW.
   *
   * It used to POST a note record on the click, which made it the one control
   * on the note bar that reached a route. It now puts ONE `ask` row in the
   * tray. The server files that row as a note with `kind="question"`,
   * `reply_to = parent.id`, and a `quote` and `section` DERIVED from the
   * parent's id — so the reply still hangs under the same line and still draws
   * no second mark (the two ranges cover the same text and `mergeRanges` keeps
   * one), and the row carries neither field. That derivation is why this is not
   * a wire change: `DraftEntryKind` stays five values.
   *
   * WHAT BECOMES OF THE PARENT IS THE SERVER'S CALL, AND IT MOVED. It used to
   * stay open — "a question is not a resolution" — and under the two-party
   * channel the same transaction that files the outgoing question closes the
   * parent `answered` (AC-5.9). Nothing on this surface holds or predicts
   * either behaviour: the status arrives on the refetch, and this editor draws
   * only open notes, so a parent that closed simply leaves the screen.
   *
   * WHO IT IS ADDRESSED TO IS READ OFF THE NOTE, never invented, never typed in
   * and never left to the server's `or parent.by` fallback — on a reply to your
   * OWN note `parent.by` is the literal `"user"`, so that fallback would address
   * the reply back to you. Replying to a note the keeper sent you addresses the
   * keeper; replying to your own addresses whoever you sent it to.
   *
   * THE ONE EDGE CASE IS NOW UNREACHABLE FROM THIS SURFACE, AND THE LINE BELOW
   * STILL HANDLES IT ANYWAY. Reply to your own note that was addressed to
   * NOBODY and the computed answer is `''`, so the server's fallback does fire
   * and resolves to the OWNER — the complete send path, not merely a badge: a
   * real `PlanSend`, a posted message, and a to-do on your own desk. AC-2.1
   * took that offer off the row, so no click reaches it today: `mayReply` in
   * `PlanNoteRow` withholds `Reply` on exactly this note.
   *
   * The expression is NOT simplified to match. The guard that makes the case
   * unreachable lives in another component and is one edit away from moving,
   * and `note.by === 'user' ? note.to : note.by` is the correct addressee with
   * or without it — narrowing it here would couple two files to save nothing.
   */
  const onReply = useCallback(
    (note: PlanNote, text: string) =>
      stage([...rows, askRow(note, text, note.by === 'user' ? note.to : note.by)]),
    [rows, stage],
  )

  /* -- render ------------------------------------------------------------- */

  if (isLoading) return <Loading />
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

  const current: PlanSection | undefined =
    pane !== 'all' && pane !== 'history' ? findSection(index, pane) : undefined
  // Notes for the pane: one section's when a section is selected, all of them
  // on the whole-document view. Every note is a root, so this is the whole set.
  const paneNotes = current ? notes.filter((n) => n.section === current.id) : notes

  /* WHO RENDERS WHICH NOTE — a static partition, so nothing is drawn twice and
   * nothing goes missing. A note with a quote, in a section on screen, belongs
   * to the document body: `PlanBody` places it under the line it quotes, or at
   * the end of its own section when that line is gone. Everything else — a note
   * with no quote at all, or one whose section is not in this pane — stays in
   * the list below, which is also where the composer lives. The rule reads off
   * `quote` and `section` alone and needs no coordination between the two
   * surfaces to stay disjoint.
   *
   * WHAT WENT IS THE `!n.reply_to` CLAUSE, and it is the whole of the
   * threading removal on this side. It used to keep a reply out of BOTH halves
   * and hand it to its parent to draw. A response note may answer a question
   * about one section with a note on ANOTHER, so there is no parent under
   * which it is correctly placed — its own `quote` and `section` are the only
   * honest answer, and the partition above already routes on exactly those.
   * `reply_to` stays on the payload as provenance and drives no layout. */
  /* THE PARENT OF A REPLY, OFF THE UNFILTERED LIST. `notes` above is narrowed
   * to `status === 'open'`, and a reply routinely outlives the question it
   * answers — resolving against the narrow list would make the row's
   * "Answering …" line blink out the moment the parent closed, which is the
   * one moment the provenance is most worth having. `index.notes` is already
   * in hand; this reads it and fetches nothing.
   * `null` on a dangling `reply_to` rather than a throw: an id pointing at
   * nothing is now a 400 at the door (`_reply_parent`), but a note filed
   * before that door existed is still on disk and must render. */
  const parentOf = (n: PlanNote): PlanNote | null =>
    n.reply_to
      ? (index.notes ?? []).find((p) => p.id === n.reply_to) ?? null
      : null

  /* THE SECTIONS THIS PANE DRAWS. A section pane draws exactly one; the
   * whole-document pane draws every section EXCEPT one nested inside a section
   * whose text the tray is holding — that parent's staged text already contains
   * it. See `visibleSections`. */
  const shownSections = current
    ? [current]
    : visibleSections(sections, (slug) => !!heldTextRow(rows, slug))
  const preamble = current ? '' : preambleText(index.body, sections)

  /**
   * WHAT A SECTION LOOKS LIKE ON SCREEN — the tray's staged text when a row
   * carries text for it, otherwise its OWN text: its extent stopped at the
   * first nested section this pane is also drawing.
   *
   * `parse_sections` puts a nested heading in the flat list AND inside its
   * parent's extent, so rendering both at full extent prints the child twice.
   * The parent gives up the overlap here.
   *
   * ALWAYS A PREFIX OF `pendingText(s.id)`, which is what keeps click-to-edit
   * correct: a block range remark reports against this string is the same range
   * inside the full text `spliceBlock` seeds from, so a splice carries the
   * untouched descendant tail across verbatim.
   */
  const renderText = (s: PlanSection) =>
    heldTextRow(rows, s.id)?.text ?? sectionOwnText(index.body, s, shownSections)

  const shownIds = new Set(shownSections.map((s) => s.id))
  /**
   * THE FIRST RUNG OF THE PLACEMENT LADDER: does this note belong in the
   * DOCUMENT at all, or at the bottom of the page? One question, and the
   * section is the whole of it.
   *
   * It used to ask two — `!!n.quote && shownIds.has(n.section)` — and the extra
   * clause was a category error that cost the middle rung. "Which line is this
   * about" is not this component's question; it is `PlanBody`'s, which asks it
   * per block and already has an answer for *no line*: `LooseNotes`, at the end
   * of the section, labelled. A note that names a section but no line was being
   * refused entry to the document by a partition that could not have known
   * that, and it landed at the bottom of the page beside notes about nothing.
   *
   * So the three outcomes now line up with the three things a note can name,
   * and each one is decided by whoever can actually see it:
   *   - section + findable quote -> under that block          (`PlanBody`)
   *   - section, no findable quote -> end of that section     (`LooseNotes`)
   *   - no resolvable section -> the page-bottom NOTES list   (here)
   *
   * The server climbs the same ladder from the other end: `_derive_section` and
   * `_derive_quote` fill in what a note's author left out, so a note reaches
   * this line already carrying the most it can honestly claim.
   */
  const bodyRoots = notes.filter((n) => shownIds.has(n.section))
  const inBody = new Set(bodyRoots.map((n) => n.id))
  const roots = paneNotes.filter((n) => !inBody.has(n.id))

  /* ALL OF THEM STAGE, AND THE SUBMIT IS THE ONLY SEND. This used to be two
   * groups the note row labelled — four that wrote zero bytes and two that
   * reached a route on the click — and the labels existed because `Dismiss` and
   * `Dismiss now` sat side by side, one word apart and irreversibly different.
   * `Apply now`, `Resolve` and `Dismiss now` are gone and `Reply` stages, so
   * there is no immediate control left to disambiguate from and the row keeps
   * one line of help instead of two labels. */
  const actions = {
    onAccept,
    onReject,
    onDismiss,
    onReply,
    staged: stagedFor,
    pending: pendingFor,
    // THE SERVER'S ANSWER, NOT A PROXY FOR IT. This read `index.draft !== null`
    // — true for the owner only because the route hands nobody else a tray, so
    // the browser was inferring authority from a scratch pad. `can_decide` is
    // the predicate `POST …/plan/review` enforces, computed by the same code
    // the guard calls, so the two cannot drift.
    // There is no `?? index.draft !== null` here and there must never be: see
    // `PlanIndex.can_decide` for why the fallback is the exact failure it looks
    // like a defence against.
    canDecide: index.can_decide,
  }

  /** One note, wherever it renders. The body and the list below it draw notes
   *  with the SAME component and the same actions — an inline note is not a
   *  second kind of note, and after the threading removal neither is a reply.
   *  `repliesOf` used to hang here, resolving `note.replies` into rows the row
   *  drew under itself; it is gone with the recursion it fed. */
  const renderNote = (n: PlanNote) => (
    <PlanNoteRow
      note={n}
      actions={actions}
      series={seriesByNote.get(n.id) ?? []}
      baseIsCurrent={baseIsCurrentByNote.get(n.id) ?? false}
      focused={focusNote === n.id}
      parent={parentOf(n)}
      sectionHeading={sections.find((s) => s.id === n.section)?.heading ?? ''}
    />
  )
  return (
    <div
      className={
        // `flex-1 min-h-0`, NOT `h-full`, AND THE DIFFERENCE IS THE SEND BUTTON.
        // This root is a flex item of `.plan-tab`, which also holds the tab's
        // header. `height: 100%` there asks for the WHOLE tab — header
        // included — so the column overflowed its own parent by the header's
        // height, every time, on every plan.
        //
        // Nothing absorbed that overflow, and the reason is the part worth
        // writing down: negative free space is distributed by SCALED shrink
        // factor, `shrink x flex-base-size`. The pane row below is `flex-1`,
        // i.e. `flex: 1 1 0%`, so its base size is 0, its scaled factor is 0,
        // and the one child that exists to give up height gave up none of it.
        // The squeeze fell entirely on the auto-basis siblings instead — the
        // acceptance strip, the outcome banners, and `PlanTray` last of all —
        // and the tray's content spilled out of the bottom of the
        // `overflow-hidden` that `ProjectView` wraps this tab in. The clipped
        // band was exactly the tray's final row, so `Send review` was in the
        // DOM and off the screen, and the tab looked like it could not submit.
        //
        // `flex-1` sizes this to what is LEFT after the header, so the negative
        // space never exists; `min-h-0` lets it shrink under its content so the
        // pane's own `overflow-y-auto` is what scrolls.
        //
        // AND HERE IS THE INVARIANT THAT FIX DEPENDS ON, DECLARED RATHER THAN
        // ASSUMED, because leaving it assumed is how it broke a second time.
        // The paragraph above sizes the COLUMN correctly and says nothing about
        // its children; the failure it describes needs only ONE unbounded child
        // above the pane row to come straight back. `PlanDeviation` was added
        // later, printed a multi-thousand-character deviation comment under
        // `min-height: auto` — whose block-axis automatic minimum IS the
        // content height — and `Send review` left the screen exactly as
        // before.
        //
        //   EVERY CHILD ABOVE THE PANE ROW IS BOUNDED AND NOT FLEXIBLE, so the
        //   pane row is the only item that can absorb anything and free space
        //   can never go negative.
        //
        // All three hold it, each at its own definition site: `PlanCommentList`
        // (`.plan-cl` — `flex: none`, a hard `max-height`, and it CLIPS, with
        // its rows as the one scroller inside), `PlanAcceptance`
        // (`.plan-approve` — `flex: none`) and the outcome banners (`shrink-0`,
        // below). `PlanTray` is no longer a fourth: it is the comment list's
        // footer now, so it is bounded by the first of the three rather than on
        // its own account — its `shrink-0` still earns its keep one level down,
        // inside that box's column. `PlanEditor.mounts.test.tsx` asserts all of
        // it on the SOURCE, because jsdom has no layout engine and cannot be
        // asked where the tray is.
        //
        // THE COMPACT BRANCH MUST STAY AUTO-HEIGHT. The desk band has no
        // full-height pane to dock against — it flows in the card's scroll, and
        // giving it a flex height would cap it at whatever the card is.
        density === 'full'
          ? 'plan-editor flex flex-col flex-1 min-h-0'
          : 'plan-editor plan-editor--compact'
      }
      data-testid="plan-editor"
      data-density={density}
    >
      {/* THE OFF-CONTRACT ALARM, FIRST, AND ON BOTH MOUNTS. It sits above the
          Approve strip because it is the reason the reader is here: the work
          has gone off the contract and a decision is waiting. It offers no
          decision of its own — each row is one line you click to LAND ON the
          note, which already carries `Accept`, `Reject`, `Reply` and `Dismiss`
          — and the pane is seeded to the newest one's section so the first is
          on screen rather than a scroll away.
          It used to render on the desk card ONLY, out of `PlanBand`. Rendering
          it here means the Plan tab gets it too, from the same code, and there
          is exactly one implementation of the alarm to keep correct.

          IT CARRIES THE SEND BAR NOW, as its footer — see `footer` below. The
          tray used to be a second box at the bottom of this column, listing the
          same batch this list already lists; there is one review surface now.

          THIS IS THE FIRST OF THE THREE BOUNDED CHILDREN — see the note on the
          root's className. It cannot grow: `.plan-cl` is `flex: none` with a
          hard `max-height`, it CLIPS rather than scrolls, its rows are the one
          scroller inside it, and each row's summary is clamped to one line. It
          used to print the whole comment, which is what pushed `Send review`
          off the bottom of the screen — and the footer being outside that
          scroller is what stops the merge doing the same thing again. */}
      <PlanCommentList
        items={items}
        keeper={index.keeper}
        // ONE ROUTE. `showNote` is unchanged, and it is the same function for a
        // real note and for a staged edit drawn as one — `anchorOf` below is
        // what gives the second a landing target, which is why there is no
        // second callback here.
        onShow={showNote}
        parentOf={parentOf}
        // THE TRAY'S ✕, MOVED ONTO THE COMMENT IT IS ABOUT. Removal, never a
        // decision: `removeRow` takes exactly one row and un-supersedes the one
        // it overtook, which is the same operation from the other end.
        onUnstage={(id: string) => stage(removeRow(rows, id))}
        // THE SEND BAR, AS THIS BOX'S FOOTER — the tray used to be a sibling at
        // the very bottom of the editor column, a second box below the document
        // saying nothing the list above it did not already list. There is one
        // review surface now: the comments, and the Send that sends them.
        //
        // THE REGRESSION THIS FLIRTS WITH, NAMED SO IT STAYS SHUT. `.plan-cl`
        // exists because an unbounded box above the pane row pushed `Send
        // review` off the bottom of the screen. Putting Send back INSIDE that
        // box re-asks the same question from the other side: a box that scrolls
        // as a whole scrolls its Send away with its rows. It does not, because
        // `.plan-cl` clips and only `.plan-cl-rows` scrolls — see the rule and
        // its `min-height: 0`, and the assertion in `PlanEditor.mounts.test.tsx`
        // that Send is outside the rows scroller.
        //
        // IT MAY RENDER NOTHING and the list is still right: `PlanTray` nulls
        // itself on an empty batch, and this list is never absent while the
        // batch is non-empty (`commentList` emits an item per open note AND per
        // unclaimed row), so no reachable Send can be hidden by the list's own
        // emptiness check.
        footer={
          <PlanTray
            rows={rows}
            pending={pending}
            notes={notes}
            // `notes` IS the open ones — filtered once, at its declaration.
            openNotes={notes.length}
            room={index.draft?.room ?? ''}
            submitting={busy}
            // THE CALLER'S SEND, OR THIS ONE — never both. See the prop.
            showSend={!sendHostedByCaller}
            onSubmit={onSubmit}
            onDiscard={onDiscard}
          />
        }
      />

      {/* ACCEPTANCE STATUS — ITS OWN STRIP, at the top of the editor, ABOVE the
          outcome banners and outside both `PlanTray` and `.plan-note-acts`.
          THERE IS NO APPROVE HERE AND NO REVOKE EITHER, AND ADDING ONE WOULD BE
          THE BUG. Accepting the plan is accepting its go-note, which happens in
          the send bar above with the same Accept every other proposal has;
          changing
          an accepted plan is applying the next note, which re-signs it. Both
          acts are already on this screen, once each, and a control here would
          be a second door onto one of them.
          It also keeps the note action bar's promise literally true: that bar's
          one line of help says nothing reaches the plan or its addressees until
          you submit, and this strip — which posts nothing at all — is now the
          only thing above it that could have contradicted it.
          IT RENDERS AT BOTH DENSITIES. `density` picks the layout and never
          decides what EXISTS — the moment it did, the desk mount would be a
          fork rather than the same component. The ONE case where the chip
          stands down is not a density branch: a caller that has already printed
          `accepted` and the revision in its own chrome says so, and it says so
          about what it RENDERED, not about how wide it is. */}
      <PlanAcceptance
        accepted={index.accepted}
        acceptedRevision={index.accepted_revision}
        changedSinceAcceptance={index.changed_since_acceptance}
        statedAbove={acceptanceStatedAbove}
        density={density}
      />

      {/* THE EDITOR'S OWN WRITE OUTCOMES, and they moved with the code that
          produces them. `banner` is the AC-6.7 proportionate refresh signal and
          names the staged-row count, `notice` reports the revision THE WRITE
          RETURNED (never a predicted +1 — a submit of only rejections lands
          with the revision unchanged), and `failure` carries the refusal.
          They are the only write outcomes on this screen now: the acceptance
          strip above posts nothing, so it has none of its own. */}
      {banner && (
        <div
          className="plan-outcome shrink-0 mb-2 flex items-center gap-2 text-xs rounded bg-sky-500/10 text-sky-800 dark:text-sky-300 px-2 py-1"
          data-testid="plan-revision-banner"
        >
          The plan moved to revision {banner.revision}
          {banner.by ? ` — @${banner.by}` : ''}. Your {rows.length} staged row
          {rows.length === 1 ? '' : 's'} {rows.length === 1 ? 'is' : 'are'} untouched.
          <button type="button" className="plan-btn ml-auto" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div className="plan-outcome shrink-0 mb-2 text-xs text-emerald-700 dark:text-emerald-400" role="status">
          {notice}
        </div>
      )}
      {/* THE BATCH'S REFUSALS, AND ONLY WHILE THERE IS NOWHERE BETTER. A note
          refusal now renders inside the composer that produced it, beside the
          text it refused; a batch refusal has no such home and belongs here.
          Suppressing the NOTE's copy here is what keeps the same sentence from
          appearing twice, with the copy a full scroll away being the one that
          used to be the ONLY copy.

          GATED ON WHOSE FAILURE IT IS, NOT ON WHETHER A COMPOSER IS OPEN. The
          two coincide for a note refusal — which is why `!quoted` looked
          equivalent — and come apart for a batch one: the tray's `Send review`
          is reachable with the popover still standing (there is no
          click-outside; `setQuoted` is cleared on success and on explicit
          close only), and `PlanQuotePop` renders `failure` only when its own
          post failed. Under `!quoted` that refusal rendered NOWHERE and the
          user was told nothing at all about a batch that did not go out. */}
      {failure && failureFrom !== 'note' && (
        <div className="plan-outcome shrink-0 mb-2 text-xs text-rose-700 dark:text-rose-400" role="alert">
          {failure}
        </div>
      )}
      {/* A 200 THAT PARTLY WENT NOWHERE. Rendered rather than swallowed: the
          server deleted these names from the fan-out before anything was
          delivered, so without this line the note simply vanishes behind a
          success. It is never fatal and never a throw — it is the only signal
          this surface has. */}
      {unresolved.length > 0 && (
        <div
          className="plan-outcome shrink-0 mb-2 text-xs text-amber-700 dark:text-amber-400"
          data-testid="plan-unresolved"
        >
          Not delivered to {unresolved.map((a) => `@${a}`).join(', ')} — they are on this project
          but not in its review room, so nothing reached them. Ask the coordinator to add them,
          then send again.
          <button
            type="button"
            className="plan-btn ml-2"
            onClick={() => setUnresolved([])}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className={density === 'full' ? 'flex-1 flex min-h-0' : 'flex flex-col min-h-0'}>
        {/* SECTION NAVIGATION — DOCUMENT ORDER, off `index.sections`, never by
            array position and never by a vocabulary this client declares. An
            unrecognised heading is an ordinary section; nothing here depends on
            any slug existing, `milestones` included. A leading `# ` title is not
            a section and the server never sends one.

            TWO FORMS, ONE LIST. `density` picks the control and changes nothing
            about what is in it or what selecting does: both write the same
            `pane` state through the same `setPane`. History is offered on the
            full mount only, and the versions query is gated on the same flag —
            see `showHistory` above. */}
        {density === 'full' ? (
          <nav
            className="w-56 shrink-0 border-r border-border overflow-y-auto p-2 space-y-0.5"
            aria-label="Plan sections"
          >
            <SectionButton
              label="Whole document"
              selected={pane === 'all'}
              onClick={() => setPane('all')}
            />
            {sections.map((s) => (
              <SectionButton
                key={s.id}
                label={sectionLabel(s)}
                slug={s.id}
                depth={s.depth}
                boxes={s.boxes}
                dot={openNotesOn(notes, s.id)}
                duplicate={dupes.has(s.heading)}
                selected={pane === s.id}
                onClick={() => setPane(s.id)}
              />
            ))}
            <SectionButton
              label="History"
              selected={pane === 'history'}
              onClick={() => setPane('history')}
            />
          </nav>
        ) : (
          <div className="px-1 pt-1 pb-2">
            {/* The open-note dot the rail draws per row has no place on an
                <option>, so the count rides the label instead — the same
                `openNotesOn` number, said in words.

                THE INDENT IS CLAMPED, exactly as the rail's `paddingLeft` is.
                `depth` is the server's grammar and it is legitimately SHALLOWER
                than `##`: a headless opening section arrives at depth 0 and a
                `#` heading that is not the document title at depth 1. Unclamped,
                `(0 - 2) * 2` is a negative count and `String.repeat` throws
                during render — which unmounts the whole app, not this select. */}
            <select
              className="plan-section-select"
              aria-label="Plan sections"
              value={pane}
              onChange={(e) => setPane(e.target.value)}
            >
              <option value="all">Whole document</option>
              {sections.map((s) => {
                const open = openNotesOn(notes, s.id)
                return (
                  <option key={s.id} value={s.id}>
                    {'\u00a0'.repeat(Math.max(0, s.depth - 2) * 2)}
                    {sectionLabel(s)}
                    {open ? ` · ${open} open` : ''}
                  </option>
                )
              })}
            </select>
          </div>
        )}

        {/* THE PANE'S SCROLLER, and the ONE flexible item in the column above
            it. `ref` is what scopes an alarm row's scroll to this mount rather
            than to `document` — see `scrollTo`. */}
        <div
          ref={paneRef}
          className={
            density === 'full'
              ? 'flex-1 overflow-y-auto p-6 space-y-4'
              : 'overflow-y-auto max-h-[420px] scrollbar-thin px-1 py-2 space-y-3'
          }
        >
          {showHistory && pane === 'history' ? (
            <PlanHistory versions={versions ?? []} history={index.history} />
          ) : (
            <>
              {stale && (
                <div className="space-y-3" data-testid="plan-stale-reconcile">
                  <p className="text-sm text-rose-700 dark:text-rose-400">
                    Nothing was applied and nothing was sent. Every row is still in your tray
                    with your text.
                  </p>
                  {stale.rows.map((s) => {
                    /* THE ROW THE SERVER WILL ACTUALLY APPLY — the LAST
                       non-superseded text row, matching `_collapse_text_rows`.
                       A settled collision leaves two text rows on this section
                       and only the later one lands; offering the earlier one
                       here re-bases a discarded proposal, leaves the winner
                       stale, and earns the identical `409` on the next Send. */
                    const mine = appliedTextRow(rows, s.section)
                    if (!mine) return null
                    return (
                      <PlanCollide
                        key={s.section}
                        section={s.section}
                        heldBy={lastToucherOf(index, s.section)}
                        heldText={s.current}
                        nextBy=""
                        nextText={mine.text}
                        reason="The document moved under this row while it was staged."
                        onCancel={() => setStale(null)}
                        onResolve={(choice, text) => {
                          const rebased: TrayRow =
                            choice === 'own'
                              ? { ...mine, text: text ?? mine.text, base: s.current }
                              : { ...mine, base: s.current }
                          const next =
                            choice === 'held'
                              ? // EVERY text row for the section, not just this
                                // one. `removeRow` would un-supersede the loser
                                // a `Take @{new}'s` overtook and stage it
                                // against the section the user just said to
                                // leave alone.
                                dropTextRows(rows, s.section)
                              : rows.map((r) => (r.id === mine.id ? rebased : r))
                          stage(next)
                          setStale({
                            ...stale,
                            rows: stale.rows.filter((x) => x.section !== s.section),
                          })
                        }}
                      />
                    )
                  })}
                  {stale.noteIds.length > 0 && (
                    <p className="text-xs text-channel">
                      The refusal filed {stale.noteIds.length} conflict note
                      {stale.noteIds.length === 1 ? '' : 's'} so nothing is lost:{' '}
                      {stale.noteIds.join(', ')}.
                    </p>
                  )}
                </div>
              )}

              {collision && (
                /* MARKED SO THE EFFECT ABOVE CAN FIND IT, and wrapped rather
                   than marking `PlanCollide` itself because this file renders
                   that component TWICE — the stale-reconcile block a few lines
                   up renders one per refused row. A marker on the component
                   would make "the collision control" ambiguous exactly when
                   both are on screen, and the wrapper costs no layout: the
                   parent's `space-y-3` counts children, not descendants. */
                <div data-plan-collide>
                  <PlanCollide
                    section={collision.section}
                    heldBy={collision.heldBy}
                    heldIsCurrent={collision.held.id === 'synthetic-current-text'}
                    heldText={collision.held.text}
                    nextBy={collision.nextBy}
                    nextText={collision.next.text}
                    reason={collision.reason}
                    onStack={collision.fold ? onStack : undefined}
                    stackRefused={collision.stackRefused}
                    onResolve={onCollide}
                    onCancel={() => setCollision(null)}
                  />
                </div>
              )}

              {pane === 'all' || current ? (
                <SectionPane
                  section={current}
                  editing={!!current && editingSlug === current.id}
                  draftText={draftText}
                  onEdit={() => {
                    if (!current) return
                    setEditingSlug(current.id)
                    setDraftText(textOf(current.id))
                  }}
                  onChange={setDraftText}
                  onCancel={() => {
                    setEditingSlug(null)
                    setDraftText('')
                  }}
                  onBlurStage={() => {
                    // The whole-document pane has no section to edit; the
                    // header and its control only render when one is selected.
                    if (!current) return
                    // AC-6.6 — a row is emitted only when the text MOVED. An
                    // editor that stages on every blur produces a phantom
                    // write: a revision and a changelog entry for a section
                    // nobody changed.
                    const base = textOf(current.id)
                    const row = editRow(current, base, draftText)
                    setEditingSlug(null)
                    setDraftText('')
                    if (!row) return
                    const held = heldTextRow(rows, current.id)
                    if (held) {
                      setCollision({
                        held,
                        next: row,
                        heldBy: byId.get(held.note_id)?.by ?? '',
                        nextBy: '',
                        section: current.id,
                        reason:
                          'Your tray already carries text for this section. Only one of them can land.',
                        // Your own text on both sides of the question — see the
                        // block-edit path above for why there is nothing to fold.
                        fold: null,
                        stackRefused: '',
                      })
                      return
                    }
                    stage([...rows, row])
                  }}
                >
                  {/* THE DOCUMENT, WITH ITS NOTES IN IT. One code path for both
                      panes: the whole-document view renders every section, a
                      section view renders exactly one, and a note that cannot
                      find its line lands at the end of ITS OWN section either
                      way. */}
                  <PlanBody
                    textOf={renderText}
                    sections={shownSections}
                    preamble={preamble}
                    notes={bodyRoots}
                    readOnly={false}
                    onQuote={setQuoted}
                    // WHICH BLOCK THE COMPOSER IS OPEN ON, HANDED BACK DOWN so
                    // the document can light it. The popover used to answer
                    // that question by reprinting the quoted words two inches
                    // from where they already are; the document answers it now,
                    // on the words themselves.
                    //
                    // THE SAME STATE, NOT A COPY, which is what makes the
                    // highlight need no teardown of its own: `setQuoted(null)`
                    // is already the single funnel for every way the composer
                    // goes away — Cancel and Escape through `onClose`, a press
                    // anywhere in the body through `onQuote`, and a successful
                    // file through `onPostNote` — so each of them drops the
                    // highlight by the same line that closes the popover. The
                    // one path that deliberately does NOT close is a FAILED
                    // file: the composer stands so the user's text survives, so
                    // the block stays lit while they fix it and retry.
                    commenting={quoted}
                    onBlockEdit={onBlockEdit}
                    renderNote={renderNote}
                    // A SECTION THE TRAY IS REWRITING BECOMES A SCROLL TARGET.
                    // `PlanCommentList` draws a staged edit as the comment it
                    // is, and clicking it routes through the same `showNote`
                    // every real note uses — which needs an element carrying
                    // that row's id. The row IS the section's text on screen,
                    // so the section's own root is the honest place to hang it.
                    // `edit` ONLY, and not every held text row: an `accept`
                    // row's item in the list is its real NOTE, whose card
                    // already carries `data-note-id`, so anchoring the section
                    // with the row's id would be an attribute nothing looks for.
                    anchorOf={(s) => {
                      const held = heldTextRow(rows, s.id)
                      return held?.kind === 'edit' ? held.id : undefined
                    }}
                  >
                    {quoted && (
                      <PlanQuotePop
                        at={quoted.at}
                        // THE ONE LEGAL ADDRESSEE, AND THE COMPOSER NO LONGER
                        // SAYS SO OUT LOUD. A note connects the user and the
                        // coordinator; the writer here is always the owner, so
                        // the recipient is always the keeper — and `''` on a
                        // plan that names no keeper, which reaches the wire as
                        // `to: []` exactly as it always has. What the composer
                        // stopped doing is PRINTING this; where the note goes
                        // is unchanged, which is why this prop survived the row
                        // that displayed it.
                        to={index.keeper}
                        busy={busy}
                        // The refusal goes WHERE THE TEXT IS. The block at the
                        // top of the pane keeps `onSubmit`'s batch refusals,
                        // which have no popover to live in; a note refusal has
                        // one, and rendering it in both places would be the
                        // same sentence twice with the far copy the one nobody
                        // is looking at.
                        //
                        // PARTITIONED HERE, NOT LEFT TO THE POPOVER'S `failed`.
                        // That flag latches: it is set after a failed post and
                        // cleared only by the NEXT submit, while this prop is
                        // the parent's live `failure` and changes underneath
                        // it. So a composer that has already had a post refused
                        // would render the BATCH's message next — wearing its
                        // alert, marking the user's unfiled text `aria-invalid`
                        // for a refusal that has nothing to do with it, and
                        // making two alerts of one failure with the near copy
                        // the misattributed one. Sending `null` unless the
                        // failure is the note's makes this exactly the
                        // complement of the pane's `failureFrom !== 'note'`:
                        // the partition is total, every failure has exactly one
                        // home, and the latch stops being load-bearing.
                        failure={failureFrom === 'note' ? failure : null}
                        // NOT `void`-ED ANY MORE, and that is the structural
                        // half of AC-2.4. The popover awaits this to know its
                        // post has settled; voiding it here is what let the
                        // composer unmount on the same tick it submitted.
                        onPost={({ comment, to }) =>
                          onPostNote({
                            section: quoted.section,
                            // ALREADY A LIST, AND ALREADY NORMALISED. The
                            // `.split(',')` that used to happen here was this
                            // file compensating for a control that held one
                            // string; the picker holds the set, and
                            // `parseAddressees` does the comma-and-`@` handling
                            // at the one point free text enters it. `[]` reaches
                            // the wire as `[]` and is a real choice.
                            to,
                            comment,
                            // NEITHER `proposal` NOR `base_section` IS HERE,
                            // and their absence is this change rather than an
                            // omission in it. The composer's replacement
                            // textarea is gone, so the browser has nothing to
                            // put in either field — and both default to `""`
                            // server-side, so a body without them is the same
                            // note the server recorded when they were sent
                            // empty, which they were on every post that did not
                            // expand the proposal area.
                            //
                            // AN AGENT'S PROPOSAL IS UNAFFECTED. It arrives on
                            // `clawmeets plan note --proposal` and on this same
                            // route with both fields filled, and every surface
                            // that renders one still does.
                            reply_to: '',
                            // NEITHER `question` NOR `deviation` IS MISSING
                            // FROM THIS PAYLOAD — BOTH ARE DELETED. Each set a
                            // stored `kind` that no longer exists: `kind` is
                            // derived server-side on every read from the note's
                            // own fields, so there is nothing for a flag to
                            // assert. A deviation is now "the keeper wrote to
                            // the user after the plan was accepted", which the
                            // server can see for itself and a human in this
                            // editor is not, so the browser could not set it
                            // even if the field survived. The request fields
                            // survive server-side as deprecated no-ops.
                            quote: quoted.quote,
                          })
                        }
                        onClose={() => setQuoted(null)}
                      />
                    )}
                  </PlanBody>
                </SectionPane>
              ) : (
                <p className="text-sm text-channel">That section is no longer in the document.</p>
              )}

              {/* THE NOTES LIST STAYS, AND DELETING IT WOULD STRAND NOTES. The
                  bottom-of-page COMPOSER is gone — its proposal and its question
                  flag moved on to the selection popover, its deviation flag and
                  its un-quoted channel left for `clawmeets plan note`. What is
                  left here is the BOTTOM RUNG of the placement ladder, and only
                  it: a note whose section does not resolve — deleted, renamed,
                  or never named at all. An un-quoted note used to land here too
                  and no longer does; it sits at the end of the section it names
                  (`bodyRoots`), which is why this list is now usually empty and
                  must still exist. */}
              <section className="space-y-2" data-testid="plan-notes">
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-channel">
                  Notes {current ? `on ${current.heading}` : ''}
                </h3>
                {roots.length === 0 && <p className="text-sm text-channel">No notes here.</p>}
                {roots.map((n) => (
                  <div key={n.id}>{renderNote(n)}</div>
                ))}
              </section>

            </>
          )}
        </div>
      </div>

    </div>
  )
}

function SectionButton({
  label,
  slug,
  depth = 2,
  boxes,
  dot = 0,
  duplicate = false,
  selected,
  onClick,
}: {
  label: string
  slug?: string
  depth?: number
  boxes?: [number, number]
  dot?: number
  duplicate?: boolean
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-section={slug}
      aria-current={selected ? 'true' : undefined}
      className={
        'w-full text-left text-xs rounded px-2 py-1 flex items-center gap-1 ' +
        (selected ? 'bg-sidebar-hover text-channel-active font-semibold' : 'text-channel')
      }
      style={{ paddingLeft: 8 + Math.max(0, depth - 2) * 12 }}
    >
      <span className="truncate">{label}</span>
      {boxes && boxes[1] > 0 && (
        <span className="ml-1 shrink-0 tabular-nums">
          {boxes[0]}/{boxes[1]}
        </span>
      )}
      {duplicate && (
        <span
          className="shrink-0 text-amber-600"
          title="Two sections share this heading; their slugs differ."
        >
          ⚠
        </span>
      )}
      {dot > 0 && (
        <span
          className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-accent"
          data-note-dot={dot}
          aria-label={`${dot} unresolved note${dot === 1 ? '' : 's'}`}
        />
      )}
    </button>
  )
}

/**
 * The section header and its raw-Markdown editor — and, when neither is in the
 * way, the document itself.
 *
 * It takes the body as `children` rather than rendering it, because the body is
 * the same `PlanBody` on the whole-document pane where there IS no section
 * header. One pane with a heading above it, one without; the document below is
 * identical code on both.
 */
function SectionPane({
  section,
  editing,
  draftText,
  onEdit,
  onChange,
  onCancel,
  onBlurStage,
  children,
}: {
  section: PlanSection | undefined
  editing: boolean
  draftText: string
  onEdit: () => void
  onChange: (v: string) => void
  onCancel: () => void
  onBlurStage: () => void
  children: ReactNode
}) {
  if (section && editing) {
    return (
      <div>
        <label className="block text-xs text-channel mb-1" htmlFor={`raw-${section.id}`}>
          Raw Markdown for <code>{section.id}</code> — staged when you finish, applied when you
          submit
        </label>
        <textarea
          id={`raw-${section.id}`}
          aria-label={`Raw Markdown for ${section.heading}`}
          // `plan-raw-edit` is read by the selection guard: text being WRITTEN
          // is not a quote of the document, so selecting in here never offers
          // to comment on it.
          className="plan-raw-edit w-full h-96 font-mono text-xs rounded border border-border bg-sidebar p-2"
          value={draftText}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="flex gap-2 mt-2">
          <button type="button" className="plan-btn plan-btn--primary" onClick={onBlurStage}>
            Stage this section
          </button>
          <button type="button" className="plan-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    )
  }
  return (
    <div>
      {section && (
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold">{sectionLabel(section)}</h2>
          <code className="text-xs text-channel">{section.id}</code>
          <button type="button" className="plan-btn ml-auto" onClick={onEdit}>
            Edit raw Markdown
          </button>
        </div>
      )}
      {children}
    </div>
  )
}

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, ArrowUp, Check, CornerUpRight, FileText, Paperclip, Send } from 'lucide-react'
import Avatar from '../common/Avatar'
import AgentNameLink from '../agent/AgentNameLink'
import MarkdownBody from '../shared/MarkdownBody'
import { useRoomTrust } from '../../hooks/useRoomTrust'
import { RenderBody } from '../shared/RenderBody'
import FileViewerModal from '../files/FileViewerModal'
import DropOverlay from '../common/DropOverlay'
import StagedAttachments from '../chatroom/StagedAttachments'
import ForwardModal from '../chatroom/ForwardModal'
import PromptEditor, { type PromptEditorHandle } from '../composer/PromptEditor'
import { useMessageAttachments } from '../../hooks/useMessageAttachments'
import { useFileDropzone } from '../../hooks/useFileDropzone'
import { sendUserMessage } from '../../api/endpoints/messages'
import { sendHubDraft } from '../../hooks/useHub'
import { completeProject } from '../../api/endpoints/projects'
import { useProjectReport } from '../../hooks/useProjectReport'
import { PlanBand } from './PlanBand'
import { type PlanSendState } from '../project/plan/PlanEditor'
import { PhaseRail } from './PhaseRail'
import { CardBand } from './CardBand'
import {
  bandsPresent,
  defaultOpenBands,
  isGated,
  planFoldMeta,
  type BandId,
} from './deskBands'
import { useMarkDeskRead } from '../../hooks/useDeskReadState'
import { type DeskFile, type DeskUpdate } from '../../hooks/useDeskUpdates'
import { AgentStatus } from '../../types'

// The card leads with WHAT (the title) and follows with WHO (the agent byline):
// scanning the desk is a scan of subjects, not of names. No lane pill and no
// source subtitle — the desk section a card sits in already says its lane
// (Review / Working / Recently done), and the source repeated the title.

// Imperative surface so DeskPage's keyboard shortcuts can drive a card's own
// behaviors without hoisting all of its local state.
export interface UpdateCardHandle {
  toggleExpand: () => void
  toggleReply: () => void
  dismiss: () => void
  /** Opens the Forward dialog; no-op on a card with nothing forwardable. */
  forward: () => void
  open: () => void
  scrollIntoView: () => void
}

// One update: review + reply-in-place, mark done, or open the thread. A card is
// a DM or Project; "Send Back" posts straight to its user-communication room.
const UpdateCard = forwardRef<
  UpdateCardHandle,
  {
    item: DeskUpdate
    /** `tab` is the destination surface within the project — omitted for the
     *  ordinary "Open project", `'plan'` for the PLAN band's release control,
     *  which must land the user on the document their answer is owed to. */
    onOpen: (item: DeskUpdate, tab?: 'plan') => void
    onToast: (msg: string) => void
    // Fired synchronously the instant the one removing action (Done) actually
    // REMOVES the card — after the complete POST has succeeded, before the
    // read-state write or any refetch. Lets the desk snapshot the current card
    // order for cursor recovery. No-op unless this card is selected.
    //
    // It moved behind the POST when Done started completing the project: a
    // failed complete leaves the card on the desk, and a snapshot taken for a
    // removal that never happened would sit stale until some later action
    // consumed it and recovered the cursor to the wrong row.
    onActStart?: (projectId: string) => void
    // Done (read-lane) cards only: hand this card up to the desk, which
    // drafts a "turn this into an SOP" request to the owner's assistant in the
    // top composer. Omitted ⇒ the button is not rendered.
    onSaveAsSop?: (item: DeskUpdate) => void
    selected?: boolean
    /** A hovered to-do on the rail lists this card's `projectId` in its
     *  `project_ids`. Paints the cross-highlight. Orthogonal to `selected` —
     *  both can be true at once, and they paint on different CSS channels
     *  (outline vs border+ring) so they stack instead of fighting. */
    linked?: boolean
    /** Pointer entered / left this card. Hands up `item.projectId` on enter and
     *  `null` on leave; the DESK decides which side of the pair lights, because
     *  it is the only place holding both the cards and the to-dos.
     *
     *  Wired to mouseenter/mouseleave, NOT the pointer events: this is a mouse
     *  affordance by design. Touch fires an enter with no matching leave, which
     *  would strand the highlight lit with nothing left to clear it. */
    onHover?: (projectId: string | null) => void
  }
>(function UpdateCard(
  { item, onOpen, onToast, onActStart, onSaveAsSop, selected, linked, onHover },
  ref,
) {
  const { markRead } = useMarkDeskRead()
  const queryClient = useQueryClient()
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const [acted, setActed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [forwarding, setForwarding] = useState(false)
  // Same trust rule as the room: a Hub thread whole, and the quote's author
  // per author (a Telegram or email contact, a requester, another account's
  // agent). The quote's files rode in with it, so they share its answer.
  const trust = useRoomTrust(item.projectId, 'user-communication')
  const untrusted = item.quoteOutsideIsolated || (item.quoteAuthorId === null
    ? trust.unknownAuthorUntrusted
    : trust.isUntrusted(item.quoteAuthorId))
  // Forwardable = the card quotes an agent's message. The user's own pending
  // request is not something to hand on, and an empty thread has nothing.
  // Forwarding is additive — it never marks the card done — so every lane
  // carries it, history included. Never for untrusted content: the server
  // quotes the body word for word into the owner's DM, which draws it trusted.
  const canForward = !!item.latestMessageId && !item.quoteIsYours && !untrusted
  // Index into item.files of the file open in the viewer; null = closed.
  // Owned by the card (not per pill) so ← / → can step across its files.
  const [openFileIdx, setOpenFileIdx] = useState<number | null>(null)
  const openFile = openFileIdx !== null ? item.files[openFileIdx] : undefined
  const editorRef = useRef<PromptEditorHandle | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Attachment staging for the inline reply — same primitives (and 20 MB cap)
  // as the top-of-desk DeskComposer, so a dropped/picked file rides the reply's
  // atomic send. Each open card owns its own instance; staged files never leak
  // between cards.
  const { stagedFiles, files, addFiles, removeStagedFile, clearStagedFiles, attachmentError } =
    useMessageAttachments()

  const isProgress = item.lane === 'progress'
  // "Recently done" cards are historical — Open-only. Re-marking a card done
  // is nonsense, so Done / Send Back are suppressed (M1 ruling 3); the card
  // keeps the same layout as its live siblings, minus the removing actions.
  const isRead = item.lane === 'read'
  const actionable = !isProgress && !isRead

  // THE THREE BANDS, in the user's fixed order: REPORT, PLAN, RESPONSE. Absent
  // bands are OMITTED ROWS, never placeholders.
  //
  // `opened` is seeded on mount from `defaultOpenBands`, which opens at most
  // ONE fetching band (report or plan) — two would be two fetches per card —
  // plus RESPONSE alongside a report, which costs nothing. Folding is never
  // destructive and every band is reachable by click.
  const present = bandsPresent(item)
  const [opened, setOpened] = useState<Partial<Record<BandId, boolean>>>(() =>
    Object.fromEntries(defaultOpenBands(item).map((id) => [id, true])),
  )
  const toggleBand = (id: BandId) => setOpened((o) => ({ ...o, [id]: !o[id] }))

  // A REPORT THAT ARRIVES AFTER MOUNT re-opens REPORT and RESPONSE. The seed
  // above runs once, so without this a card mounted while the project was
  // still running keeps its earlier choice and the new report stays folded
  // until a reload. Keyed on the publish stamp, so a republished report opens
  // again too; any other fold the user made is left alone.
  const reportAt = item.reportPublishedAt
  const prevReportAt = useRef(reportAt)
  useEffect(() => {
    if (reportAt && reportAt !== prevReportAt.current) {
      setOpened((o) => ({ ...o, report: true, response: true }))
    }
    prevReportAt.current = reportAt
  }, [reportAt])

  // THE PLAN EDITOR'S OPEN SIGNAL — A COUNTER, NOT A BOOLEAN. The compact
  // editor is UNMOUNTED while the PLAN band is folded (that is the request-cost
  // invariant two comments down), so it reads this ON MOUNT; a boolean would
  // need someone to reset it and could not fire a second time, and unfolding
  // the band a second time is an ordinary thing to do.
  //
  // TWO MECHANISMS IN ONE ORDER, and they cannot race because the second only
  // ever runs inside the first: UNFOLDING the PLAN band MOUNTS the editor (the
  // precondition), and the counter SELECTS the deviation's section (the
  // action). Incrementing on the unfold is what makes that ordering structural
  // rather than a convention two call sites have to keep.
  const [planOpenSignal, setPlanOpenSignal] = useState(0)
  const togglePlanBand = () => {
    if (!opened.plan) setPlanOpenSignal((n) => n + 1)
    toggleBand('plan')
  }

  /** THE BATCH THE PLAN EDITOR IS HOLDING, reported up from inside the PLAN
   *  band so this card's own action row can send it. `null` whenever there is
   *  no batch — including while the band is folded, because the editor is
   *  genuinely unmounted then and says so on the way out.
   *
   *  THIS IS THE ONE PIECE OF REAL PLUMBING IN THE CHANGE, and it buys the rule
   *  the row below depends on: **exactly one primary action per card, and it is
   *  always in the same place.** `Send review` used to live four inches up,
   *  inside a box that flows in the card's scroll, while the row that never
   *  moves carried `Done` and `Send Back` — so on any card with a real review
   *  the two terminal verbs were the visible ones and the review's own button
   *  was the one you had to go find.
   *
   *  It holds no rows and no notes. See `PlanSendState`: a card that could read
   *  the batch could start deciding it, and the editor is the one write funnel. */
  const [planSend, setPlanSend] = useState<PlanSendState | null>(null)

  /** ARMED = `Mark Done` has been pressed once while a review was staged, and
   *  the button is now asking whether to throw that review away.
   *
   *  THE ONE STATE WHERE MARK DONE DESTROYS SOMETHING THE USER TYPED, and so
   *  the one place it asks twice. Everything else it clears is recoverable:
   *  completing is undone by replying into the thread, and an unanswered plan
   *  note is still there when the project reopens. Staged rows are not — they
   *  live in the editor and nothing has posted them.
   *
   *  It is not a dialog and not a second surface: the button relabels itself in
   *  place, and one more press does what the label now says. */
  const [armedDiscard, setArmedDiscard] = useState(false)

  // The question expires with its subject. If the batch empties — sent,
  // discarded in the tray, or the PLAN band folded and unmounted the editor —
  // an armed button would be asking about a review that no longer exists.
  useEffect(() => {
    if (!planSend) setArmedDiscard(false)
  }, [planSend])

  // THE DEVIATION PREDICATE, WRITTEN ONCE PER CARD and passed down from here.
  // All five carriers that replace the reference design's promotion-to-focus
  // fire off this and nothing else: the card's urgent left rule, the rail's
  // reddened hint, the PLAN band's warn tone, the PLAN band being
  // default-expanded, and the `.plan-dev` alarm itself — which the editor now
  // renders off its own notes, so this card no longer feeds it anything.
  const offContract = !!item.plan?.deviation

  // THE HALTED CONJUNCTION, computed here — at its ONE display site — rather
  // than carried as a flag. There is no `halted` member on the wire and none is
  // invented here or anywhere else.
  const gated = isGated(item.plan)

  /** HOW MANY PLAN NOTES ARE WAITING ON THE USER. Read off the summary the card
   *  already carries — `plan.open_notes_for_you`, the same integer the server's
   *  execution gate refuses on — and nothing is added to it. A DM has no plan
   *  and answers 0, which is right: there is nothing to review, so `Mark Done`
   *  is the primary.
   *
   *  IT DECIDES WHICH BUTTON IS PRIMARY, NOT WHICH BUTTONS EXIST. `Mark Done`
   *  is on every actionable card; while a review is waiting it simply is not
   *  the loudest thing in the row. There is no `accepted` check anywhere here,
   *  deliberately: a second condition that happened to agree with the count is
   *  what the whole change removed from the server, and re-deriving it here
   *  would put it back. */
  const planOpenForYou = item.plan?.open_notes_for_you ?? 0

  // REQUEST COST — this is the design, not an optimisation. A folded band
  // issues NO request: the folded row renders entirely from `PlanSummary` and
  // the report stamp, both already on the card off the project list. The desk
  // makes zero plan requests today and at most ONE report request per card
  // here, and only once the user opens that band.
  //
  // WAVE 2 DEPENDS ON THIS INVARIANT HOLDING: the compact `PlanEditor` mounts
  // only while the PLAN band is expanded, so a folded PLAN band costs zero
  // `GET …/plan`. If that is ever removed, a desk of twelve plan-bearing cards
  // fires twelve plan requests on load. It is also why the editor's open signal
  // must be a COUNTER rather than a boolean — an unmounted editor reads it on
  // mount.
  const reportBand = present.includes('report')
  const { data: report } = useProjectReport(
    reportBand && opened.report ? item.projectId : undefined,
  )

  useEffect(() => {
    if (replying) editorRef.current?.focusEnd()
  }, [replying])

  const dest = item.kind === 'project' ? `#${item.sourceName}` : `@${item.agentName}`

  // Play the card's leave animation, then mark the card done: optimistically
  // write the watermark to the store (so useDeskUpdates drops the card) and PUT
  // it to the server, which broadcasts to the owner's other sessions. On a
  // failed PUT the store rolls back — the card reappears — and we toast the
  // error.
  //
  // `dismiss()` is the ONLY caller. That is what makes "Recently done"
  // honest: every row in the read-state store is a Done, never a Send Back.
  const animateOut = (toastMsg: string) => {
    setActed(true)
    onToast(toastMsg)
    window.setTimeout(() => markRead(item, onToast), 340)
  }

  // Send Back does NOT mark the card done and does not animate it away. The POST
  // synchronously creates pending work for the coordinator (a desk reply carries
  // no @mention, so messages.py fills in the project's coordinator as the
  // implicit responder), and the resulting `active_participants` broadcast flips
  // the card's lane to `progress` — the first branch in useDeskUpdates, so it
  // beats every other lane. The card stays on the desk and re-lanes from
  // *Review* to *Working*, which is where the work actually is.
  //
  // A hub thread is written only through the hub send route (the user-message
  // route answers `use_hub_send`), so its Send Back goes there.
  const sendMutation = useMutation({
    mutationFn: async ({ content, files }: { content: string; files: File[] }) => {
      if (item.hubThread) await sendHubDraft(queryClient, item.projectId, content, files)
      else await sendUserMessage(item.projectId, 'user-communication', { content, files })
    },
    onSuccess: () => {
      setReplying(false)
      setText('')
      editorRef.current?.clear()
      clearStagedFiles()
      onToast(`Sent back to ${dest} — @${item.agentName} is on it.`)
    },
    onError: (err: Error) => onToast(err.message || 'Failed to send back'),
  })

  // Drag files onto the reply block → same staging path as the paperclip.
  // Disabled while a send is in flight.
  const { isDragging, dragHandlers } = useFileDropzone({
    onFiles: addFiles,
    disabled: sendMutation.isPending,
  })

  // Send text + staged files atomically. A file-only reply (no text) is allowed,
  // so the guard passes when EITHER text OR at least one file is present.
  const send = () => {
    const content = text.trim()
    if ((!content && files.length === 0) || sendMutation.isPending) return
    // Never ship a half-filled template: pulse the empty blanks and open the
    // first instead of sending "[Deadline]" to an agent.
    if (editorRef.current?.nudgeEmpty()) return
    // No onActStart here: Send Back no longer removes the card, so the cursor
    // never has to recover from it. Freezing the order now would leave a stale
    // snapshot to be consumed by whatever removes the card later.
    sendMutation.mutate({ content, files })
  }

  // <input type=file> → stage picked files, then reset the value so the same
  // file can be re-picked immediately.
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files)
    e.target.value = ''
  }

  // Cancel: drop the draft AND any staged files for this card.
  const cancelReply = () => {
    setReplying(false)
    setText('')
    editorRef.current?.clear()
    clearStagedFiles()
  }

  /**
   * DONE = COMPLETE THE PROJECT, THEN CLEAR THE CARD. Two writes, in that
   * order, and the order is the whole design.
   *
   * The button used to write only the read watermark. The card left the desk,
   * but the project stayed `active` and the ticket chip on any to-do linked to
   * it still read Working — two surfaces on one screen disagreeing about
   * whether the thing was finished. The completion is the missing half.
   *
   * COMPLETE FIRST. `markRead` is what makes the card disappear, and it already
   * rolls back and restores the card if its PUT fails. If the completion ran
   * second and failed, the card would be gone with the chip still reading
   * Working and nothing left on screen to say so. Failing first means the card
   * stays put and the user sees the error.
   *
   * NO KIND GATE. Both `dm` and `project` cards complete — a card is exactly
   * one project (the desk keys them `${projectId}|user-communication`), and the
   * lane gate above already withholds Done from cards whose agents are
   * mid-turn (`progress`) and from history (`read`).
   *
   * Done is not terminal: replying into the thread reactivates the project
   * server-side, which is what the toast promises.
   */
  const completeMutation = useMutation({
    mutationFn: () => completeProject(item.projectId),
    onSuccess: () => {
      // THE 200 IS PROOF, AND IT USED TO BE THROWN AWAY. The response says
      // this project is now `completed`, which is exactly the input the
      // to-do's ticket state is derived from — yet the plate was refreshed
      // ONLY by the `desk_todo_sync` frame the server pushes a moment later.
      // One transport, no fallback: if that frame lands on a socket that is
      // down or reconnecting, the chip keeps reading Working with nothing
      // scheduled to correct it. Invalidating here makes the plate converge on
      // the round trip the client ALREADY made, whatever the socket is doing.
      //
      // Deliberately an invalidate and not a local write of `state`: the field
      // is derived from ALL of a to-do's associations (useTodos: "no verb
      // writes `state`, and none can"), so the browser cannot compute it — a
      // to-do linked to this project AND another still-running one is still
      // Working. Only the server knows that; we just ask it again.
      queryClient.invalidateQueries({ queryKey: ['desk-todos'] })
      onActStart?.(item.projectId) // parity with send() — snapshot before removal
      animateOut('Marked done — cleared from your desk. Reply to reopen.')
    },
    onError: (err: Error) =>
      onToast(err.message || 'Couldn’t mark this done — try again.'),
  })

  /** MARK DONE IS ALWAYS AVAILABLE, and the one thing standing in front of it
   *  is the staged batch.
   *
   *  Open plan notes do NOT hold it back. "I'm finished with this thread" is a
   *  decision the user is entitled to make over the top of unanswered
   *  questions — the coordinator asking something does not oblige an answer,
   *  and the questions survive the completion: replying reopens the project
   *  with every note still open. Withholding the button in that state left a
   *  card with an unconfirmed plan and no way off the desk at all.
   *
   *  A STAGED BATCH IS THE EXCEPTION because it is the only thing here that
   *  cannot come back. See `armedDiscard`: the first press relabels the button
   *  to say what the second one will throw away.
   *
   *  THE RULE LIVES HERE RATHER THAN ONLY IN THE JSX. `DeskPage`'s `x` shortcut
   *  calls straight through the imperative handle, so a question asked only by
   *  a button's label would be skipped entirely by the keyboard — which is why
   *  the arming press also toasts. */
  const dismiss = () => {
    if (!actionable || acted || completeMutation.isPending) return
    if (planSend && !armedDiscard) {
      setArmedDiscard(true)
      const n = planSend.count
      onToast(
        `${n} ${n === 1 ? 'reply is' : 'replies are'} staged and unsent — Mark Done again to discard ${n === 1 ? 'it' : 'them'} and complete the project.`,
      )
      return
    }
    completeMutation.mutate()
  }

  const toggleReply = () => {
    if (!actionable || acted) return
    setReplying((r) => !r)
  }

  /**
   * START REVIEW — NAVIGATION, AND IT CANNOT SEND.
   *
   * The state it exists for is *comments are open and you have decided none of
   * them*: there is nothing to send, so a Send button would be disabled chrome,
   * and `Mark Done` would offer to clear a card whose whole content is
   * unanswered questions. What the user actually needs is to get to the list.
   *
   * It unfolds the PLAN band if it is folded and scrolls the band to the top of
   * the viewport. The comment list is the first thing the editor renders, so
   * landing on the band lands on the list — which is why this does not reach
   * inside the editor for a target it does not own.
   *
   * `setTimeout` rather than a layout effect: the band mounts the editor on
   * this same click, so at call time the element either does not exist or is
   * about to change height under us. One frame is enough and a wrong scroll
   * position is the entire cost of being early.
   */
  const startReview = () => {
    if (!opened.plan) togglePlanBand()
    window.setTimeout(() => {
      rootRef.current
        ?.querySelector('[data-testid="plan-band"]')
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 0)
  }

  useImperativeHandle(
    ref,
    () => ({
      toggleExpand: () => setExpanded((e) => !e),
      toggleReply,
      dismiss,
      forward: () => canForward && setForwarding(true),
      open: () => onOpen(item),
      scrollIntoView: () =>
        rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    }),
    // `completeMutation.isPending` is in the deps because `dismiss` now reads
    // it as its re-entrancy guard: without it the keyboard shortcut would hold
    // a closure that still sees `false` and could fire a second POST.
    // `planSend` and `armedDiscard` join the deps because `dismiss` now reads
    // both: a stale closure would let the keyboard shortcut discard a staged
    // review on the first press, which is the one thing the arming step exists
    // to stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item, isProgress, acted, completeMutation.isPending, planSend, armedDiscard, canForward],
  )

  /** `Mark Done` IS ONE BUTTON WITH TWO HOMES IN THE ROW, not two buttons. It
   *  leads when there is nothing else to do and trails `Reply Back` otherwise,
   *  so it is never the neighbour of the primary it used to be mistaken for —
   *  written once here and placed twice below, because a row is an order and
   *  order is not something a className can express. */
  const donePrimary = !planSend && planOpenForYou === 0
  const markDoneButton = (
    <button
      className={donePrimary ? 'md-btn md-btn--primary' : 'md-btn'}
      data-testid="card-mark-done"
      onClick={dismiss}
      disabled={completeMutation.isPending}
    >
      <Check size={14} />
      {armedDiscard ? `Discard ${planSend?.count ?? 0} & mark done` : 'Mark Done'}
    </button>
  )

  return (
    <div
      ref={rootRef}
      className={
        'md-card md-card--' +
        item.lane +
        // Carrier 1 of 5. The red left rule is what replaces the reference
        // design's promotion-to-focus, scanning-wise: it is visible in the feed
        // before the card is opened.
        (offContract ? ' md-card--urgent' : '') +
        (acted ? ' md-card--acted' : '') +
        (selected ? ' md-card--selected' : '') +
        // Never set by this card for ITSELF: hovering card A lights A's
        // to-dos, not A's neighbours. The desk only ever hands `linked` back
        // down to the OTHER side of the pair.
        (linked ? ' md-card--linked' : '')
      }
      onMouseEnter={onHover ? () => onHover(item.projectId) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <div className="md-card-h">
        <div className="md-card-title">{item.title}</div>
        <span className="md-when">{relativeShort(item.ts)}</span>
      </div>

      <div className="md-card-by">
        <Avatar
          name={item.agentName}
          status={(item.agent?.status as AgentStatus) ?? undefined}
          size="xs"
        />
        {item.agent ? (
          <AgentNameLink agentName={item.agent.name} className="md-card-agent">
            @{item.agentName}
          </AgentNameLink>
        ) : (
          <span className="md-card-agent">@{item.agentName}</span>
        )}
      </div>

      {/* Whenever the rail renders it is the first element under the byline and
          it never moves. The rail being the fixed thing is what makes an omitted
          band read as an omission rather than as a missing card — and its third
          step, `is-next` and un-filled, is already the "no report yet"
          affordance, which is why an absent REPORT band needs no placeholder.
          A DM (`plan === null`) renders no rail at all: it has no plan to be
          missing, so the card starts straight at its response band. */}
      <PhaseRail plan={item.plan} hostName={item.agentName} offContract={offContract} />

      {item.files.length > 0 && item.lane !== 'report' && (
        <div className="md-card-files">
          {item.files.map((f, i) => (
            <DeskFilePill
              key={f.filename}
              filename={f.filename}
              entryType={f.entryType}
              onOpen={() => setOpenFileIdx(i)}
            />
          ))}
        </div>
      )}
      {/* Portaled over the desk, for the card's user-communication room — the
          room every desk card is anchored to (deskRoomKey). */}
      {openFile && openFileIdx !== null &&
        createPortal(
          <FileViewerModal
            projectId={item.projectId}
            chatroomName="user-communication"
            filename={openFile.filename}
            untrusted={untrusted}
            onClose={() => setOpenFileIdx(null)}
            nav={{
              index: openFileIdx,
              total: item.files.length,
              onPrev: () => setOpenFileIdx(openFileIdx - 1),
              onNext: () => setOpenFileIdx(openFileIdx + 1),
            }}
          />,
          document.body,
        )}

      {/* THE THREE BANDS, FIXED ORDER, EVERY CARD: report, plan, response.
          `bandsPresent` is the only thing that decides which of them render, so
          the order cannot be re-derived per lane or per phase. */}
      {present.map((id) => {
        if (id === 'report') {
          return (
            <CardBand
              key="report"
              id="report"
              expanded={!!opened.report}
              onToggle={() => toggleBand('report')}
              label="Report"
              definition="the outcome, measured against the Plan — no action needed, just your read"
              rev={<span className="md-cs-rev mono">{shortStamp(item.reportPublishedAt)}</span>}
              foldMeta={report?.title || 'the completion report'}
              foldCta="Read"
            >
              {report ? (
                <div className="max-h-[420px] overflow-y-auto scrollbar-thin rounded-md border border-[var(--line-2)] px-3 py-2.5">
                  <RenderBody
                    renderCodeJs={report.render_code_js}
                    data={report.data}
                    runKey={`${item.projectId}::${report.generated_at}`}
                    active
                  />
                </div>
              ) : (
                <div className="md-cs-def">Loading the report…</div>
              )}
            </CardBand>
          )
        }

        if (id === 'plan') {
          const fold = planFoldMeta(item.plan!)
          return (
            <CardBand
              key="plan"
              id="plan"
              expanded={!!opened.plan}
              onToggle={togglePlanBand}
              // Carrier 3 of 5 — and `tone` is set from the deviation predicate
              // and from nothing else. A merely-waiting card is `attn`, never
              // red; nothing missing is ever red.
              tone={fold.tone}
              label="Plan · the contract"
              definition="what you and the agents agreed to build — every deviation comes back here for your call"
              foldMeta={fold.meta}
              foldCta={fold.cta}
            >
              <PlanBand
                plan={item.plan}
                projectId={item.projectId}
                // The editor mounts ONLY here. `CardBand` renders no children
                // while folded, so this is belt-and-braces at one call site
                // rather than a second source of truth — and it is what keeps
                // a twelve-card desk at one `GET …/plan` instead of twelve.
                expanded={!!opened.plan}
                openSignal={planOpenSignal}
                // THE CARD DRAWS THE SEND. Passing this is also what tells the
                // editor to stop drawing its own — one primary per card.
                onSendState={setPlanSend}
                // NO `onOpenEditor`. The band's `Open the full Plan` button is
                // gone: it NAVIGATED to `…?tab=plan`, unmounting this card and
                // taking the user out of the desk, on cards where the in-band
                // editor was already mounted directly below it. The one thing
                // the tab still had that the band did not was the acceptance
                // strip, which now renders inside `PlanEditor` at both densities.
              />
            </CardBand>
          )
        }

        return (
          <CardBand
            key="response"
            id="response"
            expanded={!!opened.response}
            onToggle={() => toggleBand('response')}
            // Until the agent answers, the newest message is the user's own —
            // calling that a "Response" misreads it as the agent's reply.
            label={item.quoteIsYours || item.quoteFromContact ? 'Request' : 'Response'}
            definition={
              item.quoteIsYours
                ? `what you asked @${item.agentName} — no response yet`
                : item.quoteFromContact
                  ? `what ${item.quoteFromContact} asked @${item.agentName} — no response yet`
                  : `what @${item.agentName} is telling you right now`
            }
            foldMeta={item.quote || 'no message yet'}
            foldCta={item.lane === 'reply' ? 'Answer' : 'Read'}
          >
            {item.quote && (
              <div
                className={
                  'md-card-quote' +
                  (isProgress ? ' md-card-quote--flat' : '') +
                  (!expanded ? ' md-card-quote--clickable' : '')
                }
                onClick={!expanded ? () => setExpanded(true) : undefined}
              >
                <MarkdownBody
                  content={item.quote}
                  untrusted={untrusted}
                  clampable
                  collapsed={!expanded}
                  onToggle={() => setExpanded((e) => !e)}
                  collapsedHeightPx={120}
                />
              </div>
            )}
          </CardBand>
        )
      })}

      {/* THE LIVE METER. `.md-prog` is a SIBLING of the card body, not a child
          of the Response band, so band fold state suppresses nothing — which is
          why the gate is the halted conjunction itself rather than a layout
          outcome. A gated card draws the static held line in the PLAN band
          instead, and this is a stronger guarantee than suppression-by-fold:
          it is one boolean, at one display site. */}
      {isProgress && !gated && (
        <div className="md-prog">
          <span className="md-prog-dot" />
          <span className="md-prog-lbl">Your team is on it</span>
        </div>
      )}

      {/* THE ACTION ROW — EVERY ACTION IS ALWAYS THERE; WHAT MOVES IS WHICH ONE
          IS PRIMARY, and the rule that decides is a single sentence: **the
          primary is the next thing to do.**

            rows staged        -> Send review · N   | Reply Back · Mark Done
            comments open      -> Start review      | Reply Back · Mark Done
            nothing open       -> Mark Done         | Reply Back

          WHY PROMOTION RATHER THAN WITHHOLDING. The complaint this answers is
          that a user who has just replied to four agent comments reads `Done`
          as the next step — a reasonable reading, because `Done` was where the
          eye ended up: it was the primary, it never moved, and `Send review`
          was inside a box that scrolls with the card. Both halves of that are
          fixed by the review's own button being the primary in this row. Taking
          `Mark Done` off the card as well solved the same complaint twice, and
          charged for it: a user who wants a thread off their desk while the
          coordinator has questions open had no button at all, on the one card
          type that always has a question open.

          So it stays, demoted, and it sits AFTER `Reply Back` — the far end of
          the row from the primary — so the two are never adjacent under a
          thumb. When nothing is open it takes the primary slot, which is the
          first render site below rather than a style swap in place.

          The one press it does not honour immediately is with a batch staged:
          see `armedDiscard`. Nothing else here is lossy — completing is undone
          by replying, and an unanswered note is still open when the project
          reopens.

          `Done` IS NOW `Mark Done` and `Send Back` IS NOW `Reply Back`. The
          first because the button removes the card and does not complete the
          work, and "Done" is a review word on a screen full of review; the
          second because it opens a free-text reply, so "send back" oversold it
          as a routing decision competing with the user's actual review — and at
          22 characters `Reply to @some-coordinator` broke the row on a phone.
          `Reply Back` holds the line beside `Send review · 4` at 330px. */}
      <div className="md-actions">
        {actionable && !acted && donePrimary && markDoneButton}
        {actionable && !acted && planSend && (
          <button
            className="md-btn md-btn--primary"
            data-testid="card-send-review"
            disabled={planSend.submitting}
            onClick={planSend.submit}
          >
            <Send size={14} />
            {planSend.submitting ? 'Sending…' : `Send review · ${planSend.count}`}
          </button>
        )}
        {actionable && !acted && !planSend && planOpenForYou > 0 && (
          <button
            className="md-btn md-btn--primary"
            data-testid="card-start-review"
            onClick={startReview}
          >
            <ArrowUp size={14} />
            Start review
          </button>
        )}
        {actionable && !acted && (
          <button className="md-btn" data-testid="card-reply-back" onClick={toggleReply}>
            <ArrowLeft size={14} />
            Reply Back
          </button>
        )}
        {actionable && !acted && !donePrimary && markDoneButton}
        {/* History cards are Open-only, with one exception: distilling a
            finished project into a reusable SOP is additive — it removes
            nothing from the desk and re-marks nothing done — so it is the one
            action the read lane carries. Rendered before "Open project" so the
            row reads [Save as SOP] [Open project]. */}
        {isRead && onSaveAsSop && (
          <button className="md-btn" onClick={() => onSaveAsSop(item)}>
            <FileText size={14} />
            Save as SOP
          </button>
        )}
        {canForward && (
          <button className="md-btn" data-testid="card-forward" onClick={() => setForwarding(true)}>
            <CornerUpRight size={14} />
            Forward
          </button>
        )}
        <button className="md-btn md-btn--ghost" onClick={() => onOpen(item)}>
          Open {item.kind === 'project' ? 'project' : 'thread'}
          <ArrowRight size={13} />
        </button>
      </div>

      {forwarding && canForward && item.latestMessageId && (
        <ForwardModal
          target={{
            projectId: item.projectId,
            chatroomName: 'user-communication',
            messageIds: [item.latestMessageId],
            // An outside contact's words are forwarded under their name, never
            // re-attributed to the agent fielding the thread.
            senderName: item.quoteFromContact ?? item.agentName,
            senderId: item.quoteFromContact ? undefined : item.agent?.id,
            content: item.quote,
            files: item.files.map((f) => f.filename),
            untrusted,
          }}
          onClose={() => setForwarding(false)}
          onSent={(names) => onToast(`Forwarded to ${names.join(', ')}`)}
        />
      )}

      {replying && (
        <div className="md-reply relative" {...dragHandlers}>
          <DropOverlay visible={isDragging} />
          <div className="md-reply-to">
            <Avatar name="You" size="xs" />
            <span>you</span>
            <ArrowRight size={11} />
            <span className="md-reply-dest">{dest}</span>
          </div>
          {/* No `agents` prop: a desk reply has no roster context, so an
              `{{X|agent}}` blank degrades to free-text entry — right here. */}
          <PromptEditor
            ref={editorRef}
            className="md-reply-in"
            minHeight={56}
            maxHeight={160}
            placeholder={`Reply to @${item.agentName}…`}
            disabled={sendMutation.isPending}
            onChange={(t) => setText(t)}
            onSubmit={send}
          />
          <StagedAttachments
            files={stagedFiles}
            onRemove={removeStagedFile}
            disabled={sendMutation.isPending}
          />
          {attachmentError && <p className="md-reply-err">{attachmentError}</p>}
          <div className="md-reply-bar">
            <span className="md-reply-hint">
              Drop files or attach · <kbd>⌘</kbd>
              <kbd>↵</kbd>
            </span>
            <div className="md-reply-actions">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                className="md-reply-attach"
                title="Attach file"
                disabled={sendMutation.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={14} />
              </button>
              <button className="md-btn md-btn--quiet" onClick={cancelReply}>
                Cancel
              </button>
              <button
                className="md-btn md-btn--primary"
                disabled={(!text.trim() && stagedFiles.length === 0) || sendMutation.isPending}
                onClick={send}
              >
                <Send size={13} />
                command
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

export default UpdateCard

// Desk-styled file pill; the card owns the FileViewerModal it opens. Click
// stops propagation so it doesn't also toggle the card's expand-on-click quote.
function DeskFilePill({
  filename,
  entryType,
  onOpen,
}: {
  filename: string
  entryType: DeskFile['entryType']
  onOpen: () => void
}) {
  const action = entryType === 'file_created' ? 'created' : 'updated'
  return (
    <button
      type="button"
      className="md-file-pill"
      title={`${action}: ${filename} — click to view`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
    >
      <FileText size={12} />
      <span className="truncate">{filename}</span>
    </button>
  )
}

// The REPORT band's mono trailer: when the report was published. A pass-through
// of the stamp the project list already carries — the band is present because
// that stamp is non-null, so printing it says nothing the presence did not
// already earn.
function shortStamp(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Terse relative label (mirrors formatRelativeTime but always includes the "ago"
// framing the design uses on cards).
function relativeShort(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''
  const sec = Math.floor((Date.now() - then) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

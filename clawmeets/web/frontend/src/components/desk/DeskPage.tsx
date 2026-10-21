import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, CheckCheck, Inbox, Info, PanelRightOpen } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useUIStore } from '../../stores/uiStore'
import { useDeskStore } from '../../stores/deskStore'
import { selectHover, useDeskLinkStore } from '../../stores/deskLinkStore'
import { useDeskUpdates, type DeskUpdate } from '../../hooks/useDeskUpdates'
import { useDeskRecentlyDone } from '../../hooks/useDeskRecentlyDone'
import { useAgents } from '../../hooks/useAgents'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { useDeskDispatch } from '../../hooks/useDeskDispatch'
import { useTodos } from '../../hooks/useTodos'
import { useDeskTour } from '../../hooks/useDeskTour'
import { resolveSopRecipient } from '../../utils/sopRecipient'
import { buildSopRequestMessage, buildSopScheduleMessage } from '../../utils/sopRequest'
import { draftRecipientResolves, resolveTodoRecipient } from '../../utils/todoDraft'
import { buildAttachmentDesiredState } from '../../utils/todoAttachments'
import { resolveLinkedPair, type DeskHover } from '../../utils/deskLinks'
import { isHubRecipient, recipientId, type DeskRecipient } from '../../utils/deskRecipient'
import type { TrayEntry } from '../../hooks/useMessageAttachments'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import type { DeskSop } from '../../api/endpoints/deskSops'
import type { AgentCard, User } from '../../types'
import ResizeHandle from '../common/ResizeHandle'
import Overlay from '../common/Overlay'
import UpdateCard, { type UpdateCardHandle } from './UpdateCard'
import DeskSideRail from './DeskSideRail'
import DeskComposer, { type DeskComposerHandle } from './DeskComposer'
import DeskZeroState from './DeskZeroState'
import DeskWelcomeTour, { type TourModelAgent } from './DeskWelcomeTour'
import SaveTodoModal, { suggestTodoName } from './SaveTodoModal'
import './desk.css'

/**
 * The desk's default recipient: the user's own assistant, else any agent they
 * own, else nothing.
 *
 * Hoisted out of the mount effect because the composer's ✕ reset needs the SAME
 * answer synchronously — routing that reset through `null` and waiting for the
 * effect to re-pick would flash the "@agent" fallback in the pill for a frame,
 * and would leave the two callers free to drift apart.
 */
/**
 * The first starter to-do every account is seeded with
 * (`models/desk_todo.py:ONBOARDING_SEED_ID`). The welcome tour's last button
 * loads it into the command box.
 */
const ONBOARDING_TODO_ID = 't-seed-onboarding-know-me'

/**
 * Model agents by short name, with the label the welcome tour prints under
 * each. The names are fixed at install (`models/provider_agents.py`), which is
 * what lets the tour name only the ones this owner actually has.
 */
const MODEL_AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  claude_api: 'Anthropic API',
  openai_api: 'OpenAI API',
  gemini_api: 'Gemini API',
  openrouter: 'OpenRouter',
}

function ownModelAgents(agents: AgentCard[] | undefined, user: User | null): TourModelAgent[] {
  if (!user) return []
  const prefix = `${user.username}-`
  return (agents ?? [])
    .filter((a) => a.registered_by === user.id && a.name.startsWith(prefix))
    .map((a) => a.name.slice(prefix.length))
    .filter((name) => name in MODEL_AGENT_LABELS)
    .slice(0, 3)
    .map((name) => ({ name, label: MODEL_AGENT_LABELS[name] }))
}

function defaultRecipientId(agents: AgentCard[] | undefined, user: User | null): string | null {
  const all = agents ?? []
  const assistantName = user ? `${user.username}-assistant` : ''
  return (
    all.find((a) => a.name === assistantName)?.id ??
    all.find((a) => a.registered_by === user?.id)?.id ??
    null
  )
}

interface SectionProps {
  id: string
  icon?: React.ReactNode
  live?: boolean
  title: string
  hint: string
  count?: number
  children: React.ReactNode
}

function DeskSection({ id, icon, live, title, hint, count, children }: SectionProps) {
  return (
    <section className="md-sec" id={id}>
      <div className="md-sec-h">
        {live ? <span className="md-live-dot" /> : <span className="md-sec-ic">{icon}</span>}
        <h2 className="md-sec-t">{title}</h2>
        {count != null && <span className="md-sec-c">{count}</span>}
        <span className="md-sec-hint">{hint}</span>
        <span className="md-sec-line" />
      </div>
      {children}
    </section>
  )
}

export default function DeskPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { rightPanelWidth, setRightPanelWidth, isMobileRightPanelOpen, openMobileRightPanel, closeMobileRightPanel, setRailContext, setProjectExpanded } =
    useUIStore()
  const {
    scrollTarget,
    clearScroll,
    focusCardId,
    clearCardFocus,
    pendingSop,
    clearPendingSop,
    pendingTask,
    clearPendingTask,
  } = useDeskStore()

  const { updates, counts, ready } = useDeskUpdates()
  const {
    cards: recentlyDone,
    lastSignedOffAt,
    isLoading: signedOffLoading,
  } = useDeskRecentlyDone()
  const { data: agents } = useAgents()
  const { dispatchToAgent, confirmText, linkFailedText } = useDeskDispatch()
  const { todos, captureWithDraft, saveDraft, linkProject } = useTodos()

  // The desk's one transient channel — confirmations AND the refusals that are
  // already written for this screen (a recipient who went away, a link that did
  // not land). Two knobs, both of which exist because one caller needed them:
  //
  //  - `tone` picks the glyph. The green check is a CLAIM, and putting it
  //    beside "this didn't get linked" is the same small lie this milestone's
  //    sibling spent a criterion removing from the Archived drawer.
  //  - `ms` because 2.4 seconds is the right window for "Sent." and the wrong
  //    one for a sentence carrying a command the owner is meant to read.
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'warn' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const flash = (msg: string, opts?: { tone?: 'ok' | 'warn'; ms?: number }) => {
    setToast({ msg, tone: opts?.tone ?? 'ok' })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), opts?.ms ?? 2400)
  }

  // Free-form composer recipient — defaults to the user's assistant, then any
  // owned agent. Editable via the composer's recipient picker. Hold only the
  // recipient's id and derive the live card from the agents cache (like
  // DMChatView) so any ['agents'] invalidation — e.g. ModelSelector's PUT →
  // ['agents'] refetch — re-renders the composer with fresh local_settings
  // instead of a frozen snapshot. A retained agent of another server is held
  // by its hub id and derived from the retained list the same way.
  const { data: retained } = useRetainedAgents()
  const [deskRecipientId, setDeskRecipientId] = useState<string | null>(null)
  const deskRecipient = useMemo<DeskRecipient | null>(
    () =>
      (agents ?? []).find((a) => a.id === deskRecipientId) ??
      (retained ?? []).find((r) => !r.is_local && r.state === 'active' && r.hub_agent_id === deskRecipientId) ??
      null,
    [agents, retained, deskRecipientId],
  )
  // What a saved to-do draft names as its recipient. A to-do resolves its
  // recipient against this server's agents, so an agent of another server is
  // not saved: the draft reopens on the default recipient instead.
  const draftRecipient =
    deskRecipient && !isHubRecipient(deskRecipient) ? { id: deskRecipient.id, name: deskRecipient.name } : null
  useEffect(() => {
    if (deskRecipientId) return
    const pick = defaultRecipientId(agents, user ?? null)
    if (pick) setDeskRecipientId(pick)
  }, [agents, user, deskRecipientId])

  // Imperative handle on the desk composer so the zero-state's sample cards can
  // prefill the message box in place (instead of navigating to the assistant DM).
  const composerRef = useRef<DeskComposerHandle>(null)

  // Which to-do the message box is bound to — what "Save to-do" writes back to
  // and which row stays lit on the plate. Held as an ID and derived from the
  // live ['desk-todos'] cache (the deskRecipientId → deskRecipient pattern), so
  // the binding self-clears when the item is archived or trashed and the
  // head chip can never name a to-do that no longer exists.
  const [boundTodoId, setBoundTodoId] = useState<string | null>(null)
  const boundTodo = useMemo<DeskTodo | null>(
    () => todos.find((t) => t.id === boundTodoId && !t.archived) ?? null,
    [todos, boundTodoId],
  )

  // Draft source AND tray held while SaveTodoModal asks for a name — non-null
  // only for the first save of an unbound box.
  //
  // The tray is parked HERE rather than re-read from the composer after the
  // modal closes, because the box stays live behind the dialog: what gets saved
  // must be what was on screen when Save was pressed.
  const [namingDraft, setNamingDraft] = useState<{
    source: string
    tray: TrayEntry[]
  } | null>(null)
  // The composer's Save promise, held open across the modal round trip. The
  // create only happens after a name comes back, and the button has to stay
  // pending until it does — or resolve on cancel, or it would hang forever.
  const namingSettle = useRef<{
    resolve: () => void
    reject: (err: unknown) => void
  } | null>(null)

  // Rail → composer. The rail is a sibling <aside> in this same render (see
  // below), so a lifted pair + the composer ref crosses the gap — no need for
  // `deskStore`, which exists only for the Sidebar tree it can't reach into.
  const [sopSource, setSopSource] = useState<{ id: string; title: string } | null>(null)
  const handleUseSop = (sop: DeskSop, recipient: AgentCard | null) => {
    if (recipient) setDeskRecipientId(recipient.id)
    setSopSource({ id: sop.id, title: sop.title })
    composerRef.current?.loadTemplate(sop.body)
  }

  // ⌘K → desk. The palette sits in the Sidebar tree and can't reach the
  // composer, so it parks the SOP on `deskStore` and navigates here; we adopt it
  // through the same handler a rail click uses. Gated on `agents` so the
  // recipient resolves against a real roster instead of degrading to null on a
  // cold /desk mount — the composer would otherwise keep its default recipient
  // while showing the SOP's body.
  useEffect(() => {
    if (!pendingSop || !agents) return
    handleUseSop(pendingSop, resolveSopRecipient(pendingSop, agents, user ?? null))
    clearPendingSop()
    // handleUseSop is deliberately out of the deps: it's re-created every render,
    // and the parked request — not the handler identity — is the trigger.
  }, [pendingSop, agents, user, clearPendingSop])

  // Rail row → message box. Sibling of handleUseSop above, with one ordering
  // rule: load the draft FIRST and bind only if it actually landed, so a user
  // who answers "no" to the replace-your-draft confirm doesn't end up with a
  // chip naming a to-do whose text was never written.
  //
  // Deliberately NOT done here: no dispatch, no delete, no toggle, no PATCH.
  // Clicking a row issues no request at all. Because filling a box is not a
  // commitment the way a send is, an addressed-but-departed recipient only
  // warns and leaves the pill alone — the text still lands.
  const handleUseTodo = (t: DeskTodo) => {
    // The whole record goes in: the composer reads the attachment metadata off
    // the record rather than off extra positionals.
    const loaded = composerRef.current?.loadTodoDraft(t.draft_prompt || t.text, t)
    if (!loaded) return

    const addressed = !!(t.draft_recipient_id || t.draft_recipient_name)
    if (addressed && agents && !draftRecipientResolves(t, agents)) {
      flash(`${t.draft_recipient_name || 'That agent'} is no longer available — pick someone else.`)
    } else {
      const rec = resolveTodoRecipient(t, agents, user ?? null)
      if (rec) setDeskRecipientId(rec.id)
      // Two toasts, because the box now holds two different things. A drafted
      // row restores a message. An undrafted one falls back to the TITLE above
      // — a seed the user is meant to write over — and "Loaded … then command"
      // would claim a draft came back that never existed.
      flash(
        t.drafted
          ? `Loaded “${t.text}” — edit it, then command.`
          : `Started a draft for “${t.text}” — write it, then Save to-do.`,
      )
    }
    setBoundTodoId(t.id)
    // Put the box the row just filled in front of the user. On desktop the
    // rail and the box share the screen, so scrolling the pane to the top is
    // the whole job. On mobile the rail is an overlay ON TOP of that pane —
    // loading a draft behind it looked like the click did nothing, and the
    // user had to know to dismiss the rail to find their own text. Closing it
    // here is the same "reveal what I just loaded" gesture as the scroll, and
    // it is a no-op on desktop, where the aside is `lg:translate-x-0`
    // regardless of this flag.
    closeMobileRightPanel()
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // "Save to-do". Bound → straight to that item, no dialog, and its title is
  // left alone even if the draft's first line has changed: renaming is the
  // plate's job, not a side effect of saving a draft. Unbound → ask for a name
  // once, then bind, so the very next press saves in place.
  //
  // `source` is the editor's getSource(): unfilled {{blanks}} round-trip as
  // blanks, so a saved draft stays a template.
  //
  // Both branches end the same way: await the write, then hand the reconciled
  // descriptors back so the tray's new chips take their server ids. Until that
  // flip happens a second press would re-upload the same bytes.
  //
  // A refused write propagates to the composer, which renders the server's
  // `detail` under the box — the toast is for success only, because a
  // one-line "couldn't save" would throw away a sentence that names the file
  // and the limit it breached.
  const handleSaveTodo = async (source: string, tray: TrayEntry[]): Promise<void> => {
    if (boundTodo) {
      const attachments = await buildAttachmentDesiredState(tray)
      const saved = await saveDraft(
        boundTodo.id,
        source,
        draftRecipient,
        attachments,
      )
      composerRef.current?.adoptSavedAttachments(saved.attachments ?? [])
      flash(`Saved to “${boundTodo.text}”.`)
      return
    }
    return new Promise<void>((resolve, reject) => {
      namingSettle.current = { resolve, reject }
      setNamingDraft({ source, tray })
    })
  }

  const handleConfirmSaveTodo = async (name: string) => {
    const parked = namingDraft
    const settle = namingSettle.current
    namingSettle.current = null
    setNamingDraft(null)
    try {
      const attachments = await buildAttachmentDesiredState(parked?.tray ?? [])
      const created = await captureWithDraft(
        name,
        parked?.source ?? '',
        draftRecipient,
        attachments,
      )
      setBoundTodoId(created.id)
      composerRef.current?.adoptSavedAttachments(created.attachments ?? [])
      flash(`Saved “${created.text}” to your plate.`)
      settle?.resolve()
    } catch (err) {
      settle?.reject(err)
    }
  }

  // Cancelling the name dialog is not a failure — nothing was written and the
  // box is untouched — but the Save promise still has to settle or the button
  // stays disabled for the rest of the session.
  const handleCancelSaveTodo = () => {
    namingSettle.current?.resolve()
    namingSettle.current = null
    setNamingDraft(null)
  }

  // ⌘K → desk. Sibling of the pendingSop effect above: the palette can't reach
  // the composer either, so it parks the record on the same bus and we adopt it
  // through the same handler a rail click uses. Gated on `agents` for the same
  // reason the SOP path is — handleUseTodo resolves the recipient itself, and
  // on a cold /desk mount an empty roster would resolve to nobody.
  useEffect(() => {
    if (!pendingTask || !agents) return
    handleUseTodo(pendingTask)
    clearPendingTask()
    // handleUseTodo is deliberately out of the deps — see the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTask, agents, clearPendingTask])

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Rail-panel → main-pane: scroll to a section when requested.
  useEffect(() => {
    if (!scrollTarget) return
    const c = scrollRef.current
    const el = c?.querySelector('#' + scrollTarget) as HTMLElement | null
    if (c && el) c.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' })
    clearScroll()
  }, [scrollTarget, clearScroll])

  // `tab` is the surface to land on inside the destination — omitted for the
  // ordinary "Open project", `'plan'` for a card's PLAN band release control,
  // which must land on the document the user's answer is owed to rather than on
  // the project's activity feed.
  const openThread = (item: DeskUpdate, tab?: 'plan') => {
    // In-app rail clicks own the rail context (Sidebar syncs from the URL only
    // on mount), so switch to the destination's tab as we navigate.
    setRailContext(item.kind === 'project' ? 'projects' : 'dms')
    // Reveal the project's rooms in the Projects panel, like a sidebar click.
    if (item.kind === 'project') setProjectExpanded(item.projectId, true)
    navigate(tab ? `${item.navTo}?tab=${tab}` : item.navTo)
  }

  // "Review" is one section over two lanes — replies first, then reports, so
  // the thing an agent is literally waiting on stays at the top of the desk.
  const toReview = useMemo<DeskUpdate[]>(
    () => [
      ...updates.filter((u) => u.lane === 'reply'),
      ...updates.filter((u) => u.lane === 'report'),
    ],
    [updates],
  )
  const working = useMemo<DeskUpdate[]>(
    () => updates.filter((u) => u.lane === 'progress'),
    [updates],
  )

  // Keyboard selection over the flat, in-display-order card list (Review →
  // Working). Cards register an imperative handle so shortcuts can drive their
  // own behaviors (expand/reply/sign-off/open). "Recently done" is history,
  // not a queue — it carries no removing actions, so it stays out of the cursor.
  // Its cards share `cardRefs` (keyed by projectId), which is safe only because
  // useDeskRecentlyDone drops any project that is also live — otherwise the
  // historical twin, rendered last, would overwrite the live card's handle.
  const flat = useMemo<DeskUpdate[]>(() => [...toReview, ...working], [toReview, working])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const cardRefs = useRef(new Map<string, UpdateCardHandle>())
  const prevFlatRef = useRef<DeskUpdate[]>(flat)

  // Order the user was looking at at the instant they acted on the selected card.
  // Set synchronously by captureRecovery(); consumed once by the recovery effect
  // when the card actually leaves `flat`. Trustworthy because it predates the
  // reply's async re-sort / lane-flip.
  const frozenOrderRef = useRef<DeskUpdate[] | null>(null)

  // Called by a card the moment a removing action commits (command / Done / x).
  // Only snapshots when the acted card IS the current cursor — otherwise removing
  // a non-selected card never moves the cursor, so there is nothing to recover.
  const captureRecovery = (projectId: string) => {
    if (projectId !== selectedId) return
    frozenOrderRef.current = flat // current committed, pre-reorder order
  }

  // When the focused card leaves the feed (marked read / replied / completed),
  // move focus to the immediate previous still-present card rather than losing
  // the cursor. Falls back to the next card, then to none. Prefer the frozen
  // snapshot captured at action-time over `prevFlatRef`: a reply re-sorts and
  // lane-flips `flat` asynchronously, so prevFlatRef no longer reflects the order
  // the user saw. The snapshot does, giving the neighbor search a trustworthy list.
  useEffect(() => {
    const prevFlat = frozenOrderRef.current ?? prevFlatRef.current
    prevFlatRef.current = flat
    if (!selectedId) {
      frozenOrderRef.current = null
      return
    }
    if (flat.some((u) => u.projectId === selectedId)) return // still present; keep snapshot

    const goneIdx = prevFlat.findIndex((u) => u.projectId === selectedId)
    const present = new Set(flat.map((u) => u.projectId))
    let target: string | null = null
    for (let i = goneIdx - 1; i >= 0; i--) {
      if (present.has(prevFlat[i].projectId)) {
        target = prevFlat[i].projectId
        break
      }
    }
    if (!target) {
      for (let i = goneIdx + 1; i < prevFlat.length; i++) {
        if (present.has(prevFlat[i].projectId)) {
          target = prevFlat[i].projectId
          break
        }
      }
    }
    frozenOrderRef.current = null // consume the snapshot now that recovery ran
    setSelectedId(target)
    if (target) {
      const id = target
      requestAnimationFrame(() => cardRefs.current.get(id)?.scrollIntoView())
    }
  }, [flat, selectedId])

  // Rail-panel sub-row → main-pane: scroll one card into view. Sibling of the
  // `scrollTarget` effect above (which aims at a section heading); this one goes
  // through the `cardRefs` handle map the keyboard cursor already keeps, so it
  // reaches all three sections without any new plumbing on UpdateCard.
  //
  // The click usually arrives from another route, so the request is parked
  // before any card exists. We stay parked and let the effect re-run as the
  // feeds render, then give up once BOTH feeds have settled and still hold
  // nothing with this id — otherwise a stale request would hijack a later
  // render. `signedOffLoading` is part of that gate because a "Recently done"
  // row's card comes from the other query, which can land after `ready`.
  //
  // Selection is set only for cards in `flat`: "Recently done" is
  // deliberately outside the keyboard cursor, and the recovery effect above
  // reads "selected but not in `flat`" as "this card left the feed" — selecting
  // a historical card would bounce the cursor to a neighbour.
  useEffect(() => {
    if (!focusCardId) return
    const handle = cardRefs.current.get(focusCardId)
    if (handle) {
      if (flat.some((u) => u.projectId === focusCardId)) setSelectedId(focusCardId)
      handle.scrollIntoView()
      clearCardFocus()
      return
    }
    if (ready && !signedOffLoading) clearCardFocus()
  }, [focusCardId, flat, recentlyDone, ready, signedOffLoading, clearCardFocus])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!flat.length) return

      const idx = flat.findIndex((u) => u.projectId === selectedId)
      const selectAt = (i: number) => {
        const u = flat[Math.max(0, Math.min(flat.length - 1, i))]
        setSelectedId(u.projectId)
        requestAnimationFrame(() => cardRefs.current.get(u.projectId)?.scrollIntoView())
      }
      const handle = selectedId ? cardRefs.current.get(selectedId) : undefined

      // Non-empty section start indices within `flat` (Review → Working).
      const lens = [toReview.length, working.length]
      const starts: number[] = []
      let acc = 0
      for (const n of lens) {
        if (n) starts.push(acc)
        acc += n
      }
      const jumpSection = (dir: number) => {
        if (!starts.length) return
        const cur = idx < 0 ? 0 : idx
        let s = 0
        for (let i = 0; i < starts.length; i++) if (starts[i] <= cur) s = i
        selectAt(starts[Math.max(0, Math.min(starts.length - 1, s + dir))])
      }

      switch (e.key) {
        case 'j':
        case 'J':
        case 'ArrowDown':
          e.preventDefault()
          selectAt(idx < 0 ? 0 : idx + 1)
          break
        case 'k':
        case 'K':
        case 'ArrowUp':
          e.preventDefault()
          selectAt(idx < 0 ? 0 : idx - 1)
          break
        case '[':
          e.preventDefault()
          jumpSection(-1)
          break
        case ']':
          e.preventDefault()
          jumpSection(1)
          break
        case ' ':
        case 'e':
        case 'E':
          if (handle) {
            e.preventDefault()
            handle.toggleExpand()
          }
          break
        case 'r':
        case 'R':
          if (handle) {
            e.preventDefault()
            handle.toggleReply()
          }
          break
        case 'f':
        case 'F':
          if (handle) {
            e.preventDefault()
            handle.forward()
          }
          break
        case 'x':
        case 'X':
          if (handle) {
            e.preventDefault()
            handle.dismiss()
          }
          break
        case 'o':
        case 'O':
        case 'Enter':
          if (handle) {
            e.preventDefault()
            handle.open()
          }
          break
        case 'Escape':
          setSelectedId(null)
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [flat, toReview, working, selectedId])

  // ————————————— My Desk ↔ To-do cross-highlight —————————————
  // The join needs no new data — every to-do already carries `project_ids`, and
  // those ids are the same values as a card's `projectId` (DM threads and
  // projects share one id space). The relation is many-to-many, so a hover
  // lights EVERY match on the other side, never just the first.
  //
  // The pointer state lives in `deskLinkStore` rather than in a `useState`
  // here, because the desk is no longer the only view of the pair: the
  // sidebar's `MyDeskRailPanel` draws one sub-row per plated project and is now
  // a full third participant, and it sits in the Sidebar tree, which shares no
  // props with this one. The join itself moved to `utils/deskLinks` for the
  // same reason — one pure function both trees call cannot drift.
  const hover = useDeskLinkStore(selectHover)
  const setHover = useDeskLinkStore((s) => s.setHover)

  // Clear on the way out. `mouseleave` does NOT fire when an element unmounts
  // under the pointer, and opening a card navigates away from exactly that
  // position — so without this, a hover written on the last card touched would
  // outlive the desk and leave its sidebar sub-row lit indefinitely, with
  // nothing on screen able to clear it. Only the desk can own this: it is the
  // surface whose disappearance invalidates the state.
  useEffect(() => () => useDeskLinkStore.getState().reset(), [])

  // The highlight source, widened to include the KEYBOARD cursor — arrowing to
  // a card lights its to-dos exactly as hovering it does. The pointer wins when
  // both are live, being the more recent intent. Memoized so the derived sets
  // below keep a stable identity across renders that changed neither input.
  //
  // DELIBERATELY NOT PUBLISHED TO THE STORE. `selectedId` is this page's own
  // keyboard cursor, so the widening is this page's own; the sidebar panel
  // reads the raw pointer hover and stays dark while you arrow through the
  // feed. Mirroring `selectedId` into the store would mean an effect keeping
  // derived state fresh across trees, which is the shape this refactor exists
  // to avoid — and a rail row lighting from a cursor the rail cannot show is
  // the weaker half of "consistent" anyway.
  const hoverSource = useMemo<DeskHover>(
    () => hover ?? (selectedId ? { side: 'card', projectId: selectedId } : null),
    [hover, selectedId],
  )

  // Every projectId the plate actually RENDERS — the three lists that go
  // through `renderCard`, "Recently done" included, since a historical card
  // wears the mark like any other. Not `flat`: that one is the keyboard
  // cursor's domain and deliberately drops history.
  const platedProjectIds = useMemo<ReadonlySet<string>>(
    () => new Set([...toReview, ...working, ...recentlyDone].map((u) => u.projectId)),
    [toReview, working, recentlyDone],
  )

  // BOTH SIDES OF THE PAIR, from the one pure function the sidebar panel also
  // calls. Every rule it applies — archived rows excluded, the non-empty gate,
  // verbatim `project_ids`, the stricter self-mark — is documented at
  // `utils/deskLinks.ts` and is unchanged from the memo this replaces.
  const { linkedTodoIds, linkedProjectIds } = useMemo(
    () => resolveLinkedPair(hoverSource, todos, platedProjectIds),
    [hoverSource, todos, platedProjectIds],
  )

  // Enter (id) / leave (null). Writing the value already held is a no-op inside
  // the store, so re-entering the element already lit repaints nothing; a leave
  // only ever clears its OWN side of the pair, which is why these read `hover`
  // first rather than clearing unconditionally.
  const handleHoverCard = (projectId: string | null) => {
    if (projectId === null) {
      if (hover?.side === 'card') setHover(null)
      return
    }
    setHover({ side: 'card', projectId })
  }

  const handleHoverTodo = (todoId: string | null) => {
    if (todoId === null) {
      if (hover?.side === 'todo') setHover(null)
      return
    }
    setHover({ side: 'todo', todoId })
  }

  const renderCard = (it: DeskUpdate) => (
    <UpdateCard
      key={it.projectId}
      ref={(h) => {
        const m = cardRefs.current
        if (h) m.set(it.projectId, h)
        else m.delete(it.projectId)
      }}
      item={it}
      onOpen={openThread}
      onToast={flash}
      onActStart={captureRecovery}
      // Gated by lane here rather than inside the card: "history is not a
      // queue" is this page's rule, and it already owns lane semantics.
      onSaveAsSop={it.lane === 'read' ? handleSaveAsSop : undefined}
      selected={it.projectId === selectedId}
      linked={linkedProjectIds.has(it.projectId)}
      onHover={handleHoverCard}
    />
  )

  // The desk's three moves, as a standing tagline. Counts hang off the two
  // steps that own a queue: Working is what your team is on, Review is what
  // is parked on you. `ready` gates them so a hydrating desk shows the flow
  // without flashing a wrong number — the words never move.
  const reviewCount = counts.reply + counts.report

  // First-run onboarding: an untouched desk shows the starter zero-state instead
  // of the caught-up footer. It disappears on its own once the first card lands
  // — no explicit "onboarding done" flag. Having signed anything off also counts
  // as touched, so a cleared desk lands on the footer, not onboarding.
  // `ready` gates it so we don't flash it while read-state is hydrating.
  //
  // The touched test is `lastSignedOffAt` (all-time), NOT the rendered list:
  // that list is capped at five and drops projects that came back to life, so
  // gating on `recentlyDone.length` would hand the first-run onboarding screen
  // back to anyone whose cleared projects have all re-surfaced.
  const isEmpty = updates.length === 0 && recentlyDone.length === 0 && !lastSignedOffAt
  const assistantName = user ? `${user.username}-assistant` : null

  // The welcome tour. It opens on its own exactly once per ACCOUNT — the
  // first desk mount where the server says this account has never closed it —
  // and again whenever the ⓘ beside the heading is pressed. Decided once and
  // latched, so a refetch can't re-open it under someone who just closed it.
  // A failed read never counts as "not seen" (`useDeskTour`'s `ready`).
  const deskTour = useDeskTour()
  const [tourOpen, setTourOpen] = useState(false)
  const [infoPulse, setInfoPulse] = useState(false)
  const tourDecided = useRef(false)
  useEffect(() => {
    if (tourDecided.current || !deskTour.ready) return
    tourDecided.current = true
    if (!deskTour.seenAt) setTourOpen(true)
  }, [deskTour.ready, deskTour.seenAt])

  // Every way out marks it seen and pulses the ⓘ once, so the owner learns
  // where to get it back. Only the last step's "Start with…" also loads the
  // onboarding to-do into the box — through the same handler a rail click
  // uses, so it is highlighted on the rail and nothing is sent.
  const handleCloseTour = (finished: boolean) => {
    setTourOpen(false)
    deskTour.markSeen()
    setInfoPulse(true)
    if (!finished) return
    const starter = todos.find((t) => t.id === ONBOARDING_TODO_ID && !t.archived)
    if (starter) handleUseTodo(starter)
  }

  // Zero-state sample → prefill the desk composer in place. These starters are
  // assistant-onboarding prompts, so point the recipient at the user's assistant
  // if it's in the roster and not already selected, then write the box.
  const handleUseSample = (text: string) => {
    const assistant = (agents ?? []).find((a) => a.name === assistantName)
    if (assistant && deskRecipientId !== assistant.id) setDeskRecipientId(assistant.id)
    composerRef.current?.prefill(text)
  }

  // Hover/focus counterpart to handleUseSample. Pure decoration: it does NOT
  // select a recipient, does NOT touch the draft, and does NOT confirm before
  // replace — the composer discards the ghost by CSS the moment a draft exists.
  const handlePreviewSample = (text: string | null) => {
    composerRef.current?.setGhost(text)
  }

  // "Save as SOP" on a signed-off card → draft the request in the top-of-desk
  // composer rather than in the card. It goes to the user's assistant because
  // that is the only principal `POST /me/desk/sops` accepts (the `desk-sop`
  // skill is assistant-only), and its owner-scoped bearer can still read the
  // card's project even though it never participated in it.
  //
  // `prefill` (setPlain), not `loadTemplate`: the message's `{{…}}` examples
  // are instructions about the blank syntax, not blanks for the user to fill.
  //
  // Deliberately NOT done here: no markRead, no lane change, no navigation —
  // the signed-off card stays exactly where it is, so today's sign-off ordering
  // doesn't shuffle under the user mid-interaction.
  const handleSaveAsSop = (item: DeskUpdate) => {
    const assistant = (agents ?? []).find((a) => a.name === assistantName)
    if (assistant && deskRecipientId !== assistant.id) setDeskRecipientId(assistant.id)
    composerRef.current?.prefill(buildSopRequestMessage(item))
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    flash(
      assistant
        ? `Drafted an SOP request to @${assistant.name} — review it, then command.`
        : 'Drafted an SOP request — pick a recipient, then command.',
    )
  }

  // Rail 🕐 → draft "put this SOP on a cadence" into the composer.
  //
  // Two deliberate departures from handleUseSop: the recipient is forced to the
  // ASSISTANT rather than resolveSopRecipient's answer (the SOP's execution
  // agent can't read the library or call `sop trigger`; only the assistant
  // can), and the body goes through `loadTemplate`, because this message's
  // `{{…}}` ARE blanks the user must fill — a schedule fires unattended, so a
  // value the assistant had to guess would be wrong every day, not once.
  // `sopSource` stays unset: what's in the box is a request about the SOP, not
  // the SOP itself, and the chip would claim otherwise.
  const handleScheduleSop = (sop: DeskSop) => {
    const assistant = (agents ?? []).find((a) => a.name === assistantName)
    if (assistant && deskRecipientId !== assistant.id) setDeskRecipientId(assistant.id)
    composerRef.current?.loadTemplate(buildSopScheduleMessage(sop))
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    flash(
      assistant
        ? `Fill the blanks and the cadence, then command @${assistant.name} to schedule it.`
        : 'Fill the blanks and the cadence, then pick your assistant as recipient.',
    )
  }

  return (
    <div className="flex-1 flex overflow-hidden relative h-full">
      <div className="desk-wrap">
        <div className="md flex-1 min-w-0">
          {/* One scroll region for the whole pane: the title block and the
              command band scroll away with the cards instead of holding ~1/3
              of the viewport open. `.md-scroll` is the positioned ancestor, so
              the section-scroll effect above can keep using `el.offsetTop`. */}
          <div className="md-scroll" ref={scrollRef}>
          <header className="md-top">
            <div className="md-top-row">
              <div>
                <div className="md-h1-row">
                  <h1 className="md-h1">My Desk</h1>
                  <button
                    className={infoPulse ? 'md-h1-info md-h1-info--pulse' : 'md-h1-info'}
                    aria-haspopup="dialog"
                    aria-expanded={tourOpen}
                    aria-label="How My Desk works"
                    title="How My Desk works — replay the tour"
                    onClick={() => {
                      setInfoPulse(false)
                      setTourOpen(true)
                    }}
                    onAnimationEnd={() => setInfoPulse(false)}
                  >
                    <Info size={15} />
                  </button>
                </div>
                {/* Arrows are decorative — screen readers get the three words
                    (and their counts) as a plain list, not "Command right-arrow". */}
                <div className="md-status md-status--flow">
                  <span className="md-status-step">Command</span>
                  <span className="md-status-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="md-status-step">
                    Working
                    {ready && counts.progress > 0 && <b> ({counts.progress})</b>}
                  </span>
                  <span className="md-status-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="md-status-step">
                    Review
                    {ready && reviewCount > 0 && <b> ({reviewCount})</b>}
                  </span>
                </div>
              </div>
              <div className="md-top-actions">
                {/* Mobile-only trigger for the tasks/pulse panel, mirroring the
                    room page's right-panel affordance. */}
                <button
                  className="md-top-icon-btn lg:hidden"
                  onClick={openMobileRightPanel}
                  aria-label="Open tasks and pulse panel"
                  title="Tasks and pulse"
                >
                  <PanelRightOpen size={18} />
                </button>
              </div>
            </div>
          </header>

          <div className="md-cmd-band">
            <DeskComposer
              ref={composerRef}
              // Taller only under the zero state, where hovering an idea ghosts
              // a 3-line preview in. A constant per screen state, not a
              // per-hover change, so the box never resizes under the pointer.
              minHeight={ready && isEmpty ? 76 : undefined}
              recipient={deskRecipient}
              onRecipientChange={(a) => setDeskRecipientId(recipientId(a))}
              sopSource={sopSource}
              onClearSop={() => setSopSource(null)}
              todoSource={
                boundTodo
                  ? { id: boundTodo.id, text: boundTodo.text }
                  : null
              }
              // The binding half only. The item stays on the plate either way —
              // the composer also calls this after a successful send, because
              // sending a to-do's draft is not the same as finishing it. What
              // ELSE gets cleared is the composer's call: a send clears the box
              // itself, and the chip ✕ resets the whole box around this.
              onClearTodo={() => setBoundTodoId(null)}
              // ✕ only. A send deliberately keeps its recipient so the next
              // message can go to the same agent without re-picking.
              onResetRecipient={() => setDeskRecipientId(defaultRecipientId(agents, user ?? null))}
              onSaveTodo={handleSaveTodo}
              // The page owns the link because it owns the toast and the plate
              // hook; the composer owns the id and the token, because it owns
              // the draft they belong to.
              //
              // The thread this returns is the project the to-do is linked to.
              // It was always returned and always discarded here — forwarding
              // it is the whole of AC-3.1, and a to-do worked through this box
              // stays `new` forever without it.
              onDispatch={async (rec, text, files, { todoId, clientThreadKey }) => {
                const thread = await dispatchToAgent(rec, text, files, clientThreadKey)
                if (!todoId) {
                  flash(confirmText(rec, files.length))
                  return { linked: true }
                }
                try {
                  await linkProject(todoId, thread.id)
                  flash(confirmText(rec, files.length))
                  return { linked: true }
                } catch (err) {
                  // NEVER SILENT. A silent failure here leaves the owner
                  // believing the to-do is wired to a thread it will read New
                  // beside forever — the one outcome this path must not
                  // produce. The send is NOT rolled back and must not be: the
                  // message really went out, the sentence says so, and the
                  // to-do staying bound is what lets the owner see which one
                  // did not link.
                  flash(linkFailedText(rec, todoId, thread.id, err), {
                    tone: 'warn',
                    ms: 12000,
                  })
                  return { linked: false }
                }
              }}
            />
          </div>

          <div className="md-body">
          {toReview.length > 0 && (
            <DeskSection
              id="md-to-signoff"
              icon={<Inbox size={15} />}
              title="Review"
              count={toReview.length}
              hint="Mark done, send back in place, or open the thread"
            >
              <div className="md-list">{toReview.map(renderCard)}</div>
            </DeskSection>
          )}

          {working.length > 0 && (
            <DeskSection id="md-working" live title="Working" count={working.length} hint="Your team is on it">
              <div className="md-list">{working.map(renderCard)}</div>
            </DeskSection>
          )}

          {/* Renders at 0 too, so the rail row's mono count and this pane
              always agree — a `0` you can click to nothing reads as a bug.
              Suppressed only under the first-run zero state. */}
          {!isEmpty && (
            <DeskSection
              id="md-signed-off"
              icon={<CheckCheck size={15} />}
              title="Recently done"
              count={recentlyDone.length}
              hint="The last 5 you cleared — open to revisit"
            >
              {recentlyDone.length > 0 ? (
                <div className="md-list">{recentlyDone.map(renderCard)}</div>
              ) : (
                <RecentlyDoneEmpty lastSignedOffAt={lastSignedOffAt} />
              )}
            </DeskSection>
          )}

          {ready && isEmpty ? (
            <DeskZeroState
              onUseSample={handleUseSample}
              onPreviewSample={handlePreviewSample}
            />
          ) : (
            <div className="md-foot">
              That’s your desk. New reports and replies land here as your agents finish.
            </div>
          )}
          </div>
          </div>
        </div>

      </div>

      <Overlay isOpen={isMobileRightPanelOpen} onClose={closeMobileRightPanel} />
      <ResizeHandle side="right" onResize={setRightPanelWidth} />
      <aside
        className={`
          fixed inset-y-0 right-0 z-40 flex-shrink-0
          transform transition-transform duration-300 ease-in-out
          lg:relative lg:translate-x-0 lg:transform-none lg:transition-none lg:z-auto
          ${isMobileRightPanelOpen ? 'translate-x-0' : 'translate-x-full'}
        `}
        style={{ width: rightPanelWidth }}
      >
        <DeskSideRail
          activeTodoId={boundTodo?.id ?? null}
          linkedTodoIds={linkedTodoIds}
          onHoverTodo={handleHoverTodo}
          onUseTodo={handleUseTodo}
          onUseSop={handleUseSop}
          onScheduleSop={handleScheduleSop}
          flash={flash}
        />
      </aside>

      {/* First save of an unbound box: name the item once, then bind to it. */}
      {namingDraft !== null && (
        <SaveTodoModal
          suggested={suggestTodoName(namingDraft.source)}
          onSave={handleConfirmSaveTodo}
          onCancel={handleCancelSaveTodo}
        />
      )}

      {tourOpen && (
        <DeskWelcomeTour modelAgents={ownModelAgents(agents, user ?? null)} onClose={handleCloseTour} />
      )}

      {toast && (
        <div className={`md-toast${toast.tone === 'warn' ? ' warn' : ''}`} role="status">
          {toast.tone === 'warn' ? <AlertTriangle size={15} /> : <Check size={15} />}
          {toast.msg}
        </div>
      )}
    </div>
  )
}

/**
 * Body of the "Recently done" section when nothing qualifies. Says so plainly
 * and, when the user HAS marked things done before, how long ago the last one
 * was — the difference between "everything you cleared has come back to life"
 * and "you've never used this", which is the same distinction `isEmpty` above
 * turns on.
 *
 * No "today": the section is a count, not a day window, so a date claim here
 * would be one the section can't make. "Nothing MARKED done yet", not "Nothing
 * done yet" — the latter reads as a claim about the user rather than about this
 * section. The "Last one …" sentence still fires, because `lastSignedOffAt` is
 * the all-time newest and survives every card being filtered out as live.
 *
 * Styled with the existing `.md-empty` class — no new CSS.
 */
function RecentlyDoneEmpty({ lastSignedOffAt }: { lastSignedOffAt: string | null }) {
  const age = lastSignedOffAt ? lastSignOffAge(lastSignedOffAt) : ''
  return (
    <div className="md-empty">
      Nothing marked done yet.
      {age && <> Last one {age}.</>}
    </div>
  )
}

// "19h ago" / "yesterday" / "on Jan 5" — a phrase that reads after "Last
// one", which formatRelativeTime's bare units ("19h", "yesterday") can't
// do on their own without producing "yesterday ago". Empty string on a value we
// can't parse, so the caller drops the sentence rather than printing a stub.
function lastSignOffAge(iso: string): string {
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''
  const min = Math.floor((Date.now() - then) / 60_000)
  if (min < 60) return `${Math.max(min, 1)}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  return `on ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

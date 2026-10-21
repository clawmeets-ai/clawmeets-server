import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  ChangeEvent,
} from 'react'
import {
  Paperclip,
  Clock,
  Loader2,
  Send,
  Check,
  CheckSquare,
  FileText,
  X,
} from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useAgents } from '../../hooks/useAgents'
import {
  MAX_MESSAGE_ATTACHMENTS_BYTES,
  useMessageAttachments,
  type StagedSeed,
  type TrayEntry,
} from '../../hooks/useMessageAttachments'
import { useFileDropzone } from '../../hooks/useFileDropzone'
import PromptEditor, { type PromptEditorHandle } from '../composer/PromptEditor'
import { isHubRecipient, recipientLabel, type DeskRecipient } from '../../utils/deskRecipient'
import {
  adoptServerIds,
  unsavedAttachmentCount,
} from '../../utils/todoAttachments'
import { ensureOwnDMProject } from '../../api/endpoints/dm'
import {
  cachedTodoAttachment,
  fetchTodoAttachment,
  forgetTodoAttachment,
} from '../../api/endpoints/deskTodoAttachments'
import { ApiError } from '../../api/client'
import type { DeskTodo, DeskTodoAttachment } from '../../api/endpoints/deskTodos'
import Avatar from '../common/Avatar'
import ModelSelector from '../common/ModelSelector'
import DropOverlay from '../common/DropOverlay'
import StagedAttachments from '../chatroom/StagedAttachments'
import ScheduleMessageModal from '../scheduled/ScheduleMessageModal'
import DeskAgentPicker from './DeskAgentPicker'

interface DeskComposerProps {
  /** An agent of this server, or a retained agent of another (DeskRecipient):
   *  the second has no model choice and no own DM to schedule into. */
  recipient: DeskRecipient | null
  onRecipientChange: (agent: DeskRecipient) => void
  /**
   * Dispatch the message. The caller creates/uses a DM thread with `recipient`
   * and sends `text` + `files` atomically.
   *
   * `opts.todoId` is the to-do this box was bound to AT THE MOMENT OF THE
   * PRESS, read before anything clears. `opts.clientThreadKey` is the
   * per-draft idempotency token, so a double-press maps to ONE thread and
   * therefore one association.
   *
   * RESOLVES WITH WHAT ACTUALLY HAPPENED. `linked: false` means the message
   * WENT OUT but the to-do link did not, and the composer keeps the item bound
   * instead of clearing it — which is the whole reason this returns a value.
   * The page cannot re-bind afterwards: the clear fires once the dispatch
   * resolves and would win that race every time.
   *
   * `linked: true` is also what a send with no bound to-do resolves with —
   * there was nothing to link and nothing failed, so the box resets normally.
   */
  onDispatch: (
    recipient: DeskRecipient,
    text: string,
    files: File[],
    opts: { todoId: string | null; clientThreadKey: string },
  ) => Promise<{ linked: boolean }>
  /**
   * The to-do this box is currently bound to — named by a chip in the head.
   * Makes "Save to-do" save in place instead of asking for a name.
   */
  todoSource?: { id: string; text: string } | null
  /**
   * Detach the bound to-do. TWO callers with different surroundings: the chip ✕
   * (which resets the whole box around this call) and a successful send (which
   * has already cleared the box itself). This prop is only the BINDING half —
   * it must not assume which one is calling.
   */
  onClearTodo?: () => void
  /**
   * Put the recipient pill back to the desk's default pick. Called ONLY by the
   * chip ✕ — a send keeps its recipient, so the next message can go to the same
   * agent without re-picking. Absent ⇒ the ✕ leaves the pill alone.
   */
  onResetRecipient?: () => void
  /**
   * "Save to-do" pressed. Receives `getSource()` — unfilled `{{blanks}}` intact,
   * so a saved draft round-trips as a template rather than as "[Label]" — AND
   * the live tray, so the caller can persist the attachments in the SAME
   * request as the draft. One request is what makes the save atomic: there is
   * no upload-then-save window in which bytes exist without a plate row naming
   * them, and therefore no partial-success state to write a message for.
   *
   * Promise-returning, so the button can be held pending until the write
   * settles. It must NOT clear the tray when it resolves: a send clears because
   * the message left, but a save leaves the item bound and its files in the box.
   *
   * Absent ⇒ no button (the box is then send-only).
   */
  onSaveTodo?: (source: string, attachments: TrayEntry[]) => Promise<void>
  /** The SOP this draft came from — shown as a chip in the head. */
  sopSource?: { id: string; title: string } | null
  /** Drop the SOP chip (user dismissed it, or the message went out). */
  onClearSop?: () => void
  /**
   * Override the message box's resting height. The desk zero state passes 76 so
   * a three-line ghost preview fits — as a constant, so the box never resizes
   * on hover.
   */
  minHeight?: number
}

/** Imperative handle so a parent (DeskPage) can write the message box without
 *  lifting the composer's text state out — used by the desk zero-state to prefill
 *  a sample request in place. Mirrors DMChatView's prefill-composer path. */
export interface DeskComposerHandle {
  prefill: (text: string) => void
  /** Load a stored SOP body — its `{{blanks}}` become fillable chips. */
  loadTemplate: (body: string, focus?: boolean) => void
  /** Pass-through to PromptEditor.setGhost — see PromptEditorHandle. */
  setGhost: (text: string | null) => void
  /**
   * Load a to-do into the box: its draft text (as a template) and its stored
   * attachments as chips that fetch their bytes in the background.
   *
   * SYNCHRONOUS, and returns false when the user declined the confirm and
   * nothing was written — the caller must then NOT bind, or the head would name
   * a to-do whose draft isn't in the box. The background fetches it kicks off
   * do not change that: the tray is fully populated before this returns, and
   * only the bytes arrive later.
   *
   * Takes the whole record rather than a fourth positional argument — four
   * positionals is exactly where a wrong-order bug lives. It reads attachment METADATA (id, name, size) only; bytes come from
   * the download route.
   */
  loadTodoDraft: (body: string, todo: DeskTodo) => boolean
  /**
   * After a save resolves, replace the tray with the reconciled server truth:
   * entries that were new uploads flip from `attachmentId: null` to their
   * minted id, everything else is left alone. That flip is what makes a second
   * press of Save a no-op instead of a re-upload. Idempotent.
   */
  adoptSavedAttachments: (stored: DeskTodoAttachment[]) => void
}

/**
 * The one desk message box, at the top of My Desk. Reuses the product chat
 * composer's primitives and styling (`Avatar`, `StagedAttachments`,
 * `useMessageAttachments`, the `rounded-2xl` shell, the accent send button) so
 * it matches `MessageInput`, but targets an arbitrary agent (recipient pill +
 * `DeskAgentPicker`) and dispatches via `onDispatch` instead of a fixed room.
 *
 * It is also where a to-do is worked: clicking a row on the plate loads that
 * item in here (`loadTodoDraft`), the head names it, and **Save to-do** writes
 * the edited draft straight back to it.
 */
const DeskComposer = forwardRef<DeskComposerHandle, DeskComposerProps>(function DeskComposer({
  recipient,
  onRecipientChange,
  onDispatch,
  todoSource = null,
  onClearTodo,
  onResetRecipient,
  onSaveTodo,
  sopSource = null,
  onClearSop,
  minHeight,
}: DeskComposerProps, ref) {
  const { user } = useAuthStore()
  const { data: agents } = useAgents()
  const [text, setText] = useState('')
  const [picking, setPicking] = useState(false)
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  // Send-later: the recipient's own DM project, resolved lazily on click so we
  // can open ScheduleMessageModal against its `user-communication` room.
  const [scheduleProjectId, setScheduleProjectId] = useState<string | null>(null)
  const [resolvingSchedule, setResolvingSchedule] = useState(false)
  const editorRef = useRef<PromptEditorHandle>(null)
  // Mirror of `text` for the imperative handle, which is built with empty deps
  // and would otherwise read a stale draft in the prefill confirm guard.
  const textRef = useRef('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sentTimer = useRef<number | undefined>(undefined)
  // Per-draft idempotency token, minted lazily and ROTATED after a send that
  // linked. The server keys `(user.id, key)`, so every press carrying the same
  // token resolves to the SAME thread — which is how a double-press produces
  // one thread and one association rather than two of each.
  //
  // Rotation is deliberately gated on `linked`: when the message went out but
  // the link did not, HOLDING the key is the recovery path. The next press
  // lands in the same thread and re-attempts the association, and the
  // association route is itself idempotent, so a link that secretly succeeded
  // is a 200 no-op rather than a duplicate.
  const threadKeyRef = useRef<string | null>(null)
  // Synchronous companion to `pending`. Two clicks inside one tick both read
  // the SAME render closure, where `pending` is still false — a ref is written
  // and read in the same tick and closes that window. The token is the durable
  // guard (it survives a reload); this one just stops the second request from
  // being made at all.
  const sendingRef = useRef(false)

  const {
    stagedFiles,
    files,
    addFiles,
    replaceStagedFiles,
    updateStagedFile,
    removeStagedFile,
    clearStagedFiles,
    attachmentError,
    anyLoading,
  } = useMessageAttachments({
    // "per-message" would be a lie on a to-do — same number, same mirrored
    // constant, honest noun.
    overflowMessage: `Attachments exceed the ${Math.round(
      MAX_MESSAGE_ATTACHMENTS_BYTES / (1024 * 1024),
    )} MB limit.`,
  })

  // The imperative handle is built with empty deps, so everything it reads has
  // to come off a ref or it would see the render that first mounted the box.
  const trayRef = useRef<TrayEntry[]>(stagedFiles)
  trayRef.current = stagedFiles
  const todoSourceRef = useRef(todoSource)
  todoSourceRef.current = todoSource

  // What the server was last known to hold for the bound item — set by a load,
  // updated by a save. The difference between this and the tray is what a
  // row-switch would throw away.
  const loadedAttachmentIds = useRef<string[]>([])
  // Monotonic load counter: a background fetch that resolves after a NEWER load
  // is discarded, so clicking two rows quickly can never drop item A's bytes
  // into item B's tray.
  const loadGeneration = useRef(0)
  // tray id -> what to re-fetch for it, so retry needs no extra plumbing.
  const fetchTargets = useRef(new Map<string, { todoId: string; a: DeskTodoAttachment }>())

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Drag files onto the composer card → same staging path as the paperclip.
  const { isDragging, dragHandlers } = useFileDropzone({ onFiles: addFiles, disabled: pending })

  // `@` toggles the recipient picker while browsing My Desk (mnemonic "pick the
  // @agent"). Opening lets DeskAgentPicker autofocus its own search box;
  // closing hands focus back to the message box. We swallow `@` only when it
  // can't be a character the user meant to type — never while a field is
  // focused, EXCEPT the picker's own search, which we repurpose so the same key
  // that opened the picker also closes it.
  useEffect(() => {
    const handler = (e: WindowEventMap['keydown']) => {
      if (e.key !== '@' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const inField =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (inField && !picking) return
      e.preventDefault()
      setPicking((p) => {
        if (p) requestAnimationFrame(() => editorRef.current?.focusEnd())
        return !p
      })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [picking])

  const rname = recipient ? recipientLabel(recipient, user) : 'agent'
  // Send later goes into the recipient's own DM, so only the user's own agents
  // have one: another account's agent is reached through a Front Desk thread,
  // and an agent of another server through a hub thread.
  const ownRecipient = !!recipient && !isHubRecipient(recipient) && recipient.registered_by === user?.id
  // `!anyLoading`: a chip whose bytes have not arrived yet is a 0-byte
  // placeholder, so sending now would hand the recipient an empty file. The
  // reason goes in the button's title rather than leaving a silently dead
  // button.
  const canSend = text.trim().length > 0 && !!recipient && !pending && !anyLoading

  // "No agent registered" vs. "none selected yet": the pill only reads danger
  // when the user owns ZERO agents. A transient null recipient while the roster
  // is present keeps today's neutral "@agent" fallback.
  const hasOwnedAgent = (agents ?? []).some((a) => a.registered_by === user?.id)
  // Danger pill only when there is genuinely nothing to send to.
  const showNoAgent = !recipient && !hasOwnedAgent

  const buildMessage = () => text.trim()

  // Core send: dispatch `content` to the selected recipient, then reset the box.
  // No-op without a recipient or a non-empty body.
  const dispatch = async (content: string) => {
    if (!recipient || !content.trim() || pending || sendingRef.current) return
    // READ THE BOUND TO-DO FIRST, before anything can clear it. The clear below
    // fires the moment the send succeeds, so an id read after it would race
    // itself and the association would be made against `null` — silently, since
    // "no to-do" is a legitimate state this path already handles.
    const todoId = todoSourceRef.current?.id ?? null
    if (!threadKeyRef.current) threadKeyRef.current = crypto.randomUUID()
    const clientThreadKey = threadKeyRef.current
    sendingRef.current = true
    setPending(true)
    try {
      // The link happens INSIDE this await, while the box is still disabled and
      // before "Sent" appears — so the confirmation, when it comes, is telling
      // the truth about both halves rather than about the message alone.
      const { linked } = await onDispatch(recipient, content, files, {
        todoId,
        clientThreadKey,
      })
      setText('')
      textRef.current = ''
      editorRef.current?.clear()
      clearStagedFiles()
      onClearSop?.()
      // The bound to-do is detached, not completed: the message went out, but
      // whether the item is finished is the user's call on the plate.
      //
      // UNLESS THE LINK FAILED. Then the item stays bound, so the head still
      // names the to-do that did not get wired up — the owner can see WHICH one
      // it was and send again into the same thread. Clearing here would leave
      // the toast naming a to-do nothing on screen points at any more.
      if (linked) {
        onClearTodo?.()
        threadKeyRef.current = null
      }
      setSent(true)
      window.clearTimeout(sentTimer.current)
      sentTimer.current = window.setTimeout(() => setSent(false), 1900)
    } finally {
      sendingRef.current = false
      setPending(false)
    }
  }

  // Never ship a half-filled template: pulse the empty blanks and open the
  // first rather than sending "[Deadline]" to an agent.
  const doDispatch = () => {
    if (editorRef.current?.nudgeEmpty()) return
    dispatch(buildMessage())
  }

  // Write the composer, confirming before we clobber a draft the user started
  // (mirrors DMChatView.prefillComposer). Exposed on the imperative handle as
  // `prefill`, for callers that stage a plain body (no SOP chips).
  const prefillComposer = (next: string) => {
    const current = textRef.current.trim()
    if (current && current !== next.trim() && !window.confirm('Replace your current draft?')) {
      return
    }
    editorRef.current?.setPlain(next, true)
  }

  // Load an SOP body as chips, with the same don't-clobber-a-draft guard.
  const loadTemplate = (body: string, focus = true) => {
    const current = textRef.current.trim()
    if (current && current !== body.trim() && !window.confirm('Replace your current draft?')) {
      return
    }
    editorRef.current?.loadTemplate(body, focus)
  }

  // Load a to-do into the box, behind the don't-clobber-your-work guard.
  // `loadTemplate` (not setPlain) because a saved draft can still hold
  // `{{blanks}}` — they must chip back up rather than arrive as literal braces.
  //
  // Loading an item resets the ATTACHMENT TRAY as well as the draft — the two
  // belong to the same to-do. Attachments are never CARRIED across a switch:
  // they belong to the item, so carrying them would recreate the mis-send this
  // reset exists to prevent, and now worse, because the next Save would persist
  // someone else's file onto the wrong item. Nor is the switch auto-saved —
  // clicking a row issues no request at all, and a mis-click must not upload.
  //
  // So the drop stands and the SILENCE goes. The old guard fired only when the
  // text differed, which meant loading an item, attaching a file, and clicking a
  // row whose draft happened to match (or leaving the box empty) dropped that
  // file with no warning. That used to cost a re-attach; now the user believes
  // the file is on the item.
  const loadTodoDraft = (body: string, todo: DeskTodo): boolean => {
    const current = textRef.current.trim()
    const bound = todoSourceRef.current
    const unsaved = bound
      ? unsavedAttachmentCount(trayRef.current, loadedAttachmentIds.current)
      : 0

    // The attachment wording wins when the text is dirty too: it names the one
    // thing the user cannot retype.
    if (unsaved > 0 && bound) {
      const msg =
        `You have ${unsaved} unsaved attachment${unsaved > 1 ? 's' : ''} on ` +
        `“${bound.text}”. Switching will discard them.`
      if (!window.confirm(msg)) return false
    } else if (current && current !== body.trim()) {
      if (!window.confirm('Replace your current draft?')) return false
    }

    editorRef.current?.loadTemplate(body, true)

    // What the tray becomes: one chip per stored attachment.
    const seeds: StagedSeed[] = []
    const stored = todo.attachments ?? []
    for (const a of stored) {
      const cached = cachedTodoAttachment(todo.id, a.id)
      seeds.push({
        file: cached ?? new File([], a.name, { type: a.content_type }),
        origin: 'attachment',
        attachmentId: a.id,
        // Chips are visible NOW, with the right name and size from the
        // descriptor, so there is no flash of an empty tray and the size cap is
        // checkable immediately.
        status: cached ? 'ready' : 'loading',
        displaySize: a.size,
      })
    }

    const trayIds = replaceStagedFiles(seeds)
    loadedAttachmentIds.current = stored.map((a) => a.id)

    // Bytes resolve in the background. Eager, not lazy-at-dispatch: `dispatch`
    // is try/finally with no catch, so a fetch failing there would leave the box
    // silently doing nothing. Here the failure has somewhere to render, at the
    // moment the user is already looking at the item.
    const gen = ++loadGeneration.current
    fetchTargets.current = new Map()
    stored.forEach((a, i) => {
      const trayId = trayIds[i]
      // Undefined when the size cap truncated the tray — nothing to fill in.
      if (!trayId) return
      fetchTargets.current.set(trayId, { todoId: todo.id, a })
      if (cachedTodoAttachment(todo.id, a.id)) return
      fetchTodoAttachment(todo.id, a)
        .then((file) => {
          if (loadGeneration.current !== gen) return
          updateStagedFile(trayId, { file, status: 'ready' })
        })
        .catch(() => {
          if (loadGeneration.current !== gen) return
          updateStagedFile(trayId, { status: 'error' })
        })
    })

    return true
  }

  // Everything a to-do put into this box, taken back out. Draft, tray,
  // SOP chip, save error, the idempotency token, and the
  // recipient — plus the binding itself, via `onClearTodo`.
  //
  // Bumps `loadGeneration` so any attachment fetch still in flight for the item
  // being dropped is discarded on arrival rather than patching a tray that has
  // moved on, and empties `fetchTargets` so a stale retry has nothing to aim at.
  //
  // NOT called after a send: `dispatch` already clears the draft/tray and
  // deliberately KEEPS the recipient, so a second message can go to the same
  // agent without re-picking. Only a chip ✕ (to-do or SOP) resets this hard.
  const resetBox = () => {
    setText('')
    textRef.current = ''
    editorRef.current?.clear()
    clearStagedFiles()
    // Orphan the in-flight loads before the tray is gone, not after.
    loadGeneration.current++
    fetchTargets.current = new Map()
    loadedAttachmentIds.current = []
    threadKeyRef.current = null
    setSaveError(null)
    onClearSop?.()
    onClearTodo?.()
    onResetRecipient?.()
  }

  // A chip ✕ — the to-do chip's or the SOP chip's. Both mean "take back out
  // what this put in", so both reset the whole box; dropping only the SOP chip
  // used to leave its filled-in body behind with nothing naming where it came
  // from. Guards the one thing the user cannot retype — attachments that were
  // staged but never saved onto a bound to-do — with the same confirm the
  // row-switch uses. Declining leaves the box exactly as it was, binding
  // included.
  const handleChipReset = () => {
    const bound = todoSourceRef.current
    const unsaved = bound
      ? unsavedAttachmentCount(trayRef.current, loadedAttachmentIds.current)
      : 0
    if (unsaved > 0 && bound) {
      const msg =
        `You have ${unsaved} unsaved attachment${unsaved > 1 ? 's' : ''} on ` +
        `“${bound.text}”. Detaching will discard them.`
      if (!window.confirm(msg)) return
    }
    resetBox()
  }

  // Re-run one failed background fetch. Forgets the cache entry first, so this
  // is a real retry rather than a replayed failure.
  const retryAttachment = (trayId: string) => {
    const target = fetchTargets.current.get(trayId)
    if (!target) return
    forgetTodoAttachment(target.todoId, target.a.id)
    updateStagedFile(trayId, { status: 'loading' })
    const gen = loadGeneration.current
    fetchTodoAttachment(target.todoId, target.a)
      .then((file) => {
        if (loadGeneration.current !== gen) return
        updateStagedFile(trayId, { file, status: 'ready' })
      })
      .catch(() => {
        if (loadGeneration.current !== gen) return
        updateStagedFile(trayId, { status: 'error' })
      })
  }

  // Fold the server's reconciled descriptors back onto the tray. The pairing
  // itself belongs to `todoAttachments`; the composer owns only the setState.
  const adoptSavedAttachments = (stored: DeskTodoAttachment[]) => {
    const before = trayRef.current
    adoptServerIds(before, stored).forEach((e, i) => {
      if (e.attachmentId === before[i]?.attachmentId) return
      updateStagedFile(e.id, {
        attachmentId: e.attachmentId,
        origin: e.origin,
        status: e.status,
      })
    })
    loadedAttachmentIds.current = stored.map((a) => a.id)
  }

  // "Save to-do". Hands the source AND the live tray up, holds the button
  // pending until the promise settles, and does NOT clear the tray on success.
  //
  // A rejection renders in the same slot the overflow error uses. An ApiError's
  // message IS the server's `detail` (the client lifts it), so a 413 or a 400
  // renders VERBATIM — no parsing here, and no client-side rewording of a
  // sentence the server was careful about.
  const handleSaveTodoClick = async () => {
    if (!onSaveTodo || saving) return
    setSaveError(null)
    setSaving(true)
    try {
      await onSaveTodo(editorRef.current?.getSource() ?? text, trayRef.current)
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : 'Couldn’t save that to-do — try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  // Let DeskPage drive the message box (desk zero-state sample → prefill in
  // place or ghost-preview on hover; the SOP rail → load a stored prompt; the
  // to-do plate → load an item's draft). Empty deps: every closure reads the
  // live draft off `textRef`, never a captured render's `text`, and the
  // staging verbs it calls are all stable. `setGhost` in particular MUST stay
  // off the render path — it fires on every pointer move across the idea list.
  useImperativeHandle(
    ref,
    () => ({
      prefill: prefillComposer,
      loadTemplate,
      setGhost: (text: string | null) => editorRef.current?.setGhost(text),
      loadTodoDraft,
      adoptSavedAttachments,
    }),
    [],
  )

  // Clock → "Send later". Resolve (get-or-create) the selected agent's own DM
  // project, then open ScheduleMessageModal targeting its user-communication
  // room, prefilled with whatever's typed — i.e. schedule a DM for that agent.
  // `ensureOwnDMProject` (not `createDMThread`) so clicking the clock never
  // spawns a throwaway empty thread.
  const openSchedule = async () => {
    if (!recipient || isHubRecipient(recipient) || !ownRecipient || resolvingSchedule) return
    // Same blank guard as Send — scheduling "[Label]" for later is no better
    // than sending it now.
    if (editorRef.current?.nudgeEmpty()) return
    setResolvingSchedule(true)
    try {
      const proj = await ensureOwnDMProject(recipient.name)
      setScheduleProjectId(proj.id)
    } finally {
      setResolvingSchedule(false)
    }
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files)
    e.target.value = ''
  }

  return (
    <div className="relative">
      <div
        className={`relative rounded-2xl border bg-white shadow-sm transition-all ${
          picking
            ? 'border-purple-400 shadow-[0_0_0_3px_rgba(168,85,247,0.10)]'
            : 'border-purple-200 focus-within:border-purple-400 focus-within:shadow-[0_0_0_3px_rgba(168,85,247,0.10)]'
        }`}
        {...dragHandlers}
      >
        <DropOverlay visible={isDragging} />
        {/* Head: you → @agent (+ suggested-by badge) */}
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-1">
          {user && <Avatar name={user.username} size="xs" />}
          <span className="text-xs font-semibold text-gray-700">you</span>
          <span className="text-gray-300">→</span>
          {/* The chip is the picker's anchor, not the composer card: a list of
              agents that drops out of the @name it replaces reads as "change
              this", where the same list under the whole box read as a second,
              unrelated panel. `relative` here is what scopes it. */}
          <span className="relative">
            <button
              onClick={() => setPicking((p) => !p)}
              title={showNoAgent ? 'Register an agent to send' : 'Choose who to send to'}
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 border transition-colors ${
                showNoAgent
                  ? 'border-prio-urgent-fg/30 bg-prio-urgent-bg'
                  : 'border-transparent hover:bg-purple-50 hover:border-purple-200'
              }`}
            >
              {recipient && (
                <Avatar name={rname} status={isHubRecipient(recipient) ? undefined : recipient.status} size="xs" />
              )}
              {showNoAgent ? (
                <span className="font-mono text-[13px] font-semibold text-prio-urgent-fg">
                  No Agent Registered
                </span>
              ) : (
                <span className="font-mono text-[13px] font-medium text-gray-700">@{rname}</span>
              )}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-gray-400">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {picking && (
              <DeskAgentPicker
                onPick={(a) => {
                  onRecipientChange(a)
                  setPicking(false)
                  // After picking, hand focus back to the message box so the
                  // user can start typing immediately (mirrors the `@`-to-close
                  // handoff above).
                  requestAnimationFrame(() => editorRef.current?.focusEnd())
                }}
                onClose={() => setPicking(false)}
              />
            )}
          </span>
          {/* Which to-do this box is bound to — what "Save to-do" will write
              back to. Same chip styling as the SOP chip below it so the head
              reads as one row of provenance. */}
          {todoSource && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-deep"
              title={`Bound to the to-do “${todoSource.text}” — Save to-do writes here`}
            >
              <CheckSquare className="w-3 h-3 text-accent" />
              <span className="max-w-[160px] truncate normal-case">{todoSource.text}</span>
              {onClearTodo && (
                <button
                  onClick={handleChipReset}
                  className="text-accent-deep/50 hover:text-accent-deep"
                  title="Detach this to-do and clear the box"
                  aria-label="Detach this to-do"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          )}
          {/* Which stored SOP this draft came from. */}
          {sopSource && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-deep"
              title={`From the SOP "${sopSource.title}"`}
            >
              <FileText className="w-3 h-3 text-accent" />
              <span className="max-w-[160px] truncate normal-case">{sopSource.title}</span>
              {onClearSop && (
                <button
                  onClick={handleChipReset}
                  className="text-accent-deep/50 hover:text-accent-deep"
                  title="Detach this SOP and clear the box"
                  aria-label="Detach this SOP"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          )}
        </div>

        {/* Message. Rich: an SOP's {{blanks}} render as fillable chips, and
            send is blocked until every one has a value. Heights match what
            useAutoResizeTextarea used to cap this box at. */}
        <PromptEditor
          ref={editorRef}
          wrapClassName="px-4 pt-1 pb-2"
          className="text-gray-900 text-sm"
          minHeight={minHeight ?? 52}
          maxHeight={168}
          placeholder={`Message @${rname}…`}
          disabled={pending}
          agents={agents ?? []}
          viewer={user ?? null}
          onChange={(t) => {
            setText(t)
            textRef.current = t
          }}
          onSubmit={doDispatch}
        />

        {/* Staged attachments — the user's picks and this to-do's stored
            files. What each one IS lives on the entry, not in this call. */}
        <StagedAttachments
          files={stagedFiles}
          onRemove={removeStagedFile}
          onRetry={retryAttachment}
          disabled={pending}
        />

        {/* Toolbar — draft actions, all icon-sized. Personalizing an agent
            is not a composer action: it is the "SYSTEM:Personalize assistant"
            SOP on the rail, reached the same way every other stored prompt is. */}
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {/* Model for the recipient agent — quick-edit shortcut to Agent Settings */}
            <ModelSelector agent={isHubRecipient(recipient) ? null : recipient} />
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={pending}
              className="p-1.5 text-gray-400 hover:text-accent rounded transition-colors disabled:opacity-50"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              onClick={openSchedule}
              disabled={!ownRecipient || resolvingSchedule || pending}
              className="p-1.5 text-gray-400 hover:text-accent rounded transition-colors disabled:opacity-50"
              title={recipient && !ownRecipient ? 'Send later works for your own agents only' : 'Send later'}
            >
              {resolvingSchedule ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Clock className="w-4 h-4" />
              )}
            </button>

            {/* Park what's in the box on the plate. Disabled only on an empty
                box — a recipient is NOT required, because a to-do is a note to
                yourself, not a message. */}
            {onSaveTodo && (
              <button
                // getSource(), not getText(): an unfilled chip must round-trip
                // as "{{Label|kind}}", not flatten to "[Label]" and destroy
                // the template the next time this draft is loaded.
                onClick={handleSaveTodoClick}
                disabled={!text.trim() || saving}
                title={
                  todoSource
                    ? `Save to “${todoSource.text}”`
                    : 'Save this draft to your plate — you’ll name it once'
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-bold text-gray-700 hover:border-gray-300 hover:text-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckSquare className="w-3.5 h-3.5" />
                )}
                Save to-do
              </button>
            )}

            {sent ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold text-prio-quick-fg">
                <Check className="w-3.5 h-3.5" />
                Sent
              </span>
            ) : (
              <button
                onClick={doDispatch}
                disabled={!canSend}
                title={
                  anyLoading
                    ? 'Waiting for attachments to load…'
                    : 'Command (⌘/Ctrl+Enter)'
                }
                className="ml-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold text-white bg-accent hover:bg-accent-deep disabled:bg-accent-soft disabled:cursor-not-allowed transition-colors"
              >
                {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                <span>command</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {attachmentError && <p className="mt-2 px-1 text-sm text-red-600">{attachmentError}</p>}
      {/* A refused save, rendered where the overflow error already goes. The
          server's `detail` is a plain sentence written for this exact screen,
          so it is shown verbatim rather than mapped to a generic apology. */}
      {saveError && <p className="mt-2 px-1 text-sm text-red-600">{saveError}</p>}

      {/* Send later → schedule a DM for the selected agent, prefilled */}
      {scheduleProjectId && (
        <ScheduleMessageModal
          projectId={scheduleProjectId}
          chatroomName="user-communication"
          initialContent={buildMessage()}
          onClose={() => setScheduleProjectId(null)}
        />
      )}
    </div>
  )
})

export default DeskComposer

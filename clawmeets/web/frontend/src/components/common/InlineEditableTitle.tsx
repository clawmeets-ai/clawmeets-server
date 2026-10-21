import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Loader2, Pencil } from 'lucide-react'
import {
  THREAD_NAME_COUNTER_THRESHOLD,
  THREAD_NAME_MAX_LENGTH,
  normalizeThreadName,
  threadNameErrorMessage,
  threadNameLength,
  validateThreadName,
} from '../../utils/threadName'

/**
 * The inline rename control in the main-column header, shared by the project
 * page and the DM page.
 *
 * One component for both because there is only one thing here: a DM thread IS a
 * `Project` (`surface === 'dm'`), renamed through the same field and the same
 * route. Two look-alike implementations would be two places for the Esc rule,
 * the blur rule and the counter threshold to drift.
 *
 * The title IS the button — a pencil rides inside it as decoration rather than
 * sitting beside it as a second control. One tab stop, one accessible name, and
 * no ambiguity for a screen-reader user about which of two adjacent controls
 * they have landed on. Mouse users still get a hover affordance.
 *
 * WHAT THIS COMPONENT DOES NOT OWN: persistence. `onSave` is handed in, and the
 * caller's `useRenameProject` owns the request, the optimistic cache patch and
 * the rollback. So the displayed `value` always comes from the cache, never
 * from local state — which is why a rollback needs no undo logic here: the
 * old name reappears on its own.
 *
 * MARKUP NOTE: every element rendered here is phrasing content (`span`,
 * `button`, `input`), so the whole control is legal inside the `<h2>` each
 * header already has. A `<div>`/`<p>` root would be invalid HTML there.
 */
export interface InlineEditableTitleProps {
  /** Current persisted name. Display mode renders this verbatim. */
  value: string
  /**
   * Persist. RESOLVE = saved. REJECT = rolled back by the caller; the
   * rejection's `message` is shown inline and the typed text is restored.
   * Never called with an invalid or an unchanged value.
   */
  onSave: (next: string) => Promise<unknown>
  /**
   * Accessible name of the control, e.g. "Project name" / "Conversation name".
   */
  label: string
  /**
   * false => plain non-interactive text: no button, no pencil, no tab stop.
   * Pass false for anyone the server would 403 (a share-link viewer), so they
   * get a plain title instead of an affordance that always fails.
   */
  editable?: boolean
  /** Typography for BOTH modes, so the header does not reflow on entry. */
  className?: string
  /** Shown when `value` is empty. */
  placeholder?: string
}

export default function InlineEditableTitle({
  value,
  onSave,
  label,
  editable = true,
  className = '',
  placeholder = 'Untitled',
}: InlineEditableTitleProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [liveMessage, setLiveMessage] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Leaving edit mode unmounts the input, and the browser fires a blur at it on
  // the way out. This latch says "this edit session is already finished", so
  // that exit-blur is a no-op. It is checked in two places for two reasons:
  // in `commitEdit`, so the save cannot fire twice; in `handleBlur`, so the
  // exit-blur after an Esc cannot re-run the cancel path and overwrite Esc's
  // decision to put focus back on the trigger. Cleared by `beginEdit`, so each
  // session starts unlatched.
  const committedRef = useRef(false)
  // Select-all is right when opening a fresh edit (the common case is replacing
  // a whole auto-generated title in one keystroke) and wrong when re-entering
  // after a rejection, where the typed text must survive the next keypress.
  const selectAllRef = useRef(true)
  // Esc and Enter put focus back on the trigger; a blur must not, because focus
  // has already gone wherever the user clicked.
  const returnFocusRef = useRef(false)

  const errorId = `${useId()}-error`
  const counterId = `${useId()}-counter`

  useEffect(() => {
    if (editing) {
      const el = inputRef.current
      if (!el) return
      el.focus()
      if (selectAllRef.current) el.select()
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false
      buttonRef.current?.focus()
    }
  }, [editing])

  function beginEdit() {
    if (!editable || saving) return
    committedRef.current = false
    selectAllRef.current = true
    setDraft(value)
    setError(null)
    setEditing(true)
  }

  /** Esc, and the blur-with-an-invalid-value path. Makes no network call. */
  function cancelEdit(returnFocus: boolean) {
    committedRef.current = true
    returnFocusRef.current = returnFocus
    setError(null)
    setEditing(false)
  }

  async function commitEdit(returnFocus: boolean) {
    if (committedRef.current) return
    const normalized = normalizeThreadName(draft)

    // Unchanged after normalization => nothing to persist. Tabbing through a
    // title without typing must not write a changelog entry or broadcast.
    if (normalized === normalizeThreadName(value)) {
      cancelEdit(returnFocus)
      return
    }

    const invalid = validateThreadName(draft)
    if (invalid) {
      // Stay in edit mode with focus in the input and no request sent — the
      // rejection has to be fixable without retyping.
      setError(threadNameErrorMessage(invalid))
      inputRef.current?.focus()
      return
    }

    committedRef.current = true
    returnFocusRef.current = returnFocus
    setError(null)
    setEditing(false)
    setSaving(true)
    try {
      await onSave(normalized)
      setSaving(false)
      // Announced, not rendered: the new name is already visible in the header.
      setLiveMessage(`Renamed to "${normalized}".`)
    } catch (err) {
      setSaving(false)
      // The caller has rolled the caches back, so `value` has already snapped
      // to the old name on its own. All this has to do is give the user their
      // text and their cursor back, next to the reason.
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.")
      selectAllRef.current = false
      committedRef.current = false
      returnFocusRef.current = false
      setEditing(true)
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const next = e.target.value
    setDraft(next)
    // Live, on every keystroke — but only the length rule. An empty field the
    // user is about to type into is not an error yet; that one surfaces on
    // commit. Typing also clears a stale server-side error, since the user is
    // in the middle of fixing it.
    const invalid = validateThreadName(next)
    setError(invalid === 'too_long' ? threadNameErrorMessage(invalid) : null)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      void commitEdit(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Never let the header's Esc reach a parent overlay/modal handler.
      e.stopPropagation()
      cancelEdit(true)
    }
  }

  /**
   * Blur SAVES. An inline title has no visible Save button, so a discarding
   * blur would silently lose the edit of every user who types a name and then
   * clicks into the message list — the most likely accidental-loss path on this
   * surface. It is only safe because an explicit no-write cancel exists (Esc),
   * and it is non-destructive because of the two exceptions below.
   */
  function handleBlur() {
    if (committedRef.current) return
    // Invalid => cancel and restore. Leaving an error banner pinned to a field
    // the user has walked away from is noise, and the original name is the safe
    // resting state.
    if (validateThreadName(draft)) {
      cancelEdit(false)
      return
    }
    void commitEdit(false)
  }

  const length = threadNameLength(draft)
  const remaining = THREAD_NAME_MAX_LENGTH - length
  const counterVisible = editing && remaining <= THREAD_NAME_COUNTER_THRESHOLD
  const displayed = value || placeholder

  // A viewer who cannot rename gets a plain title, not a control that 403s.
  if (!editable) {
    return (
      <span className={`block min-w-0 max-w-full truncate ${className}`} title={value || undefined}>
        {displayed}
      </span>
    )
  }

  return (
    <span className="inline-flex min-w-0 max-w-full flex-col align-top">
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          aria-label={label}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : counterVisible ? counterId : undefined}
          // Deliberately NO maxLength: it silently swallows the tail of a
          // pasted title and never says why. We accept the text and explain.
          className={`w-full min-w-0 border-b border-accent bg-transparent outline-none ${className}`}
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          onClick={beginEdit}
          // NOT `disabled` while saving, deliberately. Enter-to-commit returns
          // focus to this button, and a disabled element cannot take focus —
          // the keyboard user would be dropped onto <body> for the duration of
          // the request. `aria-busy` states it instead, and `beginEdit` is the
          // thing that actually refuses to re-enter mid-save.
          aria-busy={saving}
          aria-label={`${label}: ${displayed}. Click to rename.`}
          className={`group flex min-w-0 max-w-full items-center gap-1.5 text-left ${className}`}
        >
          <span className="truncate" title={value || undefined}>
            {displayed}
          </span>
          {saving ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-channel" />
          ) : (
            <Pencil
              aria-hidden
              className="w-3.5 h-3.5 shrink-0 text-channel opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
            />
          )}
        </button>
      )}

      {error && (
        <span id={errorId} role="alert" className="block text-xs font-normal text-red-600">
          {error}
        </span>
      )}
      {counterVisible && (
        <span id={counterId} className="block text-xs font-normal text-channel">
          {remaining >= 0
            ? `${remaining} characters left`
            : `${-remaining} over the limit`}
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </span>
    </span>
  )
}

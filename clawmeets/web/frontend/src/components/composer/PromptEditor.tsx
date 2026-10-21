import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react'
import type { AgentCard, User } from '../../types'
import {
  caretOffset as computeCaretOffset,
  caretAfter,
  caretToEnd,
  insertLineBreakAtCaret,
  selectPlainRange,
} from './caret'
import {
  chipInnerHtml,
  domSource,
  domText,
  nodesToHtml,
  parsePrompt,
  phKey,
  uniqueChips,
  type PhChip,
  type PhNode,
} from './placeholders'
import PhPopover, { type PhPopoverPos } from './PhPopover'
import './promptEditor.css'

/** Counted over DISTINCT blanks, not `{{…}}` occurrences: a label the body
 *  uses twice is one question, so it contributes one dot and one unit of
 *  progress. `flags` is in first-occurrence order. */
export interface PromptStats {
  total: number
  filled: number
  empty: number
  flags: boolean[]
}

export const EMPTY_STATS: PromptStats = { total: 0, filled: 0, empty: 0, flags: [] }

export interface PromptEditorHandle {
  /** Parse `{{…}}` into fillable chips. */
  loadTemplate(src: string, focus?: boolean): void
  /** Set literal text — braces are left alone, no chips are minted. */
  setPlain(text: string, focus?: boolean): void
  /**
   * Show `text` as a non-committal ghost preview in place of the placeholder,
   * or null to restore it. Imperative on purpose: a React prop would re-render
   * the mounting composer on every mouseover. Only visible while the editor is
   * blank — a typed draft always wins, and that is enforced by the
   * `[data-blank='1']` CSS selector, not by a check here.
   */
  setGhost(text: string | null): void
  clear(): void
  focusEnd(): void
  /** What gets SENT: unfilled chips degrade to `[Label]`. */
  getText(): string
  /** What gets SAVED as a draft: unfilled chips keep their `{{…}}` source. */
  getSource(): string
  /** Pulse the empty chips and open the first. True ⇒ caller must NOT send. */
  nudgeEmpty(): boolean
  /** Replace a plain-text range (used to insert an accepted @mention). */
  replaceRange(start: number, end: number, insert: string): void
  caretOffset(): number
}

export interface PromptEditorProps {
  placeholder?: string
  disabled?: boolean
  /** Visual shell — border/background/padding/font. Owned by the composer. */
  className?: string
  wrapClassName?: string
  minHeight?: number
  maxHeight?: number
  ariaLabel?: string
  /** Roster for the `agent` placeholder kind. */
  agents?: AgentCard[]
  viewer?: User | null
  /** Element handle for callers that need to measure the box (mention popup). */
  innerRef?: MutableRefObject<HTMLDivElement | null>
  onChange?: (text: string, stats: PromptStats) => void
  onCaretChange?: (text: string, caret: number) => void
  onSubmit?: () => void
  onEngage?: () => void
  /** Runs BEFORE the editor's own handling; call preventDefault to take over. */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void
}

let seq = 0
const nextChipId = () => 'ph' + ++seq

/**
 * The one message box, shared by every composer.
 *
 * Text is freely editable; each placeholder is an atomic
 * `contenteditable="false"` chip the user clicks to fill. Send is blocked
 * while any blank is empty, so `[Deadline]` never reaches an agent.
 *
 * ── The caret contract ──────────────────────────────────────────────────
 * React must NEVER re-render the editable region — doing so destroys the
 * caret mid-typing. Four rules keep that true, and breaking any one of them
 * reintroduces the bug:
 *
 *   1. The editable <div> has ZERO JSX children. Do not add `{children}` or
 *      `dangerouslySetInnerHTML`, and do not derive its content from state.
 *   2. `innerHTML` is written imperatively, only when the document STRUCTURE
 *      changes, gated behind the `ver` counter. Typing never bumps `ver`.
 *   3. Filling a blank mutates only the affected chip nodes' className /
 *      innerHTML directly — one node, or every occurrence of a repeated label.
 *   4. Chip metadata lives in `chipsRef`, keyed by `data-ph` — never in
 *      render state.
 *
 * Only derived, non-structural state (blank flag, counts, popover position)
 * goes through React.
 *
 * Known scope: pasted `{{…}}` text stays literal. Chips are minted only by
 * `loadTemplate`, i.e. by loading a stored SOP.
 */
function PromptEditorImpl(
  {
    placeholder,
    disabled,
    className,
    wrapClassName,
    minHeight,
    maxHeight = 208,
    ariaLabel,
    agents,
    viewer,
    innerRef,
    onChange,
    onCaretChange,
    onSubmit,
    onEngage,
    onKeyDown,
  }: PromptEditorProps,
  ref: React.Ref<PromptEditorHandle>,
) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const chipsRef = useRef<Record<string, PhChip>>({})
  const htmlRef = useRef('')
  const focusRef = useRef(false)
  // True while we're walking the user through blanks (Tab / Fill next), so
  // committing one chip opens the next instead of returning to typing.
  const autoRef = useRef(false)
  const composingRef = useRef(false)
  const statsRef = useRef<PromptStats>(EMPTY_STATS)
  const warnTimer = useRef<number | undefined>(undefined)

  const [ver, setVer] = useState(0)
  const [pop, setPop] = useState<{ id: string; pos: PhPopoverPos } | null>(null)
  const [stats, setStats] = useState<PromptStats>(EMPTY_STATS)
  const [blank, setBlank] = useState(true)
  const [warn, setWarn] = useState(0)

  // Callback props mirrored into refs so the empty-dep imperative handle and
  // the DOM effects never close over a stale one.
  const onChangeRef = useRef(onChange)
  const onSubmitRef = useRef(onSubmit)
  const onCaretRef = useRef(onCaretChange)
  const onKeyDownRef = useRef(onKeyDown)
  onChangeRef.current = onChange
  onSubmitRef.current = onSubmit
  onCaretRef.current = onCaretChange
  onKeyDownRef.current = onKeyDown

  const chipEls = useCallback(
    (): HTMLElement[] =>
      elRef.current ? Array.from(elRef.current.querySelectorAll<HTMLElement>('[data-ph]')) : [],
    [],
  )

  const firstEmptyEl = useCallback((): HTMLElement | null => {
    return (
      chipEls().find((n) => {
        const c = chipsRef.current[n.getAttribute('data-ph') ?? '']
        return c && !c.value
      }) ?? null
    )
  }, [chipEls])

  const emit = useCallback(() => {
    const el = elRef.current
    if (!el) return
    const chips = chipsRef.current
    const list = uniqueChips(
      chipEls()
        .map((n) => chips[n.getAttribute('data-ph') ?? ''])
        .filter(Boolean),
    )
    const flags = list.map((c) => !!c.value)
    const filled = flags.filter(Boolean).length
    const s: PromptStats = {
      total: list.length,
      filled,
      empty: list.length - filled,
      flags,
    }
    statsRef.current = s
    setStats(s)
    const txt = domText(el, chips)
    setBlank(!txt.trim())
    onChangeRef.current?.(txt, s)
  }, [chipEls])

  const reportCaret = useCallback(() => {
    const el = elRef.current
    if (!el || !onCaretRef.current) return
    // Mid-composition the DOM holds provisional IME text; measuring it would
    // fire the @mention detector on garbage.
    if (composingRef.current) return
    const at = computeCaretOffset(el, chipsRef.current)
    if (at < 0) return
    onCaretRef.current(domText(el, chipsRef.current), at)
  }, [])

  const openPop = useCallback((node: HTMLElement | null) => {
    const el = elRef.current
    if (!node || !el) return
    const id = node.getAttribute('data-ph')
    if (!id || !chipsRef.current[id]) return
    const wrap = el.parentElement
    if (!wrap) return
    const r = node.getBoundingClientRect()
    const b = wrap.getBoundingClientRect()
    // Clamp so a chip near the right edge doesn't push the popover offscreen.
    const x = Math.max(0, Math.min(r.left - b.left, Math.max(0, b.width - 250)))
    // No room below (e.g. a reply box low in the desk scroller) → anchor above.
    const flip = r.bottom + 260 > window.innerHeight
    const y = flip ? b.bottom - r.top + 7 : r.bottom - b.top + 7
    setPop({ id, pos: { x, y, flip } })
  }, [])

  const setDoc = useCallback((nodes: PhNode[], focus: boolean) => {
    const chips: Record<string, PhChip> = {}
    nodes.forEach((n) => {
      if (n.t === 'ph') chips[n.chip.id] = n.chip
    })
    chipsRef.current = chips
    htmlRef.current = nodesToHtml(nodes)
    focusRef.current = focus
    setPop(null)
    setWarn(0)
    setVer((v) => v + 1)
  }, [])

  // The ONLY place innerHTML is written. Keyed on `ver`, so typing can't
  // trigger it. `focusRef` is intentionally NOT consumed here: under
  // StrictMode this effect runs → cleans up → runs again, and a consume-once
  // flag would make pass 2 skip the focus branch after pass 1's cleanup had
  // already cancelled its timer, silently killing auto-open in dev. The flag
  // is overwritten by the next setDoc instead, which makes this idempotent.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    el.innerHTML = htmlRef.current
    emit()
    if (!focusRef.current) return
    caretToEnd(el)
    const first = firstEmptyEl()
    if (!first) return
    autoRef.current = true
    const t = window.setTimeout(() => openPop(first), 80)
    return () => window.clearTimeout(t)
  }, [ver, emit, firstEmptyEl, openPop])

  const setChipValue = useCallback(
    // `keepOpen` is the multi-pick path (`agents`): the chip is committed on
    // every tick, but the popover — and therefore the caret restore and the
    // Tab-through advance, which both mean "this blank is answered" — waits
    // until the user is done picking.
    (id: string, val: string, keepOpen = false) => {
      const c = chipsRef.current[id]
      if (!c) return
      // One question, one answer: commit to EVERY occurrence of this label,
      // found by sweeping the live DOM rather than a remembered id list, so a
      // twin can never be left visibly empty and blocking send. Still surgical
      // — className + innerHTML, no state, no `ver` bump — so the caret lives
      // for a group exactly as it did for a single chip.
      const key = phKey(c.label)
      const node = elRef.current?.querySelector<HTMLElement>(`[data-ph="${id}"]`) ?? null
      chipEls().forEach((n) => {
        const twin = chipsRef.current[n.getAttribute('data-ph') ?? '']
        if (!twin || phKey(twin.label) !== key) return
        twin.value = val
        n.className = 'ph-chip' + (val ? ' filled' : '')
        n.innerHTML = chipInnerHtml(twin)
      })
      if (!keepOpen) setPop(null)
      emit()
      if (keepOpen) return

      const auto = autoRef.current
      autoRef.current = false
      const next = val ? firstEmptyEl() : null
      if (auto && next) {
        autoRef.current = true
        window.setTimeout(() => openPop(next), 90)
        return
      }
      if (node && elRef.current) caretAfter(node, elRef.current)
    },
    [chipEls, emit, firstEmptyEl, openPop],
  )

  const nudgeEmpty = useCallback((): boolean => {
    const chips = chipsRef.current
    const empties = chipEls().filter((n) => {
      const c = chips[n.getAttribute('data-ph') ?? '']
      return c && !c.value
    })
    if (empties.length === 0) {
      setWarn(0)
      return false
    }
    // Pulse every empty OCCURRENCE — each one reads as blank on screen, so
    // skipping a twin would look like a bug — but count DISTINCT blanks, which
    // is how many answers the user still owes.
    empties.forEach((n) => {
      n.classList.add('nudge')
      window.setTimeout(() => n.classList.remove('nudge'), 900)
    })
    setWarn(uniqueChips(empties.map((n) => chips[n.getAttribute('data-ph') ?? ''])).length)
    window.clearTimeout(warnTimer.current)
    warnTimer.current = window.setTimeout(() => setWarn(0), 2600)
    autoRef.current = true
    openPop(empties[0])
    return true
  }, [chipEls, openPop])

  useEffect(() => () => window.clearTimeout(warnTimer.current), [])

  // Outside-click closes the popover.
  useEffect(() => {
    if (!pop) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.ph-pop') || t?.closest?.('[data-ph]')) return
      autoRef.current = false
      setPop(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [pop])

  useImperativeHandle(
    ref,
    (): PromptEditorHandle => ({
      loadTemplate: (src, focus) => setDoc(parsePrompt(src, nextChipId), focus !== false),
      setPlain: (text, focus) =>
        setDoc(text ? [{ t: 'text', v: text }] : [], focus !== false),
      // A DOM write, not state: hovering a six-row list would otherwise
      // re-render the whole mounting view on every pointer move. Its OWN
      // attribute rather than an overwrite of `data-ph-holder`, so React's
      // next render of the `placeholder` prop can never clobber it.
      setGhost: (text) => {
        const el = elRef.current
        if (!el) return
        if (text) el.setAttribute('data-ph-ghost', text)
        else el.removeAttribute('data-ph-ghost')
      },
      clear: () => setDoc([], false),
      focusEnd: () => {
        if (elRef.current) caretToEnd(elRef.current)
      },
      getText: () => (elRef.current ? domText(elRef.current, chipsRef.current) : ''),
      getSource: () => (elRef.current ? domSource(elRef.current, chipsRef.current) : ''),
      nudgeEmpty,
      caretOffset: () =>
        elRef.current ? computeCaretOffset(elRef.current, chipsRef.current) : -1,
      replaceRange: (start, end, insert) => {
        const el = elRef.current
        if (!el) return
        el.focus()
        if (!selectPlainRange(el, chipsRef.current, start, end)) return
        // execCommand (deprecated but universal) leaves the caret after the
        // insertion, preserves the native undo stack, and fires a real input
        // event — none of which manual Range surgery gives us.
        document.execCommand('insertText', false, insert)
        emit()
      },
    }),
    [setDoc, nudgeEmpty, emit],
  )

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Consumers get first refusal (e.g. MessageInput's @mention dropdown owns
    // Arrow/Enter/Escape while it's open). preventDefault means "I took it".
    onKeyDownRef.current?.(e)
    if (e.defaultPrevented) return

    if (e.key === 'Escape') {
      if (pop) {
        e.preventDefault()
        e.stopPropagation()
        autoRef.current = false
        setPop(null)
        elRef.current?.focus()
        return
      }
      // Blur so global nav hotkeys take over; the draft stays put. No
      // stopPropagation — surfaces above still get to act on Escape, exactly
      // as they did when this was a <textarea>.
      elRef.current?.blur()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSubmitRef.current?.()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (elRef.current) insertLineBreakAtCaret(elRef.current)
      return
    }
    if (e.key === 'Tab' && statsRef.current.empty > 0) {
      e.preventDefault()
      autoRef.current = true
      openPop(firstEmptyEl())
    }
  }

  const chip = pop ? chipsRef.current[pop.id] : null
  const style: CSSProperties = { maxHeight }
  if (minHeight !== undefined) style.minHeight = minHeight

  return (
    <div className={'pe-wrap' + (wrapClassName ? ' ' + wrapClassName : '')}>
      {/* NO CHILDREN HERE — see the caret contract above. Content is written
          imperatively; adding a React child will destroy the caret. */}
      <div
        ref={(n) => {
          elRef.current = n
          if (innerRef) innerRef.current = n
        }}
        className={'pe-input' + (className ? ' ' + className : '')}
        style={style}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel ?? placeholder}
        aria-disabled={disabled || undefined}
        data-blank={blank ? '1' : '0'}
        data-ph-holder={placeholder}
        onInput={() => {
          emit()
          reportCaret()
        }}
        onKeyUp={reportCaret}
        onMouseUp={reportCaret}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          emit()
          reportCaret()
        }}
        onMouseDown={() => onEngage?.()}
        onFocus={() => onEngage?.()}
        onClick={(e) => {
          const n = (e.target as HTMLElement).closest?.('[data-ph]') as HTMLElement | null
          if (n) {
            e.preventDefault()
            autoRef.current = false
            openPop(n)
          }
        }}
        onPaste={(e) => {
          e.preventDefault()
          const t = e.clipboardData.getData('text/plain')
          document.execCommand('insertText', false, t)
        }}
        onKeyDown={handleKeyDown}
      />

      {stats.total > 0 && (
        <div className={'ph-bar' + (stats.empty === 0 ? ' done' : '')}>
          <span className="ph-bar-dots">
            {stats.flags.map((f, i) => (
              <i key={i} className={f ? 'on' : ''} />
            ))}
          </span>
          <span className="ph-bar-tx">
            {stats.empty === 0
              ? 'every placeholder filled'
              : `${stats.filled}/${stats.total} filled`}
          </span>
          {stats.empty > 0 && (
            <button
              type="button"
              className="ph-bar-go"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                autoRef.current = true
                openPop(firstEmptyEl())
              }}
            >
              Fill next<kbd>⇥</kbd>
            </button>
          )}
        </div>
      )}

      {warn > 0 && (
        <div className="ph-warn" role="status">
          {warn} placeholder{warn === 1 ? '' : 's'} still need
          {warn === 1 ? 's' : ''} a value
        </div>
      )}

      {chip && pop && (
        <PhPopover
          // Keyed so switching chips remounts rather than inheriting the
          // previous blank's typed text and tick state.
          key={pop.id}
          chip={chip}
          pos={pop.pos}
          agents={agents}
          viewer={viewer}
          onPick={(v, keepOpen) => setChipValue(pop.id, v, keepOpen)}
          onClose={() => {
            autoRef.current = false
            setPop(null)
          }}
        />
      )}
    </div>
  )
}

const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(PromptEditorImpl)
export default PromptEditor

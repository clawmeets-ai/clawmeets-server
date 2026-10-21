import { useCallback, useEffect, useRef, useState } from 'react'

interface DragState {
  dragId: string | null
  overId: string | null
}

/** Hold time before a row-body press becomes a drag.
 *
 *  A click rests for ~80ms and a flick-scroll never rests at all, so this is
 *  comfortably clear of both; iOS uses ~500ms for its own long press and
 *  Android ~400, so it is also inside what a thumb already expects. */
const HOLD_MS = 420

/** Movement, in CSS px, that cancels a pending press. Past this the finger was
 *  scrolling or drag-selecting text, and that reading has to win — a rail you
 *  cannot scroll without picking up a row is worse than no long press. */
const SLOP_PX = 8

/**
 * Controls that own their own press, matched against the pointerdown target.
 *
 * `.todo-grip` is in here with the rest: it starts a drag IMMEDIATELY via
 * `startDrag`, and its pointerdown also bubbles to the row, so without the
 * exclusion one press would arm a second, competing timer on the row it just
 * picked up. The others each have a press of their own to spend — the checkbox
 * archives, `⋮` opens the menu, `+N` expands the label strip, and the rename
 * field needs caret placement and drag-select.
 */
const NO_ARM = '.todo-grip, .todo-check, .todo-actions, .lb-more, .todo-rename'

/** Painted on `<body>` for the duration of a drag: stops the rail panning and
 *  the page selecting while a finger is dragging a row across it. */
const DRAG_BODY_CLASS = 'todo-dragging'

/**
 * Pointer-based list reordering — one code path for mouse, touch & pen.
 *
 * TWO WAYS IN, ONE MACHINE.
 *   · startDrag(id, e) — from a grip's onPointerDown. Drags immediately.
 *   · armLongPress(id, e) — from the ROW's onPointerDown. Arms a HOLD_MS timer
 *     and only drags if the press outlives it without moving past SLOP_PX.
 * Both funnel into `begin()`, so the hit-test, the visual state and the commit
 * are identical however the drag started. The timer lives HERE rather than in a
 * standalone useLongPress the component composes, because arming and dragging
 * share one state machine: a press that fires must cancel cleanly if the drag
 * is cancelled, and a drag already in flight must refuse a second arm. Split
 * them and half the machine ends up in the component.
 *
 * Once begun: the pointer is captured, then window-level pointermove/up/cancel
 * listeners track the finger — elementFromPoint(x,y).closest('[data-todo-id]')
 * yields the row under the cursor (→ overId). On pointerup, if a different row
 * is under the finger, reorder(dragId, overId) fires. dragId/overId drive the
 * visual .dragging / .drag-over classes, the same contract the old native-DnD
 * state exposed; pressId drives the "about to lift" squeeze on the armed row.
 *
 * A ref mirrors {dragId,overId} so the window handlers read live values
 * without stale-closure re-binding. Listeners are torn down on up/cancel.
 */
export function usePointerReorder(
  reorder: (from: string, to: string) => void,
  opts?: {
    /** Which attribute the hit-test reads. Defaults to `data-todo-id`, so the
     *  to-do rail is unchanged; the manage sheet passes `data-label-slug`.
     *
     *  PARAMETERISED rather than loosened to a shared class ON PURPOSE: the
     *  sheet renders OVER the rail, and a shared selector would let
     *  elementFromPoint resolve a row on the surface underneath. The attribute
     *  split makes crossing surfaces impossible by construction. */
    attr?: string
    /** Fired when a drag begins, by either entry point, before any state moves.
     *
     *  Expanding a row's `+N` toggles it to `flex-wrap: wrap`, which CHANGES
     *  THE ROW'S HEIGHT — and the hit-test runs on every pointermove, so a row
     *  that grows mid-drag moves the drop target out from under the finger and
     *  the item lands one position off. The rail collapses every expansion
     *  here. Nothing in the type system or the existing tests would find it. */
    onDragStart?: () => void
    /** Hold time before a row-body press becomes a drag. Defaults to HOLD_MS. */
    holdMs?: number
    /** Movement that cancels a pending press, in CSS px. Defaults to SLOP_PX. */
    slopPx?: number
  },
): {
  dragId: string | null
  overId: string | null
  /** A press is being HELD on this row but has not become a drag yet. */
  pressId: string | null
  startDrag: (id: string, e: React.PointerEvent) => void
  /** Deferred sibling of startDrag: arms a hold timer instead of dragging now. */
  armLongPress: (id: string, e: React.PointerEvent) => void
} {
  const attr = opts?.attr ?? 'data-todo-id'
  const onDragStart = opts?.onDragStart
  const holdMs = opts?.holdMs ?? HOLD_MS
  const slopPx = opts?.slopPx ?? SLOP_PX
  const [state, setState] = useState<DragState>({ dragId: null, overId: null })
  const ref = useRef<DragState>(state)
  const [pressId, setPressId] = useState<string | null>(null)
  /** Everything a live arm or drag needs torn down. Held in a ref so unmount
   *  can run it: a rail that unmounts mid-drag (route change, filter wipe)
   *  would otherwise leave window listeners and `body.todo-dragging` behind,
   *  and a body that cannot scroll is a much louder bug than a lost drag. */
  const cleanup = useRef<(() => void) | null>(null)

  const commit = useCallback((next: DragState) => {
    ref.current = next
    setState(next)
  }, [])

  useEffect(() => () => cleanup.current?.(), [])

  /**
   * The drag proper. Extracted from the old body of `startDrag` so both entry
   * points share ONE machine — same capture, same listeners, same hit-test,
   * same reorder() on pointerup.
   *
   * `swallowClick` is what the long-press path needs and the grip does not: the
   * row body is a <button>, and the pointerup that ENDS a drag is followed by a
   * click on it, so without a one-shot capture-phase swallower dropping a row
   * would also load it into the message box as a parting gift. The swallower is
   * removed on a 0ms timeout after teardown — late enough that the trailing
   * click has already been eaten, early enough that a cancelled drag never eats
   * an unrelated one.
   */
  const begin = useCallback(
    (id: string, el: Element, pointerId: number, swallowClick: boolean) => {
      if (ref.current.dragId) return
      onDragStart?.()
      try {
        el.setPointerCapture(pointerId)
      } catch {
        /* capture is best-effort; hit-testing works without it */
      }
      commit({ dragId: id, overId: id })

      // A desktop hold over the task title starts a text selection before the
      // timer fires. Movement past SLOP_PX cancels the hold, so drag-selecting
      // still works; the hold-then-drag overlap resolves in favour of reorder,
      // which means clearing the range it started.
      try {
        window.getSelection()?.removeAllRanges()
      } catch {
        /* selection APIs are best-effort */
      }

      // THE RAIL MUST NOT PAN UNDER THE FINGER. The grip got this free from its
      // own `touch-action: none`; the row body cannot carry that rule or the
      // rail stops scrolling by finger entirely, so the lock is installed for
      // the duration of the drag instead — a non-passive touchmove preventer
      // plus the body class, two belts for the same trousers.
      const blockTouch = (ev: TouchEvent) => {
        if (ev.cancelable) ev.preventDefault()
      }
      window.addEventListener('touchmove', blockTouch, { passive: false })
      document.body.classList.add(DRAG_BODY_CLASS)

      const rowUnder = (x: number, y: number): string | null => {
        const el = document.elementFromPoint(x, y)
        return el?.closest(`[${attr}]`)?.getAttribute(attr) ?? null
      }

      function teardown() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('touchmove', blockTouch)
        document.body.classList.remove(DRAG_BODY_CLASS)
        cleanup.current = null
        if (!swallowClick) return
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation()
          ev.preventDefault()
        }
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      }

      const onMove = (ev: PointerEvent) => {
        const overId = rowUnder(ev.clientX, ev.clientY)
        if (overId && overId !== ref.current.overId) {
          commit({ dragId: ref.current.dragId, overId })
        }
      }
      const onUp = () => {
        teardown()
        const { dragId, overId } = ref.current
        if (dragId && overId && dragId !== overId) reorder(dragId, overId)
        commit({ dragId: null, overId: null })
      }
      const onCancel = () => {
        teardown()
        commit({ dragId: null, overId: null })
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      cleanup.current = () => {
        teardown()
        commit({ dragId: null, overId: null })
      }
    },
    [attr, commit, onDragStart, reorder],
  )

  /** Immediate activation — unchanged contract, called from a grip's
   *  onPointerDown. Now a thin wrapper over `begin`. */
  const startDrag = useCallback(
    (id: string, e: React.PointerEvent) => {
      // Primary button / touch / pen contact only.
      if (e.button !== 0) return
      e.preventDefault()
      begin(id, e.currentTarget as Element, e.pointerId, false)
    },
    [begin],
  )

  /**
   * Deferred activation — called from the ROW's onPointerDown.
   *
   * Disarms on: a press that lands on a control of its own, movement past
   * `slopPx`, pointerup before the timer, pointercancel, or a drag already in
   * flight. It deliberately does NOT preventDefault: a short press has to stay
   * an ordinary click so the row still loads into the message box, and a
   * pointerdown that turns into a scroll has to stay a scroll.
   */
  const armLongPress = useCallback(
    (id: string, e: React.PointerEvent) => {
      if (e.button !== 0) return
      if (ref.current.dragId) return
      if ((e.target as Element | null)?.closest?.(NO_ARM)) return

      const el = e.currentTarget as Element
      const { pointerId, clientX: x0, clientY: y0 } = e
      let timer: number | undefined

      const disarm = () => {
        if (timer !== undefined) window.clearTimeout(timer)
        timer = undefined
        window.removeEventListener('pointermove', onArmMove)
        window.removeEventListener('pointerup', onArmEnd)
        window.removeEventListener('pointercancel', onArmEnd)
        cleanup.current = null
        setPressId(null)
      }
      const onArmMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > slopPx) disarm()
      }
      const onArmEnd = () => disarm()

      setPressId(id)
      window.addEventListener('pointermove', onArmMove)
      window.addEventListener('pointerup', onArmEnd)
      window.addEventListener('pointercancel', onArmEnd)
      cleanup.current = disarm
      timer = window.setTimeout(() => {
        // Drop the arm listeners BEFORE begin() installs its own, so the
        // pointerup that ends the drag cannot also be read as "press released".
        disarm()
        begin(id, el, pointerId, true)
        navigator.vibrate?.(12)
      }, holdMs)
    },
    [begin, holdMs, slopPx],
  )

  return { dragId: state.dragId, overId: state.overId, pressId, startDrag, armLongPress }
}

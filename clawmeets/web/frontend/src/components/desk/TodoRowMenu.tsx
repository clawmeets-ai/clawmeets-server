import { useEffect, useRef, useState } from 'react'
import { MoreVertical, Tag, Trash2 } from 'lucide-react'

/** How close to the scroller's bottom edge the trigger has to be before the
 *  menu opens UPWARD instead. Roughly the popover's own height (two items +
 *  padding + the 4px offset) — below this the menu would be clipped by
 *  `.todo-scroll`'s `overflow-y: auto`. */
const FLIP_ZONE = 80

interface TodoRowMenuProps {
  /** Open the label popover, anchored to the ⋮ trigger. Absent ⇒ no Labels
   *  item — which is what the Archived drawer wants, and it gets a Delete-only
   *  menu for free. */
  onEditLabels?: (anchor: HTMLElement) => void
  /** Delete this to-do. */
  onRemove: () => void
  /** Menu opened / closed — lets the row pin its hover-revealed cluster
   *  visible, or moving the pointer into the popover fades its own trigger
   *  out from under it. */
  onOpenChange?: (open: boolean) => void
}

/**
 * The row's overflow menu. One ⋮ trigger; Labels and Delete live inside it.
 *
 * Two icons on every row cost ~34px of a narrow plate AT REST — the touch
 * branch renders `.todo-actions` as a real flex child rather than an absolute
 * overlay — and on desktop the hover scrim over the title is that much wider.
 * One trigger halves both.
 *
 * A `<div>` + absolutely-positioned popover, NOT a portal: the row is already
 * `position: relative`, and the label popover this hands off to is itself
 * rail-anchored, so a portal would buy nothing and lose the scroll-with-row
 * behaviour. What it costs instead is clipping at the scroller's edges, which
 * is what `up` is for.
 *
 * Every handler stops propagation. The cluster sits OUTSIDE `BodyShell` so
 * there is no button-in-button, but the row's own click still loads the item
 * into the message box and must not fire from in here.
 */
export default function TodoRowMenu({ onEditLabels, onRemove, onOpenChange }: TodoRowMenuProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  /** Open upward — the trigger is near the bottom of `.todo-scroll`. */
  const [up, setUp] = useState(false)

  const set = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  // Close on a pointerdown anywhere outside, and on Escape — which also puts
  // focus back on the trigger, so a keyboard user is not dropped at the top of
  // the document. `pointerdown` rather than `click` so the menu is gone before
  // whatever was pressed underneath reacts. Registered only while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) set(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      set(false)
      trigger.current?.focus()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** Decide the direction at OPEN time, not on every render: the rail scrolls
   *  under an open menu and a mid-flight flip would be worse than a clip. */
  const toggle = () => {
    if (!open) {
      const el = trigger.current
      const scroller = el?.closest('.todo-scroll')
      if (el && scroller) {
        setUp(scroller.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom < FLIP_ZONE)
      }
    }
    set(!open)
  }

  /** Run an item's action with the menu closed first, so the row's `is-menu`
   *  pin is released before anything the action opens takes focus. */
  const pick = (run: () => void) => {
    set(false)
    run()
  }

  return (
    <div className={'todo-menu' + (open ? ' open' : '')} ref={wrap}>
      <button
        ref={trigger}
        className="todo-act todo-act--menu"
        title="More"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
      >
        <MoreVertical size={14} />
      </button>

      {open && (
        <div className={'todo-menu-pop' + (up ? ' up' : '')} role="menu">
          {onEditLabels && (
            <button
              className="todo-menu-item"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                // The TRIGGER is the anchor, not this item — the popover has
                // to line up under the ⋮ the row still shows once the menu is
                // gone, and this element unmounts on the very next frame.
                const anchor = trigger.current
                pick(() => anchor && onEditLabels(anchor))
              }}
            >
              <Tag size={13} />
              Labels
            </button>
          )}
          <button
            className="todo-menu-item danger"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation()
              pick(onRemove)
            }}
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

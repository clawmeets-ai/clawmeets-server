import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'

// Shared frame for every rail context panel: a title header with an optional
// context-specific add (`+`) action, over a scroll surface.
export default function PanelShell({
  title,
  addTo,
  onAdd,
  addLabel,
  onNavigate,
  children,
}: {
  title: string
  /** route the `+` button links to; omitted → no add button. */
  addTo?: string
  /** click handler for the `+` button (alternative to `addTo`, e.g. open palette). */
  onAdd?: () => void
  addLabel?: string
  onNavigate?: () => void
  children: React.ReactNode
}) {
  const addClass =
    'inline-flex p-1 rounded-md text-ink-3 hover:bg-sidebar-hover hover:text-ink-1 transition-colors'
  return (
    <div className="flex flex-col flex-1 min-w-0 h-full bg-sidebar">
      <div className="flex items-center gap-2 px-3.5 pt-[15px] pb-1">
        <h2 className="flex-1 text-[15px] font-extrabold text-ink-1 truncate">{title}</h2>
        {addTo ? (
          <Link
            to={addTo}
            onClick={() => onNavigate?.()}
            className={addClass}
            title={addLabel ?? 'Add'}
            aria-label={addLabel ?? 'Add'}
          >
            <Plus className="w-4 h-4" />
          </Link>
        ) : onAdd ? (
          <button onClick={onAdd} className={addClass} title={addLabel ?? 'Add'} aria-label={addLabel ?? 'Add'}>
            <Plus className="w-4 h-4" />
          </button>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain scrollbar-thin pb-2">{children}</div>
    </div>
  )
}

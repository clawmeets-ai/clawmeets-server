import { ChevronDown } from 'lucide-react'

interface ExpandToggleProps {
  expanded: boolean
  onToggle: () => void
  /** Label while collapsed. Callers append detail, e.g. "Show more · 4,312 chars". */
  moreLabel?: string
  lessLabel?: string
  className?: string
}

/**
 * The single "Show more / Show less" affordance, shared by chat messages, desk
 * cards, and the activity feed. A pill rather than a bare link so the control
 * reads as a button at a glance and matches the accent pills used elsewhere
 * (composer, catalogs).
 */
export default function ExpandToggle({
  expanded,
  onToggle,
  moreLabel = 'Show more',
  lessLabel = 'Show less',
  className,
}: ExpandToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={
        'mt-1.5 inline-flex items-center gap-1 rounded-full border border-purple-200 ' +
        'bg-white px-2.5 py-1 text-[11px] font-medium text-accent-deep transition-colors ' +
        'hover:border-purple-300 hover:bg-purple-50 focus:outline-none ' +
        'focus-visible:ring-2 focus-visible:ring-purple-500/40' +
        (className ? ' ' + className : '')
      }
    >
      <ChevronDown
        aria-hidden
        className={'w-3 h-3 transition-transform ' + (expanded ? 'rotate-180' : '')}
      />
      {expanded ? lessLabel : moreLabel}
    </button>
  )
}

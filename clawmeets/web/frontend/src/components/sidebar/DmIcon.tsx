import { Clock, MessageSquare } from 'lucide-react'

interface DmIconProps {
  /** Overlay the scheduled-messages clock badge (isScheduledDMProject). */
  scheduled?: boolean
  /** px size of the base bubble — matches the MessageSquare it replaces. */
  size?: number
  /** class(es) for the base bubble (color, etc.). */
  className?: string
  /**
   * Background the badge is ringed in, so the clock reads as sitting *on top of*
   * the bubble rather than merging into its strokes. Default is the sidebar bg.
   */
  ringColor?: string
}

// The DM bubble icon, defined once so every surface (DMs rail, My Desk, …)
// renders it identically. A scheduled-messages DM thread gets a small Clock
// badge overlaid on the bottom-right corner, ringed in the surface bg.
export default function DmIcon({
  scheduled = false,
  size = 14,
  className = 'text-ink-3',
  ringColor = 'var(--bg-sidebar)',
}: DmIconProps) {
  const badge = Math.round(size * 0.68)
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <MessageSquare className={`w-full h-full ${className}`} />
      {scheduled && (
        <span
          className="absolute -bottom-1 -right-1 inline-flex items-center justify-center rounded-full"
          style={{ width: badge, height: badge, backgroundColor: ringColor }}
          title="Scheduled messages thread"
          aria-label="Scheduled messages thread"
        >
          <Clock
            className="text-accent"
            strokeWidth={2.75}
            style={{ width: badge - 1.5, height: badge - 1.5 }}
          />
        </span>
      )}
    </span>
  )
}

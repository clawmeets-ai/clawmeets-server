import { AgentStatus } from '../../types'

interface AvatarProps {
  name: string
  status?: AgentStatus
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** Color of the ring separating the presence dot from what's behind it.
   *  Defaults to the white content surface every current consumer sits on. */
  ringColor?: string
}

const statusColors: Record<AgentStatus, string> = {
  [AgentStatus.ONLINE]: 'bg-green-500',
  [AgentStatus.OFFLINE]: 'bg-[var(--av-offline)]',
  [AgentStatus.BUSY]: 'bg-yellow-500',
  [AgentStatus.RATE_LIMITED]: 'bg-orange-500',
}

/** The box classes live on the *outer* element, which is what the presence dot is
 *  positioned against. Sizing only the inner tile would leave the wrapper's height
 *  `auto`, and a flex row's default `align-items: stretch` would then stretch it to
 *  the row's full height — dropping the dot to the bottom of a whole chat message. */
const sizeClasses = {
  xs: 'w-5 h-5 text-[10px]',
  sm: 'w-6 h-6 text-xs',
  md: 'w-8 h-8 text-sm',
  lg: 'w-10 h-10 text-base',
}

/** Presence-dot geometry in px, not Tailwind classes: the ring is drawn OUTWARD
 *  with box-shadow (same as `SidebarAvatar`) so the whole diameter stays colored.
 *  A `border-2` sits *inside* the box instead, which left the xs dot — the desk
 *  cards and the composer chip — with a 2px core out of 6px. */
const indicatorSizes = {
  xs: { d: 7, off: -2 },
  sm: { d: 8, off: -2 },
  md: { d: 10, off: -2 },
  lg: { d: 12, off: -3 },
}

function getInitials(name: string): string {
  return name
    .split(/[-_\s]/)
    .map((part) => part[0]?.toUpperCase() || '')
    .slice(0, 2)
    .join('')
}

function getColor(name: string): string {
  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-indigo-500',
    'bg-teal-500',
    'bg-orange-500',
    'bg-cyan-500',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
}

export default function Avatar({
  name,
  status,
  size = 'md',
  ringColor = 'var(--bg-card)',
}: AvatarProps) {
  const initials = getInitials(name)
  const bgColor = getColor(name)
  const dot = indicatorSizes[size]

  return (
    <div className={`relative inline-block shrink-0 ${sizeClasses[size]}`}>
      <div
        className={`
          w-full h-full ${bgColor}
          rounded-full flex items-center justify-center
          text-white font-medium
        `}
      >
        {initials}
      </div>
      {status && (
        <span
          className={`absolute rounded-full ${statusColors[status]}`}
          style={{
            width: dot.d,
            height: dot.d,
            right: dot.off,
            bottom: dot.off,
            boxShadow: `0 0 0 2px ${ringColor}`,
          }}
        />
      )}
    </div>
  )
}

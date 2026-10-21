import { AgentStatus } from '../../types'

// Rounded-square solid-color tile with white 800-weight initials and an
// optional presence dot — the sidebar avatar spec from the design handoff.
// (common/Avatar is a circle using stock Tailwind colors; this one is square
// and maps onto the `--av-*` design tokens.)

const AV_TOKENS = [
  '--av-pink',
  '--av-teal',
  '--av-green',
  '--av-amber',
  '--av-indigo',
  '--av-slate',
] as const

export function colorFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return `var(${AV_TOKENS[Math.abs(hash) % AV_TOKENS.length]})`
}

function initialsFor(name: string): string {
  return name
    .split(/[-_\s]/)
    .map((part) => part[0]?.toUpperCase() || '')
    .slice(0, 2)
    .join('')
}

/** Presence-dot color by agent status (green online / amber rate-limited / muted). */
export function statusDotColor(status?: AgentStatus): string {
  if (status === AgentStatus.ONLINE) return 'var(--av-green)'
  if (status === AgentStatus.RATE_LIMITED) return 'var(--av-amber)'
  return 'var(--av-offline)'
}

interface SidebarAvatarProps {
  name: string
  size?: number
  /** show the presence dot (bottom-right). */
  dot?: boolean
  /** dot color; defaults to the online green. */
  dotColor?: string
  /** ring color around the dot / for overlapped stacks; defaults to the sidebar fill. */
  ringColor?: string
  /** fixed tile color (e.g. `var(--av-slate)`); defaults to a per-name hash. */
  color?: string
  className?: string
}

export default function SidebarAvatar({
  name,
  size = 21,
  dot = false,
  dotColor = 'var(--av-green)',
  ringColor = 'var(--bg-sidebar)',
  color,
  className = '',
}: SidebarAvatarProps) {
  const dotSize = Math.max(7, Math.round(size * 0.32))
  return (
    <span
      className={`relative inline-block flex-shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <span
        className="flex items-center justify-center w-full h-full font-extrabold text-white select-none"
        style={{
          backgroundColor: color ?? colorFor(name),
          borderRadius: size <= 18 ? 4 : 7,
          fontSize: Math.round(size * 0.42),
          lineHeight: 1,
        }}
      >
        {initialsFor(name)}
      </span>
      {dot && (
        <span
          className="absolute rounded-full"
          style={{
            width: dotSize,
            height: dotSize,
            right: -dotSize * 0.25,
            bottom: -dotSize * 0.25,
            backgroundColor: dotColor,
            boxShadow: `0 0 0 2px ${ringColor}`,
          }}
        />
      )}
    </span>
  )
}

/** Overlapped 3-avatar preview used in collapsed team headers. */
export function SidebarAvatarStack({
  names,
  size = 16,
  max = 3,
  ringColor = 'var(--bg-sidebar)',
}: {
  names: string[]
  size?: number
  max?: number
  ringColor?: string
}) {
  const shown = names.slice(0, max)
  return (
    <span className="inline-flex items-center">
      {shown.map((n, i) => (
        <span
          key={n + i}
          style={{
            marginLeft: i === 0 ? 0 : -6,
            borderRadius: size <= 18 ? 4 : 7,
            boxShadow: `0 0 0 2px ${ringColor}`,
            zIndex: shown.length - i,
          }}
          className="inline-block"
        >
          <SidebarAvatar name={n} size={size} ringColor={ringColor} />
        </span>
      ))}
    </span>
  )
}

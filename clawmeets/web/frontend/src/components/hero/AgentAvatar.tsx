interface AgentAvatarProps {
  glyph: string
  color: string
  size?: number
  /**
   * 'round'  — standard round avatar
   * 'cs'     — "coordinator/assistant" marker: round avatar with a sparkle (✦) badge
   *            at the bottom-right. Matches the handoff `.av-cs` treatment.
   */
  variant?: 'round' | 'cs'
  active?: boolean
  ringColor?: string
}

export default function AgentAvatar({
  glyph,
  color,
  size = 28,
  variant = 'round',
  active = false,
  ringColor = 'var(--bg-sidebar)',
}: AgentAvatarProps) {
  const fontSize = size <= 22 ? 10 : size <= 28 ? 11 : 12
  const dot = Math.max(7, Math.round(size * 0.28))
  const badgeSize = Math.max(11, Math.round(size * 0.44))

  return (
    <span
      className="relative inline-grid place-items-center font-extrabold text-white font-mono shrink-0 rounded-full"
      style={{ width: size, height: size, fontSize, background: color }}
    >
      {glyph}
      {variant === 'cs' && (
        <span
          className="absolute grid place-items-center rounded-full bg-white"
          style={{
            right: -2,
            bottom: -2,
            width: badgeSize,
            height: badgeSize,
            color: 'var(--accent)',
            fontSize: Math.max(8, Math.round(badgeSize * 0.72)),
            boxShadow: '0 0 0 1px var(--line-2)',
            lineHeight: 1,
          }}
          aria-hidden="true"
        >
          ✦
        </span>
      )}
      {active && (
        <span
          className="absolute rounded-full"
          style={{
            right: -2,
            bottom: -2,
            width: dot,
            height: dot,
            background: 'var(--prio-quick-fg)',
            border: `1.5px solid ${ringColor}`,
          }}
        />
      )}
    </span>
  )
}

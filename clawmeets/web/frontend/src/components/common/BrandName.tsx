interface BrandNameProps {
  className?: string
}

/**
 * Styled product name: "Claw" in ink + "Meets" in accent purple.
 * Two colors, no ".ai" suffix — the product name is "ClawMeets".
 */
export default function BrandName({ className = '' }: BrandNameProps) {
  return (
    <span className={className}>
      <span style={{ color: 'var(--ink-1)' }}>Claw</span>
      <span style={{ color: 'var(--accent)' }}>Meets</span>
    </span>
  )
}

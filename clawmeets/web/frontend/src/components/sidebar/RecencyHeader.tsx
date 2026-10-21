// Outer-level recency divider (Today / Last 7 Days / Other). Styled a notch
// stronger than DmsPanel's inner owner SectionHeader — brighter, heavier label
// with a hairline top rule — so the two grouping levels read as distinct.
// Presentational only; the first header drops its top rule so the panel doesn't
// open with a stray line above it.
export default function RecencyHeader({ label, first }: { label: string; first?: boolean }) {
  return (
    <div
      className={`px-3 pb-1 text-[11px] font-extrabold uppercase tracking-[0.1em] text-ink-3 ${
        first ? 'pt-1' : 'pt-2.5 mt-1'
      }`}
      style={first ? undefined : { borderTop: '1px solid var(--line-1)' }}
    >
      {label}
    </div>
  )
}

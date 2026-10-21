import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, type LucideIcon } from 'lucide-react'
import type { AgentSampleRequest } from '../../hooks/useAgentSampleRequests'
import { collapsePlaceholders } from './SampleRequestBody'
import { STARTER_ICONS } from './assistantStarterSamples'
import './sampleIdeaList.css'

// One-line idea rows, shared by the My Desk and assistant-DM zero states.
//
// Replaces the two-column card grid that rendered all six prompt bodies at
// once (~120 words above the fold, composer pushed off the top of the screen).
// A row shows only the request as a single sentence; the full body previews as
// ghost text INSIDE the composer on hover — the surface where the user will
// edit it anyway — and clicking fills the composer for real.
//
// Preview vs fill is the whole design: hover is free and reversible, click
// commits. On touch there is no hover, so a tap fills directly with no preview
// step (see `useHoverCapable`).

/**
 * Flatten a sample body for display as CSS `content`. Collapses
 * `[Slot: default]` to `default` (same resolution the old card's send button
 * did), strips `**file**` emphasis to bare words, and folds newlines into
 * single spaces. Markdown can't render inside a pseudo-element, and a preview
 * shouldn't show raw syntax.
 */
export function toPlainPreview(request: string): string {
  return collapsePlaceholders(request)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}

/**
 * True when the device has a real hover-capable pointer. `matchMedia`, not a
 * user-agent sniff, so a touchscreen laptop with a mouse still gets previews
 * and an iPad doesn't. Subscribed rather than sampled once, so plugging in a
 * mouse takes effect without a reload.
 */
function useHoverCapable(): boolean {
  const [hoverCapable, setHoverCapable] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: hover)').matches
      : true,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(hover: hover)')
    const onChange = () => setHoverCapable(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return hoverCapable
}

/**
 * One idea. A real `<button>`, so Enter/Space activation, focus order and
 * disabled-state semantics come from the platform rather than from a role
 * attribute. Pointer-enter and focus preview; pointer-leave and blur clear;
 * activation fills and clears. Preview is suppressed entirely when the pointer
 * can't hover, so a tap never leaves a dangling ghost behind.
 */
function IdeaRow({
  sample,
  Icon,
  hoverCapable,
  onUse,
  onPreview,
}: {
  sample: AgentSampleRequest
  Icon: LucideIcon
  hoverCapable: boolean
  onUse: () => void
  onPreview: (text: string | null) => void
}) {
  const preview = hoverCapable ? () => onPreview(toPlainPreview(sample.request)) : undefined
  const clear = hoverCapable ? () => onPreview(null) : undefined
  return (
    <li>
      <button
        type="button"
        className="si-row"
        onMouseEnter={preview}
        onMouseLeave={clear}
        onFocus={preview}
        onBlur={clear}
        onClick={() => {
          onPreview(null)
          onUse()
        }}
        title={hoverCapable ? undefined : toPlainPreview(sample.request)}
      >
        <span className="si-row-ic" aria-hidden>
          <Icon size={15} />
        </span>
        <span className="si-row-t">{sample.title}</span>
      </button>
    </li>
  )
}

export interface SampleIdeaListProps {
  samples: AgentSampleRequest[]
  /**
   * Click / Enter / Space — fill the composer for real. Receives the
   * placeholder-collapsed body, so callers no longer call collapsePlaceholders
   * themselves.
   */
  onUse: (text: string) => void
  /**
   * Hover / focus — preview only. Called with null on mouseleave, blur, use
   * and unmount. Omit on a surface with no composer to preview into.
   */
  onPreview?: (text: string | null) => void
  /**
   * Section eyebrow above the rows. Omit to render bare rows — the desk zero
   * state already has a heading, and a second one directly under it reads as
   * a duplicate.
   */
  label?: string
  className?: string
}

/**
 * The list. Clears any live preview on unmount, because navigating away
 * mid-hover fires no mouseleave and would strand ghost text in a composer the
 * user has moved on from. Activation is announced through a visually-hidden
 * live region: the ghost itself is pseudo-element content, which screen
 * readers do not report. Hover/focus preview stays deliberately silent —
 * announcing on every arrow-key move would make the list unusable by voice.
 */
export default function SampleIdeaList({
  samples,
  onUse,
  onPreview,
  label,
  className,
}: SampleIdeaListProps) {
  const hoverCapable = useHoverCapable()
  const [announced, setAnnounced] = useState('')

  // Mirrored so the unmount cleanup below can stay a mount-once effect without
  // re-running (and re-clearing the composer) whenever the parent re-renders.
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview
  useEffect(() => () => onPreviewRef.current?.(null), [])

  const preview = useCallback((text: string | null) => onPreviewRef.current?.(text), [])

  if (samples.length === 0) return null

  return (
    <section className={'si-wrap' + (className ? ' ' + className : '')}>
      {label && (
        <div className="si-head">
          <span className="si-head-t">{label}</span>
          <span className="si-head-line" />
        </div>
      )}
      <ul className="si-list">
        {samples.map((s, i) => (
          <IdeaRow
            key={`${i}:${s.title}`}
            sample={s}
            Icon={STARTER_ICONS[s.title] ?? Sparkles}
            hoverCapable={hoverCapable}
            onPreview={preview}
            onUse={() => {
              setAnnounced(`Composer filled with: ${s.title}`)
              onUse(collapsePlaceholders(s.request))
            }}
          />
        ))}
      </ul>
      <span className="si-sr" role="status" aria-live="polite">
        {announced}
      </span>
    </section>
  )
}

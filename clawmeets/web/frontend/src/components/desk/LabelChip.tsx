import { X } from 'lucide-react'
import type { ResolvedLabel } from '../../utils/labelView'
import { displayName, sigil } from '../../utils/labelView'

/**
 * One label chip.
 *
 * THREE TREATMENTS, and the third is the one that is easy to get wrong:
 *
 *  - REGISTERED — palette colour, an OUTLINE pill with a leading `@`. One kind
 *    left, so one treatment: the FILLED `!` pill retired with the state axis,
 *    along with the second key it taught. The `@` is still the key you press to
 *    reach labels in the capture box, so the chip still teaches the keystroke.
 *
 *    A TICKET STATE IS NOT ONE OF THESE and never passes through here — it is
 *    `TicketChip`, which imports neither this file nor `labelView`.
 *  - UNREGISTERED — a slug an agent or a voice edit wrote that the owner's
 *    registry does not have. Accepted on the wire, but it must READ as
 *    unregistered, and the channel is the BORDER STYLE, not a grey fill: grey
 *    is `slate`, a real palette token the owner can legitimately choose. Three
 *    redundant channels, none of them hue — dashed border, ink-3 text where a
 *    colour would be, trailing `+`.
 *  - UNKNOWN (the registry did not load) — a plain, solid, neutral pill.
 *    Explicitly NOT the dashed treatment: under a lost registry every slug
 *    would otherwise fall through to "unregistered" and the "not in your list"
 *    signal would fire on the owner's whole vocabulary at once, each chip
 *    offering an "add it" that POSTs and earns `labels.duplicate`. No sigil
 *    either — a sigil is a claim about the axis, and we cannot read the axis.
 *    Reads as "labels are unavailable" (true) rather than "your labels don't
 *    exist" (a lie).
 */

export interface LabelChipProps {
  /** Always resolved — never a bare slug. `resolveLabel` is total, so there is
   *  no case where a caller has to invent one. */
  label: ResolvedLabel
  /** `sm` is the 9.5px row chip; `md` is the take-over, the sheet and the
   *  vocabulary strips. */
  size?: 'sm' | 'md'
  /** This chip is WHY the row matched the active filter: rendered first and
   *  ringed, so a filter can never hide the reason a row is on screen. */
  pinned?: boolean
  /** Filter popover / picker state. */
  selected?: boolean
  onClick?: (l: ResolvedLabel) => void
  /** Present ⇒ an ✕ affordance (the take-over editor and the row popover). */
  onRemove?: (l: ResolvedLabel) => void
  title?: string
}

export default function LabelChip({
  label,
  size = 'sm',
  pinned,
  selected,
  onClick,
  onRemove,
  title,
}: LabelChipProps) {
  const unknown = label.kind === 'unknown'
  const unregistered = !unknown && !label.registered

  const cls = [
    'lb',
    unknown ? 'unk' : unregistered ? 'unreg' : 'ctx',
    size === 'md' ? 'lg' : '',
    pinned ? 'pin' : '',
    selected ? 'sel' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // `color: null` on a REGISTERED row is the neutral default fill — never the
  // dashed border, which means unregistered and would mislabel a row the
  // server did register (auto-registration writes exactly that shape).
  const style =
    unknown || unregistered || !label.color
      ? undefined
      : {
          color: `var(--lb-${label.color}-fg)`,
          borderColor: `var(--lb-${label.color}-fg)55`,
          background: '#fff',
        }

  const aria = unknown
    ? `${label.slug} — your label list hasn't loaded`
    : unregistered
      ? `${displayName(label)}, not in your label list`
      : `${displayName(label)}, ${label.kind} label`

  const body = (
    <>
      {!unknown && <span className="lb-at">{sigil(label)}</span>}
      <span className="lb-t">{label.name}</span>
      {unregistered && (
        <span className="lb-add" aria-hidden="true">
          +
        </span>
      )}
    </>
  )

  // With an ✕ the chip cannot be a <button> — a button inside a button is
  // invalid and the nested click never fires in Safari.
  if (onRemove) {
    return (
      <span className={cls + ' has-x'} style={style} title={title} data-lb={label.slug}>
        {body}
        <button
          className="lb-x"
          onClick={(e) => {
            e.stopPropagation()
            onRemove(label)
          }}
          aria-label={`Remove ${displayName(label)}`}
        >
          <X size={9} />
        </button>
      </span>
    )
  }

  if (!onClick) {
    return (
      <span className={cls} style={style} title={title} data-lb={label.slug} aria-label={aria}>
        {body}
      </span>
    )
  }

  return (
    <button
      className={cls}
      style={style}
      title={title}
      data-lb={label.slug}
      aria-label={aria}
      aria-pressed={selected}
      onClick={(e) => {
        e.stopPropagation()
        onClick(label)
      }}
    >
      {body}
    </button>
  )
}

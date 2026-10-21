import { OUTSIDE_COPY } from '../../utils/agentAccessCopy'

/** "outside" beside a sender or a file: content from someone outside the
 *  owner's account (utils/roomTrust). */
export default function OutsideBadge({ label = OUTSIDE_COPY.badge, title = OUTSIDE_COPY.badgeTitle }: {
  label?: string
  title?: string
}) {
  return (
    <span
      className="px-1.5 rounded bg-amber-50 text-amber-800 text-[10px] font-semibold uppercase tracking-wide"
      title={title}
      data-testid="outside-badge"
    >
      {label}
    </span>
  )
}

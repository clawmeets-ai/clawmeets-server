import { ArrowRight, CalendarClock, Pencil, Trash2 } from 'lucide-react'
import type { AgentCard } from '../../types'
import type { DeskSop } from '../../api/endpoints/deskSops'
import type { ScheduledMessage } from '../../api/endpoints/scheduledMessages'
import { useAuthStore } from '../../stores/authStore'
import { displayName } from '../../utils/agentDisplay'
import { splitSopTitle } from '../../utils/sopSection'
import { PH_TAGS, placeholderBlanks } from '../composer/placeholders'
import Avatar from '../common/Avatar'

interface SopItemProps {
  sop: DeskSop
  /** Last one loaded into the composer — gets the accent ring. */
  active: boolean
  /** Resolved by the rail so every row agrees on who this goes to. */
  recipient: AgentCard | null
  onUse: (sop: DeskSop) => void
  onEdit: (sop: DeskSop) => void
  onDelete: (sop: DeskSop) => void
  /** Draft the "put this on a cadence" request into the composer. */
  onSchedule: (sop: DeskSop) => void
  /** The recurring message that fires this SOP, if one exists. Recovered from
   *  the schedule's marker (see utils/sopSchedule), not from storage. */
  schedule: ScheduledMessage | null
  /** Print the title's section prefix on the card. Set for rows listed
   *  OUTSIDE their own section — only "Recently used" — where the heading
   *  above them no longer supplies it. */
  showSection?: boolean
}

const MAX_PREVIEW_BLANKS = 3

/**
 * One stored prompt in the rail. Clicking it loads the body into the desk
 * composer as fillable chips, addressed to its usual recipient.
 *
 * The card shows the title MINUS its section prefix, because the heading it
 * sits under already says "Marketing" and repeating it on every row buys
 * nothing. `utils/sopSection.ts` owns that split so the rail's grouping and
 * this label can never disagree about where the prefix ends.
 *
 * The root is a div[role=button], NOT a <button>: the hover cluster holds
 * real buttons, and nesting interactive elements inside a button is invalid
 * and breaks keyboard semantics.
 */
export default function SopItem({
  sop,
  active,
  recipient,
  onUse,
  onEdit,
  onDelete,
  onSchedule,
  schedule,
  showSection = false,
}: SopItemProps) {
  const { user } = useAuthStore()
  const blanks = placeholderBlanks(sop.body)
  const label = recipient ? displayName(recipient, user) : sop.agent_name
  const { section, name } = splitSopTitle(sop.title)

  const use = () => onUse(sop)
  // Next fire in the reader's own timezone — the cron itself is stored in UTC,
  // and a raw "0 13 * * *" is not something a manager should have to decode.
  const nextRun = schedule
    ? new Date(schedule.next_fire_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''

  return (
    <div
      className={'sop-item' + (active ? ' active' : '')}
      role="button"
      tabIndex={0}
      onClick={use}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          use()
        }
      }}
      title="Load into the message box"
    >
      <div className="sop-title">
        {showSection && section && <span className="sop-sec">{section}</span>}
        {name}
      </div>

      <div className="sop-f">
        <span className="sop-to">
          {label ? (
            <>
              <Avatar name={label} status={recipient?.status} size="xs" />@{label}
            </>
          ) : (
            <span className="sop-to-none">no recipient</span>
          )}
        </span>
        <span className="sop-fields">
          {schedule && (
            <span
              className="sop-ph sop-cron"
              title={`Runs ${schedule.cron_expression} (${schedule.timezone}) — next ${nextRun}`}
            >
              <i className="ph-k">
                <CalendarClock size={10} />
              </i>
              {nextRun}
            </span>
          )}
          {blanks.slice(0, MAX_PREVIEW_BLANKS).map((c) => (
            <span className="sop-ph" key={c.id}>
              <i className="ph-k">{PH_TAGS[c.kind]}</i>
              {c.label}
            </span>
          ))}
          {blanks.length > MAX_PREVIEW_BLANKS && (
            <span className="sop-more">+{blanks.length - MAX_PREVIEW_BLANKS}</span>
          )}
        </span>
      </div>

      <div className="sop-hov">
        <button
          type="button"
          className="sop-act"
          title={schedule ? 'Change the schedule' : 'Schedule this SOP'}
          aria-label={`Schedule ${name}`}
          onClick={(e) => {
            e.stopPropagation()
            onSchedule(sop)
          }}
        >
          <CalendarClock size={13} />
        </button>
        <button
          type="button"
          className="sop-act"
          title="Edit"
          aria-label={`Edit ${name}`}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(sop)
          }}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="sop-act"
          title="Delete"
          aria-label={`Delete ${name}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(sop)
          }}
        >
          <Trash2 size={13} />
        </button>
        <span className="sop-use">
          Use
          <ArrowRight size={12} />
        </span>
      </div>
    </div>
  )
}

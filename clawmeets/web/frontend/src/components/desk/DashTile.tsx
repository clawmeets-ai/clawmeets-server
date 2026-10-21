import { Clock, ExternalLink, Plus, X } from 'lucide-react'
import Avatar from '../common/Avatar'
import { useAgents } from '../../hooks/useAgents'
import { findAgent } from '../../utils/agentDisplay'
import { formatInTz, formatRelativeTime } from '../../utils/formatDate'
import type { BriefTab } from '../../api/endpoints/briefTabs'
import type { ScheduledMessage } from '../../api/endpoints/scheduledMessages'

// One briefing tile in the Scheduled-briefings strip. Only backend-available
// fields are shown — the design's KPI/spark/delta are skipped (no source). If a
// refresh schedule is found it shows the next fire + a cancel control; otherwise
// an "Add schedule" affordance.
export default function DashTile({
  tab,
  schedule,
  onOpen,
  onAddSchedule,
  onCancelSchedule,
}: {
  tab: BriefTab
  schedule?: ScheduledMessage
  onOpen: (slug: string) => void
  onAddSchedule: (tab: BriefTab) => void
  onCancelSchedule: (id: string) => void
}) {
  const { data: agents } = useAgents()
  const owner = findAgent(agents, { id: tab.owner_agent_id, name: tab.owner_agent_name })

  return (
    <div className="md-dash" onClick={() => onOpen(tab.slug)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(tab.slug) }}>
      <div className="md-dash-h">
        <span className="md-dash-name">{tab.title || tab.slug}</span>
        <span className="md-dash-open"><ExternalLink size={13} /></span>
      </div>

      <div className="md-dash-f">
        <Avatar name={tab.owner_agent_name} status={owner?.status} size="xs" />
        <span className="md-dash-by mono">@{tab.owner_agent_name}</span>
        <span className="md-dash-ago" style={{ fontSize: 10, color: 'var(--ink-4)' }}>
          {formatRelativeTime(tab.generated_at)}
        </span>
      </div>

      {schedule ? (
        <div className="md-dash-sched">
          <Clock size={11} />
          <span className="mono">
            {formatInTz(schedule.next_fire_at, schedule.timezone, {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
          <button
            className="md-dash-sched-x"
            title="Cancel this refresh schedule"
            onClick={(e) => {
              e.stopPropagation()
              onCancelSchedule(schedule.id)
            }}
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <button
          className="md-dash-add"
          onClick={(e) => {
            e.stopPropagation()
            onAddSchedule(tab)
          }}
        >
          <Plus size={12} />
          Add refresh schedule
        </button>
      )}
    </div>
  )
}

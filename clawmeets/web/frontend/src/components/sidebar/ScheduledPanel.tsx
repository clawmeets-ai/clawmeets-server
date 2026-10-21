import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { getScheduledMessages } from '../../api/endpoints/scheduledMessages'
import { formatInTz } from '../../utils/formatDate'
import ScheduleMessageModal from '../scheduled/ScheduleMessageModal'
import PanelShell from './PanelShell'

// Scheduled context: the user's active scheduled messages as rows, each linking
// to the full Scheduled page.
export default function ScheduledPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuthStore()
  const navigate = useNavigate()
  const [showModal, setShowModal] = useState(false)
  const { data: schedules, isLoading } = useQuery({
    queryKey: ['scheduled-messages'],
    queryFn: () => getScheduledMessages(true),
    enabled: !!user,
    refetchInterval: 30000,
  })

  const open = () => {
    navigate('/scheduled')
    onNavigate?.()
  }

  return (
    <PanelShell
      title="Scheduled"
      onAdd={() => setShowModal(true)}
      addLabel="New scheduled message"
      onNavigate={onNavigate}
    >
      {showModal && <ScheduleMessageModal onClose={() => setShowModal(false)} />}
      <div className="px-1.5 pt-1">
        {!isLoading && (schedules?.length ?? 0) === 0 && (
          <div className="px-3 py-2 text-sidebar-text text-xs opacity-75">No scheduled messages</div>
        )}
        {schedules?.map((s) => (
          <button
            key={s.id}
            onClick={open}
            className="flex items-center gap-2 pl-3 pr-4 py-1.5 w-full text-left rounded hover:bg-sidebar-hover transition-colors text-sidebar-text"
            title={s.content}
          >
            <Clock className="w-3.5 h-3.5 text-channel flex-shrink-0" />
            <span className="truncate text-[13px] flex-1">{s.content || '(scheduled message)'}</span>
            <span className="font-mono text-[10.5px] text-ink-4 flex-shrink-0" title={s.cron_expression}>
              {formatInTz(s.next_fire_at, s.timezone, { hour: 'numeric', minute: '2-digit', hour12: true })}
            </span>
          </button>
        ))}
      </div>
    </PanelShell>
  )
}

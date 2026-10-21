import { useMemo, useState } from 'react'
import { X, Clock } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getScheduledMessages,
  cancelScheduledMessage,
} from '../../api/endpoints/scheduledMessages'
import type { ScheduledMessage } from '../../api/endpoints/scheduledMessages'
import { useAllProjects } from '../../hooks/useProjects'
import { PageShell, PageHeader, SectionCard, SectionHeader } from '../settings/primitives'
import Loading from '../common/Loading'
import { formatInTz } from '../../utils/formatDate'
import ScheduleMessageModal from './ScheduleMessageModal'

function formatCron(cron: string): string {
  const presets: Record<string, string> = {
    '@hourly': 'Every hour',
    '@daily': 'Every day',
    '@weekly': 'Every week',
    '@monthly': 'Every month',
    '@yearly': 'Every year',
    '@annually': 'Every year',
  }
  return presets[cron] || cron
}

export default function ScheduledMessagesPage() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<ScheduledMessage | null>(null)

  const { data: schedules, isLoading } = useQuery({
    queryKey: ['scheduled-messages'],
    queryFn: () => getScheduledMessages(true),
    refetchInterval: 30000,
  })

  const { data: projects } = useAllProjects()

  const projectNameMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of projects || []) {
      map[p.id] = p.display_name || p.name
    }
    return map
  }, [projects])

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelScheduledMessage(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-messages'] })
    },
  })

  return (
    <PageShell>
      <PageHeader
        title="Scheduled Messages"
        subtitle="Recurring messages queued from your chatrooms and DMs."
      />

      <SectionCard>
        <SectionHeader title="Active schedules" icon={<Clock className="w-4 h-4" />} />
        <div className="px-5 py-4">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loading />
            </div>
          ) : !schedules?.length ? (
            <div className="text-center py-8 px-4">
              <Clock className="w-10 h-10 mx-auto mb-3 text-gray-300" strokeWidth={1.5} />
              <p className="text-gray-700 font-medium mb-2">No scheduled messages yet</p>
              <p className="text-sm text-gray-500">
                To schedule a recurring message, open any chatroom or DM and click the{' '}
                <span className="inline-flex items-center align-middle mx-0.5 px-1 py-0.5 bg-gray-100 rounded">
                  <Clock className="w-3.5 h-3.5 text-gray-500" />
                </span>{' '}
                clock button next to the message input.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {schedules.map((schedule: ScheduledMessage) => (
                <ScheduleItem
                  key={schedule.id}
                  schedule={schedule}
                  projectName={projectNameMap[schedule.project_id]}
                  onEdit={() => setEditing(schedule)}
                  onCancel={() => cancelMutation.mutate(schedule.id)}
                  isCancelling={cancelMutation.isPending}
                />
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {editing && (
        <ScheduleMessageModal schedule={editing} onClose={() => setEditing(null)} />
      )}
    </PageShell>
  )
}

function ScheduleItem({
  schedule,
  projectName,
  onEdit,
  onCancel,
  isCancelling,
}: {
  schedule: ScheduledMessage
  projectName?: string
  onEdit: () => void
  onCancel: () => void
  isCancelling: boolean
}) {
  const isDM = schedule.chatroom_name.startsWith('dm-')
  const tz = schedule.timezone || 'UTC'

  return (
    <div
      onClick={onEdit}
      className="border border-gray-200 rounded-lg p-3 cursor-pointer hover:border-gray-300 hover:bg-gray-50 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-900 line-clamp-2">
            {schedule.content}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatCron(schedule.cron_expression)}
            </span>
            {!isDM && projectName && (
              <span className="font-medium text-gray-600">{projectName}</span>
            )}
            <span>{schedule.chatroom_name}</span>
            <span>Next: {formatInTz(schedule.next_fire_at, tz)}</span>
            <span className="text-gray-400">· {tz}</span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onCancel()
          }}
          disabled={isCancelling}
          className="flex-shrink-0 p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded disabled:opacity-50"
          title="Cancel schedule"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

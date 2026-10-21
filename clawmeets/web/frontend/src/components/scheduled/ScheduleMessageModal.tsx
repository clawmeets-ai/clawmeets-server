import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createScheduledMessage,
  updateScheduledMessage,
  type ScheduledMessage,
  type UpdateScheduledMessagePayload,
} from '../../api/endpoints/scheduledMessages'
import { detectBrowserTz } from '../../utils/formatDate'
import { useDmThreads } from '../../hooks/useDmThreads'
import { useUserProjects } from '../../hooks/useProjects'
import { isThreadProject } from '../../types'
import { shortName } from '../../utils/agentDisplay'
import CronPicker from './CronPicker'

interface ScheduleMessageModalProps {
  /** Default target. Omit both to start the picker empty (global "New schedule"). */
  projectId?: string
  chatroomName?: string
  onClose: () => void
  /** Optional prefilled message body (e.g. a brief-tab refresh marker + SOP). */
  initialContent?: string
  /** When set, the modal edits this schedule instead of creating a new one. */
  schedule?: ScheduledMessage
}

const DEFAULT_CRON = '0 9 * * *'

// A picker option encodes the full target so any (project, chatroom) pair —
// including composer `dm-*` / `shared-context` rooms not in the standard lists —
// is representable and selectable.
function targetValue(projectId: string, chatroomName: string): string {
  return `${projectId}::${chatroomName}`
}

// ISO instant → the local-time `YYYY-MM-DDTHH:mm` a datetime-local input expects.
function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// "Send once": turn a wall-clock `YYYY-MM-DDTHH:mm` into a one-shot schedule.
// The cron recurs yearly at that minute (croniter has no year field), but we
// cap it with `end_at` one minute later — after the single fire the scheduler
// recomputes next_fire_at (next year), sees it's past end_at, and deactivates.
// Net effect: it fires exactly once, at precisely the instant picked. We read
// the wall-clock parts straight off the string (no Date round-trip) so the cron
// matches the value shown, interpreted in the chosen `timezone`.
function oneShotFrom(local: string): { cron: string; endAt: string } {
  const [datePart, timePart] = local.split('T')
  const [, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  const cron = `${minute} ${hour} ${day} ${month} *`
  const endAt = new Date(new Date(local).getTime() + 60_000).toISOString()
  return { cron, endAt }
}

export default function ScheduleMessageModal({
  projectId,
  chatroomName,
  onClose,
  initialContent = '',
  schedule,
}: ScheduleMessageModalProps) {
  const queryClient = useQueryClient()
  const isEdit = !!schedule

  // Initial target: edited schedule → given props → empty (pick one).
  const initialTarget = schedule
    ? targetValue(schedule.project_id, schedule.chatroom_name)
    : projectId
      ? targetValue(projectId, chatroomName ?? 'user-communication')
      : ''

  const [target, setTarget] = useState(initialTarget)
  const [content, setContent] = useState(schedule?.content ?? initialContent)
  const [cronExpression, setCronExpression] = useState<string>(
    schedule?.cron_expression ?? DEFAULT_CRON,
  )
  const [timezone, setTimezone] = useState<string>(schedule?.timezone ?? detectBrowserTz())
  const [endAt, setEndAt] = useState(
    schedule?.end_at ? toLocalDatetimeInput(schedule.end_at) : '',
  )
  // Repeat (recurring cron) vs. Send once (a single instant). Editing always
  // opens in Repeat mode showing the stored cron.
  const [mode, setMode] = useState<'repeat' | 'once'>('repeat')
  const [sendAt, setSendAt] = useState('')
  const [error, setError] = useState('')

  const { groups } = useDmThreads()
  const { data: userProjects } = useUserProjects()

  // Both DM threads and regular projects deliver to their `user-communication` room.
  const dmOptions = useMemo(
    () =>
      groups.flatMap((g) =>
        g.threads.map((t) => ({
          value: targetValue(t.projectId, 'user-communication'),
          label: `${shortName(g.agent)} — ${t.title}`,
        })),
      ),
    [groups],
  )
  const projectOptions = useMemo(
    () =>
      (userProjects ?? [])
        .filter((p) => !isThreadProject(p))
        .map((p) => ({
          value: targetValue(p.id, 'user-communication'),
          label: p.display_name || p.name,
        })),
    [userProjects],
  )

  // If the current target isn't one of the standard options (composer dm-*/
  // shared-context rooms, or a schedule targeting one), surface it as its own
  // selectable option so it can be shown as the default and retargeted.
  const currentOption = useMemo(() => {
    if (!initialTarget) return null
    const known = new Set([...dmOptions, ...projectOptions].map((o) => o.value))
    if (known.has(initialTarget)) return null
    const [pid, room] = initialTarget.split('::')
    const proj = (userProjects ?? []).find((p) => p.id === pid)
    const base = proj?.display_name || proj?.name || pid
    const label = room && room !== 'user-communication' ? `${base} — ${room}` : base
    return { value: initialTarget, label }
  }, [initialTarget, dmOptions, projectOptions, userProjects])

  const [targetProjectId, targetChatroom] = target.split('::')

  const mutation = useMutation({
    mutationFn: () => {
      const oneShot = mode === 'once' ? oneShotFrom(sendAt) : null
      const payload: UpdateScheduledMessagePayload = {
        project_id: targetProjectId,
        chatroom_name: targetChatroom || 'user-communication',
        content: content.trim(),
        cron_expression: oneShot ? oneShot.cron : cronExpression,
        timezone,
      }
      if (oneShot) {
        payload.end_at = oneShot.endAt
      } else if (endAt) {
        payload.end_at = new Date(endAt).toISOString()
      }
      return isEdit
        ? updateScheduledMessage(schedule!.id, payload)
        : createScheduledMessage(payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-messages'] })
      onClose()
    },
    onError: (err: Error) => {
      setError(err.message || (isEdit ? 'Failed to update schedule' : 'Failed to create schedule'))
    },
  })

  const canSubmit =
    content.trim() &&
    targetProjectId &&
    !mutation.isPending &&
    (mode === 'once' ? !!sendAt : !!cronExpression)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (mode === 'once' && new Date(sendAt).getTime() <= Date.now()) {
      setError('Pick a date and time in the future.')
      return
    }
    mutation.mutate()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-white rounded-lg shadow-xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold">{isEdit ? 'Edit Schedule' : 'Schedule Message'}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {/* Target picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Send to
            </label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="" disabled>
                Choose a conversation…
              </option>
              {currentOption && (
                <option value={currentOption.value}>{currentOption.label}</option>
              )}
              {dmOptions.length > 0 && (
                <optgroup label="Direct messages">
                  {dmOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {projectOptions.length > 0 && (
                <optgroup label="Projects">
                  {projectOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* Message content */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Message
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Type the message to be sent on schedule..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Schedule picker — repeat (cron) vs. one-shot */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Schedule
            </label>
            <div className="inline-flex mb-2 rounded-lg border border-gray-300 p-0.5">
              {(['repeat', 'once'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                    mode === m
                      ? 'bg-accent text-white'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {m === 'repeat' ? 'Repeat' : 'Send once'}
                </button>
              ))}
            </div>
            {mode === 'repeat' ? (
              <CronPicker
                value={cronExpression}
                onChange={setCronExpression}
                timezone={timezone}
                onTimezoneChange={setTimezone}
              />
            ) : (
              <div>
                <input
                  type="datetime-local"
                  value={sendAt}
                  onChange={(e) => setSendAt(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Sends exactly once, at the time you pick.
                </p>
              </div>
            )}
          </div>

          {/* End date (optional) — only meaningful for a repeating schedule */}
          {mode === 'repeat' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                End Date (optional)
              </label>
              <input
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-deep disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {mutation.isPending
                ? isEdit
                  ? 'Saving...'
                  : 'Creating...'
                : isEdit
                  ? 'Save changes'
                  : 'Create Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

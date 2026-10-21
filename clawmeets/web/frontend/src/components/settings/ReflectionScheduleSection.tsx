import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain } from 'lucide-react'

import {
  ReflectionSchedule,
  deleteReflectionSchedule,
  getReflectionSchedule,
  setReflectionSchedule,
} from '../../api/endpoints/reflection'
import { Alert, SectionCard, SectionHeader } from './primitives'
import CronPicker from '../scheduled/CronPicker'
import { detectBrowserTz, formatInTz } from '../../utils/formatDate'

const primaryBtnClasses =
  'px-4 py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent-deep focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
const secondaryBtnClasses =
  'px-4 py-2 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors'

const DEFAULT_REFLECT_CRON = '0 9 * * *' // daily 9am

function formatTimestamp(value: string | null | undefined, tz: string): string {
  if (!value) return 'never'
  return formatInTz(value, tz)
}

export default function ReflectionScheduleSection() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['account', 'reflection-schedule'],
    queryFn: getReflectionSchedule,
  })

  const [reflectEnabled, setReflectEnabled] = useState(false)
  const [reflectCron, setReflectCron] = useState<string>(DEFAULT_REFLECT_CRON)
  const [timezone, setTimezone] = useState<string>(detectBrowserTz())

  const [error, setError] = useState<string>('')
  const [success, setSuccess] = useState<string>('')

  useEffect(() => {
    if (!data) {
      setReflectEnabled(false)
      setReflectCron(DEFAULT_REFLECT_CRON)
      setTimezone(detectBrowserTz())
      return
    }
    setReflectEnabled(data.is_active)
    setReflectCron(data.cron_expression)
    setTimezone(data.timezone || detectBrowserTz())
  }, [data])

  const displayTz = data?.timezone || timezone

  const saveMutation = useMutation<
    ReflectionSchedule,
    Error,
    { reflectCron: string; active: boolean; timezone: string }
  >({
    mutationFn: ({ reflectCron, active, timezone }) =>
      setReflectionSchedule(reflectCron, active, timezone),
    onSuccess: () => {
      setSuccess('Memory & reflection settings saved.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['account', 'reflection-schedule'] })
    },
    onError: (err) => {
      setError(err.message)
      setSuccess('')
    },
  })

  const turnOffEverythingMutation = useMutation({
    mutationFn: deleteReflectionSchedule,
    onSuccess: () => {
      setSuccess('Memory & reflection disabled.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['account', 'reflection-schedule'] })
    },
    onError: (err: Error) => {
      setError(err.message)
      setSuccess('')
    },
  })

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (!reflectCron) {
      setError('Please configure a reflect cadence.')
      return
    }
    saveMutation.mutate({
      reflectCron,
      active: reflectEnabled,
      timezone,
    })
  }

  return (
    <SectionCard>
      <SectionHeader
        title="Memory & Reflection"
        icon={<Brain className="w-4 h-4" />}
        subtitle="On each cadence, every owned agent distills new lessons from recent activity AND audits its existing wiki for contradictions and stale entries — in one pass."
      />
      <div className="px-5 py-4 space-y-5">
        {error && <Alert type="error" message={error} />}
        {success && <Alert type="success" message={success} />}

        {isLoading ? (
          <div className="text-xs text-gray-500">Loading…</div>
        ) : (
          <form onSubmit={handleSave} className="space-y-5">
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={reflectEnabled}
                  onChange={(e) => setReflectEnabled(e.target.checked)}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
                Reflect (distill new lessons + audit wiki)
              </label>

              {reflectEnabled && (
                <>
                  <div className="text-[11px] text-gray-500 space-y-0.5">
                    <div>Last fired: {formatTimestamp(data?.last_fired_at, displayTz)}</div>
                    <div>
                      Next fire:{' '}
                      {data?.is_active && data.next_fire_at
                        ? formatTimestamp(data.next_fire_at, displayTz)
                        : '—'}
                    </div>
                  </div>

                  <CronPicker
                    value={reflectCron}
                    onChange={setReflectCron}
                    timezone={timezone}
                    onTimezoneChange={setTimezone}
                  />
                </>
              )}
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button type="submit" disabled={saveMutation.isPending} className={primaryBtnClasses}>
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
              {data && (
                <button
                  type="button"
                  onClick={() => turnOffEverythingMutation.mutate()}
                  disabled={turnOffEverythingMutation.isPending}
                  className={secondaryBtnClasses}
                >
                  {turnOffEverythingMutation.isPending ? '…' : 'Disable memory & reflection entirely'}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </SectionCard>
  )
}

import { useMemo } from 'react'
import { Cron, CronError } from 'react-js-cron'
import cronstrue from 'cronstrue'
import 'react-js-cron/dist/styles.css'

import { listTimezones } from '../../utils/formatDate'

interface CronPickerProps {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  onError?: (error: CronError | undefined) => void
  timezone?: string
  onTimezoneChange?: (next: string) => void
}

export default function CronPicker({
  value,
  onChange,
  disabled,
  onError,
  timezone,
  onTimezoneChange,
}: CronPickerProps) {
  const summary = useMemo(() => {
    try {
      return cronstrue.toString(value, {
        use24HourTimeFormat: false,
        throwExceptionOnParseError: false,
        verbose: false,
      })
    } catch {
      return ''
    }
  }, [value])

  const tzOptions = useMemo(() => listTimezones(), [])
  const showTzPicker = timezone !== undefined && onTimezoneChange !== undefined

  return (
    <div className="space-y-2">
      <Cron
        value={value}
        setValue={(v: string) => onChange(v)}
        clearButton={false}
        disabled={disabled}
        humanizeLabels
        clockFormat="12-hour-clock"
        onError={onError}
      />
      {summary && (
        <p className="text-xs italic text-gray-600">
          <span className="font-medium not-italic text-gray-500">When:</span> {summary}
          {showTzPicker && <span className="not-italic text-gray-500"> ({timezone})</span>}
        </p>
      )}
      {showTzPicker ? (
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-gray-500">Timezone</label>
          <select
            value={timezone}
            onChange={(e) => onTimezoneChange!(e.target.value)}
            disabled={disabled}
            className="text-xs px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-purple-500"
          >
            {tzOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-[11px] text-gray-400">
          Times evaluate in UTC.
        </p>
      )}
    </div>
  )
}

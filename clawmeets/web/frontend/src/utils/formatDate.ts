// Timezone-aware date formatting helpers.
//
// Scheduled records (scheduled messages, reflection schedules) carry their
// own IANA timezone string and crons are evaluated in that zone server-side.
// These helpers render the stored UTC instants in the record's zone so what
// the user sees matches what they scheduled.

export function detectBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const DEFAULT_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
}

export function formatInTz(
  date: string | Date,
  tz: string,
  opts: Intl.DateTimeFormatOptions = DEFAULT_OPTS,
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  if (isNaN(d.getTime())) return typeof date === 'string' ? date : ''
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(d)
  } catch {
    return d.toLocaleString()
  }
}

// `Intl.supportedValuesOf` is available in modern browsers (Chrome 99+,
// Safari 15.4+, Firefox 93+). Fall back to a minimal common list.
const FALLBACK_TZS = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
]

// Compact relative-time label for sidebar rows (Recents, palette): `now`,
// `{m}m`, `{h}h`, `yesterday`, `{d}d`, `{w}w`, then a short `Mon D` date.
// Intentionally terse to fit a right-aligned mono chip.
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''
  const sec = Math.floor((Date.now() - then) / 1000)
  if (sec < 45) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}w`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function listTimezones(): string[] {
  type IntlWithSupported = typeof Intl & {
    supportedValuesOf?: (key: string) => string[]
  }
  const intl = Intl as IntlWithSupported
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      return intl.supportedValuesOf('timeZone')
    } catch {
      /* fall through */
    }
  }
  return FALLBACK_TZS
}

interface TimestampProps {
  date: string | Date
  format?: 'relative' | 'time' | 'datetime' | 'date'
}

function formatRelative(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString()
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(date: Date): string {
  return date.toLocaleDateString()
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`
}

export default function Timestamp({ date, format = 'relative' }: TimestampProps) {
  const dateObj = typeof date === 'string' ? new Date(date) : date

  let formatted: string
  switch (format) {
    case 'time':
      formatted = formatTime(dateObj)
      break
    case 'date':
      formatted = formatDate(dateObj)
      break
    case 'datetime':
      formatted = formatDateTime(dateObj)
      break
    case 'relative':
    default:
      formatted = formatRelative(dateObj)
  }

  return (
    <time
      dateTime={dateObj.toISOString()}
      title={formatDateTime(dateObj)}
      className="text-gray-500 text-xs"
    >
      {formatted}
    </time>
  )
}

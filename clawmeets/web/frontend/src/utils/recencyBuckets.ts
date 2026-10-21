// Recency bucketing for the left sidebar. Single source of truth for the
// Today / Last 7 Days / Other boundaries used by the DMs, Projects, and F-Desk
// panels. Boundaries are computed against LOCAL midnight (the browser's zone),
// matching how `formatRelativeTime` reads instants. `now` is injectable so the
// classifier is deterministic in tests.

export type RecencyBucketId = 'today' | 'week' | 'other'

export interface RecencyGroup<T> {
  id: RecencyBucketId
  label: string // 'Today' | 'Last 7 Days' | 'Other'
  items: T[]
}

const BUCKET_ORDER: { id: RecencyBucketId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Last 7 Days' },
  { id: 'other', label: 'Other' },
]

// Midnight in the browser's local timezone as an epoch-ms number.
function startOfLocalToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Classify one ISO instant. Empty/invalid timestamps fall to 'other' so a row
// is never dropped. `today` = since local midnight; `week` = the prior 7 days.
export function recencyBucketOf(
  iso: string | null | undefined,
  now: number = Date.now(),
): RecencyBucketId {
  if (!iso) return 'other'
  const ts = new Date(iso).getTime()
  if (isNaN(ts)) return 'other'
  const midnight = startOfLocalToday(now)
  if (ts >= midnight) return 'today'
  if (ts >= midnight - 7 * 24 * 60 * 60 * 1000) return 'week'
  return 'other'
}

// Order-preserving partition into [today, week, other]. Input order is kept
// within each bucket, so callers retain their existing sort; empty buckets are
// omitted. `getInstant` returns the item's activity timestamp — for grouped
// items (DM agent groups, F-Desk desks) that is the group's most-recent child.
export function groupByRecency<T>(
  items: T[],
  getInstant: (item: T) => string | null | undefined,
  now: number = Date.now(),
): RecencyGroup<T>[] {
  const byBucket: Record<RecencyBucketId, T[]> = { today: [], week: [], other: [] }
  for (const item of items) {
    byBucket[recencyBucketOf(getInstant(item), now)].push(item)
  }
  return BUCKET_ORDER.filter(({ id }) => byBucket[id].length > 0).map(({ id, label }) => ({
    id,
    label,
    items: byBucket[id],
  }))
}

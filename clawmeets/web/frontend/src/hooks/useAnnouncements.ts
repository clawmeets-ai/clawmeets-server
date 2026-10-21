import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAnnouncements } from '../api/endpoints/announcements'
import { useRunnerVersionStore } from '../stores/runnerVersionStore'
import { validateRecords, versionMatches } from '../utils/versionMatch'
import type { AnnouncementRecord } from '../utils/versionMatch'
import type { Runner } from '../types'

/**
 * THE derivation point.
 *
 * Entries are a pure function of two facts already in state — the config query
 * and the runner snapshot — and are MEMOIZED rather than stored. A third store
 * holding the computed entries would be a cache that can go stale against its
 * own inputs, which is precisely the class of bug the old server-owned
 * `affected_count` caused.
 */

export interface AnnouncementEntry {
  id: string
  severity: string
  title: string
  body: string
  /** Sorted by (name, id). Length >= 1 ALWAYS — §4.7 relies on it. */
  affected: Runner[]
}

/** A malformed element is a contract violation, not something to render. The
 *  store deliberately does not filter, so the defensive read lives here. */
function isRunner(value: unknown): value is Runner {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r.id === 'string' && typeof r.name === 'string'
}

/**
 * ONE ENTRY PER ANNOUNCEMENT ID, never one per runner — that is the entire point
 * of grouping.
 *
 * Announcements matching ZERO runners are OMITTED ENTIRELY. An entry with an
 * empty `affected` exists only to tempt the renderer into an empty banner, so it
 * never exists.
 *
 * `affected` is sorted by (name, id): a stable order means two tabs, and two
 * consecutive pushes, render the same list in the same sequence. Ties on name
 * (two agents can share a display name) break on id.
 *
 * There is no `affected_count`. It is `affected.length` — the number and the
 * list cannot disagree, because they are the same object.
 *
 * Exported pure so it can be unit-tested without React.
 */
export function group(records: AnnouncementRecord[], runners: Runner[]): AnnouncementEntry[] {
  const live = (runners as unknown[]).filter(isRunner)
  const entries: AnnouncementEntry[] = []

  for (const record of records) {
    const affected = live
      .filter(runner => versionMatches(record.target, runner.version ?? null))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    if (!affected.length) continue
    entries.push({
      id: record.id,
      severity: record.severity,
      title: record.title,
      body: record.body,
      affected,
    })
  }

  return entries
}

export interface UseAnnouncementsResult {
  entries: AnnouncementEntry[]
  /** True while `runners === null` (no push yet) OR the config query has not
   *  resolved. The caller renders NOTHING while pending (§4.7) — a banner that
   *  flashes in and out on every reload is worse than one that appears 200ms
   *  late. */
  pending: boolean
}

export function useAnnouncements(): UseAnnouncementsResult {
  const runners = useRunnerVersionStore(s => s.runners)

  const { data, isSuccess } = useQuery({
    queryKey: ['announcements'],
    queryFn: ({ signal }) => fetchAnnouncements(signal),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  })

  const records = useMemo(() => validateRecords(data), [data])
  const entries = useMemo(
    () => (runners === null ? [] : group(records, runners)),
    [records, runners],
  )

  return { entries, pending: runners === null || !isSuccess }
}

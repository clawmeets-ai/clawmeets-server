import type { ScheduledMessage } from '../api/endpoints/scheduledMessages'

// A brief tab is refreshed by a scheduled message whose body carries the
// trigger marker `<!-- clawmeets:brief-tab-trigger:<slug> -->` (posted into the
// publishing agent's DM). To surface each briefing's cadence on My Desk we scan
// the user's schedules for that marker and key them by slug. Slug charset
// mirrors the server's `_SLUG_RE` in clawmeets/models/brief_tab.py.
const MARKER_RE = /<!--\s*clawmeets:brief-tab-trigger:([a-z0-9][a-z0-9_-]*)\s*-->/

/** Build the trigger-marker body for a slug (used to prefill the schedule modal). */
export function briefTriggerMarker(slug: string): string {
  return `<!-- clawmeets:brief-tab-trigger:${slug} -->`
}

/** Map slug → the scheduled message that refreshes it (first match wins). */
export function matchBriefSchedules(
  schedules: ScheduledMessage[] | undefined,
): Map<string, ScheduledMessage> {
  const bySlug = new Map<string, ScheduledMessage>()
  for (const s of schedules ?? []) {
    const m = s.content.match(MARKER_RE)
    if (m && !bySlug.has(m[1])) bySlug.set(m[1], s)
  }
  return bySlug
}

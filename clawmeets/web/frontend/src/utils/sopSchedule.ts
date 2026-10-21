import type { ScheduledMessage } from '../api/endpoints/scheduledMessages'

// A scheduled SOP is a recurring message the assistant addresses to ITSELF,
// carrying `<!-- clawmeets:sop-run:<sop-id> -->` plus the values to fill. Each
// fire wakes the assistant, which dispatches `clawmeets sop trigger`. Nothing
// links the schedule to the SOP in storage — the marker IS the link, so the
// rail recovers a SOP's cadence by scanning the user's schedules for it.
// Id charset mirrors `gen_id` in clawmeets/models/desk_sop.py (`sop-` + hex).
const MARKER_RE = /<!--\s*clawmeets:sop-run:(sop-[0-9a-f]+)\s*-->/

/** The trigger-marker line for a SOP id — the shape the assistant writes. */
export function sopRunMarker(sopId: string): string {
  return `<!-- clawmeets:sop-run:${sopId} -->`
}

/** Map SOP id → the scheduled message that fires it (first match wins). */
export function matchSopSchedules(
  schedules: ScheduledMessage[] | undefined,
): Map<string, ScheduledMessage> {
  const byId = new Map<string, ScheduledMessage>()
  for (const s of schedules ?? []) {
    const m = s.content.match(MARKER_RE)
    if (m && !byId.has(m[1])) byId.set(m[1], s)
  }
  return byId
}

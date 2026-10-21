import { get } from '../client'

/**
 * GET /announcements — the config VERBATIM as the server parsed it.
 *
 * The server does NO record-level validation, ever, and never 5xxs: a missing,
 * unreadable, invalid or non-object config is `200 {"announcements": []}` plus a
 * server-side log line, so a typo'd file cannot break the app shell. Rejecting a
 * bad record is therefore OUR job and ours alone (§4.2, validateRecords).
 *
 * ETag / If-None-Match are handled by the BROWSER's HTTP cache — we add no
 * manual revalidation bookkeeping. That is what makes invalidating this query on
 * every RUNNER_VERSIONS push cheap enough to do unconditionally, which in turn
 * is what preserves "editing announcements.json takes effect with no server
 * restart".
 *
 * `announcements` is typed `unknown[]` deliberately: nothing may consume these
 * records without going through validateRecords() first.
 */
export interface AnnouncementsResponse {
  announcements: unknown[]
}

export function fetchAnnouncements(signal?: AbortSignal): Promise<AnnouncementsResponse> {
  return get<AnnouncementsResponse>('/announcements', signal)
}

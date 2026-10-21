import { get } from '../client'

/**
 * One signed-off card as the backend serializes it (snake_case, mirrors
 * models/desk_sign_off.py::SignOffCard). This is the message-content snapshot +
 * sign-off ordering the frontend can't cheaply derive here; the live `agent`,
 * `agentName`, `navTo`, `roomLabel`, and presentational `lane` are hydrated
 * client-side in useDeskRecentlyDone — the same hydration split every other
 * desk lane uses. Ordering is server-side (updated_at desc); do NOT re-sort.
 */
export interface SignOffCard {
  project_id: string
  chatroom_name: string
  kind: 'dm' | 'project'
  coordinator_id: string
  /** fallback label when the coordinator isn't in the live agents cache. */
  agent_name: string
  source_name: string
  title: string
  /** the WATERMARKED message's content, trimmed ("" when it can't resolve). */
  quote: string
  /** the message this card quotes — the one signed off, not the room's newest. */
  quoted_message_id: string | null
  files: SignOffFile[]
  /** DeskReadState.updated_at — the ordering key AND the card's "when". */
  signed_off_at: string
}

export interface SignOffFile {
  filename: string
  entry_type: 'file_created' | 'file_updated'
}

/**
 * One "Recently done" response — this is the wire boundary where the names
 * diverge: **Done (UI) = sign-off (wire)**. The route, the stored rows, and
 * every field below deliberately keep "sign-off"; only the copy the user reads
 * changed.
 *
 * `last_signed_off_at` is the newest sign-off EVER (null ⇒ the user has never
 * marked anything done), deliberately outside both the window and the limit: it
 * tells "brand-new desk" apart from "everything you cleared is live again",
 * which is what gates DeskPage's first-run zero state, and it feeds the empty
 * state's "Last one Nh ago" subtitle.
 */
export interface SignOffFeed {
  cards: SignOffCard[]
  last_signed_off_at: string | null
}

/**
 * GET the owner's sign-offs, most-recent-first. Owner is derived from the JWT
 * server-side. Returns an empty `cards` list (never 404/403) when there is
 * nothing to show. Rows are already ordered — render as-is.
 *
 * Two independent, composable narrowings, both optional (omit both ⇒ every row
 * ever):
 *   - `limit` — the last N cards, ANY date. What "Recently done" asks for
 *     (see useDeskRecentlyDone); it also bounds the server's per-row chatroom-log
 *     read, so an unwindowed feed doesn't get slower as history grows. Out of
 *     the server's 1..100 band is a 422.
 *   - `sinceIso` — a date boundary. The server has no idea what timezone the
 *     viewer is in, so a day window is the caller's to compute. A value the
 *     server can't parse is a 422, not a silent full feed.
 */
export async function getDeskSignOffs(
  params?: { sinceIso?: string; limit?: number },
): Promise<SignOffFeed> {
  const qs = new URLSearchParams()
  if (params?.sinceIso) qs.set('since', params.sinceIso)
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  const suffix = qs.toString() ? `?${qs}` : ''
  return get<SignOffFeed>(`/me/desk/sign-offs${suffix}`)
}

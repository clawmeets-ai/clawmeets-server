import { get, put } from '../client'

/**
 * One desk card's server-persisted read watermark. Mirrors the backend
 * `DeskReadState` (models/desk_read_state.py). The server also serializes an
 * `owner_user_id` (for symmetry with desk-todos); the frontend never reads it,
 * so it is intentionally omitted from this type.
 */
export interface DeskReadState {
  project_id: string
  chatroom_name: string
  last_seen_message_id: string // "__dismissed__" sentinel allowed
  updated_at: string // server ISO-8601 clock; drives last-writer-wins
}

/**
 * GET all of the owner's persisted desk watermarks — hydration on desk
 * mount/focus so a fresh (or reconnected) device becomes correct before, or
 * without, any WebSocket event.
 */
export async function getDeskReadState(): Promise<DeskReadState[]> {
  return get<DeskReadState[]>('/me/desk/read-state')
}

export interface PutDeskReadStateInput {
  project_id: string
  chatroom_name: string
  last_seen_message_id: string
}

/**
 * Idempotent upsert of ONE card's watermark. `chatroom_name` is always
 * "user-communication" for desk cards; `last_seen_message_id` may be the
 * "__dismissed__" sentinel. The server stamps `updated_at`, returns the stored
 * row, and echoes DESK_READ_STATE_SYNC to the owner's other sessions.
 */
export async function putDeskReadState(
  input: PutDeskReadStateInput,
): Promise<DeskReadState> {
  return put<DeskReadState>('/me/desk/read-state', input)
}

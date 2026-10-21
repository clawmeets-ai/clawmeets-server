import { get } from '../client'
import type { ChatLogEntry } from '../../types'

/**
 * GET /me/desk/latest-messages — per project, the newest non-ack
 * user-communication message plus the file events that rode in with it
 * (server: models/desk_sign_off.py::latest_message_slice). One request for the
 * whole desk instead of one full-history download per card. Projects the
 * caller can't read are omitted; treat a missing id as an empty room.
 */
export interface DeskLatestMessages {
  /** The ids this response was requested for (client-side bookkeeping). */
  ids: string[]
  entries: Record<string, ChatLogEntry[]>
}

export async function getDeskLatestMessages(projectIds: string[]): Promise<DeskLatestMessages> {
  if (projectIds.length === 0) return { ids: [], entries: {} }
  const res = await get<{ entries: Record<string, ChatLogEntry[]> }>(
    `/me/desk/latest-messages?project_ids=${encodeURIComponent(projectIds.join(','))}`,
  )
  return { ids: projectIds, entries: res.entries ?? {} }
}

import { put } from '../client'
import type { RoomFlow } from './hub'

/**
 * Stop or reopen a room's inbound outside messages. The project owner's
 * browser login only: an agent token gets user_only [403], anyone else 404,
 * and 503 means room flow is not available on this server. Only the owner
 * reopens, also after the monitor stopped the room.
 */
export const setRoomFlow = (projectId: string, chatroomName: string, state: 'open' | 'stopped', reason?: string) =>
  put<RoomFlow>(
    `/projects/${encodeURIComponent(projectId)}/chatrooms/${encodeURIComponent(chatroomName)}/flow`,
    reason ? { state, reason } : { state },
  )

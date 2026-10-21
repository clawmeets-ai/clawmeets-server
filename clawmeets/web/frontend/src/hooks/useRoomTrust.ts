import { useMemo } from 'react'
import { useChatroom, useProject, useUserProjects } from './useProjects'
import { useUntrustedBodies } from './useUntrustedBodies'
import { anyOutsideParticipant, outsideAuthorRule } from '../utils/roomTrust'

export interface RoomTrust {
  /** Every body in the room renders untrusted (useUntrustedBodies: a Hub
   *  thread, a Front Desk room not proven local). */
  untrustedBodies: boolean
  /** Per author: outside the owner's account (utils/roomTrust). */
  isOutsideAuthor: (authorId: string) => boolean
  /** Does this author's body, name, file or note render untrusted?
   *  untrustedBodies || isOutsideAuthor(authorId). Forward and Save hide too. */
  isUntrusted: (authorId: string) => boolean
  /** The answer for content whose author is not known (a signed-off card's
   *  quote): untrusted when the room is, when it has any outside participant,
   *  while the room is still loading, or when it carries no participant list
   *  (fail closed, as outsideAuthorRule). */
  unknownAuthorUntrusted: boolean
  /** The project's owner, once known: the per-author rule's one insider
   *  besides the server (for outsideFileNames). */
  ownerId: string | undefined
}

/**
 * The one trust answer for a room's messages, for every surface that draws
 * them (ChatroomView, DMChatView, the Activity feed, the My Desk card, the
 * file viewer). It joins the whole-room rule with the per-author rule so no
 * surface can ask one without the other; components never call
 * useUntrustedBodies directly (.eslintrc.cjs).
 *
 * While the room or its project is still loading, the per-author rule has
 * no list and no owner, so every author but the server counts as outside:
 * it fails closed and settles once both arrive.
 */
export function useRoomTrust(projectId: string, chatroomName: string): RoomTrust {
  const untrustedBodies = useUntrustedBodies(projectId, chatroomName)
  // One read settles the answer; the room view keeps its own poll.
  const { data: room } = useChatroom(projectId, chatroomName, { poll: false })
  // The project list already carries created_by for the user's own and shared
  // projects; only a project missing from it is fetched on its own.
  const { data: userProjects } = useUserProjects()
  const listed = userProjects?.find((p) => p.id === projectId)
  const { data: fetched } = useProject(listed ? '' : projectId)
  const ownerId = listed?.created_by ?? fetched?.created_by ?? undefined
  return useMemo(() => {
    const isOutsideAuthor = outsideAuthorRule(room, ownerId)
    return {
      untrustedBodies,
      isOutsideAuthor,
      isUntrusted: (authorId: string) => untrustedBodies || isOutsideAuthor(authorId),
      unknownAuthorUntrusted: untrustedBodies || anyOutsideParticipant(room),
      ownerId,
    }
  }, [room, ownerId, untrustedBodies])
}

import { useMemo } from 'react'
import { useAuthStore } from '../stores/authStore'
import { frontDeskSide } from '../utils/frontDesk'
import { useAllParticipants } from './useAgents'
import { useUserProjects } from './useProjects'
import { useChannelThread } from './useChannelThreads'

/**
 * Whether a room's message bodies must render as untrusted Markdown (no image
 * loads, links show their host). A Hub thread's bodies come from a stranger on
 * another server, and a Hub thread can be opened through ChatroomView or
 * DMChatView (a search hit links a Front Desk project to /dm/...), so both ask
 * here and never decide it themselves.
 *
 * A user-communication room is trusted only on positive evidence:
 *  - its project is in the user's project list, has no hub_target, and is not
 *    a Front Desk project; or
 *  - it is the user's own Front Desk project and its coordinator is a known
 *    agent of another account (the requester end of a cross-account thread on
 *    this server). Own, because a viewer of a shared host-side Hub Request
 *    also sees its coordinator as another account's agent: the owner's; or
 *  - it is the user's own Front Desk project and the loaded thread list has
 *    its row with a channel other than Hub.
 * Everything else renders untrusted: the list still loading or not holding
 * the project yet (a new Request lands before the list refetches), a missing
 * thread row, a thread list that failed or answered 404 ('off'), an unknown
 * coordinator, a Front Desk project the user only views. Other rooms are
 * trusted WHOLE here, which says nothing about their authors.
 *
 * This decides whole-room trust only. Per-author trust (a stand-in in a
 * workroom, another account's agent, a requester, a channel contact) lives in
 * utils/roomTrust, and hooks/useRoomTrust joins the two. Components ask
 * useRoomTrust, never this hook (.eslintrc.cjs).
 */
export function useUntrustedBodies(projectId: string, chatroomName: string): boolean {
  const viewerId = useAuthStore((s) => s.user?.id)
  const { data: userProjects } = useUserProjects()
  const isUserCommRoom = chatroomName.startsWith('user-communication')
  const project = isUserCommRoom ? userProjects?.find((p) => p.id === projectId) : undefined
  const isOwnFrontDesk = !!project && project.surface === 'frontdesk'
    && !project.is_viewer && !!viewerId && project.created_by === viewerId
  const { row, state } = useChannelThread(projectId, { enabled: isOwnFrontDesk })
  const { data: agents } = useAllParticipants()
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  if (!isUserCommRoom) return false
  if (!project || project.hub_target) return true
  if (project.surface !== 'frontdesk') return false
  if (isOwnFrontDesk && viewerId && frontDeskSide(project, agentById, viewerId) === 'local') return false
  return !(isOwnFrontDesk && state === 'ready' && row !== null && row.channel !== 'hub')
}

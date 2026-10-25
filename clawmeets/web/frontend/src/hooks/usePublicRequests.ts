import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createPublicRequest, getPublicRequest, listPublicRequests, reportMatchOutcome, sendDMMessage, sendPublicRequest,
  setMatchDismissed, type PublicRequest, type RequestMatch,
} from '../api/endpoints'
import { useWebSocketStatus } from './useWebSocket'
import { sendHubDraft } from './useHub'

/**
 * Public requests. The hub ranks; the server reports each match's status; a
 * changelog push on any thread refreshes them (useWebSocket), so these only
 * poll while the socket is down.
 */

export const PUBLIC_REQUESTS_KEY = ['public-requests'] as const
const listKey = [...PUBLIC_REQUESTS_KEY, 'list'] as const
export const publicRequestKey = (id: string) => [...PUBLIC_REQUESTS_KEY, 'one', id] as const

export function usePublicRequests() {
  const live = useWebSocketStatus()
  return useQuery({
    queryKey: listKey,
    queryFn: listPublicRequests,
    refetchInterval: live ? false : 10_000,
  })
}

export function usePublicRequest(id: string | undefined) {
  const live = useWebSocketStatus()
  return useQuery({
    queryKey: publicRequestKey(id ?? ''),
    queryFn: () => getPublicRequest(id!),
    enabled: !!id,
    refetchInterval: live ? false : 5_000,
  })
}

function useStoreRequest() {
  const qc = useQueryClient()
  return (request: PublicRequest) => {
    qc.setQueryData(publicRequestKey(request.id), request)
    void qc.invalidateQueries({ queryKey: listKey })
    // Each new thread shows in the Public panel's conversations.
    void qc.invalidateQueries({ queryKey: ['user-projects'] })
  }
}

export function useCreatePublicRequest() {
  const store = useStoreRequest()
  return useMutation({
    mutationFn: ({ text, sendCount }: { text: string; sendCount?: number }) => createPublicRequest(text, sendCount),
    onSuccess: store,
  })
}

export function useSendPublicRequest(id: string) {
  const store = useStoreRequest()
  return useMutation({
    mutationFn: (body: { count?: number }) => sendPublicRequest(id, body),
    onSuccess: store,
  })
}

export function useSetMatchDismissed(id: string) {
  const store = useStoreRequest()
  return useMutation({
    mutationFn: ({ agentRef, dismissed }: { agentRef: string; dismissed: boolean }) =>
      setMatchDismissed(id, agentRef, dismissed),
    onSuccess: store,
  })
}

/** "Use this answer": marks the match used; the server reports it to the hub. */
export function useMarkAnswerUsed(id: string) {
  const store = useStoreRequest()
  return useMutation({
    mutationFn: (agentRef: string) => reportMatchOutcome(id, agentRef, 'used'),
    onSuccess: store,
  })
}

/** A reply on a match's thread, through the route that thread takes: the
 *  user-message route for a same-server agent, the hub send route for one on
 *  another server (the only way a hub thread is written). */
export function useReplyToMatch(match: RequestMatch) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (text: string) => {
      const pid = match.project_id
      if (!pid) throw new Error('This agent has not been sent your request yet')
      if (match.kind === 'hub') await sendHubDraft(qc, pid, text, [])
      else await sendDMMessage(pid, 'user-communication', text)
    },
    onSuccess: () => {
      if (match.project_id) void qc.invalidateQueries({ queryKey: ['messages', match.project_id] })
    },
  })
}

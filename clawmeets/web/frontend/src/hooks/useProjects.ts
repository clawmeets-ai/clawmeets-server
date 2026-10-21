import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'
import { useWebSocketStatus } from './useWebSocket'
import {
  getProject,
  getProjects,
  getChatrooms,
  getChatroom,
  getMessages,
  getUserProjects,
} from '../api/endpoints'
import { cancelChatroomInvocation } from '../api/endpoints/messages'
import { retryUnlessIsolated } from '../utils/agentAccessCopy'

export function useAllProjects() {
  return useQuery({
    queryKey: ['all-projects'],
    queryFn: () => getProjects(),
  })
}

export function useUserProjects() {
  // The id is part of the query key, so switching accounts refetches instead
  // of serving the previous account's cached list.
  const id = useAuthStore((s) => s.user?.id)

  return useQuery({
    queryKey: ['user-projects', id],
    queryFn: () => getUserProjects(id!),
    enabled: !!id,
  })
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  })
}

export function useChatrooms(projectId: string) {
  const isWsConnected = useWebSocketStatus()

  return useQuery({
    queryKey: ['chatrooms', projectId],
    queryFn: () => getChatrooms(projectId),
    enabled: !!projectId,
    retry: retryUnlessIsolated,
    // Only poll when WebSocket is disconnected (fallback)
    refetchInterval: isWsConnected ? false : 5000,
    staleTime: isWsConnected ? 60000 : 5000,
  })
}

/** `poll: false` for a reader that needs the room once, not live (the trust
 *  read on every desk card and Activity-feed row): it never polls, even with
 *  the WebSocket down. Another observer of the same room still polls. */
export function useChatroom(projectId: string, chatroomName: string, { poll = true }: { poll?: boolean } = {}) {
  const isWsConnected = useWebSocketStatus()

  return useQuery({
    queryKey: ['chatroom', projectId, chatroomName],
    queryFn: () => getChatroom(projectId, chatroomName),
    enabled: !!projectId && !!chatroomName,
    // An isolated project's rooms answer 409 until a computer can isolate it.
    retry: retryUnlessIsolated,
    // Only poll when WebSocket is disconnected (fallback)
    refetchInterval: isWsConnected || !poll ? false : 5000,
    staleTime: isWsConnected ? 60000 : 5000,
  })
}

export function useMessages(projectId: string, chatroomName: string) {
  const isWsConnected = useWebSocketStatus()

  return useQuery({
    queryKey: ['messages', projectId, chatroomName],
    queryFn: () => getMessages(projectId, chatroomName),
    enabled: !!projectId && !!chatroomName,
    retry: retryUnlessIsolated,
    // Only poll when WebSocket is disconnected (fallback)
    // Reduced staleTime to 30s for faster fallback if invalidation fails
    refetchInterval: isWsConnected ? false : 5000,
    staleTime: isWsConnected ? 30000 : 5000,
  })
}

export function useCancelInvocation(projectId?: string, chatroomName?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!projectId || !chatroomName) throw new Error('missing project/chatroom')
      return cancelChatroomInvocation(projectId, chatroomName, agentId)
    },
    onSuccess: () => {
      if (!projectId || !chatroomName) return
      queryClient.invalidateQueries({
        queryKey: ['messages', projectId, chatroomName],
      })
    },
  })
}

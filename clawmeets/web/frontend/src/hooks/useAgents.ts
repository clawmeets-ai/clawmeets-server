import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteAgent, getAgents, getAgent } from '../api/endpoints'
import { useAuthStore } from '../stores/authStore'

export function useAgents() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  return useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
    staleTime: 60000, // Agents don't change often
    enabled: isAuthenticated,
  })
}

export function useAgent(agentId: string) {
  return useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => getAgent(agentId),
    enabled: !!agentId,
  })
}

/**
 * Fetch all participants the caller can see (public agents + their own
 * private agents — including their linked assistant agent).
 *
 * Since the Agent/Assistant class merge, a user's assistant is just a
 * private agent owned by that user, and /agents already returns it when
 * called with user auth. No separate /assistants endpoint is needed.
 */
export function useAllParticipants() {
  const { data, isLoading } = useAgents()
  return { data: data ?? [], isLoading }
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (agentId: string) => deleteAgent(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', 'search'] })
    },
  })
}

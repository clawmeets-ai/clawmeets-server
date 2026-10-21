import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { disconnectIntegration, type DisconnectResult } from '../api/endpoints/skills'
import type { ApiError } from '../api/client'

/**
 * React-Query mutation wrapping `disconnectIntegration()` (gap G2). On a 200
 * (dispatched) it invalidates the installed-skills query so any dependent view
 * reconciles; the calling panel drives the optimistic "Access removed" row
 * state, since the skill stays installed and there is no server-side connected
 * read to flip. Errors surface as the shared `ApiError` (branch on `.status`),
 * mirroring the reauth mutation.
 */
export function useDisconnectIntegration(
  agentId: string,
): UseMutationResult<DisconnectResult, ApiError, { skillName: string }> {
  const queryClient = useQueryClient()
  return useMutation<DisconnectResult, ApiError, { skillName: string }>({
    mutationFn: ({ skillName }) => disconnectIntegration(agentId, skillName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', agentId] })
    },
  })
}

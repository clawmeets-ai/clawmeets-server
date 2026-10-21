import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMatch, useNavigate } from 'react-router-dom'
import { deleteProject } from '../api/endpoints'

export function useDeleteProject() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const match = useMatch('/projects/:projectId/*')
  const currentProjectId = match?.params.projectId ?? null
  // DM threads live at /dm/:agentName/:threadId (not under /projects), so cover
  // them separately: deleting the open thread returns to the agent's new-chat draft.
  const dmMatch = useMatch('/dm/:agentName/:threadId')

  return useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: (_data, projectId) => {
      if (currentProjectId === projectId) {
        navigate('/projects', { replace: true })
      } else if (dmMatch?.params.threadId === projectId) {
        navigate(`/dm/${dmMatch.params.agentName}`, { replace: true })
      }
      queryClient.invalidateQueries({ queryKey: ['user-projects'] })
      queryClient.invalidateQueries({ queryKey: ['all-projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })
}

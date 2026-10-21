import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMatch, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useUserProjects } from './useProjects'
import { createShareLink, removeSharedProject } from '../api/endpoints'

/**
 * Check if the current user is a read-only viewer of a project.
 * Uses the cached user-projects query data.
 */
export function useIsProjectViewer(projectId: string | null): boolean {
  const { data: projects } = useUserProjects()
  if (!projectId || !projects) return false
  const project = projects.find((p) => p.id === projectId)
  return project?.is_viewer === true
}

/**
 * Mutation to create a share link for a project.
 */
export function useCreateShareLink() {
  return useMutation({
    mutationFn: (projectId: string) => createShareLink(projectId),
  })
}

/**
 * Mutation to remove a shared project (viewer unsubscribe).
 */
export function useRemoveSharedProject() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const match = useMatch('/projects/:projectId/*')
  const currentProjectId = match?.params.projectId ?? null

  return useMutation({
    mutationFn: (projectId: string) => removeSharedProject(projectId),
    onSuccess: (_data, projectId) => {
      if (currentProjectId === projectId) {
        navigate('/projects', { replace: true })
      }
      queryClient.invalidateQueries({ queryKey: ['user-projects', user?.id] })
    },
  })
}

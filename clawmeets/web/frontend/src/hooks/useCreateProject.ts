import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { createProject, getChatrooms, sendUserMessage, uploadUserFile } from '../api/endpoints'
import type { Chatroom } from '../types'

export interface CreateProjectData {
  name: string
  request: string
  files: File[]
  agentPool?: 'owned' | 'verified' | 'all'
  agentTeams?: string[]
  agentNames?: string[]
  // Override who drives this project. Falls back to the user's assistant.
  // Both id and name must be supplied together when overriding — the name is
  // used to build the opening @mention posted into user-communication.
  coordinatorId?: string
  coordinatorName?: string
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { user } = useAuthStore()

  return useMutation({
    mutationFn: async (data: CreateProjectData) => {
      if (!user?.assistant_agent_id) {
        throw new Error('No assistant agent linked to your account')
      }

      // 1. Create project. Coordinator defaults to the user's assistant unless
      //    the caller picked a different agent in the New Project form.
      const coordinatorId = data.coordinatorId ?? user.assistant_agent_id
      const project = await createProject({
        name: data.name,
        coordinator_id: coordinatorId,
        request: data.request,
        created_by: user.id,
        agent_pool: data.agentPool || 'verified',
        agent_teams: data.agentTeams && data.agentTeams.length > 0 ? data.agentTeams : undefined,
        agent_names: data.agentNames && data.agentNames.length > 0 ? data.agentNames : undefined,
      })

      // 2. Fetch chatrooms to get room IDs
      const chatrooms = await getChatrooms(project.id)
      const sharedContext = chatrooms.find(
        (r: Chatroom) => r.name === 'shared-context'
      )
      const userComm = chatrooms.find(
        (r: Chatroom) => r.name === 'user-communication'
      )

      if (!sharedContext || !userComm) {
        throw new Error('Required chatrooms not found')
      }

      // 3. Upload files to shared-context room
      for (const file of data.files) {
        const content = await file.arrayBuffer()
        await uploadUserFile(project.id, sharedContext.id, file.name, content)
      }

      // 4. Post "@{coordinator_name} {request}" to user-communication room
      const coordinatorName = data.coordinatorName ?? `${user.username}-assistant`
      await sendUserMessage(project.id, userComm.id, {
        content: `@${coordinatorName} ${data.request}`,
      })

      return project
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['user-projects'] })
      queryClient.invalidateQueries({ queryKey: ['all-projects'] })
      navigate(`/projects/${project.id}`)
    },
  })
}

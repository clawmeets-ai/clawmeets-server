import { useQueries } from '@tanstack/react-query'
import { useUserProjects } from './useProjects'
import { isThreadProject, ProjectStatus } from '../types'
import { getChatrooms } from '../api/endpoints'
import type { PlanSummary } from '../api/endpoints/projectPlans'
import { BatchItemError } from '../api/endpoints/batch'

// Sidebar view models. Kept structurally in sync with the local `ProjectView`
// that `ProjectItem` consumes.
export interface ChatroomView {
  chatroom_id: string
  chatroom_name: string
}

export interface ProjectView {
  project_id: string
  project_name: string
  status: ProjectStatus
  created_at: string
  chatrooms: ChatroomView[]
  is_viewer?: boolean
  // Drives the DM vs regular split and (for DM rows) the nav target.
  surface?: 'regular' | 'dm' | 'frontdesk'
  coordinator_id?: string
  // Newest-first sort key; falls back to created_at pre-M2a.
  last_modified?: string
  // Mirrors Project.report_published_at — the My Desk report lane gates on this.
  // Non-null iff a real completion report exists (⇒ completed).
  report_published_at?: string | null
  // Mirrors Project.plan — the desk card's Plan band reads it. ABSENT means the
  // project has no plan at all; four of its members are null on a front-desk
  // shape, so read `plan.phase` with a null check.
  plan?: PlanSummary | null
  // /me/chatrooms answered "unavailable" for this project (isolation, unknown
  // or not authorized: the batch does not say which).
  chatrooms_unavailable?: boolean
}

/**
 * Fetches the caller's projects plus each project's
 * chatrooms, transformed into the `ProjectView[]` the sidebar renders. Every
 * thread-shaped project is excluded here: own-DM threads render in the DMs rail
 * (`useDmThreads`) and both Front Desk ends render in Public/Front Desk, so
 * neither dm nor frontdesk rows belong in this regular-projects source.
 *
 * Lifted verbatim out of the former `ProjectList` so multiple sidebar sections
 * (and the command palette) can share one source instead of re-querying.
 */
export function useProjectsWithChatrooms() {
  const { data: projects, isLoading: projectsLoading, error: projectsError } = useUserProjects()

  const listedProjects =
    projects?.filter((project) => !isThreadProject(project)) ?? []

  const chatroomQueries = useQueries({
    queries: listedProjects.map((project) => ({
      queryKey: ['chatrooms', project.id],
      queryFn: () => getChatrooms(project.id),
      enabled: !!project.id,
      staleTime: 30_000,
      // An "unavailable" item will answer the same again.
      retry: (n: number, e: unknown) => !(e instanceof BatchItemError) && n < 1,
    })),
  })

  // Gate ONLY on the project-list query — never on the per-project chatroom
  // fetches; a single slow getChatrooms must not blank the whole list. Show
  // stale cached projects over an error banner on background-refetch failure.
  const isLoading = projectsLoading
  const error = projects ? null : projectsError

  const projectViews: ProjectView[] = listedProjects.map((project, index) => {
    const chatrooms = chatroomQueries[index]?.data ?? []
    const roomsError = chatroomQueries[index]?.error
    return {
      project_id: project.id,
      // DM threads always carry a model-set display_name ("New chat" until
      // auto-titled); regular/legacy rows fall back to the raw name.
      project_name: project.display_name || project.name,
      status: project.status,
      created_at: project.created_at,
      is_viewer: project.is_viewer,
      surface: project.surface,
      coordinator_id: project.coordinator_id,
      last_modified: project.last_modified,
      report_published_at: project.report_published_at ?? null,
      plan: project.plan ?? null,
      chatrooms: chatrooms.map((cr): ChatroomView => ({
        chatroom_id: cr.id,
        chatroom_name: cr.name,
      })),
      chatrooms_unavailable: roomsError instanceof BatchItemError && roomsError.code === 'unavailable',
    }
  })

  return { data: projectViews.length > 0 ? projectViews : undefined, isLoading, error }
}

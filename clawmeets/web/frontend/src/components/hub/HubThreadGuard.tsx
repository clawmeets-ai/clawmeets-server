import type { ReactNode } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { ApiError } from '../../api/client'
import { useProject, useUserProjects } from '../../hooks/useProjects'
import { hubThreadPath } from '../../utils/hubDisplay'
import Loading from '../common/Loading'

/**
 * Wraps the ordinary project, chatroom and DM routes. A project with a
 * hub_target is a conversation with an agent on another server, and its
 * remote replies must only ever render in HubChatView (untrusted Markdown).
 * A search hit, a pasted link or an old bookmark can still point at one of
 * the ordinary views, so this waits for the project and, for a hub thread,
 * redirects to its /hub route before the ordinary view mounts at all.
 *
 * The answer comes from the user's project list when it already holds the
 * project (both carry hub_target), so moving between known threads never
 * waits or remounts; otherwise from the project itself.
 *
 * `param` names the route parameter holding the project id. Without one (the
 * agent view, /dm/:agentName), or when the server says the project is not
 * the user's to read (403 or 404), the ordinary view renders as before and
 * handles its own errors. Any other failure (a 5xx, a network error) says
 * nothing about the project, so the ordinary view is not mounted: its own
 * message read could still succeed and render a hub reply as trusted.
 */
export default function HubThreadGuard({ param, children }: { param: string; children: ReactNode }) {
  const projectId = useParams()[param] ?? ''
  const { data: userProjects } = useUserProjects()
  const listed = projectId ? userProjects?.find((p) => p.id === projectId) : undefined
  const { data: fetched, isLoading, error, refetch, isFetching } = useProject(listed ? '' : projectId)
  const project = listed ?? fetched
  if (!projectId) return <>{children}</>
  if (!project && isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center" data-testid="hub-thread-guard-loading">
        <Loading size="lg" />
      </div>
    )
  }
  if (!project && error && !(error instanceof ApiError && (error.status === 403 || error.status === 404))) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-gray-600" data-testid="hub-thread-guard-error" role="alert">
        <p>Couldn't open this conversation. Check your connection and try again.</p>
        <button
          type="button"
          className="px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          disabled={isFetching}
          onClick={() => { void refetch() }}
        >
          Try again
        </button>
      </div>
    )
  }
  const t = project?.hub_target
  if (t) return <Navigate replace to={hubThreadPath(t.hub_agent_id, project.id)} />
  return <>{children}</>
}

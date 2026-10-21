import { useQuery } from '@tanstack/react-query'
import { getProjectReport, type ProjectReport } from '../api/endpoints/projectReports'
import { retryUnlessIsolated } from '../utils/agentAccessCopy'

/** Fetches a project's completion report. The list refreshes on
 *  PROJECT_REPORT_SYNC envelopes (see `useWebSocketUpdates` in
 *  `hooks/useWebSocket.ts`) — no polling.
 *
 *  Returns `null` when no report exists yet — that's a normal empty
 *  state (project hasn't been wrapped up), not an error. */
export function useProjectReport(projectId: string | undefined) {
  return useQuery<ProjectReport | null>({
    queryKey: ['project-report', projectId],
    queryFn: () => getProjectReport(projectId!),
    retry: retryUnlessIsolated,
    enabled: !!projectId,
    staleTime: 0,
  })
}

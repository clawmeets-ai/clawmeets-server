import { useQuery } from '@tanstack/react-query'
import {
  getPlanVersions,
  getProjectPlan,
  type PlanIndex,
  type PlanVersion,
} from '../api/endpoints/projectPlans'
import { retryUnlessIsolated } from '../utils/agentAccessCopy'

/** Fetches a project's plan index. Refreshed by PROJECT_PLAN_SYNC envelopes
 *  (see `useWebSocketUpdates` in `hooks/useWebSocket.ts`) — never polled.
 *
 *  Returns `null` when the project has no PLAN.md — a DM, or a pre-feature
 *  project. That is a normal empty state, not an error. */
export function useProjectPlan(projectId: string | undefined) {
  return useQuery<PlanIndex | null>({
    queryKey: ['project-plan', projectId],
    queryFn: () => getProjectPlan(projectId!),
    retry: retryUnlessIsolated,
    enabled: !!projectId,
    staleTime: 0,
  })
}

/** The revision history behind the tab's History panel. Its own key so a write
 *  that only files a note does not force a second fetch of a list that did not
 *  move — the sync invalidates both, and react-query refetches only what is
 *  mounted. */
export function useProjectPlanVersions(projectId: string | undefined, enabled = true) {
  return useQuery<PlanVersion[]>({
    queryKey: ['project-plan-versions', projectId],
    queryFn: () => getPlanVersions(projectId!),
    enabled: !!projectId && enabled,
    staleTime: 0,
  })
}

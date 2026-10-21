import { ApiError, del, get } from '../client'

/** A project's interactive completion report — the artifact the
 *  coordinator uploads via `clawmeets project upsert-report`. One per
 *  project; overwrites on every republish.
 *
 *  `data` is whatever JSON the render code understands. `render_code_js`
 *  is the body of `function(mount, data, lib)`; the shell wraps and
 *  executes it via the shared <RenderBody>. */
export interface ProjectReport {
  project_id: string
  title: string
  generated_by_agent_id: string
  generated_by_agent_name: string
  data: unknown
  render_code_js: string
  generated_at: string
}

/** Fetch the report. Returns `null` when no report has been authored
 *  yet (server 404) — that's a fine empty state, not an error. Other
 *  failures propagate so React Query can show them. */
export async function getProjectReport(
  projectId: string,
): Promise<ProjectReport | null> {
  try {
    return await get<ProjectReport>(`/projects/${projectId}/report`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

export async function deleteProjectReport(projectId: string): Promise<void> {
  await del(`/projects/${projectId}/report`)
}

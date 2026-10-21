import { get, post, del } from '../client'
import { chatroomsLoader } from '../loaders'
import type { Project, Chatroom } from '../../types'

export interface CreateProjectRequest {
  name: string
  coordinator_id: string
  request: string
  created_by?: string
  agent_pool?: 'owned' | 'verified' | 'all'
  agent_teams?: string[]
  agent_names?: string[]
}

export async function createProject(data: CreateProjectRequest): Promise<Project> {
  return post<Project>('/projects', data)
}

export async function getProjects(): Promise<Project[]> {
  return get<Project[]>('/projects')
}

export async function getProject(projectId: string): Promise<Project> {
  return get<Project>(`/projects/${projectId}`)
}

/**
 * A project's chatroom list — coalesced.
 *
 * Every same-tick caller across the app joins ONE
 * `GET /me/chatrooms?project_ids=...` batch, chunked at the server's 50-id cap.
 * A reconnect that used to cost one request per project now costs one per 50.
 *
 * The swap lives HERE rather than in each `queryFn` deliberately: all five call
 * sites keep a zero diff, and a sixth cannot silently reintroduce the
 * per-project fan-out — which is exactly how FrontDeskPanel's ×130 stayed
 * invisible through five milestones. Enforced by singleIssuer.test.ts.
 *
 * Callers see no change: the resolved value is byte-identical to what
 * `GET /projects/{id}/chatrooms` returned (server pins this with a
 * serialized-bytes equality test), so existing `['chatrooms', projectId]`
 * cache entries are interchangeable with batch-sourced ones. A failure still
 * rejects this promise, so per-project error and retry state are unchanged.
 */
export async function getChatrooms(projectId: string): Promise<Chatroom[]> {
  return chatroomsLoader.load(projectId)
}

export async function getChatroom(
  projectId: string,
  chatroomName: string
): Promise<Chatroom> {
  return get<Chatroom>(`/projects/${projectId}/chatrooms/${chatroomName}`)
}

export async function getUserProjects(userId: string): Promise<Project[]> {
  return get<Project[]>(`/participants/${userId}/projects`)
}

export async function deleteProject(projectId: string): Promise<{ status: string }> {
  return del<{ status: string }>(`/projects/${projectId}`)
}

/**
 * Rename a thread — `POST /projects/{id}/display-name`, `{display_name}` in,
 * the full updated `Project` back on 200.
 *
 * One call covers both surfaces in the UI: a DM thread IS a `Project`
 * (`surface === 'dm'`), so the project page and the DM page rename the same
 * field through the same route.
 *
 * Two contract details that are easy to get wrong:
 *
 * - `expected_current` is deliberately NOT sent. On the server it is a
 *   best-effort re-check, and on mismatch the route returns 200 with the
 *   *unchanged* project — a silent no-op that would show the user success next
 *   to the old name. The auto-titler pins it (that is what stops an auto-title
 *   from clobbering a manual rename); a manual rename must omit it and take
 *   last-write-wins.
 * - The returned `display_name` is the SERVER'S normalized value, not the
 *   string we sent ("Trip   plan" comes back "Trip plan"). Callers must render
 *   from this response rather than from local input.
 *
 * Rejects with `ApiError{status, message = the server's `detail` sentence}` on
 * 4xx — `client.ts:throwApiError` already lifts `detail` into `message`, so
 * there is no response parsing here.
 */
export async function renameProject(
  projectId: string,
  displayName: string
): Promise<Project> {
  return post<Project>(`/projects/${projectId}/display-name`, {
    display_name: displayName,
  })
}

/**
 * Mark a thread DONE — `POST /projects/{id}/complete`, no body.
 *
 * The desk card's **Done** button is the only browser caller. That button used
 * to write a read watermark and nothing else: the card vanished, but the
 * project stayed `active` and the ticket chip on the linked to-do still read
 * Working. This is the other half — the status flip the chip is derived from.
 *
 * One call covers both card kinds. A DM thread and a regular project are both
 * `Project` rows, and the desk keys cards as `${projectId}|user-communication`,
 * so one card is exactly one project with nothing to disambiguate.
 *
 * `changed` distinguishes a real transition from a no-op on an
 * already-completed project (a card in the report lane is exactly that case).
 * The button ignores it — the project is completed either way, which is what
 * the press asked for — but it is on the wire so a caller that cares can tell.
 *
 * Rejects with `ApiError{status, message}` on 4xx; `403` is "not your thread",
 * never 401 (the client reads a 401 as an expired token and logs the user out).
 */
export async function completeProject(
  projectId: string
): Promise<{ status: string; changed: boolean }> {
  return post<{ status: string; changed: boolean }>(
    `/projects/${projectId}/complete`,
    {}
  )
}

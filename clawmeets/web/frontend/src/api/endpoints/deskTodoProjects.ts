import { get, post, del } from '../client'
import type { DeskTodo } from './deskTodos'

/**
 * The associations between a to-do and the projects it spawned — the write half
 * of the ticket axis.
 *
 * ONE ID SPACE. A DM thread and a regular project are the same kind of thing to
 * these three routes and appear on the same footing in a listed row; nothing
 * here branches on which it is. That is what lets the desk's **command** button
 * — which spawns a DM thread — link its to-do through the ordinary path.
 *
 * REFUSALS ON THIS SURFACE ARE BARE. `detail` is the whole sentence, with no
 * `labels.<code>:` prefix, and it is rendered verbatim. The prefix is not a
 * house style, it is a client-rewrite protocol: `utils/labelErrors.ts` strips
 * the code so the browser can write copy BETTER than the server's, using
 * context only the browser holds. Neither association refusal has that shape —
 * the 404 already names the id the owner typed and the 403 already names the
 * project's display name — so there is nothing for a code to dispatch on.
 *
 * `parseLabelError` is still safe to run these through: `CODED` is anchored on
 * `^labels\.`, so a bare detail simply does not match and the whole string
 * comes back as the sentence with a null code. The one rule is that no caller
 * on this surface may REQUIRE a code.
 */

/**
 * One row of `GET /me/desk/todos/{id}/projects`.
 *
 * The row is discriminated by `resolved`, and the split is exact: three keys
 * are on EVERY row and five appear only when the id resolved. The five are
 * OMITTED, never sent as `null`, which is why `?:` is the whole story here and
 * why this interface contains no `| null` anywhere — no reader needs a
 * null-vs-undefined branch.
 */
export interface TodoProjectRow {
  // ── Always present, on every row, resolved or not ────────────────────────
  id: string
  /** False for a DANGLING id — one whose project has been deleted. Such a row
   *  is still LISTED rather than hidden: an association the owner cannot see is
   *  one they could not otherwise remove, and `dissociateTodoProject` is the
   *  only way out. */
  resolved: boolean
  /**
   * Does this association feed the derived `state`? REQUIRED, not optional,
   * and that is the stricter reading rather than a nicety.
   *
   * Were it omitted on a dangling row, a reader would have to treat ABSENT as
   * false — which holds right up until a resolved-but-FAILED project sends a
   * genuine `contributes: false`, and then two different wire shapes mean one
   * thing. One always-emitted key buys a required type and a single reading.
   */
  contributes: boolean

  // ── Present ONLY when `resolved === true` — omitted, never null ───────────
  display_name?: string
  name?: string
  /** Closed at THREE values: `models/project.py:58` states there will
   *  deliberately never be a fourth `ProjectStatus` member and names the
   *  callsites a fourth would break. A literal union, never `string`. */
  status?: 'active' | 'completed' | 'failed'
  surface?: 'regular' | 'dm' | 'frontdesk'
  /** NOT `surface === 'dm'`. It is `Project.is_dm_shaped`, true for BOTH
   *  `"dm"` and `"frontdesk"` (`models/project.py:430-439`), so deriving it
   *  from `surface` gets every Front Desk thread wrong. Read the field.
   *  Descriptive only — it never filters what may be listed or linked. */
  is_dm?: boolean
}

/**
 * Link a project or DM thread to a to-do. Resolves with the to-do in WIRE
 * shape, so the caller sees the `state` its own write just produced rather
 * than having to refetch to find out.
 *
 * IDEMPOTENT: linking an id the to-do already carries is a 200 no-op, not a
 * 409. That is what makes a double-press safe from this end as well as from
 * the thread-creation end.
 *
 * Throws `ApiError` on the two refusals — 404 for an id that does not resolve
 * OR resolves but is invisible to this owner (one answer for two facts, on
 * purpose: splitting them would make the route an existence oracle), 403 for a
 * project someone else created. Both carry a bare sentence.
 */
export async function associateTodoProject(
  todoId: string,
  projectId: string,
): Promise<DeskTodo> {
  return post<DeskTodo>(`/me/desk/todos/${todoId}/projects`, {
    project_id: projectId,
  })
}

/**
 * Unlink a project from a to-do. Resolves with the to-do in wire shape.
 *
 * Idempotent in the other direction: removing an id the to-do does not carry
 * is a 200 no-op. `projectId` is a PATH segment here rather than a body field,
 * so it is encoded — a dangling id is arbitrary stored text and this is the one
 * route that has to survive it.
 */
export async function dissociateTodoProject(
  todoId: string,
  projectId: string,
): Promise<DeskTodo> {
  return del<DeskTodo>(
    `/me/desk/todos/${todoId}/projects/${encodeURIComponent(projectId)}`,
  )
}

/** The to-do's associations, resolved. Dangling ids included — see
 *  `TodoProjectRow.resolved`. */
export async function getTodoProjects(todoId: string): Promise<TodoProjectRow[]> {
  return get<TodoProjectRow[]>(`/me/desk/todos/${todoId}/projects`)
}

import { getFile } from '../client'
import type { DeskTodoAttachment } from './deskTodos'

/**
 * Reading a to-do's stored attachment bytes back.
 *
 * Its own module rather than a function on `deskTodos.ts` because it returns
 * BYTES, not plate JSON: different response handling, different cache, and a
 * different reason to change.
 *
 * There is deliberately no room-scoped URL to link to. The blobs live in a
 * user-scoped tree behind the owner's own `/me/desk/*` routes, addressed by an
 * opaque server-minted id, precisely so a file parked on a private to-do is not
 * fanned out to every agent before the user has chosen a recipient.
 */

/** Per-attachment-id blob cache. Re-clicking the same plate row must not
 *  re-download 20 MB, and eager-fetch-on-load is only affordable because of
 *  this. Keyed by to-do AND attachment: ids are minted per to-do and a stale
 *  hit across items would stage the wrong bytes. */
const cache = new Map<string, File>()

const keyOf = (todoId: string, attachmentId: string) => `${todoId}:${attachmentId}`

/**
 * Download one stored attachment and wrap it as a `File` named and typed by its
 * descriptor, so a re-staged chip is indistinguishable from one the user just
 * picked — which is what makes a later dispatch send the REAL bytes rather than
 * a name.
 *
 * `Content-Disposition` on the response is not load-bearing here: we read the
 * body as a blob, which ignores it.
 *
 * A 404 — the deliberately-surfaced case where the plate names bytes that are
 * gone — and any other failure both reject; the caller renders the error chip.
 * Nothing is cached on failure, so a retry is a real retry rather than a
 * replayed one.
 */
export async function fetchTodoAttachment(
  todoId: string,
  a: DeskTodoAttachment,
): Promise<File> {
  const key = keyOf(todoId, a.id)
  const hit = cache.get(key)
  if (hit) return hit

  const blob = await getFile(`/me/desk/todos/${todoId}/attachments/${a.id}`)
  const file = new File([blob], a.name, {
    type: a.content_type || blob.type || 'application/octet-stream',
  })
  cache.set(key, file)
  return file
}

/** Synchronous cache peek, so a load can stage an already-resolved blob as
 *  `ready` in its first render instead of flashing a loading chip at a user who
 *  is just clicking back and forth between two rows. */
export function cachedTodoAttachment(
  todoId: string,
  attachmentId: string,
): File | undefined {
  return cache.get(keyOf(todoId, attachmentId))
}

/** Drop one entry. Used by retry, and after a delete so a recycled id can never
 *  resolve to stale bytes. */
export function forgetTodoAttachment(todoId: string, attachmentId: string): void {
  cache.delete(keyOf(todoId, attachmentId))
}

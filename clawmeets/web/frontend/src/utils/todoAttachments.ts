import { filesToAttachments } from '../api/attachments'
import type { StagedFile } from '../hooks/useMessageAttachments'
import type {
  DeskTodoAttachment,
  DeskTodoAttachmentInput,
} from '../api/endpoints/deskTodos'

/**
 * Single home for "what does this tray save as?" — the sibling of
 * `todoDraft.ts`'s "what does this to-do dispatch as?".
 *
 * The save body carries ONE ordered desired-state array, not add/remove deltas:
 * the array is the complete intended set, so a client that re-sends bytes for
 * something already stored produces a REPLACE (new id, old id absent) rather
 * than a duplicate. That structural property is worth more than a correct
 * client. Its cost runs the other way — a caller that FORGETS a kept id deletes
 * it — which is exactly why the emitter is one pure function with the invariant
 * asserted directly, instead of logic spread through a click handler.
 */

/**
 * The desired-state emitter. THE testable statement of the invariant:
 *
 *   origin 'attachment' + non-null attachmentId  -> {keep: attachmentId}
 *   null attachmentId ('user', or a not-yet-saved 'attachment')
 *                                                -> {filename, content_b64}
 *   an entry the user ✕'d                        -> nothing (it is not in `tray`)
 *
 * Order-preserving: the stored array is rebuilt in the order it arrives, so a
 * kept entry that moved position moves in the response and nothing scrambles
 * the tray.
 *
 * Async only because new uploads need base64, which comes from
 * `filesToAttachments` — the same helper the message send path already uses, so
 * the desk route inherits the exact wire convention. This function does not
 * know how to encode a file and must not learn.
 *
 * Returns `[]` for an empty tray, which the caller MUST distinguish from
 * omitting the key: `[]` means "remove all", omitted means "leave alone".
 */
export async function buildAttachmentDesiredState(
  tray: readonly StagedFile[],
): Promise<DeskTodoAttachmentInput[]> {
  const uploads = tray.filter((e) => !e.attachmentId)
  const encoded = await filesToAttachments(uploads.map((e) => e.file))

  let next = 0
  const out: DeskTodoAttachmentInput[] = []
  for (const e of tray) {
    out.push(e.attachmentId ? { keep: e.attachmentId } : encoded[next++])
  }
  return out
}

/**
 * The entries that WOULD upload — i.e. exactly the `{filename, content_b64}`
 * branch above. Sole source of the "unsaved additions" half of the row-switch
 * warning, so the warning can never count something the save would not have
 * sent. Pure and synchronous, unlike the emitter, because counting does not
 * need the bytes read.
 */
export function newUploadEntries(tray: readonly StagedFile[]): StagedFile[] {
  return tray.filter((e) => !e.attachmentId)
}

/**
 * How many attachment changes on this tray a switch would throw away: files
 * staged but not yet saved, PLUS stored attachments the user ✕'d but has not
 * yet saved the removal of.
 *
 * Both halves matter and the second is the one the old guard missed entirely:
 * it fired only when the TEXT differed, so loading an item, deleting its
 * attachment and clicking a row whose draft happened to match silently undid
 * the deletion with no warning at all.
 *
 * `storedIds` is what the server was last known to hold for the bound item —
 * from the load, or from the descriptors the last save returned.
 */
export function unsavedAttachmentCount(
  tray: readonly StagedFile[],
  storedIds: readonly string[],
): number {
  const onTray = new Set(
    tray.filter((e) => e.attachmentId).map((e) => e.attachmentId as string),
  )
  const removed = storedIds.filter((id) => !onTray.has(id)).length
  return newUploadEntries(tray).length + removed
}

/**
 * Fold the server's reconciled descriptors back onto the tray after a save, so
 * a second press of Save is a no-op instead of churn: every entry that emitted
 * a new upload takes the id of the descriptor it produced and will emit
 * `{keep}` next time.
 *
 * Pairing is greedy on (name, size) among still-unclaimed descriptors, in tray
 * order, with a positional fallback. The server echoes the request's ordering,
 * which makes the positional fallback exact; the (name, size) pass is what
 * keeps this correct without depending on that promise. Two tray entries can
 * collide only when they share BOTH name and size — in which case they are
 * indistinguishable to the user anyway, and greedy still claims each descriptor
 * exactly once, so every id is assigned and no id is assigned twice. That
 * totality is the property that matters; which of two identical files got which
 * id does not.
 */
export function adoptServerIds(
  tray: readonly StagedFile[],
  stored: readonly DeskTodoAttachment[],
): StagedFile[] {
  const claimed = new Set(
    tray.filter((e) => e.attachmentId).map((e) => e.attachmentId as string),
  )
  const pool = stored.filter((d) => !claimed.has(d.id))

  return tray.map((e) => {
    if (e.attachmentId) return e
    let i = pool.findIndex((d) => d.name === e.file.name && d.size === e.file.size)
    if (i < 0) i = 0
    const [desc] = pool.splice(i, 1)
    if (!desc) return e
    // A staged 'user' file that has been persisted IS a stored attachment now.
    // Without this the next save would re-upload it and the server would mint a
    // second id for the same bytes.
    return { ...e, origin: 'attachment', attachmentId: desc.id, status: 'ready' }
  })
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Keep in sync with the server cap (CLAWMEETS_MAX_MESSAGE_ATTACHMENTS_BYTES,
// default 20 MB in server/routes/messages.py). Enforced client-side so the
// user sees the limit before an oversize atomic send is rejected with 413.
//
// ALSO the per-to-do total cap on the desk attachment route — one mirror, one
// number. A to-do exists to be dispatched, and dispatch enforces this same cap,
// so a to-do allowed to hold more would be a to-do that can be saved and can
// never be sent. Gated cross-language by a pytest that greps THIS symbol in
// THIS file and asserts it equals `_max_message_attachments_bytes()`; minting a
// second desk-only constant would leave one of the two ungated.
export const MAX_MESSAGE_ATTACHMENTS_BYTES = 20 * 1024 * 1024

/**
 * What a tray entry IS. Never a filename check — provenance is what the entry
 * carries.
 *
 *   'user'       picked with the paperclip or dropped on the box — uploads
 *   'attachment' a real stored attachment (or one about to become one)
 */
export type StagedOrigin = 'user' | 'attachment'

/** Where a re-staged attachment is in its eager background fetch. Absent on
 *  every entry the chatroom composer creates — those are `ready` by nature. */
export type StagedStatus = 'ready' | 'loading' | 'error'

interface StagedEntry {
  id: string
  file: File
  origin: StagedOrigin
  /** The server id, for an entry already stored. `null`/absent ⇒ a new upload.
   *  This and `origin` are the ONLY two things the desired-state emitter
   *  branches on. */
  attachmentId?: string | null
  status?: StagedStatus
  /** Size to DISPLAY, and to charge against the cap, while `status` is
   *  `'loading'` — it comes from the stored descriptor, because the
   *  placeholder File has no bytes yet and `file.size` would read 0 B. */
  displaySize?: number
}

export interface StagedFile {
  id: string
  file: File
  previewUrl?: string // object URL, images only
  origin: StagedOrigin
  attachmentId?: string | null
  status?: StagedStatus
  displaySize?: number
}

/** The desk save path spells the tray element `TrayEntry`. It IS `StagedFile` —
 *  an alias, not a second type, so there is one shape to keep true. */
export type TrayEntry = StagedFile

/** What `replaceStagedFiles` takes: a File plus what it IS. A bare
 *  `FileList | File[]` could not express origin, and origin is the whole
 *  point of the replacement — N attachment chips, each needing its own
 *  provenance, id and status. */
export interface StagedSeed {
  file: File
  origin: StagedOrigin
  attachmentId?: string | null
  status?: StagedStatus
  displaySize?: number
}

export interface MessageAttachmentsOptions {
  /** Overflow sentence. Defaults to the per-message wording, so the chatroom
   *  composer is untouched; the desk box passes its own, because "per-message"
   *  would be a lie on a to-do. */
  overflowMessage?: string
}

/** What an entry costs against the cap. A chip still fetching its bytes has a
 *  0-byte placeholder File, so charging `file.size` would let a 20 MB to-do
 *  load and then accept 20 MB more on top. */
function entrySize(e: { file: File; displaySize?: number }): number {
  return e.displaySize ?? e.file.size
}

/**
 * Whether the cap is allowed to REFUSE this entry — as opposed to merely charge
 * it, which every entry is.
 *
 * An entry carrying an `attachmentId` is bytes the server has ALREADY accepted
 * and is ALREADY holding. Refusing it cannot lower the stored total; the file
 * exists either way. What refusing it does do is drop the chip — and on the desk
 * save path the tray is emitted as the COMPLETE desired state, so a stored id
 * missing from the tray is a stored id the next Save deletes. That turns a
 * client-side size check into silent data loss, which is the one thing a size
 * check must never be.
 *
 * The drift is not hypothetical in either direction. This file's cap is a
 * hardcoded mirror of `CLAWMEETS_MAX_MESSAGE_ATTACHMENTS_BYTES` — the very
 * variable the server's own 413 tells a deployment to raise — so a raised server
 * cap leaves a client that is merely stricter. Stricter is safe for an UPLOAD
 * and destructive for a RE-STAGE.
 *
 * So: charge stored bytes, so a NEW file on top is still refused exactly as the
 * server would refuse it — but never refuse the stored bytes themselves.
 */
function isRefusable(e: { attachmentId?: string | null }): boolean {
  return !e.attachmentId
}

/**
 * Client-side attachment staging for a composer. Files are held in memory
 * (never uploaded on pick); they ride the message's atomic send request. Image
 * object URLs are managed here (created + revoked) for inline previews.
 *
 * What an entry now carries beyond its File is WHAT IT IS (`origin`) and, if it
 * is already stored, WHICH stored object it is (`attachmentId`). Everything
 * downstream — what uploads, what a ✕ means, what a switch warns about —
 * branches on those two fields and never on a filename.
 */
export function useMessageAttachments(opts?: MessageAttachmentsOptions) {
  const [staged, setStaged] = useState<StagedEntry[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  // Mirror state into a ref for synchronous total-size reads inside addFiles
  // (avoids side effects inside the setState updater).
  const stagedRef = useRef<StagedEntry[]>(staged)
  stagedRef.current = staged

  // Read through a ref so `admit` can stay a stable callback while a caller is
  // free to pass its sentence inline.
  const overflowRef = useRef<string | undefined>(opts?.overflowMessage)
  overflowRef.current = opts?.overflowMessage

  // Manage image preview object URLs. Recomputed whenever the staged set
  // changes; cleanup revokes so there is no leak on add/remove/unmount.
  useEffect(() => {
    const urls: Record<string, string> = {}
    for (const entry of staged) {
      // A still-loading chip's File is an empty placeholder — previewing it
      // would flash a blank thumbnail that the real bytes then replace.
      if (entry.status !== 'loading' && entry.file.type.startsWith('image/')) {
        urls[entry.id] = URL.createObjectURL(entry.file)
      }
    }
    setPreviews(urls)
    return () => {
      Object.values(urls).forEach((url) => URL.revokeObjectURL(url))
    }
  }, [staged])

  /**
   * Entries from `incoming` that still fit on top of `base`, and the overflow
   * error that goes with them. The size budget is measured against `base` — the
   * caller says what the tray will actually contain, so a replace is costed
   * against an empty tray rather than against files it is about to drop.
   *
   * "Fit" is a question the cap only gets to ask about entries it may refuse
   * (see `isRefusable`). Everything is CHARGED; only new bytes are REFUSED. The
   * running total can therefore legitimately end above the cap — that is what a
   * to-do the server already accepted looks like — and the next new file the
   * user picks is refused on top of it, which is the answer the server would
   * give too.
   */
  const admit = useCallback(
    (incoming: readonly StagedSeed[], base: StagedEntry[]): StagedEntry[] => {
      let running = base.reduce((n, s) => n + entrySize(s), 0)
      const additions: StagedEntry[] = []
      let overflow = false
      for (const seed of incoming) {
        // Latching, rather than the `break` this used to be: a break would stop
        // at the first refusal and drop the whole REST of the list, including
        // entries the cap has no right to refuse. Latching keeps the behaviour
        // identical for a homogeneous list of new files — once one is refused
        // every later one is too — while making it structurally impossible for
        // an already-stored attachment to be lost to a neighbour's overflow.
        if (isRefusable(seed)) {
          if (overflow) continue
          if (running + entrySize(seed) > MAX_MESSAGE_ATTACHMENTS_BYTES) {
            overflow = true
            continue
          }
        }
        running += entrySize(seed)
        additions.push({ id: crypto.randomUUID(), ...seed })
      }

      setAttachmentError(
        overflow
          ? overflowRef.current ??
              `Attachments exceed the ${Math.round(
                MAX_MESSAGE_ATTACHMENTS_BYTES / (1024 * 1024)
              )} MB per-message limit.`
          : null
      )
      return additions
    },
    []
  )

  /**
   * Stage files for the next send. Returns the ids it actually created, so a
   * caller that auto-stages a file on the user's behalf can remove exactly
   * that one later instead of guessing
   * which entry was its. Callers that stage on a user gesture ignore the value.
   *
   * `origin` defaults to `'user'`, so the paperclip, the drop zone and the whole
   * chatroom composer keep calling this with one argument and are unchanged.
   */
  const addFiles = useCallback(
    (incoming: FileList | File[], origin: StagedOrigin = 'user'): string[] => {
      const list = Array.from(incoming)
      if (list.length === 0) return []

      const additions = admit(
        list.map((file) => ({ file, origin })),
        stagedRef.current
      )
      if (additions.length) setStaged((prev) => [...prev, ...additions])
      return additions.map((a) => a.id)
    },
    [admit]
  )

  /**
   * Swap the whole tray for `incoming` in one step — what was staged is dropped,
   * not added to. For composers that switch SUBJECT rather than just send (the
   * desk box loading a different to-do): the previous subject's attachments must
   * not ride along into the next one's send. Pass `[]` to empty the tray as part
   * of that switch. Returns created ids, same contract as `addFiles` — and in
   * seed order, so a caller can pair the id it got back with the descriptor it
   * seeded and start that entry's background fetch.
   */
  const replaceStagedFiles = useCallback(
    (incoming: readonly StagedSeed[]): string[] => {
      const additions = admit(incoming, [])
      setStaged(additions)
      return additions.map((a) => a.id)
    },
    [admit]
  )

  /**
   * Patch one entry in place, by tray id. Two callers: a background fetch
   * landing its File (`'loading'` → `'ready'`), and a save landing a server id
   * (`attachmentId` null → `"a-…"`). A no-op when the entry is gone, which is
   * what makes a late fetch for a ✕'d chip harmless rather than a resurrection.
   */
  const updateStagedFile = useCallback((id: string, patch: Partial<StagedEntry>) => {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  const removeStagedFile = useCallback((id: string) => {
    setStaged((prev) => prev.filter((s) => s.id !== id))
    setAttachmentError(null)
  }, [])

  const clearStagedFiles = useCallback(() => {
    setStaged([])
    setAttachmentError(null)
  }, [])

  const stagedFiles = useMemo<StagedFile[]>(
    () => staged.map((s) => ({ ...s, previewUrl: previews[s.id] })),
    [staged, previews]
  )

  const files = useMemo(() => staged.map((s) => s.file), [staged])

  // True while any entry is still fetching its bytes. Gates the send button:
  // dispatching now would hand the recipient an empty file.
  const anyLoading = useMemo(() => staged.some((s) => s.status === 'loading'), [staged])

  return {
    stagedFiles,
    files,
    addFiles,
    replaceStagedFiles,
    updateStagedFile,
    removeStagedFile,
    clearStagedFiles,
    attachmentError,
    anyLoading,
  }
}

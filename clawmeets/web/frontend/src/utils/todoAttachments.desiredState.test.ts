import { describe, expect, it } from 'vitest'
import {
  adoptServerIds,
  buildAttachmentDesiredState,
  newUploadEntries,
  unsavedAttachmentCount,
} from './todoAttachments'
import type { StagedFile } from '../hooks/useMessageAttachments'
import type { DeskTodoAttachment } from '../api/endpoints/deskTodos'

/**
 * The desired-state invariant, asserted directly rather than inferred from a
 * rendered composer. The save body is ONE complete array — absence is the
 * delete signal — so what this function emits is exactly what the to-do will
 * hold afterwards, and a wrong entry here is a deleted file rather than a
 * cosmetic bug.
 *
 *   origin 'attachment' + non-null attachmentId  -> {keep: attachmentId}
 *   null attachmentId                            -> {filename, content_b64}
 *   an entry the user ✕'d                        -> nothing (it left the tray)
 */

let seq = 0
const entry = (over: Partial<StagedFile> & { file: File }): StagedFile => ({
  id: `tray-${++seq}`,
  origin: 'user',
  ...over,
})

const f = (name: string, body = 'x', type = 'text/plain') =>
  new File([body], name, { type })

const desc = (over: Partial<DeskTodoAttachment> = {}): DeskTodoAttachment => ({
  id: 'a-1',
  name: 'notes.pdf',
  size: 1,
  content_type: 'application/pdf',
  sha256: '9f86d0',
  created_at: '2026-09-01T10:14:02+00:00',
  ...over,
})

describe('buildAttachmentDesiredState', () => {
  it('kept entries emit {keep: attachmentId}', async () => {
    const out = await buildAttachmentDesiredState([
      entry({ file: f('notes.pdf'), origin: 'attachment', attachmentId: 'a-4f9c2b1e' }),
    ])

    expect(out).toEqual([{ keep: 'a-4f9c2b1e' }])
  })

  it('new entries emit {filename, content_b64}', async () => {
    const out = await buildAttachmentDesiredState([entry({ file: f('contract.pdf', 'hi') })])

    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ filename: 'contract.pdf', content_b64: btoa('hi') })
  })

  it('a not-yet-saved attachment entry emits bytes, not a keep for a null id', async () => {
    const out = await buildAttachmentDesiredState([
      entry({ file: f('fresh.pdf', 'hi'), origin: 'attachment', attachmentId: null }),
    ])

    expect(out).toEqual([{ filename: 'fresh.pdf', content_b64: btoa('hi') }])
  })

  it('a ✕’d entry emits nothing — it is simply not in the tray', async () => {
    const kept = entry({ file: f('a.pdf'), origin: 'attachment', attachmentId: 'a-keep' })
    const dropped = entry({ file: f('b.pdf'), origin: 'attachment', attachmentId: 'a-gone' })

    const out = await buildAttachmentDesiredState([kept, dropped].filter((e) => e !== dropped))

    expect(out).toEqual([{ keep: 'a-keep' }])
    expect(out).not.toContainEqual({ keep: 'a-gone' })
  })

  it('preserves tray order across a mixed tray', async () => {
    const out = await buildAttachmentDesiredState([
      entry({ file: f('kept.pdf'), origin: 'attachment', attachmentId: 'a-kept' }),
      entry({ file: f('new.pdf', 'n') }),
      entry({ file: f('kept2.pdf'), origin: 'attachment', attachmentId: 'a-kept2' }),
    ])

    expect(out).toEqual([
      { keep: 'a-kept' },
      { filename: 'new.pdf', content_b64: btoa('n') },
      { keep: 'a-kept2' },
    ])
  })

  it('an empty tray emits [], which is not the same as omitting the key', async () => {
    // `[]` means "remove all". The caller decides whether to send it at all —
    // omitting the key is what leaves the stored set untouched — and this
    // function has no way to express "omitted", by design.
    await expect(buildAttachmentDesiredState([])).resolves.toEqual([])
  })
})

describe('newUploadEntries', () => {
  it('is exactly the set that would emit bytes', () => {
    const upload = entry({ file: f('new.pdf') })
    const stored = entry({ file: f('old.pdf'), origin: 'attachment', attachmentId: 'a-1' })

    expect(newUploadEntries([upload, stored])).toEqual([upload])
  })
})

describe('unsavedAttachmentCount', () => {
  it('counts a staged-not-saved file', () => {
    expect(unsavedAttachmentCount([entry({ file: f('new.pdf') })], [])).toBe(1)
  })

  it('does not count a stored attachment that carries a server id', () => {
    const stored = entry({ file: f('old.pdf'), origin: 'attachment', attachmentId: 'a-1' })

    expect(unsavedAttachmentCount([stored], ['a-1'])).toBe(0)
  })

  it('counts a ✕’d-not-saved stored attachment', () => {
    // The tray no longer holds `a-1`, but the server still does: switching away
    // now would silently undo the deletion.
    expect(unsavedAttachmentCount([], ['a-1'])).toBe(1)
  })
})

describe('adoptServerIds', () => {
  it('gives a new upload the id the server minted for it', () => {
    const tray = [entry({ file: f('notes.pdf', 'x') })]

    const [after] = adoptServerIds(tray, [desc({ id: 'a-new', name: 'notes.pdf', size: 1 })])

    expect(after.attachmentId).toBe('a-new')
    // And it is an 'attachment' now, so the NEXT save emits {keep} rather than
    // re-uploading the same bytes under a second id.
    expect(after.origin).toBe('attachment')
  })

  it('leaves kept entries alone', () => {
    const kept = entry({ file: f('kept.pdf'), origin: 'attachment', attachmentId: 'a-kept' })

    const after = adoptServerIds([kept], [desc({ id: 'a-kept', name: 'kept.pdf' })])

    expect(after[0]).toBe(kept)
  })

  it('claims each descriptor exactly once, including two identical files', () => {
    const tray = [entry({ file: f('same.pdf', 'x') }), entry({ file: f('same.pdf', 'x') })]

    const after = adoptServerIds(tray, [
      desc({ id: 'a-one', name: 'same.pdf', size: 1 }),
      desc({ id: 'a-two', name: 'same.pdf', size: 1 }),
    ])

    // Which of the two got which id does not matter — they are
    // indistinguishable to the user. Totality does: every entry has an id, and
    // no id was handed out twice.
    expect(new Set(after.map((e) => e.attachmentId))).toEqual(new Set(['a-one', 'a-two']))
  })

  it('survives a response whose order does not match the tray', () => {
    const tray = [entry({ file: f('a.pdf', 'aa') }), entry({ file: f('b.pdf', 'b') })]

    const after = adoptServerIds(tray, [
      desc({ id: 'a-b', name: 'b.pdf', size: 1 }),
      desc({ id: 'a-a', name: 'a.pdf', size: 2 }),
    ])

    expect(after.map((e) => e.attachmentId)).toEqual(['a-a', 'a-b'])
  })

  it('is idempotent — a second adopt of the same descriptors changes nothing', () => {
    const tray = [entry({ file: f('notes.pdf', 'x') })]
    const stored = [desc({ id: 'a-new', name: 'notes.pdf', size: 1 })]

    const once = adoptServerIds(tray, stored)
    const twice = adoptServerIds(once, stored)

    expect(twice.map((e) => e.attachmentId)).toEqual(['a-new'])
  })
})

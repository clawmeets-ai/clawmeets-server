import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  MAX_MESSAGE_ATTACHMENTS_BYTES,
  useMessageAttachments,
} from './useMessageAttachments'

/**
 * The size cap on the desk save path.
 *
 * The number is a MIRRORED constant, not an endpoint: the client needs it
 * before any request goes out (it checks on file pick), an endpoint would put a
 * round trip and a loading state behind a paperclip click, and it still would
 * not stop a mid-session env change.
 *
 * Drift is safe in one direction ONLY, and which direction depends on what the
 * tray is being used for. A deployment that raises the server env var without
 * rebuilding gets a client that is merely stricter — harmless when the tray is a
 * list of files to UPLOAD, because the worst case is refusing something the
 * server would have taken. It is destructive when the tray is a RE-STAGE,
 * because there the tray is emitted as the complete desired state and a chip the
 * cap dropped is a stored file the next Save deletes. Hence the split in
 * `isRefusable`: an entry with an `attachmentId` is charged and never refused.
 *
 * The cross-language assertion that this number still equals the Python
 * constant is a pytest on the server side. It cannot live here: a vitest cannot
 * import a Python constant, so a "matches the backend" test in this file could
 * only compare a fixture against itself and would pass forever while the two
 * drifted apart.
 *
 * The per-to-do cap IS the per-message cap, deliberately. A to-do exists to be
 * dispatched, and dispatch enforces this same number — one allowed to hold more
 * would be a to-do that can be saved and can never be sent.
 */

// A File whose `size` is the stated number without allocating it: jsdom reads
// `size` off the blob parts, and a real 20 MB buffer per test is pure cost.
function sized(name: string, bytes: number): File {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: bytes })
  return f
}

const MB = 1024 * 1024

afterEach(cleanup)

describe('the desk box’s attachment cap', () => {
  it('blocks at MAX_MESSAGE_ATTACHMENTS_BYTES before any request, with the desk sentence', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderHook(() =>
      useMessageAttachments({ overflowMessage: 'Attachments exceed the 20 MB limit.' }),
    )

    act(() => {
      result.current.addFiles([sized('huge.psd', MAX_MESSAGE_ATTACHMENTS_BYTES + 1)])
    })

    expect(result.current.stagedFiles).toEqual([])
    expect(result.current.attachmentError).toBe('Attachments exceed the 20 MB limit.')
    // Rejected in the box: nothing was uploaded and then refused.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('measures the TOTAL, not each file — the cap is per to-do', () => {
    const { result } = renderHook(() =>
      useMessageAttachments({ overflowMessage: 'Attachments exceed the 20 MB limit.' }),
    )

    act(() => {
      result.current.addFiles([sized('a.pdf', 15 * MB)])
    })
    expect(result.current.attachmentError).toBeNull()

    act(() => {
      result.current.addFiles([sized('b.pdf', 6 * MB)])
    })

    expect(result.current.stagedFiles.map((s) => s.file.name)).toEqual(['a.pdf'])
    expect(result.current.attachmentError).toBe('Attachments exceed the 20 MB limit.')
  })

  it('charges a still-loading chip its DESCRIPTOR size, not its empty placeholder', () => {
    // Re-staged chips hold a 0-byte placeholder until their bytes land. Charging
    // `file.size` would let a full 20 MB to-do load and then accept 20 MB more
    // on top, which the server would then refuse on save.
    const { result } = renderHook(() => useMessageAttachments())

    act(() => {
      result.current.replaceStagedFiles([
        {
          file: new File([], 'stored.pdf'),
          origin: 'attachment',
          attachmentId: 'a-1',
          status: 'loading',
          displaySize: 19 * MB,
        },
      ])
    })
    act(() => {
      result.current.addFiles([sized('extra.pdf', 2 * MB)])
    })

    expect(result.current.stagedFiles.map((s) => s.file.name)).toEqual(['stored.pdf'])
    expect(result.current.attachmentError).toMatch(/exceed/)
  })

  it('keeps the chatroom composer’s per-message sentence and its ‘user’ default origin', () => {
    // The chatroom call site passes no options and one argument. Both halves of
    // its behaviour have to be unchanged, or this milestone leaked into a
    // surface it never touched.
    const { result } = renderHook(() => useMessageAttachments())

    act(() => {
      result.current.addFiles([sized('a.pdf', MAX_MESSAGE_ATTACHMENTS_BYTES + 1)])
    })
    expect(result.current.attachmentError).toBe(
      'Attachments exceed the 20 MB per-message limit.',
    )

    act(() => {
      result.current.addFiles([new File(['x'], 'ok.pdf')])
    })
    expect(result.current.stagedFiles[0].origin).toBe('user')
    expect(result.current.stagedFiles[0].attachmentId).toBeUndefined()
  })

  it('is the same 20 MB the send path already enforces', () => {
    // Not a tautology check on a literal: the point is that ONE symbol carries
    // the number, so the desk route cannot drift from the dispatch it feeds and
    // the server-side drift guard only has one thing to grep.
    expect(MAX_MESSAGE_ATTACHMENTS_BYTES).toBe(20 * MB)
  })
})

describe('a re-stage is never truncated by the cap', () => {
  // The load path is the one place where dropping a chip DESTROYS something.
  // `buildAttachmentDesiredState` emits the tray as the complete desired state
  // and the server deletes any stored id absent from it, so "refused by the
  // client-side cap" and "deleted on the next Save" are the same event.

  it('keeps a stored to-do whole even when its stored bytes sum past the cap', () => {
    // Stored entries are bytes the server already accepted. Charging them
    // together must never cost the user one of them.
    const { result } = renderHook(() =>
      useMessageAttachments({ overflowMessage: 'Attachments exceed the 20 MB limit.' }),
    )

    act(() => {
      result.current.replaceStagedFiles([
        {
          file: new File([], 'notes.md'),
          origin: 'attachment',
          attachmentId: 'a-000',
          status: 'loading',
          displaySize: 7,
        },
        {
          file: new File([], 'big.psd'),
          origin: 'attachment',
          attachmentId: 'a-111',
          status: 'loading',
          displaySize: MAX_MESSAGE_ATTACHMENTS_BYTES,
        },
      ])
    })

    expect(result.current.stagedFiles.map((s) => s.file.name)).toEqual([
      'notes.md',
      'big.psd',
    ])
    expect(result.current.stagedFiles.map((s) => s.attachmentId)).toEqual([
      'a-000',
      'a-111',
    ])
    // Nothing is wrong from the user's side: the server is holding exactly this.
    expect(result.current.attachmentError).toBeNull()
  })

  it('keeps every stored chip when the deployment raised the server cap past ours', () => {
    // CLAWMEETS_MAX_MESSAGE_ATTACHMENTS_BYTES at 30 MB, this file still built at
    // 20. Three 10 MB attachments are legal there and over the cap here.
    const { result } = renderHook(() => useMessageAttachments())

    act(() => {
      result.current.replaceStagedFiles(
        ['a-111', 'a-222', 'a-333'].map((id, i) => ({
          file: new File([], `f${i}.bin`),
          origin: 'attachment' as const,
          attachmentId: id,
          status: 'loading' as const,
          displaySize: 10 * MB,
        })),
      )
    })

    expect(result.current.stagedFiles.map((s) => s.attachmentId)).toEqual([
      'a-111',
      'a-222',
      'a-333',
    ])
  })

  it('still refuses a NEW file stacked on an over-cap to-do', () => {
    // The exemption is for bytes the server already holds, not a hole in the
    // cap. Adding on top is exactly what the server would refuse, so we do too.
    const { result } = renderHook(() => useMessageAttachments())

    act(() => {
      result.current.replaceStagedFiles([
        {
          file: new File([], 'stored.bin'),
          origin: 'attachment',
          attachmentId: 'a-111',
          status: 'loading',
          displaySize: 30 * MB,
        },
      ])
    })
    expect(result.current.attachmentError).toBeNull()

    act(() => {
      result.current.addFiles([sized('extra.pdf', 1)])
    })

    expect(result.current.stagedFiles.map((s) => s.attachmentId)).toEqual(['a-111'])
    expect(result.current.attachmentError).toMatch(/exceed/)
  })

  it('does not let one refused new file take a stored chip down with it', () => {
    // The `break` this replaced stopped the whole loop, so anything AFTER the
    // overflow point was dropped too — including entries the cap may not refuse.
    const { result } = renderHook(() => useMessageAttachments())

    act(() => {
      result.current.replaceStagedFiles([
        { file: sized('fresh.psd', 25 * MB), origin: 'user' },
        {
          file: new File([], 'stored.bin'),
          origin: 'attachment',
          attachmentId: 'a-111',
          status: 'loading',
          displaySize: 1 * MB,
        },
      ])
    })

    expect(result.current.stagedFiles.map((s) => s.file.name)).toEqual(['stored.bin'])
    expect(result.current.attachmentError).toMatch(/exceed/)
  })

  it('still refuses every new file after the first overflow, as the break did', () => {
    // Latching, not skipping: a homogeneous list of new files must behave
    // exactly as before, or this fix leaked into the chatroom composer.
    const { result } = renderHook(() => useMessageAttachments())

    act(() => {
      result.current.addFiles([sized('huge.psd', 25 * MB), sized('tiny.txt', 1)])
    })

    expect(result.current.stagedFiles).toEqual([])
    expect(result.current.attachmentError).toMatch(/exceed/)
  })
})

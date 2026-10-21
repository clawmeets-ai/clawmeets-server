import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FileViewerModal, { type FileViewerNav } from './FileViewerModal'
import { makeSession, seedSessions } from '../../test/authFixtures'

/**
 * ← / → step through the files attached to one message. The modal only knows
 * its position; the caller owns the list. What must hold: arrows call the
 * caller back, never past either end, and never while the user is typing or
 * holding a modifier (Cmd/Alt+← is browser back).
 */

// The viewer's content hooks hit the server; a loaded text file is all these
// tests need.
let fileText = 'hello'
let blobUrl: string | null = null
let untrusted = false
const trustAsked: [string, string][] = []
vi.mock('../../hooks/useFiles', () => ({
  isBinaryFile: (name: string) => /\.html$/.test(name),
  useFileContent: () => ({ data: fileText, isLoading: false, error: null }),
  useFileBlobUrl: () => ({ blobUrl, isLoading: false, error: null }),
  useLocalFileView: () => ({ content: null, blobUrl: null, isLoading: false, error: null }),
}))
vi.mock('../../hooks/useRoomTrust', () => ({
  useRoomTrust: (projectId: string, room: string) => {
    trustAsked.push([projectId, room])
    return { untrustedBodies: untrusted, isOutsideAuthor: () => false, isUntrusted: () => untrusted, unknownAuthorUntrusted: untrusted }
  },
}))
vi.mock('../../api/endpoints/files', () => ({ downloadFileAsBlob: vi.fn() }))

afterEach(() => {
  cleanup()
  fileText = 'hello'
  blobUrl = null
  untrusted = false
  trustAsked.length = 0
})

function renderAt(index: number, total = 3) {
  const nav: FileViewerNav = { index, total, onPrev: vi.fn(), onNext: vi.fn() }
  render(
    <FileViewerModal
      projectId="p1"
      chatroomName="user-communication"
      filename="notes.txt"
      untrusted={false}
      onClose={vi.fn()}
      nav={nav}
    />,
  )
  return nav
}

describe('FileViewerModal — prev/next', () => {
  it('arrow keys call onPrev / onNext from the middle of the list', () => {
    const nav = renderAt(1)
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(nav.onPrev).toHaveBeenCalledTimes(1)
    expect(nav.onNext).toHaveBeenCalledTimes(1)
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })

  it('stops at the first file', () => {
    const nav = renderAt(0)
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(nav.onPrev).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Previous file') as HTMLButtonElement).disabled).toBe(true)
  })

  it('stops at the last file', () => {
    const nav = renderAt(2)
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(nav.onNext).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Next file') as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores arrows typed into an input', () => {
    const nav = renderAt(1)
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(nav.onNext).not.toHaveBeenCalled()
    input.remove()
  })

  it('ignores arrows with a modifier held', () => {
    const nav = renderAt(1)
    fireEvent.keyDown(document, { key: 'ArrowLeft', metaKey: true })
    fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })
    expect(nav.onPrev).not.toHaveBeenCalled()
  })

  it('shows no stepper for a single file', () => {
    renderAt(0, 1)
    expect(screen.queryByLabelText('Next file')).toBeNull()
    expect(screen.queryByText('1 / 1')).toBeNull()
  })
})

describe('FileViewerModal: a file from a Hub thread', () => {
  const HOSTILE_MD = 'Hi ![pixel](https://x.example/p.png?u=owner)'
  const open = (filename: string, outsideFile = false) =>
    render(<FileViewerModal projectId="p1" chatroomName="user-communication" filename={filename} untrusted={outsideFile} onClose={vi.fn()} />)

  it('asks the room\'s trust rule, and a .md attachment from an untrusted room loads no image', () => {
    fileText = HOSTILE_MD
    untrusted = true
    const { container } = open('notes.md')
    expect(trustAsked).toContainEqual(['p1', 'user-communication'])
    expect(container.ownerDocument.querySelectorAll('img').length).toBe(0)
    expect(screen.getByText(/Hi/)).toBeTruthy()
  })

  it('an .html attachment from an untrusted room is neither framed nor offered in a new tab', () => {
    blobUrl = 'blob:http://localhost/x'
    untrusted = true
    open('page.html')
    expect(document.querySelectorAll('iframe').length).toBe(0)
    expect(screen.queryByLabelText('Open in new tab')).toBeNull()
    expect(screen.getByText(/came from another server/)).toBeTruthy()
  })

  it('a file the caller marks outside opens untrusted even in a trusted room', () => {
    blobUrl = 'blob:http://localhost/x'
    open('page.html', true)
    expect(document.querySelectorAll('iframe').length).toBe(0)
    expect(screen.queryByLabelText('Open in new tab')).toBeNull()
  })

  it('offers Save to agent for a trusted file only', () => {
    seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1')
    open('notes.md')
    expect(screen.getByLabelText('Save to agent')).toBeTruthy()
    cleanup()
    open('notes.md', true)
    expect(screen.queryByLabelText('Save to agent')).toBeNull()
    cleanup()
    untrusted = true
    open('notes.md')
    expect(screen.queryByLabelText('Save to agent')).toBeNull()
    seedSessions([])
  })

  it('a trusted room still draws the .md image and frames the .html page', () => {
    fileText = HOSTILE_MD
    open('notes.md')
    expect(document.querySelectorAll('img').length).toBe(1)
    cleanup()
    blobUrl = 'blob:http://localhost/x'
    open('page.html')
    expect(document.querySelectorAll('iframe').length).toBe(1)
    expect(screen.getByLabelText('Open in new tab')).toBeTruthy()
  })
})

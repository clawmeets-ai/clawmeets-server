import { useEffect, useState, useCallback } from 'react'
import { Loader2, Download, X, ExternalLink, ChevronLeft, ChevronRight, FolderInput } from 'lucide-react'
import { useFileContent, useFileBlobUrl, useLocalFileView, isBinaryFile } from '../../hooks/useFiles'
import { downloadFileAsBlob } from '../../api/endpoints/files'
import { BlobFilePreview, TextFilePreview, isHtmlFile } from './FilePreview'
import SaveToAgentPanel from './SaveToAgentPanel'
import { useAuthStore } from '../../stores/authStore'
import { useRoomTrust } from '../../hooks/useRoomTrust'

/** Optional stepping through a sibling list the caller owns (e.g. the files
 *  attached to one message). The viewer only knows its position; the caller
 *  swaps `filename` in response to onPrev / onNext. */
export interface FileViewerNav {
  /** 0-based position of `filename` in the caller's list. */
  index: number
  total: number
  /** Only called when index > 0. */
  onPrev: () => void
  /** Only called when index < total - 1. */
  onNext: () => void
}

/** Two sources, one viewer: a file already in a chatroom (fetched from the
 *  server), or a `File` still in the browser — a staged attachment the user
 *  wants to look at before sending. */
type FileViewerModalProps = {
  filename: string
  onClose: () => void
  nav?: FileViewerNav
} & (
  // A chatroom file must say whether it came from outside (utils/roomTrust):
  // required, so a caller that forgets gets a type error, not a trusted view.
  | { projectId: string; chatroomName: string; untrusted: boolean; file?: undefined }
  // A staged local file is the user's own and has no room.
  | { file: File; projectId?: undefined; chatroomName?: undefined; untrusted?: undefined }
)

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export default function FileViewerModal({
  projectId = '',
  chatroomName = '',
  file,
  filename,
  onClose,
  nav,
  untrusted: outsideFile,
}: FileViewerModalProps) {
  const binary = isBinaryFile(filename)
  const local = file ?? null
  const serverText = useFileContent(projectId, chatroomName, filename, !local && !binary)
  const serverBlob = useFileBlobUrl(projectId, chatroomName, filename, !local && binary)
  const localView = useLocalFileView(local, binary)
  // A file in a Hub thread came from another server. A staged local file has
  // no room ('' is not user-communication), so it stays trusted.
  const untrusted = useRoomTrust(projectId, chatroomName).untrustedBodies || outsideFile === true

  const content = local ? localView.content : serverText.data
  const blobUrl = local ? localView.blobUrl : serverBlob.blobUrl
  const isLoading = local
    ? localView.isLoading
    : binary ? serverBlob.isLoading : serverText.isLoading
  const error = local ? localView.error : binary ? serverBlob.error : serverText.error

  const [downloading, setDownloading] = useState(false)
  // "Save to agent" copies a chatroom file into one of the owner's agents'
  // home folders; a staged local file isn't in a chatroom yet. Outside content
  // is never saved, as Forward and Save are hidden for it everywhere.
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const canSaveToAgent = !local && isAuthenticated && !untrusted
  const [saveOpen, setSaveOpen] = useState(false)
  // A different file is a different save: close the panel when stepping.
  useEffect(() => setSaveOpen(false), [filename])

  const handleDownload = useCallback(async () => {
    setDownloading(true)
    try {
      // Reuse existing blobUrl for binary files, otherwise fetch as blob
      const url = binary && blobUrl
        ? blobUrl
        : URL.createObjectURL(local ?? await downloadFileAsBlob(projectId, chatroomName, filename))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Only revoke URLs we created (not the one managed by useFileBlobUrl)
      if (!binary || !blobUrl) {
        URL.revokeObjectURL(url)
      }
    } finally {
      setDownloading(false)
    }
  }, [binary, blobUrl, local, projectId, chatroomName, filename])

  const hasPrev = !!nav && nav.index > 0
  const hasNext = !!nav && nav.index < nav.total - 1

  // Escape closes; with `nav`, ← / → step through the caller's list. Arrows
  // are left alone while typing or with a modifier held (Cmd/Alt+← = back).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (!nav || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isEditableTarget(e.target)) return
      e.preventDefault()
      if (e.key === 'ArrowLeft' && hasPrev) nav.onPrev()
      if (e.key === 'ArrowRight' && hasNext) nav.onNext()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, nav, hasPrev, hasNext])

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Modal */}
      <div
        className="relative bg-white rounded-lg shadow-xl w-[80vw] h-[90vh] max-w-6xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900 truncate pr-4">
            {filename}
          </h2>
          <div className="flex items-center gap-1">
          {nav && nav.total > 1 && (
            <div className="flex items-center gap-0.5 mr-2">
              <button
                onClick={nav.onPrev}
                disabled={!hasPrev}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                aria-label="Previous file"
                title="Previous file (←)"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-sm text-gray-500 tabular-nums min-w-[3rem] text-center" aria-live="polite">
                {nav.index + 1} / {nav.total}
              </span>
              <button
                onClick={nav.onNext}
                disabled={!hasNext}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                aria-label="Next file"
                title="Next file (→)"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}
          {/* A blob: URL opened in a tab runs with this app's origin. */}
          {isHtmlFile(filename) && blobUrl && !untrusted && (
            <a
              href={blobUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
              aria-label="Open in new tab"
              title="Open in new tab"
            >
              <ExternalLink className="w-5 h-5" />
            </a>
          )}
          {canSaveToAgent && (
            <button
              onClick={() => setSaveOpen((o) => !o)}
              className={`p-2 rounded-md transition-colors ${
                saveOpen ? 'text-accent-deep bg-purple-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
              }`}
              aria-label="Save to agent"
              aria-pressed={saveOpen}
              title="Save to an agent's folder"
            >
              <FolderInput className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={handleDownload}
            disabled={downloading || isLoading}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Download"
            title="Download file"
          >
            {downloading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Download className="w-5 h-5" />
            )}
          </button>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
          </div>
        </div>

        {/* Content — keyed on filename so stepping to another file remounts
            it: fresh scroll position, and hljs never re-highlights a <code>
            React is still reconciling. */}
        <div className="flex-1 flex overflow-hidden">
        <div key={filename} className="flex-1 overflow-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-gray-500">Loading file content...</div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-red-500 text-center">
                <span className="text-2xl block mb-2">⚠️</span>
                <p>Error loading file</p>
                <p className="text-sm text-gray-500 mt-1">{String(error)}</p>
              </div>
            </div>
          ) : binary && blobUrl ? (
            <BlobFilePreview filename={filename} blobUrl={blobUrl} untrusted={untrusted} />
          ) : content ? (
            <TextFilePreview filename={filename} content={content} untrusted={untrusted} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-gray-500">File is empty</div>
            </div>
          )}
        </div>
        {saveOpen && (
          <SaveToAgentPanel
            projectId={projectId}
            chatroomName={chatroomName}
            filename={filename}
            onClose={() => setSaveOpen(false)}
          />
        )}
        </div>
      </div>
    </div>
  )
}

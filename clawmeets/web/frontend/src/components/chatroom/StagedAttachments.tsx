import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, FileText, Loader2, RotateCw, X } from 'lucide-react'
import type { StagedFile } from '../../hooks/useMessageAttachments'
import FileViewerModal from '../files/FileViewerModal'

interface StagedAttachmentsProps {
  files: StagedFile[]
  onRemove: (id: string) => void
  disabled?: boolean
  /** Retry a failed background fetch. Absent ⇒ error chips render without a
   *  retry control — which is right for the chatroom composer, whose files came
   *  off the user's disk and have nothing to re-fetch. */
  onRetry?: (id: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ChatGPT-style attachment tray: image thumbnails + file chips, each with a
// remove control. Rendered above the send row while files are staged (they are
// held client-side and only uploaded when the message is sent).
//
// A chip also says WHERE its bytes are: a re-staged attachment shows its stored
// name and size while its bytes are still arriving, so the tray is visually correct from the
// first frame instead of flashing empty. Every one of those reads off fields
// already on `StagedFile` and is inert when unset, so the chatroom call sites
// render byte-identically.
//
// Clicking a chip opens it in the same `FileViewerModal` a sent message's file
// pill opens, reading the bytes straight from the staged `File` — so the user
// can check what they are about to send. Loading / errored chips have no bytes
// yet and stay inert.
export default function StagedAttachments({
  files,
  onRemove,
  disabled,
  onRetry,
}: StagedAttachmentsProps) {
  const [viewing, setViewing] = useState<File | null>(null)
  // Chips whose thumbnail the browser couldn't decode. `image/*` is not the
  // same as "renderable": Chrome and Firefox can't draw HEIC (the iPhone
  // default), so its <img> would paint a broken-image glyph with the alt text
  // spilling out of the 40px box. Those fall back to the plain file icon.
  const [undecodable, setUndecodable] = useState<ReadonlySet<string>>(() => new Set())
  if (files.length === 0) return null

  // `pt-2` matches the `pb-2` the editor wrap above already ends on, so the
  // chip row is separated from the input by the composer's own spacing step
  // rather than butting against it — the remove badge sits at `-top-1.5`, so
  // the editor's `pb-2` alone left barely 2px of real clearance and the tray
  // read as part of the input. Nothing renders at all when no file is staged
  // (the early return above), so this can never leave an empty gap behind.
  return (
    <div
      role="list"
      aria-label="Staged attachments"
      className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2"
    >
      {files.map((f) => {
        const loading = f.status === 'loading'
        const errored = f.status === 'error'
        const isImage = !!f.previewUrl && !loading && !errored && !undecodable.has(f.id)
        // A loading chip's File is an empty placeholder, so its own `size` would
        // read 0 B — the stored descriptor's size is the honest one.
        const size = f.displaySize ?? f.file.size
        return (
          <div
            key={f.id}
            role="listitem"
            className={
              'group relative flex items-center gap-2 max-w-[220px] rounded-lg border pr-2 shadow-sm ' +
              (errored ? 'border-red-200 bg-red-50/60' : 'border-gray-200 bg-gray-50')
            }
            title={
              errored ? `${f.file.name} — couldn’t load its contents` : f.file.name
            }
          >
            <button
              type="button"
              disabled={loading || errored}
              onClick={(e) => {
                e.stopPropagation()
                setViewing(f.file)
              }}
              aria-label={`View ${f.file.name}`}
              className="flex min-w-0 items-center gap-2 text-left enabled:cursor-pointer enabled:hover:opacity-80 disabled:cursor-default"
            >
              {isImage ? (
                <img
                  src={f.previewUrl}
                  alt={f.file.name}
                  className="h-10 w-10 rounded-l-lg object-cover"
                  onError={() => setUndecodable((prev) => new Set(prev).add(f.id))}
                />
              ) : (
                <div
                  className={
                    'flex h-10 w-10 items-center justify-center rounded-l-lg ' +
                    (errored ? 'bg-red-100' : 'bg-blue-50')
                  }
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                  ) : errored ? (
                    <AlertCircle className="h-4 w-4 text-red-500" />
                  ) : (
                    <FileText className="h-4 w-4 text-blue-500" />
                  )}
                </div>
              )}
              <div className="min-w-0 py-1">
                <div className="truncate text-xs font-medium text-gray-700">{f.file.name}</div>
                <div
                  className={'text-[10px] ' + (errored ? 'text-red-500' : 'text-gray-400')}
                >
                  {formatSize(size)}
                  {loading && ' · loading…'}
                  {errored && ' · unavailable'}
                </div>
              </div>
            </button>
            {errored && onRetry && (
              <button
                type="button"
                onClick={() => onRetry(f.id)}
                title={`Retry ${f.file.name}`}
                className="shrink-0 rounded p-1 text-gray-400 hover:text-accent"
              >
                <RotateCw className="h-3 w-3" />
              </button>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => onRemove(f.id)}
                title={`Remove ${f.file.name}`}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-400 shadow-sm hover:text-red-500"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )
      })}
      {viewing &&
        createPortal(
          <FileViewerModal
            file={viewing}
            filename={viewing.name}
            onClose={() => setViewing(null)}
          />,
          document.body,
        )}
    </div>
  )
}

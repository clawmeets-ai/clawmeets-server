import { useCallback, useRef, useState, DragEvent as ReactDragEvent } from 'react'

export interface FileDropzone {
  isDragging: boolean
  dragHandlers: {
    onDragEnter: (e: ReactDragEvent) => void
    onDragOver: (e: ReactDragEvent) => void
    onDragLeave: (e: ReactDragEvent) => void
    onDrop: (e: ReactDragEvent) => void
  }
}

// Does this drag carry actual files (vs. a text selection / link drag)? The
// DataTransfer.types list includes "Files" only for OS file drags, so we key
// the overlay off it and never flash on non-file drags.
function draggingFiles(e: ReactDragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && Array.from(types).includes('Files')
}

/**
 * Wire native HTML5 drag-and-drop onto a container so dropped files flow into
 * an existing file-staging callback (e.g. useMessageAttachments.addFiles).
 * - Tracks a drag depth counter (enter/leave fire per nested child); the
 *   overlay only clears when the counter returns to 0, preventing flicker as
 *   the cursor moves over the textarea / buttons inside the card.
 * - Activates ONLY for file drags: ignores drags whose dataTransfer.types omit
 *   "Files" so the overlay never flashes on text/selection/link drags.
 * - When `disabled`, all handlers no-op and isDragging stays false.
 * - onDrop: preventDefault + stopPropagation, reset counter, hand
 *   e.dataTransfer.files to onFiles (size cap / validation stays in onFiles).
 */
export function useFileDropzone(opts: {
  onFiles: (files: FileList | File[]) => void
  disabled?: boolean
}): FileDropzone {
  const { onFiles, disabled = false } = opts
  const [isDragging, setIsDragging] = useState(false)
  // enter/leave fire once per nested element the cursor crosses; count depth so
  // moving over a child doesn't read as "left the card".
  const depth = useRef(0)

  const onDragEnter = useCallback(
    (e: ReactDragEvent) => {
      if (disabled || !draggingFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current += 1
      setIsDragging(true)
    },
    [disabled]
  )

  const onDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (disabled || !draggingFiles(e)) return
      // Must preventDefault on dragover for the element to be a valid drop
      // target (otherwise the browser rejects the drop and navigates).
      e.preventDefault()
      e.stopPropagation()
    },
    [disabled]
  )

  const onDragLeave = useCallback(
    (e: ReactDragEvent) => {
      if (disabled || !draggingFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setIsDragging(false)
    },
    [disabled]
  )

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      if (disabled) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) onFiles(files)
    },
    [disabled, onFiles]
  )

  return {
    isDragging,
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}

import { useEffect } from 'react'

// A file dropped outside any real drop target makes the browser navigate away
// from the app to render the file — a jarring, data-losing surprise. This
// window-level guard cancels the default for file drags that reach `window`,
// i.e. drops that missed every composer / project drop zone (those stop
// propagation, so their events never bubble here). Non-file drags (text
// selection, links) are left untouched.
function carriesFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && Array.from(types).includes('Files')
}

export function useWindowFileDropGuard(): void {
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      // Required so the drop is delivered to (and swallowed by) our handler
      // rather than treated as a navigation by the browser.
      e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
}

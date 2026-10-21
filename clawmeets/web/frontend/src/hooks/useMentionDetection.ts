import { RefObject, useCallback, useState } from 'react'

export interface MentionState {
  isOpen: boolean
  query: string
  startIndex: number
  position: { top: number; left: number }
  selectedIndex: number
}

const CLOSED: MentionState = {
  isOpen: false,
  query: '',
  startIndex: 0,
  position: { top: 0, left: 0 },
  selectedIndex: 0,
}

/**
 * Track @mention dropdown state for a composer.
 *
 * Scans backwards from the cursor for an `@` preceded by start-of-string or
 * whitespace, ending at the next whitespace. When `disabled` is true (e.g.
 * context-only or user-communication rooms where the backend doesn't resolve
 * mentions) the dropdown is force-closed and detect() is a no-op.
 *
 * `anchorRef` is only measured (`getBoundingClientRect`) to place the dropdown
 * above the box, so it accepts any element — the composer is a contentEditable
 * `PromptEditor` now, not a textarea. `cursorPosition` is an index into the
 * composer's plain-text serialization; both the caller's `detect` call and its
 * `replaceRange` insertion use that same coordinate space.
 */
export function useMentionDetection(
  anchorRef: RefObject<HTMLElement | null>,
  disabled: boolean,
) {
  const [mention, setMention] = useState<MentionState>(CLOSED)

  const close = useCallback(() => {
    setMention((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev))
  }, [])

  const moveSelection = useCallback((delta: number, max: number) => {
    setMention((prev) => ({
      ...prev,
      selectedIndex: Math.max(0, Math.min(prev.selectedIndex + delta, max - 1)),
    }))
  }, [])

  const detect = useCallback(
    (text: string, cursorPosition: number) => {
      if (disabled) {
        close()
        return
      }
      const before = text.slice(0, cursorPosition)
      const atIndex = before.lastIndexOf('@')

      if (atIndex === -1) {
        close()
        return
      }
      // @ must be at start or follow whitespace
      if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) {
        close()
        return
      }
      const query = before.slice(atIndex + 1)
      // whitespace inside the query closes the trigger
      if (/\s/.test(query)) {
        close()
        return
      }

      const el = anchorRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setMention({
        isOpen: true,
        query,
        startIndex: atIndex,
        position: { top: rect.height + 8, left: 0 },
        selectedIndex: 0,
      })
    },
    [disabled, close, anchorRef],
  )

  return { mention, detect, close, moveSelection }
}

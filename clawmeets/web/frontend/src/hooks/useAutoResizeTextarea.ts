import { useEffect, RefObject } from 'react'

/**
 * Sync a textarea's height to its content, clamped at maxHeightPx.
 * Re-runs whenever `value` changes.
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement>,
  value: string,
  maxHeightPx = 200,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeightPx)}px`
  }, [ref, value, maxHeightPx])
}

import { useEffect, useState } from 'react'

/**
 * Returns `value` delayed by `delayMs`. A change before the timer fires resets
 * it, so only a settled value propagates. Generic — nothing search-specific.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}

import { useCallback, useState } from 'react'
import { useAuthStore } from '../stores/authStore'

const MAX_RECENTS = 3
const KEY_PREFIX = 'claw-sop-recent-v1'

/**
 * The last few SOPs this user reached for, newest first.
 *
 * Deliberately localStorage rather than server state: "recently used" is a
 * per-device convenience, and putting it on the server would cost a PATCH, a
 * WebSocket broadcast and a list invalidation on the hot click path — for a
 * signal nobody needs synced across machines.
 *
 * Stale ids (an SOP deleted here or in another session) are filtered at render
 * by the caller, never pruned on write, so a delete just quietly stops showing.
 */
export function useSopRecents() {
  const userId = useAuthStore((s) => s.user?.id)
  const storageKey = `${KEY_PREFIX}:${userId ?? 'anon'}`

  const [recentIds, setRecentIds] = useState<string[]>(() => read(storageKey))

  const touch = useCallback(
    (id: string) => {
      setRecentIds((prev) => {
        const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENTS)
        write(storageKey, next)
        return next
      })
    },
    [storageKey],
  )

  return { recentIds, touch }
}

// Private-mode Safari and storage-disabled browsers throw on access, so every
// read/write degrades to "no recents" rather than taking the rail down.
function read(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function write(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

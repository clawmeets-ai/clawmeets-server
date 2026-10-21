import { create } from 'zustand'

// Reference-stable empty result so selectors don't thrash when a room has no
// active work. Exported because chatroom/DM views call .map() on it.
export const EMPTY_PARTICIPANTS: readonly string[] = Object.freeze([])

const keyOf = (projectId: string, chatroomName: string) =>
  `${projectId}|${chatroomName}`

interface ActiveWorkSnapshotEntry {
  project_id: string
  chatroom_name: string
  active_participants: string[]
}

interface ActiveWorkState {
  // key = `${project_id}|${chatroom_name}`, value = outstanding participant ids.
  // Entries with an empty list are deleted rather than stored, so .has(key)
  // ≡ "this room is actively being worked on".
  participants: Map<string, readonly string[]>

  hydrate: (snapshot: ActiveWorkSnapshotEntry[]) => void
  setParticipants: (projectId: string, chatroomName: string, ids: string[]) => void
  reset: () => void
}

export const useActiveWorkStore = create<ActiveWorkState>((set) => ({
  participants: new Map(),

  hydrate: (snapshot) => {
    const next = new Map<string, readonly string[]>()
    for (const entry of snapshot) {
      if (entry.active_participants.length === 0) continue
      next.set(keyOf(entry.project_id, entry.chatroom_name), Object.freeze([...entry.active_participants]))
    }
    set({ participants: next })
  },

  setParticipants: (projectId, chatroomName, ids) =>
    set((state) => {
      const key = keyOf(projectId, chatroomName)
      const next = new Map(state.participants)
      if (ids.length === 0) {
        if (!next.has(key)) return state
        next.delete(key)
      } else {
        next.set(key, Object.freeze([...ids]))
      }
      return { participants: next }
    }),

  reset: () => set({ participants: new Map() }),
}))

/** Outstanding participants for a single chatroom; reference-stable when absent. */
export function selectActiveParticipants(
  projectId: string,
  chatroomName: string,
): (state: ActiveWorkState) => readonly string[] {
  const key = keyOf(projectId, chatroomName)
  return (state) => state.participants.get(key) ?? EMPTY_PARTICIPANTS
}

/** True if any chatroom under ``projectId`` has outstanding work. */
export function selectProjectHasActiveWork(
  projectId: string,
): (state: ActiveWorkState) => boolean {
  const prefix = `${projectId}|`
  return (state) => {
    for (const key of state.participants.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }
}

/** True if any of ``projectIds`` has outstanding work (e.g. any DM thread). */
export function selectAnyProjectHasActiveWork(
  projectIds: string[],
): (state: ActiveWorkState) => boolean {
  const ids = new Set(projectIds)
  return (state) => {
    for (const key of state.participants.keys()) {
      if (ids.has(key.slice(0, key.indexOf('|')))) return true
    }
    return false
  }
}

import { create } from 'zustand'

/**
 * In-memory map of pending skill OAuth links keyed by `${agent_id}|${skill_name}`.
 * Skill-rail sibling of `mcpAuthStore`. The runner posts a
 * `skill_auth_url_for_user` envelope when it builds a Google consent URL for a
 * skill whose registry entry declares an `auth` block (gmail / google-calendar /
 * google-drive / google-drive-write); the entry stays in the store until the
 * user clicks it (optimistic clear) or the page reloads.
 */
const keyOf = (agentId: string, skillName: string) => `${agentId}|${skillName}`

interface PendingAuth {
  auth_url: string
  state: string
}

interface SkillAuthState {
  pending: Map<string, PendingAuth>
  set: (agentId: string, skillName: string, auth: PendingAuth) => void
  clear: (agentId: string, skillName: string) => void
  reset: () => void
}

export const useSkillAuthStore = create<SkillAuthState>((set) => ({
  pending: new Map(),

  set: (agentId, skillName, auth) =>
    set((state) => {
      const next = new Map(state.pending)
      next.set(keyOf(agentId, skillName), auth)
      return { pending: next }
    }),

  clear: (agentId, skillName) =>
    set((state) => {
      const key = keyOf(agentId, skillName)
      if (!state.pending.has(key)) return state
      const next = new Map(state.pending)
      next.delete(key)
      return { pending: next }
    }),

  reset: () => set({ pending: new Map() }),
}))

/** Returns the pending auth for one (agent, skill), or undefined. */
export function selectPendingSkillAuth(
  agentId: string,
  skillName: string,
): (state: SkillAuthState) => PendingAuth | undefined {
  const key = keyOf(agentId, skillName)
  return (state) => state.pending.get(key)
}

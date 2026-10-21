import { create } from 'zustand'

/**
 * In-memory map of pending MCP OAuth links keyed by `${agent_id}|${mcp_name}`.
 * The runner posts an `mcp_auth_url_for_user` envelope when it builds a Google
 * consent URL via the relay flow; the entry stays in the store until the user
 * clicks it (optimistic clear) or the page is reloaded.
 */
const keyOf = (agentId: string, mcpName: string) => `${agentId}|${mcpName}`

interface PendingAuth {
  auth_url: string
  state: string
}

interface McpAuthState {
  pending: Map<string, PendingAuth>
  set: (agentId: string, mcpName: string, auth: PendingAuth) => void
  clear: (agentId: string, mcpName: string) => void
  reset: () => void
}

export const useMcpAuthStore = create<McpAuthState>((set) => ({
  pending: new Map(),

  set: (agentId, mcpName, auth) =>
    set((state) => {
      const next = new Map(state.pending)
      next.set(keyOf(agentId, mcpName), auth)
      return { pending: next }
    }),

  clear: (agentId, mcpName) =>
    set((state) => {
      const key = keyOf(agentId, mcpName)
      if (!state.pending.has(key)) return state
      const next = new Map(state.pending)
      next.delete(key)
      return { pending: next }
    }),

  reset: () => set({ pending: new Map() }),
}))

/** Returns the pending auth for one (agent, mcp), or undefined. */
export function selectPendingAuth(
  agentId: string,
  mcpName: string,
): (state: McpAuthState) => PendingAuth | undefined {
  const key = keyOf(agentId, mcpName)
  return (state) => state.pending.get(key)
}

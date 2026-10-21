import { create } from 'zustand'

/**
 * Transient, per-agent model-config selection for the composer
 * (model-config-selection-revamp, spec #2/#3).
 *
 * The selector writes the picked config NAME here; the composer send path reads
 * it and ships it as `model_config_name` for that ONE message. It is deliberately
 * NOT persisted to the server or to localStorage (plan assumption A3): on reload
 * the map is empty, so every agent falls back to its backend default. `undefined`
 * for an agent means "use the agent's default" — the reader resolves
 * `byAgent[agentId] ?? default`.
 */
interface ModelSelectionState {
  /** agentId → selected config NAME (absent ⇒ use the agent default). */
  byAgent: Record<string, string>
  setSelection: (agentId: string, name: string) => void
  /** Revert to the agent default (drops the transient override for this agent). */
  clearSelection: (agentId: string) => void
}

export const useModelSelectionStore = create<ModelSelectionState>((set) => ({
  byAgent: {},
  setSelection: (agentId, name) =>
    set((s) => ({ byAgent: { ...s.byAgent, [agentId]: name } })),
  clearSelection: (agentId) =>
    set((s) => {
      if (!(agentId in s.byAgent)) return s
      const next = { ...s.byAgent }
      delete next[agentId]
      return { byAgent: next }
    }),
}))

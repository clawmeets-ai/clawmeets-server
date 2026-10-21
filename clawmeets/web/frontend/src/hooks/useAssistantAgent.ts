import { useMemo } from 'react'
import { useAgents } from './useAgents'
import { useAuthStore } from '../stores/authStore'
import type { AgentCard } from '../types'

/**
 * Resolves the current user's personal assistant agent: prefer the linked
 * `user.assistant_agent_id`, fall back to the `{username}-assistant` name
 * pattern. Unifies the two ad-hoc checks previously inlined in DMChatView /
 * DMZeroState so the pinned assistant hero has a single source.
 */
export function useAssistantAgent(): AgentCard | null {
  const { user } = useAuthStore()
  const { data: agents } = useAgents()

  return useMemo(() => {
    if (!user || !agents) return null
    if (user.assistant_agent_id) {
      const byId = agents.find((a) => a.id === user.assistant_agent_id)
      if (byId) return byId
    }
    return agents.find((a) => a.name === `${user.username}-assistant`) ?? null
  }, [agents, user])
}

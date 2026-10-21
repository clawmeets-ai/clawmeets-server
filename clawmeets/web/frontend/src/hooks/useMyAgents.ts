import { useMemo } from 'react'
import { useAgents } from './useAgents'
import { useAuthStore } from '../stores/authStore'

/**
 * Returns agents owned by the logged-in user (registered_by === user id).
 */
export function useMyAgents() {
  const id = useAuthStore((s) => s.user?.id)
  const { data: agents, isLoading, error } = useAgents()

  const myAgents = useMemo(() => {
    if (!agents || !id) return []
    return agents.filter(a => a.registered_by === id)
  }, [agents, id])

  return { data: myAgents, isLoading, error }
}

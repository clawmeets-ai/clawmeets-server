import { useQuery } from '@tanstack/react-query'
import { getAgentCapabilities } from '../api/endpoints'

export function useAgentCapabilities() {
  return useQuery({
    queryKey: ['agents', 'capabilities'],
    queryFn: getAgentCapabilities,
    staleTime: 300000, // 5 minutes
  })
}

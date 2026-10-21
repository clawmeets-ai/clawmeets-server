import { useQuery } from '@tanstack/react-query'
import { getAgentConnection } from '../../../api/endpoints/agents'
import { AgentStatus } from '../../../types'
import type { AgentCard } from '../../../types'

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (hours < 24) return `${hours}h ${mins}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  try {
    const d = new Date(iso)
    if (d.getFullYear() <= 1970) return 'never'
    return d.toLocaleString()
  } catch {
    return iso
  }
}

function dotColor(status: string): string {
  return status === AgentStatus.ONLINE
    ? 'bg-emerald-400'
    : status === AgentStatus.BUSY
    ? 'bg-amber-400'
    : status === AgentStatus.RATE_LIMITED
    ? 'bg-orange-400'
    : 'bg-gray-300'
}

/**
 * One-line replacement for the old Status card: status dot, uptime, last
 * heartbeat, last reflected. Registered-at and connected IP sit behind "more".
 * Polls the connection every 10s, as the card did.
 */
export default function AgentStatusStrip({ agent }: { agent: AgentCard }) {
  const { data: connection } = useQuery({
    queryKey: ['agent', agent.id, 'connection'],
    queryFn: () => getAgentConnection(agent.id),
    refetchInterval: 10000,
  })

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
      <span className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${dotColor(agent.status)}`} />
        <span className="font-semibold text-gray-800 capitalize">{agent.status}</span>
      </span>
      {connection?.connected && connection.uptime_seconds != null && (
        <span>up {formatUptime(connection.uptime_seconds)}</span>
      )}
      <span>heartbeat {formatDate(agent.last_heartbeat)}</span>
      <span>last reflected {formatDate(agent.last_reflected_at ?? null)}</span>
      <details className="inline-block">
        <summary className="cursor-pointer select-none text-purple-700 hover:text-purple-800 list-none">more</summary>
        <span className="block mt-1">
          Registered {formatDate(agent.registered_at)} · IP{' '}
          <span className="font-mono">
            {connection?.connected ? connection.ip || 'unknown' : 'not connected'}
          </span>
        </span>
      </details>
    </div>
  )
}

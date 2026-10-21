import { Send } from 'lucide-react'
import { hubError } from '../../../api/endpoints/hub'
import { useAgentHubUsage } from '../../../hooks/useAgentAccess'
import { USAGE_COPY } from '../../../utils/agentAccessCopy'
import { formatHubTime } from '../../../utils/hubDisplay'
import { SectionCard, SectionHeader } from '../primitives'

/**
 * How much of each hub send window this agent used (GET
 * /api/hub/agents-usage/{id}). Read only: no edit control and no switch; the
 * limits are the server's. Hidden for a viewer who does not own the agent
 * (not_owner). A window name this build does not know is shown as sent, as text.
 */
export default function HubSendUsageCard({ agentId }: { agentId: string }) {
  const { data, error, isLoading } = useAgentHubUsage(agentId)
  if (hubError(error)?.code === 'not_owner') return null

  return (
    <SectionCard>
      <SectionHeader title={USAGE_COPY.title} icon={<Send className="w-4 h-4" />} subtitle={USAGE_COPY.subtitle} />
      <div className="px-6 py-4 text-sm" data-testid="hub-send-usage">
        {isLoading ? (
          <div className="h-10 animate-pulse rounded bg-gray-100" data-testid="hub-send-usage-loading" />
        ) : error ? (
          <p className="text-gray-500">{USAGE_COPY.failed}</p>
        ) : !data || data.windows.length === 0 ? (
          <p className="text-gray-500">{USAGE_COPY.empty}</p>
        ) : (
          <ul className="space-y-1.5">
            {data.windows.map((w) => (
              <li key={w.name} className="flex flex-wrap items-baseline gap-x-2 text-gray-700" data-testid="hub-send-usage-row">
                <span>{USAGE_COPY.window(w.name)}</span>
                <span className="font-mono tabular-nums text-gray-900">{w.used} / {w.limit}</span>
                <span className="text-xs text-gray-500">· {USAGE_COPY.resets(formatHubTime(w.resets_at))}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  )
}

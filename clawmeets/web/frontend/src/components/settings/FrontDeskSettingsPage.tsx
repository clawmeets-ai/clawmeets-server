import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Globe, Users } from 'lucide-react'
import { useMyAgents } from '../../hooks/useMyAgents'
import { useAuthStore } from '../../stores/authStore'
import { displayName } from '../../utils/agentDisplay'
import type { AgentCard, User } from '../../types'
import Loading from '../common/Loading'
import InvitableAgentsPicker from './InvitableAgentsPicker'
import { PageHeader, PageShell, SectionCard, SectionHeader } from './primitives'
import { getHubChannel } from '../../api/endpoints/hub'
import { listConnections } from '../../api/endpoints/channels'
import { hubChannelKey } from '../../hooks/useHub'
import { CONNECTIONS_KEY } from './agent/channelsShared'
import HostDisclaimerSlot from './agent/HostDisclaimerSlot'

export const FRONT_DESK_COPY = {
  helper:
    'Applies to new conversations only, for people on other servers (through the hub) and on this ' +
    'server alike. Teams and agents add up; leave both empty and the agent answers alone.',
  manageSharing: 'Sharing and the hub listing',
} as const

function AgentRow({ coordinator, candidates, viewer }: {
  coordinator: AgentCard
  candidates: AgentCard[]
  viewer: User | null
}) {
  return (
    <div className="px-6 py-5 border-b border-gray-100 last:border-b-0">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-gray-900">{displayName(coordinator, viewer)}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{coordinator.description}</p>
        </div>
        {/* The Hub switch is the one control for public: it also ends the
            hub listing and owner isolation, which a plain card update skips. */}
        <Link
          to={`/agents/${coordinator.id}/settings?section=channels&channel=hub`}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <Globe className="w-3.5 h-3.5" />
          {FRONT_DESK_COPY.manageSharing}
        </Link>
      </div>
      <ListingIsolation agent={coordinator} />
      <InvitableAgentsPicker
        coordinator={coordinator}
        candidates={candidates}
        viewer={viewer}
        helper={FRONT_DESK_COPY.helper}
        idPrefix="fd-default"
      />
    </div>
  )
}

/**
 * The host disclaimer slot of a public agent. The agent payload carries no
 * isolation of its own, so it is read from the agent's Hub channel first,
 * then from any of its channel connections; an agent with neither shows no
 * slot (it is not reachable by outside requesters through either).
 */
function ListingIsolation({ agent }: { agent: AgentCard }) {
  const hub = useQuery({
    queryKey: hubChannelKey(agent.name),
    queryFn: () => getHubChannel(agent.name),
    retry: false,
    staleTime: 60_000,
  })
  const connections = useQuery({ queryKey: CONNECTIONS_KEY, queryFn: listConnections, retry: false, staleTime: 60_000 })
  const source = hub.data ?? connections.data?.find((c) => c.agent_id === agent.id)
  if (!source) return null
  return (
    <div className="mb-3">
      <HostDisclaimerSlot isolation={source.isolation} heldConversations={source.held_conversations} />
    </div>
  )
}

export default function FrontDeskSettingsPage() {
  const { user } = useAuthStore()
  const { data: myAgents, isLoading } = useMyAgents()

  const publicAgents = useMemo(
    () => (myAgents ?? []).filter((a) => a.discoverable_through_registry),
    [myAgents],
  )

  return (
    <PageShell>
      <PageHeader
        title="Front Desk"
        subtitle={
          <>
            Agents are published through the ClawMeets Hub: open an agent's settings → Channels →
            Hub to make it public and list it. When someone messages a public agent, the conversation
            appears under FRONT DESK. Below, pick which of your other agents each public agent may
            bring into new conversations. The same setting is on each agent's Hub tab.
          </>
        }
      />
      <SectionCard>
        <SectionHeader
          title="Public agents"
          icon={<Users className="w-4 h-4" />}
        />
        {isLoading && (
          <div className="px-6 py-8">
            <Loading size="sm" />
          </div>
        )}
        {!isLoading && (
          <>
            {publicAgents.length === 0 && (
              <p className="px-6 py-4 text-xs text-gray-500">
                None of your agents is public. To publish one, open its settings → Channels → Hub.
              </p>
            )}
            {publicAgents.map((coordinator) => (
              <AgentRow
                key={coordinator.id}
                coordinator={coordinator}
                candidates={(myAgents ?? []).filter((c) => c.id !== coordinator.id)}
                viewer={user ?? null}
              />
            ))}
          </>
        )}
      </SectionCard>
    </PageShell>
  )
}

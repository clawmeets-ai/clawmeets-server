import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { getHubChannel } from '../../../api/endpoints/hub'
import { hubChannelKey } from '../../../hooks/useHub'
import { useMyAgents } from '../../../hooks/useMyAgents'
import { useAuthStore } from '../../../stores/authStore'
import { SectionCard, SectionHeader } from '../primitives'
import InvitableAgentsPicker from '../InvitableAgentsPicker'

export const HUB_INVITE_COPY = {
  title: 'Agents it may bring in',
  subtitle:
    'Which of your other agents this agent may invite into the conversations people start with it over the hub.',
  helper:
    'Applies to new conversations only. Teams and agents add up; leave both empty and the agent answers ' +
    'alone. An agent you pick answers only if its computer can run isolated turns, like this one; ' +
    'otherwise its part waits. What they say stays out of their memory, as for the rest of the conversation.',
  ownerIsolated:
    'This agent runs in its own isolated environment, so it can never bring in other agents. ' +
    'It answers every conversation alone.',
} as const

/**
 * Agent Settings → Channels → Hub: the owner picks which of their other
 * agents this public agent may bring into hub conversations. Stored on the
 * card (default_invitable_agents / default_invitable_teams) — the same setting
 * the Front Desk page edits — and read by the server when it creates each new
 * hub conversation (gateway.invite_pool). Hidden for a viewer who does not
 * own the agent. An owner-isolated agent is held to an allowlist without
 * invites, so it gets the reason instead of the picker.
 */
export default function HubInvitableAgentsCard({ agentId, agentFullName }: { agentId: string; agentFullName: string }) {
  const user = useAuthStore((s) => s.user)
  const { data: myAgents } = useMyAgents()
  const hub = useQuery({
    queryKey: hubChannelKey(agentFullName),
    queryFn: () => getHubChannel(agentFullName),
    retry: false,
    staleTime: 60_000,
  })
  const coordinator = myAgents.find((a) => a.id === agentId)
  const candidates = useMemo(
    () => myAgents.filter((a) => a.id !== agentId),
    [myAgents, agentId],
  )
  if (!coordinator) return null

  return (
    <SectionCard>
      <SectionHeader title={HUB_INVITE_COPY.title} icon={<Users className="w-4 h-4" />} subtitle={HUB_INVITE_COPY.subtitle} />
      <div className="px-6 py-4" data-testid="hub-invitable-agents">
        <InvitableAgentsPicker
          coordinator={coordinator}
          candidates={candidates}
          viewer={user ?? null}
          helper={HUB_INVITE_COPY.helper}
          disabledReason={hub.data?.owner_isolated ? HUB_INVITE_COPY.ownerIsolated : null}
          idPrefix="hub-invitable"
        />
      </div>
    </SectionCard>
  )
}

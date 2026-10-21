import { useMemo, useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { Globe } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import { useAssistantAgent } from '../../hooks/useAssistantAgent'
import { useRecentAgents } from '../../hooks/useRecentAgents'
import { useDmThreads } from '../../hooks/useDmThreads'
import { useTeamGroups } from '../../hooks/useTeamGroups'
import { useAgents } from '../../hooks/useAgents'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { reachableAgents } from '../../utils/reachableAgents'
import { hubThreadPath, REMOTE_TEXT_CAP, retainedHubLabel, safeRemoteText } from '../../utils/hubDisplay'
import type { RetainedAgent } from '../../api/endpoints/hub'
import { formatRelativeTime } from '../../utils/formatDate'
import { displayName } from '../../utils/agentDisplay'
import { type AgentCard } from '../../types'
import PanelShell from './PanelShell'
import AssistantHero from './AssistantHero'
import AgentRow from './AgentRow'
import TeamGroup from './TeamGroup'
import SidebarAvatar from './SidebarAvatar'
import DmComposeModal from '../dm/DmComposeModal'

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-channel">
      {children}
    </div>
  )
}

// One retained agent of another server. It has no agent card here, so it is
// not an AgentRow: no presence dot, a globe for "elsewhere", and every remote
// string through safeRemoteText. Opens its hub thread, as Cmd-K does.
function HubAgentRow({
  agent,
  isSelected,
  onClick,
}: {
  agent: RetainedAgent
  isSelected: boolean
  onClick: () => void
}) {
  const name = safeRemoteText(agent.name, REMOTE_TEXT_CAP.name)
  const label = retainedHubLabel(agent)
  const description = safeRemoteText(agent.description, REMOTE_TEXT_CAP.description)
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 pl-3 pr-4 py-1 w-full text-left rounded hover:bg-sidebar-hover transition-colors ${
        isSelected ? 'bg-sidebar-active text-sidebar-text-active font-bold' : 'text-sidebar-text'
      }`}
      title={description ? `${label} — ${description}` : label}
    >
      <SidebarAvatar name={name} size={21} ringColor="var(--bg-sidebar)" />
      <span className="truncate font-mono text-[13px]">{label}</span>
      <Globe className="ml-auto w-3 h-3 shrink-0 opacity-60" aria-label="On another server" />
    </button>
  )
}

// The default rail context: pinned assistant, Recents, teams, then the agents
// the user retained — the same agent-first roster from approach B, now inside
// the rail panel.
export default function AgentsPanel({
  onNavigate,
}: {
  onNavigate?: () => void
}) {
  const { user } = useAuthStore()
  const navigate = useNavigate()
  const dmMatch = useMatch('/dm/:agentName')
  const activeAgentName = dmMatch?.params.agentName ? decodeURIComponent(dmMatch.params.agentName) : null
  const hubMatch = useMatch('/hub/:hubAgentId/*')
  const activeHubAgentId = hubMatch?.params.hubAgentId ? decodeURIComponent(hubMatch.params.hubAgentId) : null

  const assistant = useAssistantAgent()
  const recents = useRecentAgents(6, assistant?.id)
  const { sortedTeamNames, teamBuckets, untemmedAgents, myAgents, isLoading } = useTeamGroups()
  const { mostRecentByAgentId } = useDmThreads()
  const { data: allAgents } = useAgents()
  const { data: retained } = useRetainedAgents()
  // Retained: other accounts' agents of this server (still shared) and agents
  // of other servers — the same set Cmd-K and the agents' rosters list
  // (utils/reachableAgents), minus the user's own agents shown above.
  const { retainedHere, retainedHub } = useMemo(() => {
    const { local, hub } = reachableAgents(allAgents, user?.id, retained)
    return {
      retainedHere: local
        .filter((a) => a.registered_by !== user?.id)
        .sort((a, b) => displayName(a, user).localeCompare(displayName(b, user))),
      retainedHub: [...hub].sort((a, b) => a.name.localeCompare(b.name)),
    }
  }, [allAgents, retained, user])
  const [composeOpen, setComposeOpen] = useState(false)

  const activeWorkRoomFor = (agent: AgentCard) => {
    const recent = mostRecentByAgentId.get(agent.id)
    return recent ? { projectId: recent.projectId, chatroomName: 'user-communication' } : undefined
  }

  const selectAgent = (agent: AgentCard) => {
    if (!confirmLeaveIfDirty()) return
    navigate(`/dm/${encodeURIComponent(agent.name)}`)
    onNavigate?.()
  }

  const selectHubAgent = (agent: RetainedAgent) => {
    if (!confirmLeaveIfDirty()) return
    navigate(hubThreadPath(agent.hub_agent_id))
    onNavigate?.()
  }
  const retainedCount = retainedHere.length + retainedHub.length

  // `+` opens the DM compose modal (mode='agent') against the user's assistant.
  // Falls back to the classic register form if no assistant is registered yet
  // (brand-new user), so the button is never a dead end.
  return (
    <>
    <PanelShell
      title="Agents"
      onAdd={assistant ? () => setComposeOpen(true) : undefined}
      addTo={assistant ? undefined : '/agents/new'}
      addLabel="Register agent"
      onNavigate={onNavigate}
    >
      {assistant && (
        <div className="pt-2">
          <AssistantHero
            assistant={assistant}
            viewer={user}
            isActive={activeAgentName === assistant.name}
            onSelect={() => selectAgent(assistant)}
          />
        </div>
      )}

      {recents.length > 0 && (
        <>
          <Eyebrow>Recents</Eyebrow>
          <div className="px-1.5">
            {recents.map((r) => (
              <AgentRow
                key={r.agent.id}
                agent={r.agent}
                viewer={user}
                isSelected={activeAgentName === r.agent.name}
                onClick={() => selectAgent(r.agent)}
                activeWorkRoom={activeWorkRoomFor(r.agent)}
                time={formatRelativeTime(r.lastModified)}
              />
            ))}
          </div>
        </>
      )}

      <Eyebrow>
        Teams
        <span className="font-mono text-[10.5px] text-ink-4 tabular-nums normal-case tracking-normal">
          · {myAgents.length}
        </span>
      </Eyebrow>
      <div className="px-1.5 space-y-0.5">
        {sortedTeamNames.map((teamName) => (
          <TeamGroup
            key={teamName}
            teamName={teamName}
            members={teamBuckets.get(teamName) ?? []}
            viewer={user}
            activeAgentName={activeAgentName}
            onSelectAgent={selectAgent}
            activeWorkRoomFor={activeWorkRoomFor}
          />
        ))}
        {untemmedAgents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            viewer={user}
            isSelected={activeAgentName === agent.name}
            onClick={() => selectAgent(agent)}
            activeWorkRoom={activeWorkRoomFor(agent)}
          />
        ))}
        {!isLoading && myAgents.length === 0 && (
          <div className="pl-3 pr-4 py-2 text-sidebar-text text-xs opacity-75">No agents yet</div>
        )}
      </div>

      {retainedCount > 0 && (
        <>
          <Eyebrow>
            Retained
            <span className="font-mono text-[10.5px] text-ink-4 tabular-nums normal-case tracking-normal">
              · {retainedCount}
            </span>
          </Eyebrow>
          <div className="px-1.5 space-y-0.5">
            {retainedHere.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                viewer={user}
                isSelected={activeAgentName === agent.name}
                onClick={() => selectAgent(agent)}
                activeWorkRoom={activeWorkRoomFor(agent)}
              />
            ))}
            {retainedHub.map((agent) => (
              <HubAgentRow
                key={agent.hub_agent_id}
                agent={agent}
                isSelected={activeHubAgentId === agent.hub_agent_id}
                onClick={() => selectHubAgent(agent)}
              />
            ))}
          </div>
        </>
      )}
    </PanelShell>
    {composeOpen && assistant && (
      <DmComposeModal
        mode="agent"
        recipient={assistant}
        onClose={() => setComposeOpen(false)}
      />
    )}
    </>
  )
}

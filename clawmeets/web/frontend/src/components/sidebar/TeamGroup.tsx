import { ChevronRight } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { displayName } from '../../utils/agentDisplay'
import type { AgentCard, User } from '../../types'
import AgentRow from './AgentRow'
import { SidebarAvatarStack } from './SidebarAvatar'

interface TeamGroupProps {
  teamName: string
  members: AgentCard[]
  viewer: User | null
  activeAgentName: string | null
  onSelectAgent: (agent: AgentCard) => void
  activeWorkRoomFor?: (agent: AgentCard) => { projectId: string; chatroomName: string } | undefined
}

// Collapsible team header (chevron + name + preview avatar stack + count) over
// indented member rows. Open state lives in uiStore.expandedAgentTeams (empty
// Set ⇒ collapsed by default, which is the redesign's default).
export default function TeamGroup({
  teamName,
  members,
  viewer,
  activeAgentName,
  onSelectAgent,
  activeWorkRoomFor,
}: TeamGroupProps) {
  const { expandedAgentTeams, toggleAgentTeam } = useUIStore()
  const open = expandedAgentTeams.has(teamName)

  return (
    <div>
      <button
        onClick={() => toggleAgentTeam(teamName)}
        className="flex items-center gap-1.5 pl-3 pr-4 py-1 w-full text-left rounded hover:bg-sidebar-hover transition-colors"
      >
        <ChevronRight
          className={`w-3.5 h-3.5 text-channel shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-[12.5px] font-bold text-sidebar-text truncate">{teamName}</span>
        {!open && (
          <span className="ml-auto flex items-center gap-2">
            <SidebarAvatarStack names={members.map((m) => displayName(m, viewer))} size={16} />
            <span className="font-mono text-[10.5px] text-ink-4 tabular-nums">{members.length}</span>
          </span>
        )}
        {open && (
          <span className="ml-auto font-mono text-[10.5px] text-ink-4 tabular-nums">
            {members.length}
          </span>
        )}
      </button>
      {open &&
        members.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            viewer={viewer}
            isSelected={activeAgentName === agent.name}
            onClick={() => onSelectAgent(agent)}
            activeWorkRoom={activeWorkRoomFor?.(agent)}
            sub
          />
        ))}
    </div>
  )
}

import type { AgentCard, User } from '../../types'
import { displayName } from '../../utils/agentDisplay'
import { useActiveWorkStore, selectActiveParticipants } from '../../stores/activeWorkStore'
import VerifiedBadge from '../common/VerifiedBadge'
import ActiveWorkDot from './ActiveWorkDot'
import SidebarAvatar, { statusDotColor } from './SidebarAvatar'

interface AgentRowProps {
  agent: AgentCard
  viewer: User | null
  isSelected: boolean
  onClick: () => void
  /** right-aligned relative timestamp (Recents rows). */
  time?: string
  /** indented member row (inside a team group). */
  sub?: boolean
  /** own-DM room backing the active-work dot; undefined suppresses it. */
  activeWorkRoom?: { projectId: string; chatroomName: string }
  /** override the computed handle (e.g. owner-stripped short name when the
   *  owner is already shown as a section header). */
  label?: string
}

// One agent in the roster: rounded-square avatar + presence dot, mono handle,
// optional trailing timestamp. Settings/delete live in the DM chat header. Adapted from the former
// private `AgentItem` in AgentList.
export default function AgentRow({
  agent,
  viewer,
  isSelected,
  onClick,
  time,
  sub,
  activeWorkRoom,
  label: labelOverride,
}: AgentRowProps) {
  const label = labelOverride ?? displayName(agent, viewer)
  const activeParticipants = useActiveWorkStore(
    selectActiveParticipants(activeWorkRoom?.projectId ?? '', activeWorkRoom?.chatroomName ?? ''),
  )
  const isActive = activeWorkRoom !== undefined && activeParticipants.length > 0
  const size = sub ? 20 : 21

  return (
    <div>
      <button
        onClick={onClick}
        className={`flex items-center gap-2 ${sub ? 'pl-6' : 'pl-3'} pr-4 py-1 w-full text-left rounded hover:bg-sidebar-hover transition-colors ${
          isSelected ? 'bg-sidebar-active text-sidebar-text-active font-bold' : 'text-sidebar-text'
        }`}
        title={`DM with ${label} — ${agent.description}`}
      >
        <SidebarAvatar
          name={label}
          size={size}
          dot
          dotColor={statusDotColor(agent.status)}
          ringColor="var(--bg-sidebar)"
        />
        <span className="truncate font-mono text-[13px]">{label}</span>
        {agent.is_verified && <VerifiedBadge />}
        {isActive && <ActiveWorkDot />}
        {time && (
          <span className="ml-auto font-mono text-[10.5px] text-ink-4 tabular-nums flex-shrink-0">
            {time}
          </span>
        )}
      </button>
    </div>
  )
}

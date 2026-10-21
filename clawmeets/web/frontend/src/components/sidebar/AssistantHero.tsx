import { Pin } from 'lucide-react'
import { AgentStatus, type AgentCard, type User } from '../../types'
import { displayName } from '../../utils/agentDisplay'
import SidebarAvatar, { statusDotColor } from './SidebarAvatar'

interface AssistantHeroProps {
  assistant: AgentCard
  viewer: User | null
  isActive: boolean
  onSelect: () => void
}

// The pinned coordinator card: a raised, gradient-filled hero that keeps the
// user's assistant at the top of the roster instead of buried among agents.
export default function AssistantHero({ assistant, viewer, isActive, onSelect }: AssistantHeroProps) {
  const label = displayName(assistant, viewer)
  const online = assistant.status === AgentStatus.ONLINE
  return (
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[11px] border text-left transition-all mx-2.5"
      style={{
        width: 'calc(100% - 20px)',
        background: 'linear-gradient(180deg, #ffffff, var(--accent-softer))',
        borderColor: isActive ? 'var(--accent)' : 'var(--accent-soft)',
        boxShadow: isActive
          ? '0 0 0 2px var(--accent-soft)'
          : 'var(--shadow-1)',
      }}
      title={`DM with ${label}`}
    >
      <SidebarAvatar
        name={label}
        size={34}
        dot
        dotColor={statusDotColor(assistant.status)}
        ringColor="#ffffff"
      />
      <span className="flex flex-col min-w-0 flex-1">
        <span className="text-[13.5px] font-extrabold text-ink-1 truncate">{label}</span>
        <span className="text-[11px] font-semibold" style={{ color: 'var(--accent-deep)' }}>
          Your coordinator{online ? ' · online' : ''}
        </span>
      </span>
      <Pin className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent)' }} />
    </button>
  )
}

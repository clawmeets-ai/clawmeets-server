import { useEffect, useRef } from 'react'
import type { AgentCard, User } from '../../types'
import { AgentStatus } from '../../types'
import { displayName, matchesQuery } from '../../utils/agentDisplay'
import Avatar from '../common/Avatar'
import VerifiedBadge from '../common/VerifiedBadge'

interface MentionDropdownProps {
  agents: AgentCard[]
  viewer: User | null
  query: string
  position: { top: number; left: number }
  selectedIndex: number
  onSelect: (agent: AgentCard) => void
  onClose: () => void
}

export default function MentionDropdown({
  agents,
  viewer,
  query,
  position,
  selectedIndex,
  onSelect,
  onClose,
}: MentionDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Match against both full and namespace-aware short name so typing ``res``
  // offers ``researcher`` even when the stored name is ``alice-researcher``.
  const filteredAgents = agents.filter((agent) => matchesQuery(agent, query, viewer))

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Scroll selected item into view
  useEffect(() => {
    if (dropdownRef.current) {
      const selectedElement = dropdownRef.current.querySelector('[data-selected="true"]')
      selectedElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (filteredAgents.length === 0) {
    return null
  }

  return (
    <div
      ref={dropdownRef}
      className="absolute z-50 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto min-w-[200px]"
      style={{
        bottom: position.top,
        left: position.left,
      }}
    >
      <div className="py-1">
        {filteredAgents.map((agent, index) => {
          const label = displayName(agent, viewer)
          return (
            <button
              key={agent.id}
              data-selected={index === selectedIndex}
              className={`w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-100 ${
                index === selectedIndex ? 'bg-blue-50' : ''
              }`}
              onClick={() => onSelect(agent)}
            >
              <Avatar
                name={label}
                status={agent.status as AgentStatus}
                size="sm"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate flex items-center gap-1">
                  {label}
                  {agent.is_verified && <VerifiedBadge />}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {agent.status}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

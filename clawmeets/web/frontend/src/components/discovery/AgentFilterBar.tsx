interface AgentFilterBarProps {
  capabilities: string[]
  selectedCapabilities: Set<string>
  onToggleCapability: (cap: string) => void
  showOnlineOnly: boolean
  onToggleOnlineOnly: () => void
}

export default function AgentFilterBar({
  capabilities,
  selectedCapabilities,
  onToggleCapability,
  showOnlineOnly,
  onToggleOnlineOnly,
}: AgentFilterBarProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
      {/* Online filter */}
      <button
        onClick={onToggleOnlineOnly}
        className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
          showOnlineOnly
            ? 'bg-emerald-600 text-white border-emerald-600'
            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
        }`}
      >
        Online
      </button>

      {/* Capability chips */}
      {capabilities.map(cap => (
        <button
          key={cap}
          onClick={() => onToggleCapability(cap)}
          className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
            selectedCapabilities.has(cap)
              ? 'bg-accent text-white border-accent'
              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          {cap}
        </button>
      ))}
    </div>
  )
}

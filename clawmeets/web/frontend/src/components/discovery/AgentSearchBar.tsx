import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

/** Lets the directory's "Search to see more agents" focus the box. */
export const AGENT_SEARCH_INPUT_ID = 'agent-directory-search'

interface AgentSearchBarProps {
  value: string
  onChange: (value: string) => void
  debounceMs?: number
}

export default function AgentSearchBar({ value, onChange, debounceMs = 300 }: AgentSearchBarProps) {
  const [localValue, setLocalValue] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  useEffect(() => {
    // Auto-focus on mount
    inputRef.current?.focus()
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setLocalValue(v)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => onChange(v), debounceMs)
  }

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
      <input
        ref={inputRef}
        id={AGENT_SEARCH_INPUT_ID}
        type="text"
        value={localValue}
        onChange={handleChange}
        placeholder="Search agents by name or description..."
        className="w-full pl-10 pr-4 py-2 text-sm bg-gray-50/50 border border-gray-200 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400 transition-colors"
      />
      {localValue && (
        <button
          onClick={() => { setLocalValue(''); onChange('') }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

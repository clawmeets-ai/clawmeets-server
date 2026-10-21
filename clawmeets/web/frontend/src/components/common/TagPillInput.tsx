import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

interface TagPillInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  id?: string
  autoFocus?: boolean
  /** Optional autocomplete dropdown options. Items already in `value` are filtered out. */
  suggestions?: string[]
}

export default function TagPillInput({
  value,
  onChange,
  placeholder,
  id,
  autoFocus,
  suggestions = [],
}: TagPillInputProps) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const filteredSuggestions = useMemo(() => {
    const q = draft.trim().toLowerCase()
    return suggestions.filter((s) => {
      if (value.includes(s)) return false
      if (!q) return true
      return s.toLowerCase().includes(q)
    })
  }, [suggestions, draft, value])

  useEffect(() => {
    setHighlight((i) => Math.min(i, Math.max(0, filteredSuggestions.length - 1)))
  }, [filteredSuggestions.length])

  // Close dropdown on outside click.
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const commit = (token: string) => {
    const t = token.trim().replace(/,$/, '').trim()
    if (!t) return
    if (!value.includes(t)) onChange([...value, t])
    setDraft('')
    setOpen(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const hasDropdown = open && filteredSuggestions.length > 0
    if (hasDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((i) => Math.min(i + 1, filteredSuggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        commit(filteredSuggestions[highlight])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
    }
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault()
      onChange(value.slice(0, -1))
    } else if (e.key === 'ArrowDown' && suggestions.length > 0) {
      e.preventDefault()
      setOpen(true)
    }
  }

  const handleBlur = () => {
    // Defer so suggestion-click can fire first.
    setTimeout(() => {
      if (draft.trim()) commit(draft)
    }, 120)
  }

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
    inputRef.current?.focus()
  }

  return (
    <div className="relative" ref={wrapperRef}>
      <div
        onClick={() => {
          inputRef.current?.focus()
          if (suggestions.length > 0) setOpen(true)
        }}
        className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50/50 focus-within:ring-2 focus-within:ring-purple-500/20 focus-within:border-purple-400 transition-colors cursor-text min-h-[42px]"
      >
        {value.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-purple-50 border border-purple-200 text-purple-700 text-xs font-medium"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeAt(i)
              }}
              className="text-purple-400 hover:text-purple-700 transition-colors"
              aria-label={`Remove ${tag}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (suggestions.length > 0) setOpen(true)
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={value.length === 0 ? placeholder : ''}
          autoFocus={autoFocus}
          autoComplete="off"
          className="flex-1 min-w-[80px] outline-none bg-transparent text-sm placeholder-gray-400"
        />
      </div>
      {open && filteredSuggestions.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
        >
          <div className="py-1">
            {filteredSuggestions.map((tag, index) => (
              <button
                key={tag}
                type="button"
                data-selected={index === highlight}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  commit(tag)
                }}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-100 ${
                  index === highlight ? 'bg-purple-50' : ''
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

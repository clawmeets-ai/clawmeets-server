import { useCallback, useEffect, useMemo, useRef, useState, KeyboardEvent, ChangeEvent, FocusEvent } from 'react'

interface TagAutocompleteInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  suggestions: string[]
  placeholder?: string
  className?: string
  autoFocus?: boolean
}

function splitTokens(value: string): string[] {
  return value.split(',').map((t) => t.trim()).filter(Boolean)
}

export default function TagAutocompleteInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  className,
  autoFocus,
}: TagAutocompleteInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [tokenStart, setTokenStart] = useState(0)
  const [tokenEnd, setTokenEnd] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const rawQuery = value.slice(tokenStart, tokenEnd)
  const trimmedQuery = rawQuery.trim()

  // Exclude tags already present elsewhere in the value from suggestions.
  const usedTags = useMemo(() => {
    const tokens = splitTokens(value)
    // Drop the token currently being edited (its position equals the current
    // token) so a user re-typing an existing tag still sees it in the list.
    const currentTrimmed = trimmedQuery
    const used = new Set<string>()
    for (const t of tokens) {
      if (t === currentTrimmed) continue
      used.add(t.toLowerCase())
    }
    return used
  }, [value, trimmedQuery])

  const filtered = useMemo(() => {
    const q = trimmedQuery.toLowerCase()
    return suggestions.filter((s) => {
      if (usedTags.has(s.toLowerCase())) return false
      if (!q) return true
      return s.toLowerCase().includes(q)
    })
  }, [suggestions, usedTags, trimmedQuery])

  // Keep selectedIndex in range as the filter set changes.
  useEffect(() => {
    setSelectedIndex((i) => {
      if (filtered.length === 0) return 0
      return Math.min(i, filtered.length - 1)
    })
  }, [filtered.length])

  const updateTokenRange = useCallback((text: string, cursor: number) => {
    // Current token spans from the last comma before the cursor (exclusive)
    // to the cursor. The same token can contain leading whitespace, which we
    // preserve in rawQuery so replacement reinserts it.
    const lastComma = text.lastIndexOf(',', cursor - 1)
    const start = lastComma + 1
    setTokenStart(start)
    setTokenEnd(cursor)
  }, [])

  const openForCursor = useCallback((text: string, cursor: number) => {
    updateTokenRange(text, cursor)
    setIsOpen(true)
    setSelectedIndex(0)
  }, [updateTokenRange])

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    onChange(newValue)
    const cursor = e.target.selectionStart ?? newValue.length
    openForCursor(newValue, cursor)
  }

  // **READ THE EVENT'S TARGET, NOT THE REF.** React applies the `autoFocus`
  // attribute during `commitMount`, which runs BEFORE the ref callback
  // attaches — so on an autofocused mount `inputRef.current` is still null.
  // The old `if (!el) return` guard bailed there and `isOpen` never flipped,
  // which meant an autofocused field silently offered no suggestions until
  // the user clicked it. `e.currentTarget` is the input in every case,
  // including that first one.
  const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    const cursor = el.selectionStart ?? value.length
    openForCursor(value, cursor)
  }

  const handleKeyUp = () => {
    // Track caret movement via arrow keys, clicks, Home/End, etc.
    const el = inputRef.current
    if (!el || !isOpen) return
    const cursor = el.selectionStart ?? value.length
    updateTokenRange(value, cursor)
  }

  const insertTag = useCallback(
    (tag: string) => {
      // Replace the current in-progress token with the selected tag and trail
      // with ", " so the user can keep typing the next one. Preserve the
      // text to the right of the cursor unchanged.
      const before = value.slice(0, tokenStart)
      const after = value.slice(tokenEnd)
      // Preserve any leading whitespace the user already typed after the
      // previous comma (e.g. "Marketing, Outb…") so output stays "Marketing, Outbound".
      const leadingWs = (rawQuery.match(/^\s*/) || [''])[0]
      // If the text right after the cursor already starts with a comma, reuse
      // it; otherwise append ", " so the user can keep typing the next tag
      // without manually delimiting.
      const trailingSep = after.trimStart().startsWith(',') ? '' : ', '
      const insertion = `${leadingWs}${tag}${trailingSep}`
      const newValue = `${before}${insertion}${after}`
      onChange(newValue)
      setIsOpen(false)

      // Restore focus and place cursor after the insertion.
      const nextCursor = before.length + insertion.length
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [value, tokenStart, tokenEnd, rawQuery, onChange],
  )

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || filtered.length === 0) {
      // Even when closed, reopen on ArrowDown so keyboard-only users can
      // pop the dropdown without retyping.
      if (e.key === 'ArrowDown' && !isOpen) {
        e.preventDefault()
        const el = inputRef.current
        const cursor = el?.selectionStart ?? value.length
        openForCursor(value, cursor)
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertTag(filtered[selectedIndex])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setIsOpen(false)
      return
    }
    if (e.key === ',') {
      // User is manually delimiting — close the dropdown; it will reopen
      // on the next keystroke via handleChange.
      setIsOpen(false)
    }
  }

  // Close on click outside the input + dropdown.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      if (inputRef.current?.contains(target)) return
      if (dropdownRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Scroll selected item into view.
  useEffect(() => {
    if (!dropdownRef.current) return
    const el = dropdownRef.current.querySelector('[data-selected="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={handleKeyUp}
        placeholder={placeholder}
        autoComplete="off"
        autoFocus={autoFocus}
        className={className}
      />
      {isOpen && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
        >
          <div className="py-1">
            {filtered.map((tag, index) => (
              <button
                key={tag}
                type="button"
                data-selected={index === selectedIndex}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-100 ${
                  index === selectedIndex ? 'bg-blue-50' : ''
                }`}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertTag(tag)
                }}
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

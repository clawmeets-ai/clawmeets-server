import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

interface Props {
  children: ReactNode
  className?: string
  maxCollapsedHeight?: number
  maxExpandedVh?: number
}

export default function CollapsibleHeader({
  children,
  className = '',
  maxCollapsedHeight = 120,
  maxExpandedVh = 50,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => setIsOverflowing(el.scrollHeight > maxCollapsedHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [maxCollapsedHeight])

  const clipped = isOverflowing && !isExpanded
  const contentStyle = clipped
    ? { maxHeight: maxCollapsedHeight, overflow: 'hidden' as const }
    : isExpanded
      ? { maxHeight: `${maxExpandedVh}vh`, overflowY: 'auto' as const }
      : undefined

  return (
    <header className={`relative ${className}`}>
      <div ref={contentRef} style={contentStyle}>
        {children}
      </div>
      {clipped && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-white"
        />
      )}
      {isOverflowing && (
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          aria-label={isExpanded ? 'Collapse header' : 'Expand header'}
          aria-expanded={isExpanded}
          className="absolute left-1/2 -translate-x-1/2 -bottom-3 z-10 w-7 h-7 rounded-full bg-white border border-border shadow-sm flex items-center justify-center hover:bg-sidebar-hover transition-colors"
        >
          <ChevronDown
            className={`w-4 h-4 text-channel transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    </header>
  )
}

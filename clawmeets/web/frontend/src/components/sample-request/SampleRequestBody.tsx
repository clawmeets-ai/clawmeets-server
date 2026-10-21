import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Sample-request rendering primitives. The on-disk convention authored in
// the agent pool's setup.json (agents/setup.json) is:
//   [Slot: default value]   — placeholder the user fills in
//   **file**                — file the user needs to attach (e.g. **attached resume**)
// This module renders both as visually distinct chips, with placeholders
// optionally interactive (clickable popover for editing the slot value) and
// files always static (read-only highlight).

// Matches `[slot]` or `[slot: default value]` tokens. Slot must start with a
// letter so `[/route]` and `[1,400 sqft]` aren't caught. Negative lookahead
// on `](` skips markdown links.
export const PLACEHOLDER_RE = /\[([A-Za-z][^:\]]*)(?::\s*([^\]]+))?\](?!\()/g

// Strip default-value `[Slot: default]` to bare `default` text on submit, so
// the final message is clean. Bare `[Slot]` with no default is preserved so
// the user notices any unfilled slots.
export function collapsePlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, (full, _slot: string, def?: string) =>
    def !== undefined ? def : full,
  )
}

function PlaceholderChipInteractive({
  slot,
  defaultValue,
  onCommit,
}: {
  slot: string
  defaultValue: string
  onCommit: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(defaultValue)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setDraft(defaultValue)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, defaultValue])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed) onCommit(trimmed)
    setOpen(false)
  }
  const cancel = () => {
    setOpen(false)
    setDraft(defaultValue)
  }

  return (
    <span ref={wrapRef} className="relative inline-block align-baseline">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        title={`Edit ${slot}`}
        className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 hover:bg-purple-200 font-medium border border-dashed border-purple-300"
      >
        {defaultValue || slot}
      </button>
      {open && (
        <span
          className="absolute z-20 top-full left-0 mt-1.5 w-72 max-w-[calc(100vw-2rem)] bg-white border border-gray-200 rounded-xl shadow-lg p-3.5 block text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1.5 font-semibold">
            {slot}
          </span>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
            autoFocus
            className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-md mb-3 text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
          />
          <span className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={cancel}
              className="text-xs px-3 py-1 border border-gray-200 text-gray-600 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              className="text-xs px-3 py-1 bg-accent text-white rounded-md hover:bg-accent-deep font-medium"
            >
              Save
            </button>
          </span>
        </span>
      )}
    </span>
  )
}

// Static (non-interactive) placeholder visualization for read-only previews.
function PlaceholderChipStatic({
  slot,
  defaultValue,
}: {
  slot: string
  defaultValue: string
}) {
  return (
    <span
      className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-medium border border-dashed border-purple-300"
      title={`Placeholder: ${slot}`}
    >
      {defaultValue || slot}
    </span>
  )
}

// File-chip styling matches the established welcome-page treatment for `**X**`:
// solid 8% accent fill, accent-deep text, rounded. No icon — the `**resume
// attached**` / `**file**` wording itself signals "attach this".
function FileChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        color: 'var(--accent-deep)',
        fontWeight: 700,
        background: 'rgba(107,42,160,0.08)',
        padding: '0 3px',
        borderRadius: 3,
      }}
    >
      {children}
    </span>
  )
}

// Walk a markdown-rendered React tree and split any [Slot: default] tokens
// inside text nodes into PlaceholderChip elements. `onReplace` rewrites the
// underlying request string when a slot is committed.
function interleaveChips(
  children: ReactNode,
  interactive: boolean,
  onReplace?: (full: string, value: string) => void,
): ReactNode {
  return Children.map(children, (child, idx) => {
    if (typeof child === 'string') {
      const parts: ReactNode[] = []
      const re = new RegExp(PLACEHOLDER_RE.source, 'g')
      let last = 0
      let m: RegExpExecArray | null
      let n = 0
      while ((m = re.exec(child)) !== null) {
        if (m.index > last) parts.push(child.slice(last, m.index))
        const full = m[0]
        const slot = m[1]
        const def = m[2] ?? ''
        const key = `chip-${idx}-${n++}`
        if (interactive && onReplace) {
          parts.push(
            <PlaceholderChipInteractive
              key={key}
              slot={slot}
              defaultValue={def}
              onCommit={(v) => onReplace(full, v)}
            />,
          )
        } else {
          parts.push(
            <PlaceholderChipStatic key={key} slot={slot} defaultValue={def} />,
          )
        }
        last = m.index + full.length
      }
      if (parts.length === 0) return child
      if (last < child.length) parts.push(child.slice(last))
      return <Fragment>{parts}</Fragment>
    }
    if (isValidElement(child)) {
      const el = child as ReactElement<{ children?: ReactNode }>
      return cloneElement(
        el,
        {},
        interleaveChips(el.props.children, interactive, onReplace),
      )
    }
    return child
  })
}

export interface SampleRequestBodyProps {
  /** The sample-request markdown source (with `[Slot: default]` and `**file**` markers). */
  request: string
  /**
   * When true, placeholder chips are clickable. Editing a chip calls
   * `onRequestChange` with a functional updater that performs the textual
   * replacement, so consumers can pass a `useState` setter directly without
   * worrying about stale closures.
   */
  interactive?: boolean
  onRequestChange?: (updater: (current: string) => string) => void
  className?: string
}

/**
 * Renders a sample-request body with:
 * - Markdown via ReactMarkdown + remark-gfm
 * - `**X**` → static FileChip (highlighted file marker)
 * - `[Slot: default]` → PlaceholderChip (interactive when `interactive` is true,
 *   static otherwise)
 */
export default function SampleRequestBody({
  request,
  interactive = false,
  onRequestChange,
  className,
}: SampleRequestBodyProps) {
  const replacePlaceholder = (fullToken: string, newValue: string) => {
    onRequestChange?.((current) => current.replace(fullToken, newValue))
  }

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Files: `**X**` → FileChip (highlighted, no markdown bold)
          strong: ({ children }) => <FileChip>{children}</FileChip>,
          // Recurse into block elements to interleave placeholder chips into text.
          p: ({ children, ...rest }) => (
            <p {...rest}>
              {interleaveChips(children, interactive, replacePlaceholder)}
            </p>
          ),
          li: ({ children, ...rest }) => (
            <li {...rest}>
              {interleaveChips(children, interactive, replacePlaceholder)}
            </li>
          ),
        }}
      >
        {request}
      </ReactMarkdown>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { CheckSquare, X } from 'lucide-react'
import { parsePrompt } from '../composer/placeholders'

/** Longest suggested name we'll seed the field with. Past this a title stops
 *  being scannable on the plate and the user should shorten it themselves. */
const NAME_LEN = 80

/**
 * A name for the to-do a draft is about to become: its first non-empty line,
 * whitespace-collapsed and capped. Unfilled `{{blanks}}` are rendered as their
 * plain labels — a title reading "Chase {{Quarter|text}}" would be leaking
 * syntax into the plate.
 *
 * Empty draft → empty string, and the field just starts blank on its placeholder.
 */
export function suggestTodoName(draft: string): string {
  let n = 0
  const flat = parsePrompt(draft, () => 'n' + ++n)
    .map((node) => (node.t === 'ph' ? node.chip.label : node.v))
    .join('')
  const first = flat.split('\n').find((l) => l.trim()) ?? ''
  const clean = first.replace(/\s+/g, ' ').trim()
  return clean.length > NAME_LEN ? clean.slice(0, NAME_LEN).trimEnd() : clean
}

interface SaveTodoModalProps {
  /** Suggested name — the draft's first line. Editable. */
  suggested: string
  onSave: (name: string) => void
  onCancel: () => void
}

/**
 * The one-field dialog the FIRST "Save to-do" opens: what should this item be
 * called on the plate? Asked once and only once — every later press of the
 * button saves straight to the bound item, and never rewrites its title.
 *
 * Reuses the SOP editor's dialog chrome (`.sop-scrim` / `.sop-dlg` /
 * `.sop-field` / `.sop-btn`) at a narrow width rather than growing a second
 * modal system for one text input.
 */
export default function SaveTodoModal({ suggested, onSave, onCancel }: SaveTodoModalProps) {
  const [name, setName] = useState(suggested)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus AND select: the suggestion is a decent default but usually worth
  // rewriting, so typing over it should not need a manual select-all first.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const canSave = name.trim().length > 0
  const submit = () => {
    if (canSave) onSave(name.trim())
  }

  return (
    <div className="sop-scrim" onMouseDown={onCancel}>
      <div
        className="sop-dlg sop-dlg--sm"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Name this to-do"
      >
        <div className="sop-dlg-head">
          <span className="sop-dlg-ic">
            <CheckSquare size={16} />
          </span>
          <div>
            <div className="sop-dlg-title">Name this to-do</div>
            <div className="sop-dlg-sub">
              Your draft is saved with it — you won’t be asked again
            </div>
          </div>
          <button type="button" className="sop-dlg-x" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="sop-ed-main">
          <label className="sop-field">
            <span className="sop-field-l">Name</span>
            <input
              ref={inputRef}
              className="sop-field-in"
              value={name}
              placeholder="What is this task?"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </label>
        </div>

        <div className="sop-dlg-foot">
          <button type="button" className="sop-btn" onClick={onCancel}>
            Cancel <span className="sop-kb">Esc</span>
          </button>
          <button
            type="button"
            className="sop-btn sop-btn--primary"
            disabled={!canSave}
            onClick={submit}
          >
            Save to-do
          </button>
        </div>
      </div>
    </div>
  )
}

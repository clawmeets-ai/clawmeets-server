import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Sparkles, X } from 'lucide-react'
import type { SopDraft } from '../../api/endpoints/deskSops'
import { useMyAgents } from '../../hooks/useMyAgents'
import { useAuthStore } from '../../stores/authStore'
import { displayName } from '../../utils/agentDisplay'
import { PH_TAGS, parsePrompt, placeholderBlanks } from '../composer/placeholders'
import { SOP_BODY_PLACEHOLDER, SOP_SYNTAX } from './sopSyntax'

interface SopEditorProps {
  draft: SopDraft
  onSave: (draft: SopDraft) => void
  onCancel: () => void
}

/** Render a body through the real parser, as static (non-interactive) chips —
 *  so the author sees exactly what the composer will show. */
export function SopPreview({ body }: { body: string }) {
  if (!body.trim()) {
    return <div className="sop-prev empty">Your prompt will preview here.</div>
  }
  let n = 0
  const nodes = parsePrompt(body, () => 'prev' + ++n)
  return (
    <div className="sop-prev">
      {nodes.map((node, i) =>
        node.t === 'ph' ? (
          <span className="ph-chip static" key={i}>
            <span className="ph-k">{PH_TAGS[node.chip.kind]}</span>
            <span className="ph-tx">{node.chip.label}</span>
          </span>
        ) : (
          <span key={i}>{node.v}</span>
        ),
      )}
    </div>
  )
}

/**
 * Author or edit a stored prompt. Two columns: the form on the left, a
 * clickable syntax cheat sheet on the right (we ship no built-in SOPs, so this
 * panel and the prompt field's worked-example placeholder are the only things
 * teaching the blank syntax).
 */
export default function SopEditor({ draft, onSave, onCancel }: SopEditorProps) {
  const { user } = useAuthStore()
  const { data: myAgents } = useMyAgents()
  const [title, setTitle] = useState(draft.title)
  const [body, setBody] = useState(draft.body)
  const [agentId, setAgentId] = useState(draft.agent_id ?? '')
  const [helpOpen, setHelpOpen] = useState(true)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const firstRef = useRef<HTMLInputElement>(null)

  // Focus lands on the first EMPTY field, which is the Name box only when the
  // dialog opened with nothing in it. The SOP rail's `+` seeds the title from
  // its search box, so for that path the name is already settled and the
  // prompt is the field the author actually came here to fill.
  useEffect(() => {
    if (draft.title.trim()) taRef.current?.focus()
    else firstRef.current?.focus()
    // Mount only: re-running on a keystroke would fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const roster = myAgents ?? []

  // Drop a blank at the caret, then select its Label so it can be renamed
  // immediately — the fastest path from "insert a date" to "insert Deadline".
  const insert = (code: string) => {
    const el = taRef.current
    const at = el ? el.selectionStart : body.length
    const end = el ? el.selectionEnd : body.length
    setBody(body.slice(0, at) + code + body.slice(end))
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const labelStart = at + 2 // past "{{"
      const pipe = code.indexOf('|')
      // To the pipe, or (for a bare "{{Label}}") up to the closing braces.
      const labelEnd = at + (pipe > 0 ? pipe : code.length - 2)
      el.setSelectionRange(labelStart, Math.max(labelStart, labelEnd))
    })
  }

  const blanks = placeholderBlanks(body)
  const canSave = title.trim().length > 0 && body.trim().length > 0

  const submit = () => {
    if (!canSave) return
    const picked = roster.find((a) => a.id === agentId)
    onSave({
      ...draft,
      title: title.trim(),
      body: body.trim(),
      // Both fields always travel, so "unassigned" round-trips as an explicit
      // null rather than leaving a stale recipient on the server.
      agent_id: picked?.id ?? null,
      agent_name: picked?.name ?? null,
    })
  }

  return (
    <div className="sop-scrim" onMouseDown={onCancel}>
      <div
        className="sop-dlg"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? 'Edit SOP' : 'New SOP'}
      >
        <div className="sop-dlg-head">
          <span className="sop-dlg-ic">
            <FileText size={16} />
          </span>
          <div>
            <div className="sop-dlg-title">{draft.id ? 'Edit SOP' : 'New SOP'}</div>
            <div className="sop-dlg-sub">
              A reusable prompt with blanks you fill in at send time
            </div>
          </div>
          <button type="button" className="sop-dlg-x" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="sop-ed">
          <div className="sop-ed-main">
            <div className="sop-ed-row">
              <label className="sop-field">
                <span className="sop-field-l">
                  Name
                  {/* The rail's sections come from this field and only this
                      field (utils/sopSection.ts), so the convention has to be
                      discoverable where the title is typed — otherwise the
                      grouping looks like something the app decided. */}
                  <span className="sop-field-opt">a Marketing: prefix files it there</span>
                </span>
                <input
                  ref={firstRef}
                  className="sop-field-in"
                  value={title}
                  placeholder="e.g. Marketing:weekly reel batch"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="sop-field sop-ed-who">
                <span className="sop-field-l">Usually goes to</span>
                <select
                  className="sop-field-in mono"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  <option value="">— nobody —</option>
                  {roster.map((a) => (
                    <option key={a.id} value={a.id}>
                      @{displayName(a, user)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="sop-field">
              <span className="sop-field-l">
                Prompt
                <i className="sop-field-opt">
                  {blanks.length} blank{blanks.length === 1 ? '' : 's'}
                </i>
              </span>
              <div className="sop-ins">
                <span className="sop-ins-l">Insert a blank</span>
                {/* Skip the "with a default" variant — same kind as row 0, and
                    the cheat sheet on the right covers it. */}
                {SOP_SYNTAX.filter((_, i) => i !== 1).map((s) => (
                  <button
                    type="button"
                    key={s.code}
                    className="sop-ins-b"
                    onClick={() => insert(s.code)}
                    title={s.note}
                  >
                    <i className="ph-k">{s.kind}</i>
                    {s.name}
                  </button>
                ))}
              </div>
              <textarea
                ref={taRef}
                className="sop-field-in sop-ta mono"
                value={body}
                spellCheck={false}
                placeholder={SOP_BODY_PLACEHOLDER}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>

            <div className="sop-field">
              <span className="sop-field-l">
                Preview<i className="sop-field-opt">what the composer will show</i>
              </span>
              <SopPreview body={body} />
            </div>
          </div>

          <aside className="sop-ed-help">
            <button
              type="button"
              className="sop-help-h"
              onClick={() => setHelpOpen((h) => !h)}
              aria-expanded={helpOpen}
            >
              <Sparkles size={13} />
              How blanks work
              {helpOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            {helpOpen && (
              <div className="sop-help-b">
                <p className="sop-help-p">
                  Wrap a blank in double braces. The word before the <code>|</code> is its
                  label; after it is the type. Click a row to drop it into your prompt.
                </p>
                {SOP_SYNTAX.map((s) => (
                  <button
                    type="button"
                    key={s.code}
                    className="sop-help-row"
                    onClick={() => insert(s.code)}
                  >
                    <span className="sop-help-t">
                      <i className="ph-k">{s.kind}</i>
                      {s.name}
                    </span>
                    <code className="sop-help-c">{s.code}</code>
                    <span className="sop-help-n">{s.note}</span>
                  </button>
                ))}
                <p className="sop-help-p sop-help-foot">
                  Every type also accepts a typed-in value, so a set is a shortcut — never
                  a cage. Anything left blank blocks send.
                </p>
              </div>
            )}
          </aside>
        </div>

        <div className="sop-dlg-foot">
          <span className="sop-ed-count">
            {blanks.length
              ? `${blanks.length} blank${blanks.length === 1 ? '' : 's'} detected`
              : 'No blanks yet — this will send as plain text'}
          </span>
          <button type="button" className="sop-btn" onClick={onCancel}>
            Cancel <span className="sop-kb">Esc</span>
          </button>
          <button
            type="button"
            className="sop-btn sop-btn--primary"
            disabled={!canSave}
            onClick={submit}
          >
            Save SOP
          </button>
        </div>
      </div>
    </div>
  )
}

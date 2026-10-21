import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, CornerUpRight, FileText, Search } from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'
import { useAuthStore } from '../../stores/authStore'
import { useUIStore } from '../../stores/uiStore'
import { displayName, matchesQuery } from '../../utils/agentDisplay'
import { forwardToOwnAgent } from '../../api/endpoints/dm'
import { ApiError } from '../../api/client'
import type { AgentCard } from '../../types'
import Avatar from '../common/Avatar'
import MarkdownBody from '../shared/MarkdownBody'

export interface ForwardTarget {
  projectId: string
  chatroomName: string
  /** One message, or every message of a coalesced group. */
  messageIds: string[]
  /** Who wrote the original — shown in the quote header. */
  senderName: string
  /** Preview only. The server re-reads the stored original; this is never sent. */
  content: string
  /** Attachments that rode in with the original. */
  files: string[]
  /** The original's author, excluded from the picker (forwarding an agent its
   *  own words back is never the intent). */
  senderId?: string
  /** The original came from outside this server (a Hub thread): the preview
   *  renders it as untrusted Markdown, like the room it came from. */
  untrusted?: boolean
}

interface Props {
  target: ForwardTarget
  onClose: () => void
  /** Fired once every recipient has the message. Desk cards show a toast. */
  onSent?: (recipientNames: string[]) => void
}

// "Use Forward on this message to send it to @backend" — the convention the
// relay skill asks agents to end with. Recipients named that way are pre-ticked
// and marked SUGGESTED.
const SUGGESTION_RE = /forward[^\n]*?@([\w.-]+)/gi

function suggestedNames(content: string): Set<string> {
  const out = new Set<string>()
  for (const m of content.matchAll(SUGGESTION_RE)) out.add(m[1].toLowerCase())
  return out
}

/**
 * Forward a message to one or more of the user's own agents.
 *
 * Sent from the user's own session, as the user, into a new DM thread with
 * each recipient: the original goes as a quote the user cannot edit ("Forwarded
 * from X"), the user's note sits above it, and the original's attachments
 * ride along unless unticked. No agent ever sends on the user's behalf.
 */
export default function ForwardModal({ target, onClose, onSent }: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setRailContext = useUIStore((s) => s.setRailContext)
  const viewer = useAuthStore((s) => s.user) ?? null
  const { data: agents = [] } = useAgents()

  const suggested = useMemo(() => suggestedNames(target.content), [target.content])
  const candidates = useMemo<AgentCard[]>(() => {
    if (!viewer) return []
    const own = agents.filter((a) => a.registered_by === viewer.id && a.id !== target.senderId)
    const isSuggested = (a: AgentCard) =>
      suggested.has(a.name.toLowerCase()) || suggested.has(displayName(a, viewer).toLowerCase())
    return [...own].sort((a, b) => {
      const sa = isSuggested(a) ? 0 : 1
      const sb = isSuggested(b) ? 0 : 1
      return sa - sb || displayName(a, viewer).localeCompare(displayName(b, viewer))
    })
  }, [agents, viewer, target.senderId, suggested])

  const isSuggested = (a: AgentCard) =>
    suggested.has(a.name.toLowerCase()) || suggested.has(displayName(a, viewer).toLowerCase())

  // Untouched ⇒ the suggested recipients, derived live so they appear once
  // the agent list loads; the first click freezes it into a manual choice.
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const selected = picked ?? new Set(candidates.filter(isSuggested).map((a) => a.name))
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')
  const [files, setFiles] = useState<Set<string>>(() => new Set(target.files))
  const [openAfter, setOpenAfter] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One thread key per recipient for the dialog's lifetime: a retry after a
  // partial failure reuses the thread already minted instead of opening a twin.
  const threadKeys = useRef(new Map<string, string>())
  const threadKey = (agentName: string) => {
    let key = threadKeys.current.get(agentName)
    if (!key) {
      key = crypto.randomUUID()
      threadKeys.current.set(agentName, key)
    }
    return key
  }

  const visible = candidates.filter((a) => !query || matchesQuery(a, query, viewer))
  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    return next
  }

  const recipients = candidates.filter((a) => selected.has(a.name))

  const handleSend = async () => {
    if (recipients.length === 0 || sending) return
    setSending(true)
    setError(null)
    const includeFiles = target.files.filter((f) => files.has(f))
    const failed: string[] = []
    let lastProjectId: string | null = null
    for (const agent of recipients) {
      try {
        const { projectId } = await forwardToOwnAgent(
          agent.name,
          {
            projectId: target.projectId,
            chatroomName: target.chatroomName,
            messageIds: target.messageIds,
            includeFiles,
          },
          note,
          threadKey(agent.name),
        )
        lastProjectId = projectId
      } catch (e) {
        failed.push(`${displayName(agent, viewer)}: ${e instanceof ApiError ? e.message : String(e)}`)
      }
    }
    setSending(false)
    queryClient.invalidateQueries({ queryKey: ['projects'] })
    queryClient.invalidateQueries({ queryKey: ['user-projects'] })
    queryClient.invalidateQueries({ queryKey: ['all-projects'] })
    if (failed.length > 0) {
      setError(`Not sent to ${failed.join('; ')}`)
      return
    }
    onSent?.(recipients.map((a) => displayName(a, viewer)))
    onClose()
    if (openAfter && recipients.length === 1 && lastProjectId) {
      setRailContext('dms')
      navigate(`/dm/${encodeURIComponent(recipients[0].name)}/${lastProjectId}`)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Forward message"
        className="bg-white rounded-xl shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Keep keystrokes out of page-level shortcuts (My Desk binds bare
          // letters: X would dismiss the card behind this dialog).
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend()
        }}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <CornerUpRight className="w-4 h-4 text-accent" />
          <h2 className="text-lg font-bold text-gray-900">Forward message</h2>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="p-3 border border-red-200 bg-red-50 rounded-lg text-xs text-red-700">{error}</div>
          )}

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">To</label>
            <div className="border border-gray-200 rounded-lg">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
                <Search className="w-3.5 h-3.5 text-gray-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your agents"
                  className="flex-1 text-sm outline-none"
                />
              </div>
              <ul className="max-h-48 overflow-y-auto py-1">
                {visible.length === 0 && (
                  <li className="px-3 py-2 text-xs text-gray-400">No matching agents</li>
                )}
                {visible.map((a) => {
                  const on = selected.has(a.name)
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => setPicked(toggle(selected, a.name))}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${on ? 'bg-accent/5' : ''}`}
                      >
                        <span
                          className={`w-4 h-4 rounded border flex items-center justify-center ${on ? 'bg-accent border-accent' : 'border-gray-300'}`}
                        >
                          {on && <Check className="w-3 h-3 text-white" />}
                        </span>
                        <Avatar name={displayName(a, viewer)} status={a.status} size="sm" />
                        <span className="font-medium text-gray-900">{displayName(a, viewer)}</span>
                        {isSuggested(a) && (
                          <span className="text-[10px] font-semibold tracking-wider text-accent uppercase">
                            Suggested
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">
              Note <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Add context for the recipient"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-accent/20 focus:border-accent resize-vertical"
            />
          </div>

          <div className="border-l-4 border-gray-200 bg-gray-50 rounded-r-lg px-4 py-3">
            <div className="text-xs font-semibold text-gray-500 mb-1.5">Forwarded from {target.senderName}</div>
            <div className="text-sm text-gray-700 max-h-48 overflow-y-auto">
              <MarkdownBody content={target.content} untrusted={target.untrusted} />
            </div>
          </div>

          {target.files.length > 0 && (
            <div className="space-y-1">
              <div className="text-sm font-semibold text-gray-800">Attachments</div>
              {target.files.map((f) => (
                <label key={f} className="flex items-center gap-2 text-xs font-mono text-gray-700">
                  <input
                    type="checkbox"
                    checked={files.has(f)}
                    onChange={() => setFiles(toggle(files, f))}
                  />
                  <FileText className="w-3.5 h-3.5 text-blue-500" />
                  {f}
                </label>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-2">
            <label
              className={`flex items-center gap-2 text-xs ${recipients.length === 1 ? 'text-gray-600' : 'text-gray-300'}`}
            >
              <input
                type="checkbox"
                checked={openAfter && recipients.length === 1}
                disabled={recipients.length !== 1}
                onChange={(e) => setOpenAfter(e.target.checked)}
              />
              Open the new thread after sending
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={recipients.length === 0 || sending}
                className="px-5 py-2 text-sm font-bold text-white bg-accent rounded-lg hover:bg-accent-deep transition-colors disabled:opacity-50"
              >
                {sending
                  ? 'Sending…'
                  : recipients.length > 1
                    ? `Forward to ${recipients.length} agents`
                    : 'Forward'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

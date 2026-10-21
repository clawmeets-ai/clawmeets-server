import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Send, Loader2, Pencil } from 'lucide-react'
import { createDMThread, sendDMMessage } from '../../api/endpoints/dm'
import { useUIStore } from '../../stores/uiStore'
import { useAuthStore } from '../../stores/authStore'
import { useAgents } from '../../hooks/useAgents'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import { useComposeForm, type ComposeMode } from '../../hooks/useComposeForm'
import ComposeFields from './ComposeFields'
import type { AgentCard } from '../../types'

// CTA label — one constant if the wording changes.
export const CTA_LABEL = 'Send DM'

export interface DmComposeModalProps {
  // Which template drives the field set. AgentsPanel + → 'agent'; ProjectsPanel + → 'project'.
  mode: ComposeMode
  // The user's assistant — shown read-only as "To: @assistant"; passed to the
  // send path by NAME (the URL path of createDMThread), never as a payload field.
  recipient: AgentCard
  // Dismiss callback; the launching panel owns open-state and unmounts on close.
  onClose: () => void
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Popup DM composer (v2). Replaces the sidebar `+` "navigate to the assistant DM
// with a ?draft= prefill" flow with a variable-driven form. Collects one field
// per template variable (mode-selected), assembles the message via dmPrefill
// helpers, previews it live, and fires the EXISTING two-call send contract
// (createDMThread → sendDMMessage). Three phases in one mount:
//   collect → sending (locked) → success (navigate to the new thread, no beat).
export default function DmComposeModal({ mode, recipient, onClose }: DmComposeModalProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setRailContext = useUIStore((s) => s.setRailContext)
  const user = useAuthStore((s) => s.user)
  const { data: agents } = useAgents()

  const form = useComposeForm(mode)

  // Idempotency token — one per open, REUSED on retry so a failed second call
  // after a successful createDMThread re-targets the same thread (no duplicate).
  const draftKeyRef = useRef<string>()
  if (!draftKeyRef.current) draftKeyRef.current = crypto.randomUUID()

  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const titleId = 'dm-compose-title'
  const recipientId = 'dm-compose-recipient'

  const [error, setError] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  // Manual-edit buffer. null ⇒ structured form drives the body (default);
  // non-null ⇒ "Edit message directly" is ON and this string is the send body.
  const [editedBody, setEditedBody] = useState<string | null>(null)
  const editMode = editedBody !== null

  const recipientLabel = agentDisplayName(recipient, user)
  const titleText = mode === 'agent' ? 'New agent' : 'New project'

  // Project mode: roster of the user's own agents, by display name, for the
  // TagPillInput autocomplete. Free-typed names are still accepted.
  const agentSuggestions = useMemo(() => {
    if (mode !== 'project' || !agents || !user) return []
    return agents
      .filter((a) => a.registered_by === user.id)
      .map((a) => agentDisplayName(a, user))
      .sort((a, b) => a.localeCompare(b))
  }, [mode, agents, user])

  // The exact string that will be sent: the manual buffer while editing,
  // otherwise the live-assembled body. Feeds both the preview and the send call.
  const sendBody = editMode ? (editedBody as string) : form.assembled
  const bodyIsValid = editMode ? (editedBody as string).trim().length > 0 : form.isValid

  const sendMutation = useMutation({
    mutationFn: async (body: string): Promise<string> => {
      const thread = await createDMThread(recipient.name, draftKeyRef.current)
      await sendDMMessage(thread.id, 'user-communication', body)
      return thread.id
    },
    onSuccess: (threadId) => {
      // Mirror DMChatView.createThreadMutation.onSuccess: surface the new thread
      // in the rail, then navigate straight into it — no in-dialog beat.
      queryClient.invalidateQueries({ queryKey: ['user-projects'] })
      queryClient.invalidateQueries({ queryKey: ['all-projects'] })
      setRailContext('dms')
      navigate(`/dm/${encodeURIComponent(recipient.name)}/${threadId}`)
      onClose()
    },
    onError: (err: Error) => {
      setError(err?.message || 'Failed to send. Please try again.')
    },
  })

  const isSending = sendMutation.isPending
  const canSend = bodyIsValid && !isSending

  // Dirty for the discard guard: structured fields touched, or a non-empty
  // manual edit buffer while editing.
  const isDirty = form.isDirty || (editMode && (editedBody as string).trim().length > 0)

  const submit = useCallback(() => {
    if (isSending) return
    if (!bodyIsValid) {
      setShowErrors(true)
      return
    }
    setError(null)
    sendMutation.mutate(sendBody)
  }, [isSending, bodyIsValid, sendBody, sendMutation])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    submit()
  }

  const attemptClose = useCallback(() => {
    if (isSending) return // locked while a send is in flight
    if (isDirty && !window.confirm('Discard your message?')) return
    onClose()
  }, [isSending, isDirty, onClose])

  const toggleEditMessage = () => {
    if (isSending) return
    // ON → seed with the current assembled body; OFF → discard the manual buffer.
    setEditedBody((prev) => (prev === null ? form.assembled : null))
  }

  // Esc dismiss + Cmd/Ctrl+Enter submit + Tab focus-trap, scoped to the dialog.
  // `defaultPrevented` lets an inner control (e.g. TagPillInput closing its
  // suggestion dropdown on Esc) swallow the key before it reaches the modal.
  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      attemptClose()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // Remember the trigger element and restore focus to it when the modal unmounts.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    return () => restoreFocusRef.current?.focus?.()
  }, [])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={attemptClose}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={recipientId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        className="relative bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg font-semibold text-gray-900">
              {titleText}
            </h3>
            <p id={recipientId} className="mt-0.5 text-sm text-gray-500">
              To: <span className="font-mono text-gray-700">@{recipientLabel}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={attemptClose}
            disabled={isSending}
            aria-label="Close"
            className="p-1 rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <fieldset disabled={isSending} className="min-w-0 border-0 p-0 m-0 space-y-4">
              <ComposeFields
                mode={mode}
                form={form}
                showErrors={showErrors}
                disabled={isSending}
                autoFocus
                agentSuggestions={agentSuggestions}
              />

              {/* Preview / manual-edit region */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700">
                    {editMode ? 'Message' : 'Message preview'}
                  </span>
                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={editMode}
                      onChange={toggleEditMessage}
                      className="rounded border-gray-300 text-purple-600 focus:ring-purple-500/30"
                    />
                    <Pencil className="w-3 h-3" />
                    Edit message directly
                  </label>
                </div>
                {editMode ? (
                  <textarea
                    value={editedBody as string}
                    onChange={(e) => setEditedBody(e.target.value)}
                    rows={5}
                    aria-label="Message"
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-400 disabled:bg-gray-50"
                  />
                ) : (
                  <div
                    aria-live="polite"
                    className="min-h-[76px] w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-gray-50 text-gray-700 whitespace-pre-wrap break-words"
                  >
                    {form.assembled || (
                      <span className="text-gray-400">
                        Fill in the fields above to preview your message.
                      </span>
                    )}
                  </div>
                )}
              </div>
            </fieldset>

            {/* Send-failure banner — values are kept; retry reuses the draftKey */}
            {error && (
              <div
                role="alert"
                className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg"
              >
                {error}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button
              type="button"
              onClick={attemptClose}
              disabled={isSending}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSend}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-deep disabled:bg-accent-soft disabled:cursor-not-allowed transition-colors"
            >
              {isSending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              <span>{isSending ? 'Sending…' : CTA_LABEL}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

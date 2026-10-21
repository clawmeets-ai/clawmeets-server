import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'

export interface DisconnectConfirmModalProps {
  open: boolean
  integrationName: string
  /** True while the disconnect request is in flight. */
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation dialog for withdrawing an integration's Google access (gap G2).
 * Copy is deliberately honest about the async, dispatch-and-forget contract —
 * it does NOT claim Google-side revocation is confirmed (there is no completion
 * callback) and notes the skill stays installed but must be reconnected.
 * Renders nothing when `!open`.
 */
export function DisconnectConfirmModal({
  open,
  integrationName,
  busy,
  onConfirm,
  onCancel,
}: DisconnectConfirmModalProps): JSX.Element | null {
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={() => !busy && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl max-w-md w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <h2 id={titleId} className="text-lg font-bold text-gray-900">
            Disconnect{' '}
            <span className="font-mono text-red-700">{integrationName}</span>?
          </h2>
        </div>

        <div className="px-6 py-4">
          <p className="text-sm text-gray-600 leading-relaxed">
            ClawMeets will ask the agent's computer to revoke its access and delete
            the stored token. The integration stays installed but must be
            reconnected before it can be used again.
          </p>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 bg-white hover:border-gray-300 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-red-600 text-white border border-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default DisconnectConfirmModal

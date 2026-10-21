import { useEffect, useId, useRef } from 'react'
import type { SendWarning } from '../../api/endpoints/hub'
import { offlineConfirmText, type HubThreadNames } from '../../utils/hubThread'

/**
 * The warn-and-confirm before a message goes to an agent (or a whole server)
 * that is offline. Nothing was stored yet; "Send anyway" re-sends with the
 * same client_message_id and confirm_offline, so a double click sends once.
 * Focus starts on Cancel.
 */
export default function HubOfflineConfirm({ warning, names, busy, onSend, onCancel }: {
  warning: SendWarning
  names: HubThreadNames
  busy: boolean
  onSend: () => void
  onCancel: () => void
}) {
  const textId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  return (
    <div
      role="alertdialog"
      aria-describedby={textId}
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-gray-800"
      data-testid="hub-offline-confirm"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
    >
      <p id={textId}>{offlineConfirmText(warning, names)}</p>
      <div className="mt-2 flex justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-gray-700 hover:bg-amber-100">
          Cancel
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={busy}
          className="rounded bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          Send anyway
        </button>
      </div>
    </div>
  )
}

import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import type { HubChannel } from '../../../api/endpoints/hub'
import { turnOffDialogText } from '../../../utils/hubChannelView'

/**
 * "Stop sharing {agent}?" — the only way the Hub switch turns off. Off makes
 * the agent private, so the body says who stops getting replies and whether
 * owner isolation ends (turnOffDialogText).
 *
 * "Stop sharing" drains: replies already being written keep sending for up to
 * 10 minutes. "Stop sharing and don't send pending replies" (stop_now) is the
 * escape hatch for a misbehaving agent, shown only while replies are in flight;
 * with nothing in flight the two are the same. Focus starts on Cancel.
 */
export default function HubTurnOffDialog({ channel, agentName, busy = false, onConfirm, onCancel }: {
  channel: HubChannel
  agentName: string
  busy?: boolean
  onConfirm: (stopNow: boolean) => void
  onCancel: () => void
}) {
  const titleId = useId()
  const bodyId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { title, body } = turnOffDialogText(channel, agentName)

  useEffect(() => { cancelRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && onCancel()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="bg-white rounded-xl shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <h2 id={titleId} className="text-base font-bold text-gray-900">{title}</h2>
        </div>
        <div id={bodyId} className="px-6 py-4 space-y-2 text-sm text-gray-700">
          {body.map((line) => <p key={line}>{line}</p>)}
        </div>
        <div className="px-6 py-3 border-t border-gray-100 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm font-semibold border border-gray-200 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          {channel.in_flight_messages > 0 && (
            <button
              type="button"
              onClick={() => onConfirm(true)}
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold border border-red-200 text-red-700 rounded-lg disabled:opacity-50"
            >
              Stop sharing and don&apos;t send pending replies
            </button>
          )}
          <button
            type="button"
            onClick={() => onConfirm(false)}
            disabled={busy}
            className="px-4 py-2 text-sm font-bold bg-red-600 text-white rounded-lg disabled:opacity-50"
          >
            {busy ? 'Stopping…' : 'Stop sharing'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

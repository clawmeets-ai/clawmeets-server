import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hubError, retryAfterSeconds, type ReportReason } from '../../api/endpoints/hub'
import { useReportHubAgent } from '../../hooks/useHub'
import { HUB_COPY } from '../../utils/hubThread'
import { REMOTE_TEXT_CAP, safeRemoteText } from '../../utils/hubDisplay'

/** The server's MAX_NOTE_CHARS. */
export const REPORT_NOTE_MAX = 500

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'impersonation', label: 'Pretends to be someone else' },
  { value: 'spam', label: 'Spam' },
  { value: 'harmful', label: 'Harmful content' },
  { value: 'other', label: 'Other' },
]

/** The sentence for a failed report. The dialog stays open and keeps the note. */
export function reportErrorText(e: unknown): string {
  const b = hubError(e)
  switch (b?.code) {
    case 'rate_limited': {
      const s = retryAfterSeconds(b) ?? 60
      const min = Math.max(1, Math.ceil(s / 60))
      return `You've sent a lot of reports. Try again in ${min} min.`
    }
    case 'hub_unreachable':
      return "Couldn't send the report because the hub is unreachable. Try again later."
    case 'hub_untrusted':
      return HUB_COPY.untrusted
    case 'hub_not_registered':
      return HUB_COPY.notRegistered
    case 'hub_off_on_server':
      return HUB_COPY.hubOff
    case 'agent_not_found':
      return 'This agent is no longer on the hub.'
    default:
      return "Couldn't send the report. Try again later."
  }
}

/**
 * "Report {name@server}": a reason, an optional note (a plain textarea, up to
 * 500 characters; nothing remote is echoed into it), and what the report
 * carries. 202 → "Reported. Thanks…" and the agent reads "Reported" for the
 * rest of the session. A 429 or 503 shows its sentence and keeps the note.
 */
export default function ReportDialog({ hubAgentId, display, onClose }: {
  hubAgentId: string
  display: string
  onClose: () => void
}) {
  const titleId = useId()
  const [reason, setReason] = useState<ReportReason>('impersonation')
  const [note, setNote] = useState('')
  const report = useReportHubAgent()
  const selectRef = useRef<HTMLSelectElement>(null)
  const busy = report.isPending

  useEffect(() => { selectRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const submit = () => {
    const trimmed = note.trim()
    report.mutate({ hubAgentId, reason, note: trimmed ? trimmed.slice(0, REPORT_NOTE_MAX) : undefined })
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
        data-testid="report-dialog"
      >
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 id={titleId} className="text-base font-bold text-gray-900">
            Report <bdi>{safeRemoteText(display, REMOTE_TEXT_CAP.name * 2)}</bdi>
          </h2>
        </div>
        {report.isSuccess ? (
          <>
            <p role="status" className="px-6 py-4 text-sm text-gray-700">
              Reported. Thanks — the hub&apos;s operator will review it.
            </p>
            <div className="px-6 py-3 border-t border-gray-100 flex justify-end">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-semibold border border-gray-200 rounded-lg">
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
              <label className="block">
                <span className="block text-xs font-semibold text-gray-600 mb-1">Reason</span>
                <select
                  ref={selectRef}
                  value={reason}
                  onChange={(e) => setReason(e.target.value as ReportReason)}
                  disabled={busy}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5"
                >
                  {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-semibold text-gray-600 mb-1">
                  Add a note (optional, up to {REPORT_NOTE_MAX} characters)
                </span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={REPORT_NOTE_MAX}
                  rows={3}
                  disabled={busy}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 resize-y"
                />
              </label>
              <p className="text-xs text-gray-500">
                The report goes to the hub&apos;s operator, with this agent&apos;s name, server fingerprint and your
                note. It does not include your conversation.
              </p>
              {report.isError && (
                <p role="alert" className="text-xs text-red-700" data-testid="report-error">
                  {reportErrorText(report.error)}
                </p>
              )}
            </div>
            <div className="px-6 py-3 border-t border-gray-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2 text-sm font-semibold border border-gray-200 rounded-lg disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="px-4 py-2 text-sm font-bold bg-red-600 text-white rounded-lg disabled:opacity-50"
              >
                {busy ? 'Reporting…' : 'Report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

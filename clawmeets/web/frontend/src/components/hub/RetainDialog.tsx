import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { hubError } from '../../api/endpoints/hub'
import { accessErrorText, RETAIN_COPY } from '../../utils/agentAccessCopy'
import { HUB_COPY } from '../../utils/hubThread'

/** The sentence for a refused retain, shown inside the dialog. */
export function retainErrorText(e: unknown): string {
  const b = hubError(e)
  const access = accessErrorText(b)
  if (access) return access
  switch (b?.code) {
    case 'own_agent': return RETAIN_COPY.ownAgent
    case 'hub_off_on_server': return HUB_COPY.hubOff
    case 'hub_not_registered': return HUB_COPY.notRegistered
    case 'hub_discover_only': return HUB_COPY.browseOnly
    case 'hub_untrusted': return HUB_COPY.untrusted
    case 'hub_unreachable': return HUB_COPY.unreachable(null)
    default: return RETAIN_COPY.failed
  }
}

/**
 * "Retain {name@server}?" Says, in order: what retaining allows, that the
 * agent's replies are outside content, and that the workroom it joins keeps
 * full powers; plus the identity line for "Retain again". Esc and the
 * backdrop cancel (not while busy); Tab stays inside the dialog. The label is
 * already safe remote text, drawn as text.
 */
export default function RetainDialog({ agentLabel, open, onConfirm, onCancel, busy, error, identityChanged = false }: {
  agentLabel: string
  open: boolean
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
  error: string | null
  identityChanged?: boolean
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
      if (e.key !== 'Tab' || !panel.current) return
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && onCancel()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
        data-testid="retain-dialog"
      >
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 id={titleId} className="text-base font-bold text-gray-900">
            <bdi>{RETAIN_COPY.dialogTitle(agentLabel)}</bdi>
          </h2>
        </div>
        <div className="px-6 py-4 space-y-2 text-sm text-gray-700">
          {identityChanged && (
            <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-900" data-testid="retain-identity">
              {RETAIN_COPY.identityChanged(agentLabel)}
            </p>
          )}
          <ul className="list-disc space-y-1.5 pl-5">
            <li data-testid="retain-allows">{RETAIN_COPY.allows(agentLabel)}</li>
            <li data-testid="retain-outside">{RETAIN_COPY.outside(agentLabel)}</li>
            <li data-testid="retain-full-powers">{RETAIN_COPY.fullPowers}</li>
          </ul>
          {error && <p role="alert" className="text-xs text-red-700" data-testid="retain-error">{error}</p>}
        </div>
        <div className="px-6 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm font-semibold border border-gray-200 rounded-lg disabled:opacity-50"
          >
            {RETAIN_COPY.cancel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg disabled:opacity-50"
          >
            {busy ? RETAIN_COPY.retaining : RETAIN_COPY.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

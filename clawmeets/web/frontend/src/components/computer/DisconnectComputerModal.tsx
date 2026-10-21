import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { WifiOff } from 'lucide-react'

/**
 * "Disconnect <machine>?" — the confirm behind the kill switch.
 *
 * The copy has one job: separate what this DOES from what a user might fear it
 * does. It removes ClawMeets' access to the machine. It does not stop anything
 * running there, and it does not touch any agent's data. Getting that wrong in
 * either direction is bad — a user who thinks it is harmless is surprised when
 * the buttons die, and a user who thinks it kills their agents will never press
 * it even when they should.
 *
 * It is also PERMANENT, and says so before the button rather than after: the
 * machine's key is destroyed, not parked, so coming back needs a fresh pairing
 * code. A confirm dialog that undersells irreversibility is the one place this
 * feature could genuinely trap someone.
 */
export default function DisconnectComputerModal({
  open,
  computerName,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean
  computerName: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
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
        className="rounded-xl shadow-xl w-full max-w-md flex flex-col"
        style={{ background: 'var(--bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-3.5 flex items-center gap-2"
          style={{ borderBottom: '1px solid var(--line-1)' }}
        >
          <WifiOff size={19} style={{ color: 'var(--interrupt)' }} />
          <h2 id={titleId} className="text-[16px] font-extrabold" style={{ color: 'var(--ink-1)' }}>
            Disconnect {computerName}?
          </h2>
        </div>

        <div className="px-5 py-4 space-y-2.5">
          <p className="text-[13.5px]" style={{ color: 'var(--ink-1)' }}>
            ClawMeets will immediately lose all access to this computer.
          </p>
          <ul className="space-y-1.5 text-[13px] list-disc pl-5" style={{ color: 'var(--ink-2)' }}>
            <li>
              Agents already running there <strong>keep running</strong> — nothing
              is stopped and nothing is lost.
            </li>
            <li>You'll no longer be able to start or stop them from the web.</li>
            <li>
              The key this computer uses stops working right away, here and
              everywhere.
            </li>
          </ul>
          <p className="text-[13px]" style={{ color: 'var(--ink-2)' }}>
            To connect it again later you'll run one command on the machine with a
            new code.
          </p>
        </div>

        <div
          className="px-5 py-3 flex items-center justify-end gap-2"
          style={{ borderTop: '1px solid var(--line-1)' }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-bold disabled:opacity-50"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--line-2)',
              color: 'var(--ink-2)',
            }}
          >
            Keep connected
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'var(--interrupt)', border: '1px solid var(--interrupt)' }}
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

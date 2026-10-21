import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { Laptop } from 'lucide-react'
import { useComputerConsent, usePairingCode } from '../../hooks/useComputers'
import CopyCommand from './CopyCommand'
import TrustPanel from './TrustPanel'

/**
 * Connect a computer — the moment permission is actually granted.
 *
 * There is no "added but not yet connected" state to design for, and that is a
 * property of the data model rather than a simplification: the machine's record
 * is created BY its first connection, so a listed-but-unconnected computer
 * cannot exist. This dialog hands out a code; the row appears when the machine
 * uses it.
 *
 * The consent text is the SAME component the machine's page renders, not a
 * paraphrase of it. That is the point — the user agrees to a list here and the
 * page later claims that list is complete, so the two must be one thing.
 *
 * The code is minted on open and never cached: each one is single-use with its
 * own 15-minute clock. Closing and reopening deliberately mints a fresh one
 * rather than showing a stale code that may already have expired.
 */
export default function ConnectComputerModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const titleId = useId()
  const { data: consent } = useComputerConsent()
  const pairing = usePairingCode()
  const { mutate: mint, data: code, isPending, isError, reset } = pairing

  useEffect(() => {
    if (open) mint()
    else reset()
    // `mint` / `reset` are stable mutation methods; re-running on their identity
    // would mint a second code on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="rounded-xl shadow-xl w-full max-w-xl flex flex-col max-h-[90vh]"
        style={{ background: 'var(--bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-3.5 flex items-center gap-2"
          style={{ borderBottom: '1px solid var(--line-1)' }}
        >
          <Laptop size={19} style={{ color: 'var(--accent)' }} />
          <h2 id={titleId} className="text-[16px] font-extrabold" style={{ color: 'var(--ink-1)' }}>
            Connect a computer
          </h2>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          <p className="text-[13.5px]" style={{ color: 'var(--ink-2)' }}>
            Run this on the computer your agents live on. It pairs that machine to
            your account, and the code expires in 15 minutes.
          </p>

          {isPending && (
            <div className="text-[13px]" style={{ color: 'var(--ink-3)' }}>
              Getting you a code…
            </div>
          )}
          {isError && (
            <div
              className="px-3 py-2 rounded-lg text-[13px]"
              style={{
                background: 'var(--interrupt-bg)',
                border: '1px solid var(--interrupt-border)',
                color: 'var(--ink-1)',
              }}
            >
              Couldn't get a code just now. Close this and try again.
            </div>
          )}
          {code && <CopyCommand command={code.command} />}

          {/* The consent text, verbatim and before the user runs anything. The
              terminal line says "on" because that is how a new computer starts. */}
          <TrustPanel consent={consent} terminalEnabled />

          <p className="text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
            The computer appears in the list on the left the moment it connects.
            Nothing is listed before then.
          </p>
        </div>

        <div
          className="px-5 py-3 flex justify-end"
          style={{ borderTop: '1px solid var(--line-1)' }}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-bold"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--line-2)',
              color: 'var(--ink-2)',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

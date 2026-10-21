import { useEffect, useState } from 'react'
import { ArrowUpCircle, Loader2, Package } from 'lucide-react'
import type { Computer } from '../../api/endpoints/computers'
import { useComputerCommand } from '../../hooks/useComputers'
import { isReachable, softwareCardCopy, unreachableReason, updateOutcome } from './computerCopy'

/** An upgrade resolves and downloads two packages and may restart every running
 *  agent; the machine gives each installer five minutes. Past this the button
 *  comes back rather than spinning for the rest of the session. */
const UPDATE_TIMEOUT_MS = 6 * 60_000

/**
 * Which ClawMeets this computer runs, and the one click that updates it.
 *
 * One button for both packages on purpose: the user does not need to know the
 * app and its connection are separate installs, nor which tool installed them.
 * The machine works that out (`clawmeets_daemon/upgrade.py`) and the outcome
 * line says what moved.
 */
export default function SoftwareCard({ computer }: { computer: Computer }) {
  const command = useComputerCommand()
  const copy = softwareCardCopy(computer)
  const reachable = isReachable(computer)
  // The command id this card is waiting on, and when it was sent. Settled when
  // the machine echoes the id on `last_command`.
  const [pending, setPending] = useState<{ id: string | null; sentAt: number } | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  const echoed = computer.last_command?.command_id
  useEffect(() => {
    if (pending?.id && echoed === pending.id) setPending(null)
  }, [echoed, pending])

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(
      () => setPending(null),
      Math.max(0, pending.sentAt + UPDATE_TIMEOUT_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [pending])

  const update = () => {
    setSendError(null)
    setPending({ id: null, sentAt: Date.now() })
    command
      .mutateAsync({ id: computer.id, action: 'update' })
      .then((res) => setPending((p) => (p ? { ...p, id: res.command_id } : p)))
      .catch((err: unknown) => {
        setPending(null)
        setSendError(`Couldn't update. ${err instanceof Error ? err.message : ''}`.trim())
      })
  }

  // Hidden while a new update runs, so the previous result cannot read as this one's.
  const outcome = pending ? null : updateOutcome(computer)

  return (
    <section
      className="rounded-xl overflow-hidden"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--line-2)' }}
    >
      <header
        className="px-4 pt-3.5 pb-2.5 flex items-start justify-between gap-3"
        style={{ borderBottom: '1px solid var(--line-1)' }}
      >
        <div>
          <h2
            className="flex items-center gap-2 text-[15px] font-extrabold"
            style={{ color: 'var(--ink-1)' }}
          >
            <Package size={16} style={{ color: 'var(--accent)' }} />
            ClawMeets software
          </h2>
          <div className="text-[12px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
            {copy.hint}
          </div>
        </div>
        <button
          type="button"
          disabled={!reachable || pending !== null}
          title={unreachableReason(computer)}
          onClick={update}
          aria-busy={pending !== null}
          aria-label="Update ClawMeets on this computer"
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-bold text-white shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
          style={{ background: 'var(--accent)', border: '1px solid var(--accent)' }}
        >
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" /> Updating…
            </>
          ) : (
            <>
              <ArrowUpCircle size={11} /> Update
            </>
          )}
        </button>
      </header>

      {(sendError || outcome) && (
        <div
          className="px-4 py-2.5 text-[12.5px]"
          style={
            sendError || !outcome?.ok
              ? {
                  background: 'var(--interrupt-bg)',
                  borderBottom: '1px solid var(--interrupt-border)',
                  color: 'var(--ink-1)',
                }
              : {
                  background: 'var(--accent-softer)',
                  borderBottom: '1px solid var(--accent-soft)',
                  color: 'var(--ink-1)',
                }
          }
          role={sendError || !outcome?.ok ? 'alert' : 'status'}
        >
          {sendError ?? outcome?.line}
        </div>
      )}

      <dl className="px-4 py-2.5 space-y-1">
        {copy.rows.map((row) => (
          <div key={row.pkg} className="flex items-center justify-between text-[12.5px]">
            <dt style={{ color: 'var(--ink-2)' }}>
              {row.label}{' '}
              <code className="text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
                {row.pkg}
              </code>
            </dt>
            <dd className="font-mono" style={{ color: row.reported ? 'var(--ink-1)' : 'var(--ink-3)' }}>
              {row.version}
            </dd>
          </div>
        ))}
      </dl>
      {copy.staleNote && (
        <div className="px-4 pb-3 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
          {copy.staleNote}
        </div>
      )}
    </section>
  )
}

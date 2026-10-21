import { Suspense, lazy, useState } from 'react'
import { Loader2, SquareTerminal } from 'lucide-react'
import { createTerminalTicket, type Computer } from '../../api/endpoints/computers'
import CopyCommand from './CopyCommand'
import {
  TERMINAL_DISABLE_COMMAND,
  TERMINAL_ENABLE_COMMAND,
  terminalCardCopy,
} from './computerCopy'

// Split out so xterm and its CSS are fetched only when a terminal is opened.
const loadPanel = () => import('./TerminalPanel')
const TerminalPanel = lazy(loadPanel)

/** The size the ticket asks for. A guess — the panel sends the fitted size as
 *  soon as the session opens. */
const INITIAL_SIZE = { cols: 100, rows: 30 }

/**
 * The terminal, on the Computer page: whether it is available, and the session.
 *
 * Four states, each with its own one line (`terminalCardCopy`): the computer
 * is not reachable, its software predates the terminal, it was turned off on
 * the machine, or it is on. Only "on" has a button. "Off" offers the command
 * that turns it back on, typed on the machine — deliberately not a toggle here.
 *
 * Opening asks the server for a single-use ticket first, so a refusal (the
 * computer dropped off, too many sessions) is shown here, in the server's own
 * words, before any terminal is drawn.
 */
export default function TerminalCard({ computer }: { computer: Computer }) {
  const copy = terminalCardCopy(computer)
  const [ticket, setTicket] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async () => {
    setOpening(true)
    setError(null)
    try {
      // The chunk loads while the ticket is minted; its 60-second clock should
      // not be spent waiting on a download.
      const [res] = await Promise.all([createTerminalTicket(computer.id, INITIAL_SIZE), loadPanel()])
      setTicket(res.ticket)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't open a terminal just now.")
    } finally {
      setOpening(false)
    }
  }

  return (
    // No `overflow-hidden`: it would stop the session's red bar sticking to
    // the top of the page while the user scrolls.
    <section
      className="rounded-xl"
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
            <SquareTerminal size={16} style={{ color: 'var(--accent)' }} />
            Terminal
          </h2>
          <div className="text-[12px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
            {copy.line}
          </div>
        </div>
        {!ticket && (copy.availability === 'on' || copy.availability === 'unreachable') && (
          <button
            type="button"
            disabled={copy.availability !== 'on' || opening}
            onClick={open}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-bold text-white shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent)', border: '1px solid var(--accent)' }}
          >
            {opening ? <Loader2 size={11} className="animate-spin" /> : <SquareTerminal size={11} />}
            Open terminal
          </button>
        )}
      </header>

      {error && (
        <div
          className="px-4 py-2.5 text-[12.5px]"
          style={{ background: 'var(--interrupt-bg)', borderBottom: '1px solid var(--interrupt-border)', color: 'var(--ink-1)' }}
          role="alert"
        >
          {error}
        </div>
      )}

      {ticket ? (
        <div className="rounded-b-xl overflow-clip">
          <Suspense
            fallback={
              <div className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
                Loading the terminal…
              </div>
            }
          >
            <TerminalPanel
              computerId={computer.id}
              computerName={computer.name}
              ticket={ticket}
              onClose={() => setTicket(null)}
            />
          </Suspense>
        </div>
      ) : copy.availability === 'off' ? (
        <div className="px-4 py-3">
          <CopyCommand label="Turn it on, on this computer" command={TERMINAL_ENABLE_COMMAND} />
        </div>
      ) : copy.availability === 'on' ? (
        <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--ink-3)' }}>
          A full shell, as you. To turn it off, run{' '}
          <code className="font-mono text-[11.5px]" style={{ color: 'var(--ink-1)' }}>
            {TERMINAL_DISABLE_COMMAND}
          </code>{' '}
          on this computer. Sessions end after 15 minutes idle.
        </div>
      ) : null}
    </section>
  )
}

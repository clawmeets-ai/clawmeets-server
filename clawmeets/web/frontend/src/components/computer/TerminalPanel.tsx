import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { SquareTerminal, X } from 'lucide-react'
import {
  AckAccumulator,
  RESIZE_DEBOUNCE_MS,
  type TerminalClientFrame,
  base64ToBytes,
  binaryInputFrames,
  parseServerFrame,
  terminalSocketUrl,
  textInputFrames,
} from './terminalProtocol'
import { terminalActiveLine, terminalDropReason } from './computerCopy'

type Phase =
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'ended'; reason: string }

/**
 * One live terminal session on one computer: xterm, its socket, and the red bar.
 *
 * Loaded with `React.lazy` from `TerminalCard`, so xterm and its stylesheet are
 * fetched only by someone who actually opens a terminal — never by the main
 * bundle every page load pays for.
 *
 * The session is one socket, opened once. There is NO reconnect: the ticket is
 * single-use, and a shell that silently re-attached after a drop would be a
 * different shell pretending to be the old one. A dropped session is over, and
 * the panel says so.
 *
 * The red bar is persistent for as long as the socket is up, because this is
 * a full shell as the user on their own machine; forgetting one is open in a
 * background tab is the failure the bar exists to prevent.
 */
export default function TerminalPanel({
  computerId,
  computerName,
  ticket,
  onClose,
}: {
  computerId: string
  computerName: string
  /** Single-use, from `createTerminalTicket`. Changing it opens a new session. */
  ticket: string
  /** Back to the idle card: after End session, or Close once it has ended. */
  onClose: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const endSessionRef = useRef<() => void>(() => {})
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#16131d', foreground: '#ece8f3', cursor: '#ece8f3' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    const refit = () => {
      // Throws when the container is momentarily 0x0 (a collapsing layout);
      // the next observation fits it.
      try {
        fit.fit()
      } catch {
        /* next resize will fit */
      }
    }
    refit()

    const ws = new WebSocket(terminalSocketUrl(computerId))
    let ended = false
    const send = (frame: TerminalClientFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
    }
    const acks = new AckAccumulator((bytes) => send({ type: 'term_ack', bytes }))
    const end = (reason: string) => {
      if (ended) return
      ended = true
      acks.dispose()
      term.options.disableStdin = true
      setPhase({ kind: 'ended', reason })
    }

    // The ticket goes in the first frame, not the URL, so it never lands in a
    // proxy's access log. Sent on open rather than at construction: under
    // StrictMode's mount-unmount-mount the first socket is closed before it
    // opens, and the ticket is still unspent for the second.
    ws.onopen = () => ws.send(JSON.stringify({ ticket }))
    ws.onmessage = (event) => {
      const frame = parseServerFrame(event.data)
      if (!frame || ended) return
      switch (frame.type) {
        case 'term_opened':
          if (!frame.ok) {
            end(frame.detail || 'This computer would not open a terminal.')
            ws.close()
            return
          }
          setPhase({ kind: 'open' })
          // The ticket carried a guess at the size; this is the real one.
          send({ type: 'term_resize', cols: term.cols, rows: term.rows })
          term.focus()
          return
        case 'term_output': {
          const bytes = base64ToBytes(frame.data_b64)
          // Credit is returned only once xterm has parsed the bytes, so a slow
          // tab applies back-pressure to the machine instead of buffering
          // without bound.
          term.write(bytes, () => acks.add(bytes.length))
          return
        }
        case 'term_exit':
          end(frame.reason || 'The session ended.')
          ws.close()
          return
      }
    }
    ws.onclose = (event) => end(terminalDropReason(event.code))

    const dataSub = term.onData((data) => {
      if (!ended) textInputFrames(data).forEach(send)
    })
    const binarySub = term.onBinary((data) => {
      if (!ended) binaryInputFrames(data).forEach(send)
    })
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const resizeSub = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => send({ type: 'term_resize', cols, rows }), RESIZE_DEBOUNCE_MS)
    })
    const observer = new ResizeObserver(refit)
    observer.observe(container)

    const close = () => {
      if (!ended) send({ type: 'term_close' })
      ended = true
      ws.onclose = null
      ws.close()
    }
    endSessionRef.current = close

    return () => {
      observer.disconnect()
      clearTimeout(resizeTimer)
      dataSub.dispose()
      binarySub.dispose()
      resizeSub.dispose()
      acks.dispose()
      // Leaving the page ends the session: a shell nobody can see is exactly
      // the thing the red bar exists to prevent.
      close()
      term.dispose()
    }
  }, [computerId, ticket])

  const live = phase.kind !== 'ended'

  return (
    <div>
      {live ? (
        <div
          className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-2"
          style={{ background: 'var(--interrupt)', color: '#fff' }}
          role="status"
        >
          <span className="flex items-center gap-2 text-[12.5px] font-bold">
            <SquareTerminal size={14} />
            {terminalActiveLine(computerName)}
            {phase.kind === 'connecting' && (
              <span className="font-semibold opacity-80">· connecting…</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              endSessionRef.current()
              onClose()
            }}
            className="px-2.5 py-1 rounded-md text-[11.5px] font-bold shrink-0"
            style={{ background: '#fff', color: 'var(--interrupt)' }}
          >
            End session
          </button>
        </div>
      ) : (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2 text-[12.5px]"
          style={{
            background: 'var(--interrupt-bg)',
            borderBottom: '1px solid var(--interrupt-border)',
            color: 'var(--ink-1)',
          }}
          role="status"
        >
          <span>
            <strong>Session ended.</strong> {phase.reason}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-bold shrink-0"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--line-2)', color: 'var(--ink-2)' }}
          >
            <X size={12} /> Close
          </button>
        </div>
      )}
      {/* The terminal stays visible after the end, so its last lines — often
          the reason it ended — can still be read. */}
      <div className="p-2" style={{ background: '#16131d' }}>
        <div ref={containerRef} style={{ height: '60vh', minHeight: 260 }} />
      </div>
    </div>
  )
}

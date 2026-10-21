import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Info,
  Laptop,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Terminal,
  Unplug,
} from 'lucide-react'
import {
  useComputer,
  useComputerCommand,
  useComputerConsent,
  useComputers,
  useDisconnectComputer,
  useRenameComputer,
} from '../../hooks/useComputers'
import type { Computer, ComputerAgent } from '../../api/endpoints/computers'
import Avatar from '../common/Avatar'
import AgentNameLink from '../agent/AgentNameLink'
import Loading from '../common/Loading'
import ConnectComputerModal from './ConnectComputerModal'
import CopyCommand from './CopyCommand'
import DisconnectComputerModal from './DisconnectComputerModal'
import TrustPanel from './TrustPanel'
import TerminalCard from './TerminalCard'
import SoftwareCard from './SoftwareCard'
import {
  type AgentAction,
  agentStateTone,
  bannerFor,
  inFlightLabel,
  isReachable,
  lastSeenLine,
  machineMeta,
  manualSection,
  startingSummary,
  statusPill,
  unreachableReason,
} from './computerCopy'
import { COMPUTER_SECTIONS, type ComputerSectionId, parseComputerSection } from './sections'

/**
 * One computer's page: is it up, what is running on it, and what can be done.
 *
 * Laid out like Agent Settings: a header, then a left-hand section list that
 * shows ONE section at a time (`?section=<id>`, default Agents).
 *
 * 1. **Name and state**, so the first line answers the question the user came
 *    with. The ⓘ beside the name folds out "What this connection can do" — the
 *    same pattern as My Desk's title, so the trust copy is one click away from
 *    the machine's name without pushing every control down the page.
 * 2. **The situational banner**, which names WHICH kind of quiet this is. Three
 *    states that used to be one silence, with three different remedies.
 * 3. **The sections**: agents with their actions, the ClawMeets software, the
 *    terminal, and the typeable equivalents. When the machine can't be reached
 *    the typeable equivalents are the remedy, so they leave the list and sit
 *    under the banner instead.
 * 4. **Disconnect** stays visible under the section list on every section — a
 *    kill switch the user has to unfold something to find is not one they can
 *    rely on.
 *
 * There is deliberately NO per-machine activity log. Live state plus the reason
 * a failed command failed is what the page needs to be trusted; a durable
 * command history on top of that was cut as redundant with it.
 */
export default function ComputerPage() {
  const { computerId } = useParams<{ computerId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const section = parseComputerSection(searchParams.get('section'))
  const navRefs = useRef<Partial<Record<ComputerSectionId, HTMLButtonElement | null>>>({})
  const [trustOpen, setTrustOpen] = useState(false)
  const { data: computers, isLoading: listLoading } = useComputers()
  const { computer } = useComputer(computerId)
  const { data: consent } = useComputerConsent()
  const [connectOpen, setConnectOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const disconnect = useDisconnectComputer()

  // With no id in the URL, open the user's first computer — the same
  // "click the tab, land on something" behaviour every other rail context has.
  // `replace` so Back does not bounce through the bare /computers URL.
  const firstId = computers?.[0]?.id
  useEffect(() => {
    if (!computerId && firstId) navigate(`/computers/${firstId}`, { replace: true })
  }, [computerId, firstId, navigate])

  if (listLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading size="md" />
      </div>
    )
  }

  if (!computers || computers.length === 0) {
    return (
      <>
        <EmptyComputers onConnect={() => setConnectOpen(true)} />
        <ConnectComputerModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      </>
    )
  }

  if (!computer) {
    // An id that is not one of this user's machines. Not found and not yours are
    // the same answer here because they are the same answer from the server.
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <h2 className="text-[16px] font-extrabold" style={{ color: 'var(--ink-1)' }}>
            That computer isn't in your list
          </h2>
          <p className="text-[13px] mt-1" style={{ color: 'var(--ink-3)' }}>
            It may have been disconnected. Pick one from the list on the left.
          </p>
        </div>
      </div>
    )
  }

  const banner = bannerFor(computer)
  const manual = manualSection(computer)
  // Unreachable: the typeable commands are the only fix, so they are promoted
  // under the banner rather than left behind a nav item.
  const manualPromoted = !isReachable(computer)
  const sections = COMPUTER_SECTIONS.filter((s) => !(manualPromoted && s.id === 'manual'))
  const active = sections.some((s) => s.id === section) ? section : 'agents'

  const selectSection = (id: ComputerSectionId) => {
    // replace: flipping between sections shouldn't fill the Back stack.
    // Other params (the `?agent=` deep link) are kept.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (id === 'agents') next.delete('section')
        else next.set('section', id)
        return next
      },
      { replace: true },
    )
  }

  // Vertical tablist keyboard support: ↑/↓ move, Home/End jump.
  const onNavKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const i = sections.findIndex((s) => s.id === active)
    const last = sections.length - 1
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight' ? Math.min(i + 1, last)
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? Math.max(i - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    const id = sections[next].id
    selectSection(id)
    navRefs.current[id]?.focus()
  }

  const manualCard = (
    <section
      className="rounded-xl overflow-hidden"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--line-2)' }}
    >
      <header className="px-4 pt-3.5 pb-2.5" style={{ borderBottom: '1px solid var(--line-1)' }}>
        <h2
          className="flex items-center gap-2 text-[15px] font-extrabold"
          style={{ color: 'var(--ink-1)' }}
        >
          <Terminal size={16} style={{ color: 'var(--accent)' }} />
          {manual.title}
        </h2>
        <div className="text-[12px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
          {manual.hint}
        </div>
      </header>
      <div className="px-4 py-3 space-y-3">
        {manual.steps.map((step) => (
          <CopyCommand key={step.command} label={step.label} command={step.command} />
        ))}
      </div>
    </section>
  )

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-24">
        <header className="mb-6">
          <ComputerHeader
            computer={computer}
            trustOpen={trustOpen}
            onToggleTrust={() => setTrustOpen((o) => !o)}
          />
          {trustOpen && (
            <div id="computer-trust-panel" className="mt-4">
              <TrustPanel consent={consent} terminalEnabled={computer.terminal_enabled ?? null} />
            </div>
          )}
        </header>

        {banner && (
          <div
            className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl mb-4"
            style={
              banner.tone === 'warn'
                ? {
                    background: 'var(--interrupt-bg)',
                    border: '1px solid var(--interrupt-border)',
                  }
                : { background: 'var(--accent-softer)', border: '1px solid var(--accent-soft)' }
            }
            role="status"
          >
            {banner.tone === 'warn' ? (
              <AlertTriangle size={17} className="mt-[2px] shrink-0" style={{ color: 'var(--interrupt)' }} />
            ) : (
              <Info size={17} className="mt-[2px] shrink-0" style={{ color: 'var(--accent)' }} />
            )}
            <div className="text-[13px]" style={{ color: 'var(--ink-1)' }}>
              <strong>{banner.title}</strong> {banner.body}
            </div>
          </div>
        )}

        {manualPromoted && <div className="mb-6">{manualCard}</div>}

        <div className="flex flex-col md:flex-row md:items-start gap-6">
          {/* Section list — a vertical rail on desktop, a scrollable pill row on small screens. */}
          <div className="md:w-48 md:shrink-0 md:sticky md:top-6">
            <nav
              role="tablist"
              aria-label="Computer sections"
              aria-orientation="vertical"
              onKeyDown={onNavKeyDown}
              className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mx-1 px-1 pb-1 md:pb-0"
            >
              {sections.map(({ id, label, icon: Icon }) => {
                const selected = id === active
                return (
                  <button
                    key={id}
                    ref={(el) => {
                      navRefs.current[id] = el
                    }}
                    type="button"
                    role="tab"
                    id={`computer-tab-${id}`}
                    aria-selected={selected}
                    aria-controls="computer-panel"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => selectSection(id)}
                    className={`shrink-0 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-left whitespace-nowrap transition-colors ${
                      selected ? 'bg-purple-50 text-purple-800 font-bold' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${selected ? 'text-purple-600' : 'text-gray-400'}`} />
                    <span className="flex-1">{label}</span>
                    {id === 'agents' && (
                      <span className="text-[11px] font-semibold text-gray-400">
                        {computer.running_count}/{computer.agent_count}
                      </span>
                    )}
                  </button>
                )
              })}
            </nav>
            <button
              type="button"
              onClick={() => setDisconnectOpen(true)}
              className="mt-3 md:mt-4 w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-left font-semibold"
              style={{ color: 'var(--interrupt)', borderTop: '1px solid var(--line-1)' }}
              title="Destroys this computer's key. Nothing here can reach it again until you connect it with a new code."
            >
              <Unplug className="w-4 h-4" />
              Disconnect
            </button>
          </div>

          <section
            role="tabpanel"
            id="computer-panel"
            aria-labelledby={`computer-tab-${active}`}
            className="flex-1 min-w-0"
          >
            {active === 'agents' && (
              <AgentsCard key={computer.id} computer={computer} />
            )}
            {active === 'software' && (
              <SoftwareCard key={`software-${computer.id}`} computer={computer} />
            )}
            {/* Keyed so switching to another computer ends this one's session. */}
            {active === 'terminal' && (
              <TerminalCard key={`terminal-${computer.id}`} computer={computer} />
            )}
            {active === 'manual' && manualCard}
          </section>
        </div>
      </div>

      <DisconnectComputerModal
        open={disconnectOpen}
        computerName={computer.name}
        busy={disconnect.isPending}
        onConfirm={() => {
          disconnect.mutate(computer.id, { onSettled: () => setDisconnectOpen(false) })
        }}
        onCancel={() => setDisconnectOpen(false)}
      />
      <ConnectComputerModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  )
}

/** Name (renameable) with its ⓘ, state pill, last check-in, and the quiet machine line. */
function ComputerHeader({
  computer,
  trustOpen,
  onToggleTrust,
}: {
  computer: Computer
  trustOpen: boolean
  onToggleTrust: () => void
}) {
  const pill = statusPill(computer.status)
  const rename = useRenameComputer()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(computer.name)

  // Re-seed the draft whenever the persisted name changes — including when a
  // rename lands from another of the user's tabs. The input is transient state;
  // the cache is the truth.
  useEffect(() => setDraft(computer.name), [computer.name])

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (!next || next === computer.name) {
      setDraft(computer.name)
      return
    }
    rename.mutate({ id: computer.id, name: next })
  }

  return (
    <div className="flex items-start gap-3">
      <div
        className="shrink-0 grid place-items-center rounded-xl"
        style={{
          width: 44,
          height: 44,
          background: 'var(--accent-softer)',
          color: 'var(--accent-deep)',
          border: '1px solid var(--accent-soft)',
        }}
      >
        <Laptop size={22} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {editing ? (
            <input
              autoFocus
              value={draft}
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                // Esc abandons the edit rather than saving it — the standard
                // rename contract elsewhere in the app.
                if (e.key === 'Escape') {
                  setDraft(computer.name)
                  setEditing(false)
                }
              }}
              aria-label="Rename this computer"
              className="text-[20px] font-extrabold px-1 -mx-1 rounded"
              style={{
                color: 'var(--ink-1)',
                background: 'var(--bg-rail)',
                border: '1px solid var(--line-2)',
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Rename this computer"
              className="group flex items-center gap-1.5 text-[20px] font-extrabold text-left truncate"
              style={{ color: 'var(--ink-1)' }}
            >
              <span className="truncate">{computer.name}</span>
              <Pencil size={14} className="opacity-0 group-hover:opacity-60 shrink-0" />
            </button>
          )}
          <button
            type="button"
            onClick={onToggleTrust}
            aria-expanded={trustOpen}
            aria-controls="computer-trust-panel"
            aria-label={trustOpen ? 'Hide what this connection can do' : 'What this connection can do'}
            title={trustOpen ? 'Hide what this connection can do' : 'What this connection can do'}
            className="shrink-0 grid place-items-center rounded-full"
            style={{
              width: 24,
              height: 24,
              color: trustOpen ? 'var(--accent-deep)' : 'var(--ink-4)',
              background: trustOpen ? 'var(--accent-softer)' : 'transparent',
            }}
          >
            <Info size={15} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px] font-bold"
            style={{ background: pill.bg, color: pill.fg }}
          >
            <span className="rounded-full" style={{ width: 7, height: 7, background: pill.dot }} />
            {pill.label}
          </span>
          <span className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            {lastSeenLine(computer)}
          </span>
        </div>
        {machineMeta(computer) && (
          <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            {machineMeta(computer)}
          </div>
        )}
      </div>
    </div>
  )
}

/** A command a row has sent and is still waiting on the machine to answer. */
interface InFlight {
  action: AgentAction
  /** Filled in when the route answers; the machine echoes it back on
   *  `last_command` when this exact command has finished. */
  commandId: string | null
  /** The pid when the button was pressed — a restart is done once the agent is
   *  running under a DIFFERENT one. */
  pidAtClick: number | null
  sentAt: number
}

/** Long enough for the slowest honest case (a start resolving a Python
 *  environment behind a queue of other starts); short enough that a lost answer
 *  does not leave a button dead for the rest of the session. */
const IN_FLIGHT_TIMEOUT_MS = 120_000

/**
 * Has the machine answered this row's command?
 *
 * The primary signal is the echoed `command_id`. The roster checks exist
 * because `last_command` is a single slot: "Start 3 stopped" sends three
 * commands, and when their answers land close together one refetch can skip
 * over an id — but the roster it brings back still shows that agent running.
 */
function isSettled(p: InFlight, agent: ComputerAgent | undefined, computer: Computer, now: number) {
  if (!isReachable(computer)) return true
  if (!agent) return true
  if (p.commandId && computer.last_command?.command_id === p.commandId) return true
  if (now - p.sentAt > IN_FLIGHT_TIMEOUT_MS) return true
  switch (p.action) {
    case 'start':
      return agent.state === 'running'
    case 'stop':
      return agent.state !== 'running'
    case 'restart':
      return agent.state === 'running' && agent.pid !== null && agent.pid !== p.pidAtClick
  }
}

/** One row per agent on the machine, with the actions that reach it. */
function AgentsCard({ computer }: { computer: Computer }) {
  const command = useComputerCommand()
  const reachable = isReachable(computer)
  const reason = unreachableReason(computer)
  const last = computer.last_command
  // Per agent, not one flag for the page: the old `command.isPending` covered
  // only the HTTP round trip (the route returns as soon as the command is SENT),
  // so a button re-enabled while the machine was still stopping the agent — and
  // one click froze every other row for that moment too.
  const [inFlight, setInFlight] = useState<Record<string, InFlight>>({})
  // A command the route refused (409: the machine dropped off between render
  // and click). Nothing was sent, so there will be no `last_command` to explain
  // it — this is the only place that failure can surface.
  const [sendError, setSendError] = useState<string | null>(null)

  // Release every row whose command the machine has answered. Runs on each
  // fresh roster (HOST_SYNC → refetch) and whenever a command id arrives.
  useEffect(() => {
    const now = Date.now()
    setInFlight((prev) => {
      const next: Record<string, InFlight> = {}
      let changed = false
      for (const [name, p] of Object.entries(prev)) {
        const agent = computer.agents.find((a) => a.short_name === name)
        if (isSettled(p, agent, computer, now)) changed = true
        else next[name] = p
      }
      return changed ? next : prev
    })
  }, [computer, inFlight])

  // The timeout above only fires if something re-renders; this guarantees it.
  useEffect(() => {
    const pending = Object.values(inFlight)
    if (pending.length === 0) return
    const oldest = Math.min(...pending.map((p) => p.sentAt))
    const timer = setTimeout(
      () => setInFlight((prev) => ({ ...prev })),
      Math.max(0, oldest + IN_FLIGHT_TIMEOUT_MS - Date.now()) + 50,
    )
    return () => clearTimeout(timer)
  }, [inFlight])

  const send = (agent: ComputerAgent, action: AgentAction) => {
    const name = agent.short_name
    setSendError(null)
    setInFlight((prev) => ({
      ...prev,
      [name]: { action, commandId: null, pidAtClick: agent.pid, sentAt: Date.now() },
    }))
    command
      .mutateAsync({ id: computer.id, action, agent: name })
      .then((res) => {
        setInFlight((prev) =>
          prev[name] ? { ...prev, [name]: { ...prev[name], commandId: res.command_id } } : prev,
        )
      })
      .catch((err: unknown) => {
        setInFlight((prev) => {
          const { [name]: _dropped, ...rest } = prev
          return rest
        })
        const detail = err instanceof Error ? err.message : ''
        setSendError(`Couldn't ${action} ${name}. ${detail}`.trim())
      })
  }

  // Everything not currently up — stopped by the user AND stopped on its own.
  // Both want the same button, which is why "Stopped on its own" is a label
  // difference rather than a sixth command.
  const idle = computer.agents.filter((a) => a.state !== 'running')
  // Split by whether a start is already on its way, so a second click cannot
  // send a duplicate and the button can say what it is waiting for.
  const startable = idle.filter((a) => !inFlight[a.short_name])
  const starting = idle.filter((a) => inFlight[a.short_name]?.action === 'start')

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
          <h2 className="text-[15px] font-extrabold" style={{ color: 'var(--ink-1)' }}>
            Agents on this computer
          </h2>
          <div className="text-[12px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
            {/* "Last known" when unreachable: the roster is the machine's last
                report, and claiming live knowledge of a computer we cannot reach
                is the specific dishonesty this page exists to end. */}
            {reachable
              ? `${computer.running_count} of ${computer.agent_count} running`
              : `Last known: ${computer.running_count} of ${computer.agent_count} running`}
          </div>
        </div>
        {/* The one-click answer to the banner above it. Hidden rather than
            disabled when everything is already up: a permanently greyed button
            on a healthy machine is noise, and the state it serves ("on, nothing
            running") is the whole reason this page exists. */}
        {startable.length > 0 ? (
          <button
            type="button"
            disabled={!reachable}
            title={reason}
            onClick={() => {
              // N separate commands, because the allowlist has five verbs and
              // "start everything" is not one of them. Widening the protocol to
              // make one button tidier would widen what the server can ask a
              // machine to do, which is the opposite of the trade this feature
              // makes.
              for (const agent of startable) send(agent, 'start')
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-bold text-white shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent)', border: '1px solid var(--accent)' }}
          >
            <Play size={11} />
            {startable.length === computer.agent_count
              ? 'Start all'
              : `Start ${startable.length} stopped`}
          </button>
        ) : starting.length > 0 ? (
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-bold text-white shrink-0 opacity-70 cursor-wait"
            style={{ background: 'var(--accent)', border: '1px solid var(--accent)' }}
          >
            <Loader2 size={11} className="animate-spin" />
            {startingSummary(starting.length)}
          </button>
        ) : null}
      </header>

      {sendError && (
        <div
          className="px-4 py-2.5 text-[12.5px]"
          style={{ background: 'var(--interrupt-bg)', borderBottom: '1px solid var(--interrupt-border)', color: 'var(--ink-1)' }}
          role="alert"
        >
          {sendError}
        </div>
      )}

      {/* The outcome of the last command, and ONLY when it failed. A success is
          already visible in the rows below; a failure otherwise leaves a button
          that looks like it did nothing. */}
      {/* Update failures are shown on the software card instead. */}
      {last && !last.ok && last.action !== 'update' && (
        <div
          className="px-4 py-2.5 text-[12.5px]"
          style={{ background: 'var(--interrupt-bg)', borderBottom: '1px solid var(--interrupt-border)', color: 'var(--ink-1)' }}
        >
          <strong>
            Couldn't {last.action}
            {last.agent ? ` ${last.agent}` : ''}.
          </strong>{' '}
          {last.detail}
        </div>
      )}

      {computer.agents.length === 0 ? (
        <div className="px-4 py-5 text-[13px]" style={{ color: 'var(--ink-3)' }}>
          No agents are set up on this computer yet. Register one, then start it
          here.
        </div>
      ) : (
        <div>
          {computer.agents.map((agent) => (
            <AgentRow
              key={agent.short_name}
              agent={agent}
              reachable={reachable}
              reason={reason}
              inFlight={inFlight[agent.short_name]?.action ?? null}
              onAction={(action) => send(agent, action)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function AgentRow({
  agent,
  reachable,
  reason,
  inFlight,
  onAction,
}: {
  agent: ComputerAgent
  reachable: boolean
  reason: string
  /** The command this row is waiting on, if any. */
  inFlight: AgentAction | null
  onAction: (action: AgentAction) => void
}) {
  const tone = agentStateTone(agent.state)
  const running = agent.state === 'running'

  const buttonStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--line-2)',
    color: 'var(--ink-2)',
  }
  const buttonClass =
    'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-bold disabled:opacity-45 disabled:cursor-not-allowed'

  return (
    <div
      id={`agent-${agent.short_name}`}
      className="flex items-center gap-3 px-4 py-2.5"
      style={{ borderTop: '1px solid var(--line-1)' }}
    >
      <Avatar name={agent.short_name} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <AgentNameLink agentName={agent.name} className="text-[13.5px] font-bold truncate">
            <span style={{ color: 'var(--ink-1)' }}>{agent.short_name}</span>
          </AgentNameLink>
          <span
            className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-full text-[10.5px] font-bold shrink-0"
            style={{ background: tone.bg, color: tone.fg }}
          >
            <span className="rounded-full" style={{ width: 6, height: 6, background: tone.dot }} />
            {tone.label}
          </span>
        </div>
        {agent.pid !== null && (
          <div className="text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
            Running as {agent.pid}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {inFlight ? (
          // One disabled button naming the request, until the machine answers.
          // The status pill beside it stays the machine's last word: it changes
          // when the machine says so, not when we asked.
          <button
            type="button"
            disabled
            aria-busy="true"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-bold cursor-wait"
            style={{ ...buttonStyle, color: 'var(--ink-3)' }}
          >
            <Loader2 size={12} className="animate-spin" /> {inFlightLabel(inFlight)}
          </button>
        ) : running ? (
          <>
            <button
              type="button"
              disabled={!reachable}
              title={reason}
              onClick={() => onAction('restart')}
              className={buttonClass}
              style={buttonStyle}
            >
              <RotateCcw size={12} /> Restart
            </button>
            <button
              type="button"
              disabled={!reachable}
              title={reason}
              onClick={() => onAction('stop')}
              className={buttonClass}
              style={buttonStyle}
            >
              <Square size={11} /> Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!reachable}
            title={reason}
            onClick={() => onAction('start')}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-bold text-white disabled:opacity-45 disabled:cursor-not-allowed"
            style={{ background: 'var(--accent)', border: '1px solid var(--accent)' }}
          >
            <Play size={11} /> Start
          </button>
        )}
      </div>
    </div>
  )
}

/** A brand-new account, which still has to land somewhere. */
function EmptyComputers({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-10">
      <div className="text-center max-w-md">
        <div
          className="mx-auto grid place-items-center rounded-2xl mb-3"
          style={{
            width: 52,
            height: 52,
            background: 'var(--accent-softer)',
            color: 'var(--accent-deep)',
            border: '1px solid var(--accent-soft)',
          }}
        >
          <Laptop size={26} strokeWidth={1.7} />
        </div>
        <h2 className="text-[17px] font-extrabold" style={{ color: 'var(--ink-1)' }}>
          No computers connected yet
        </h2>
        <p className="text-[13px] mt-1.5" style={{ color: 'var(--ink-2)' }}>
          Connect the computer your agents live on and this page will show you
          what's running there — and let you start or stop it — without opening a
          terminal again. It takes one command and a few seconds.
        </p>
        <button
          type="button"
          onClick={onConnect}
          className="mt-4 px-3.5 py-2 rounded-lg text-[12.5px] font-bold text-white"
          style={{ background: 'var(--accent)', border: '1px solid var(--accent)' }}
        >
          Connect a computer
        </button>
      </div>
    </div>
  )
}

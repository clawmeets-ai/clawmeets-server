import { del, get, patch, post } from '../client'

/** One agent as the MACHINE sees it, not as the server remembers it.
 *
 *  `crashed` is the state that earns its own word in the UI ("Stopped on its
 *  own"): the machine started this agent and found its process gone without
 *  being asked to stop it. That is a genuinely different fact from a stop the
 *  user performed, and collapsing the two is how a crash goes unnoticed. */
export type AgentRunState = 'running' | 'crashed' | 'stopped'

export interface ComputerAgent {
  short_name: string
  name: string
  state: AgentRunState
  pid: number | null
}

/** A machine's state, decided server-side in `models/host.derive_status` so the
 *  page, the list row and any future reader cannot disagree about what "off"
 *  means.
 *
 *  - `online`         — a live socket right now.
 *  - `not_answering`  — no socket, but it checked in within the last 15 minutes.
 *                       Awake, contact lost; the remedy is a command ON the
 *                       machine, and the buttons here cannot reach it.
 *  - `off`            — no socket and no recent check-in. The remedy is to open
 *                       the computer.
 *  - `revoked`        — the user disconnected it. Only ever seen on the
 *                       response to `disconnectComputer`: the list drops the
 *                       machine from then on.
 *
 *  `online` with `running_count === 0` is the state this whole feature exists
 *  for, and it is NOT a separate status: it is the combination that used to be
 *  indistinguishable from `off`. */
export type ComputerStatus = 'online' | 'not_answering' | 'off' | 'revoked'

/** One model CLI as the MACHINE found it — the only witness there is.
 *
 *  Whether a `claude` / `codex` / `agy` binary exists on someone's laptop and is
 *  signed in cannot be seen from here: the credential lives in an OS keychain or
 *  a dotfile on that machine. So the machine probes and reports, and this is what
 *  it said. `logged_in` is its best-effort reading (see `clawmeets/doctor.py` on
 *  why that is a heuristic). */
export interface ComputerModelCli {
  id: string
  label: string
  binary: string
  present: boolean
  logged_in: boolean
  version: string
}

export interface Computer {
  id: string
  owner_user_id: string
  name: string
  hostname: string
  platform: string
  os_version: string
  created_at: string
  last_seen_at: string
  revoked_at: string | null
  daemon_version: string | null
  /** The installed `clawmeets` version, as the machine reported it. `null` /
   *  missing when it has not said — an older connection cannot. */
  runner_version?: string | null
  agents: ComputerAgent[]
  agents_reported_at: string
  /** Outcome of the MOST RECENT command only — a single slot, not a log. It
   *  exists so a failed "Start" can say why instead of leaving a button that
   *  appears to have done nothing. */
  last_command: {
    /** The id `runComputerCommand` returned for this command — how the page
     *  knows the command a button sent has finished. Empty on older records. */
    command_id: string
    action: string
    agent: string | null
    ok: boolean
    detail: string
    finished_at: string
  } | null
  connected: boolean
  status: ComputerStatus
  running_count: number
  agent_count: number
  /** What this machine found when it looked for model CLIs, or `null` if it has
   *  never told us (a computer running an older release cannot report it). */
  model_clis: ComputerModelCli[] | null
  /** ISO-8601 of when the machine last ran that check (by its own clock), or
   *  `''` if it never reported one. The machine re-checks every few minutes and
   *  re-sends its last answer in between, so this is the age of the answer. */
  model_clis_checked_at: string
  /** Did this machine report a model CLI that is installed AND signed in?
   *
   *  THREE-VALUED, and the zero-state checklist depends on all three:
   *  `true` = reported one, `false` = looked and found none,
   *  `null` = never said. A row that cannot tell "no" from "don't know" either
   *  nags a working user or reassures a broken one.
   *
   *  Installed-but-signed-out is `false`, decided server-side: from the browser
   *  it is indistinguishable from nothing installed — the runner shells the
   *  binary, the binary refuses, the agent goes silent. */
  model_cli_ready: boolean | null
  /** Whether this machine accepts a terminal session from its Computer page.
   *
   *  THREE-VALUED, like `model_cli_ready`: `true` = on (the default),
   *  `false` = turned off ON THE MACHINE (`clawmeets computer terminal
   *  disable`) — nothing in the browser can turn it back on, `null` = the
   *  machine's software predates the terminal. Optional because older servers
   *  omit it; the page reads a missing field as `null`. */
  terminal_enabled?: boolean | null
}

/** The complete list of what ClawMeets may and may never do on a computer,
 *  served rather than hardcoded here.
 *
 *  Duplicating it in the frontend would let the consent screen drift from what
 *  the server actually enforces, and the claim "this is the complete list" is
 *  worthless the moment those two can differ. It is derived server-side from
 *  the same allowlist the command route checks. */
export interface ComputerConsent {
  allowed: { action: string; label: string }[]
  never: string[]
  /** "The agents it runs act as you and can run commands on this computer." */
  agents_note: string
  /** The terminal line for a machine where it is on. May carry a `backticked`
   *  command, rendered as inline code. */
  terminal_on: string
  /** The terminal line for a machine where it was turned off. */
  terminal_off: string
}

/** The allowlisted actions. Anything else is refused twice — by the server
 *  before it sends a frame, and by the machine before it runs one. */
export type ComputerAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'update'

export interface PairingCode {
  code: string
  expires_at: string
  /** The whole command, assembled server-side so the dialog never builds it and
   *  the two can never disagree about the verb. */
  command: string
}

export async function getComputers(): Promise<Computer[]> {
  return get<Computer[]>('/me/computers')
}

export async function getComputerConsent(): Promise<ComputerConsent> {
  return get<ComputerConsent>('/me/computers/consent')
}

export async function createPairingCode(): Promise<PairingCode> {
  return post<PairingCode>('/me/computers/pairing-code')
}

export async function renameComputer(id: string, name: string): Promise<Computer> {
  return patch<Computer>(`/me/computers/${encodeURIComponent(id)}`, { name })
}

/** Disconnect a computer — permanent.
 *
 *  Goes out on the owner's user JWT; the route accepts nothing else, the same
 *  fence that guards deleting an agent. The machine's key is destroyed, so
 *  reconnecting needs a fresh pairing code. Agents already running there are
 *  NOT stopped — this removes our access, it is not a remote shutdown. */
export async function disconnectComputer(id: string): Promise<Computer> {
  return del<Computer>(`/me/computers/${encodeURIComponent(id)}`)
}

/** Ask a computer to do one allowlisted thing.
 *
 *  Fire-and-forget by design: the machine reports the outcome on its next
 *  check-in, which restamps the agent roster and pushes `HOST_SYNC`. Holding a
 *  request open until a subprocess on someone's laptop finished would tie this
 *  page to a process we do not control.
 *
 *  A 409 means the machine holds no live socket and NOTHING WAS SENT — the
 *  caller must say so rather than showing a pending button, because silently
 *  swallowing a command for an unreachable machine is the exact failure the host
 *  view exists to remove. A 400 means the action was refused. */
export async function runComputerCommand(
  id: string,
  action: ComputerAction,
  agent?: string,
): Promise<{ command_id: string; action: string; agent: string | null; dispatched: boolean }> {
  return post(`/me/computers/${encodeURIComponent(id)}/commands`, {
    action,
    agent: agent ?? null,
  })
}

/** A single-use, 60-second pass for ONE terminal socket.
 *
 *  User JWT only on the route: a terminal is a full shell as the user, so the
 *  assistant token that can start and stop agents cannot open one. The ticket
 *  rather than the JWT goes in the socket's first frame, so the long-lived
 *  credential never rides a connection that stays open for a whole session.
 *
 *  A 409 carries a `detail` written for the user (off, turned off on the
 *  machine, software too old, too many sessions) and is shown verbatim. */
export async function createTerminalTicket(
  id: string,
  body: { cols: number; rows: number },
): Promise<{ ticket: string; expires_in: number }> {
  return post(`/me/computers/${encodeURIComponent(id)}/terminal/ticket`, body)
}

import { formatRelativeTime } from '../../utils/formatDate'
import type { AgentRunState, Computer, ComputerStatus } from '../../api/endpoints/computers'

/**
 * Every user-visible word about a computer, in one module.
 *
 * Two reasons it is not inlined in the components:
 *
 * 1. **The list row and the page must agree.** The panel says "On · nothing
 *    running" and the page says "Your computer is on, but none of your agents
 *    are running". Those are the same finding in two lengths; derived from two
 *    places they would eventually contradict each other, and a contradiction
 *    here is exactly the confusion the feature removes.
 * 2. **The vocabulary rule is testable from one file.** Nothing a user reads may
 *    say "runner", "daemon", "host" or "process"; a single module is something a
 *    test can assert over.
 */

/** Words that must never reach a user. Exported so a test can assert over the
 *  strings this module produces rather than trusting a code review.
 *
 *  "process" is on the list with the others: "the agent process exited" is how
 *  an engineer describes what the user experiences as "it stopped on its own". */
export const BANNED_WORDS = ['runner', 'daemon', 'host', 'process'] as const

export interface StatusPill {
  label: string
  /** Dot colour — a presence indicator, so these are the 3:1-contrast tokens
   *  rather than the text inks. */
  dot: string
  fg: string
  bg: string
}

export function statusPill(status: ComputerStatus): StatusPill {
  switch (status) {
    case 'online':
      return { label: 'On', dot: '#2fbf5a', fg: '#0d6d57', bg: '#d9efe5' }
    case 'not_answering':
      return { label: 'Not answering', dot: '#d48a1c', fg: '#8a5a00', bg: '#fbf0dc' }
    case 'revoked':
      return { label: 'Disconnected', dot: '#6b7280', fg: '#433859', bg: '#ececf0' }
    case 'off':
    default:
      return { label: 'Off', dot: '#6b7280', fg: '#433859', bg: '#ececf0' }
  }
}

/** "On · 3 of 5 running" — the one-line summary on a list row.
 *
 *  The nothing-running case gets its own words rather than "0 of 5": a zero is
 *  read as a number, and this is the state that needs to be read as a problem. */
export function rowSummary(computer: Computer): string {
  const { status, running_count: running, agent_count: total } = computer
  if (status === 'revoked') return 'Disconnected'
  if (status === 'not_answering') return 'Not answering'
  if (status === 'off') {
    const seen = formatRelativeTime(computer.last_seen_at)
    return seen ? `Off · seen ${seen}` : 'Off'
  }
  if (total === 0) return 'On · no agents set up here'
  if (running === 0) return 'On · nothing running'
  return `On · ${running} of ${total} running`
}

export interface Banner {
  tone: 'warn' | 'info'
  title: string
  body: string
}

/**
 * The situational banner, or null when the machine is simply fine.
 *
 * The `online` + `nothing running` arm is the reason the host connection exists.
 * That state used to be indistinguishable from the computer being off — both
 * were silence in chat — and someone sat in it for two and a half days believing
 * ClawMeets was down. It is only expressible because something on the machine
 * stays connected when every agent is dead, so it gets its own words and its own
 * remedy rather than being folded into "offline".
 *
 * Three states, three different remedies, and the remedy is what makes the
 * distinction worth drawing:
 *  - on, nothing running  -> press Start here.
 *  - awake, not answering -> the buttons are dead; type a command on the machine.
 *  - off                  -> open the computer; nothing to type, nothing to resend.
 */
export function bannerFor(computer: Computer): Banner | null {
  const name = computer.name
  if (computer.status === 'revoked') {
    return {
      tone: 'warn',
      title: `${name} is disconnected from ClawMeets.`,
      body:
        `Its key was revoked, so nothing here can see or control it. Agents on ` +
        `that computer are unaffected and may still be running. To bring it ` +
        `back, connect it again with a new code.`,
    }
  }
  if (computer.status === 'off') {
    const seen = computer.last_seen_at
      ? `Nothing has run here since ${new Date(computer.last_seen_at).toLocaleString()}.`
      : 'It has not checked in yet.'
    return {
      tone: 'warn',
      title: `${name} is off, asleep, or not on the internet.`,
      body:
        `${seen} Messages sent to these agents are being held and will be ` +
        `delivered when they're back — you don't need to send them again. Open ` +
        `the computer to resume. This is your machine, not a ClawMeets outage.`,
    }
  }
  if (computer.status === 'not_answering') {
    const seen = formatRelativeTime(computer.last_seen_at)
    return {
      tone: 'warn',
      title: `${name} stopped answering${seen ? ` ${seen} ago` : ''}.`,
      body:
        `The computer looks awake but ClawMeets has lost contact with it, so the ` +
        `buttons below can't reach it right now. Run the reconnect command below ` +
        `on the machine and this page will come back on its own.`,
    }
  }
  if (computer.agent_count > 0 && computer.running_count === 0) {
    return {
      tone: 'info',
      title: 'Your computer is on, but none of your agents are running.',
      body:
        `That's why they look offline in chat and why replies aren't coming ` +
        `back. Start the ones you need below.`,
    }
  }
  return null
}

/** Whether the remote buttons can do anything at all right now. */
export function isReachable(computer: Computer): boolean {
  return computer.status === 'online'
}

/** Why a button is disabled, as a tooltip. Empty when it is not. */
export function unreachableReason(computer: Computer): string {
  switch (computer.status) {
    case 'online':
      return ''
    case 'off':
      return `${computer.name} is off. Open it to resume.`
    case 'not_answering':
      return `${computer.name} isn't answering, so this can't reach it. Use the commands below.`
    case 'revoked':
      return `${computer.name} is disconnected from ClawMeets.`
  }
}

const AGENT_STATE_LABELS: Record<AgentRunState, string> = {
  running: 'Running',
  // NOT "Stopped". The machine started this agent and found its process gone
  // without being asked to stop it, and that is a different fact from a stop the
  // user performed — it is the difference between "I turned it off" and
  // "something went wrong". Same button either way; different words.
  crashed: 'Stopped on its own',
  stopped: 'Stopped',
}

export function agentStateLabel(state: AgentRunState): string {
  return AGENT_STATE_LABELS[state] ?? 'Stopped'
}

export function agentStateTone(state: AgentRunState): StatusPill {
  switch (state) {
    case 'running':
      return { label: 'Running', dot: '#2fbf5a', fg: '#0d6d57', bg: '#d9efe5' }
    case 'crashed':
      return { label: 'Stopped on its own', dot: '#d48a1c', fg: '#8a5a00', bg: '#fbf0dc' }
    default:
      return { label: 'Stopped', dot: '#6b7280', fg: '#433859', bg: '#ececf0' }
  }
}

/** The three actions an agent row (and "Start N stopped") can send. */
export type AgentAction = 'start' | 'stop' | 'restart'

const IN_FLIGHT_LABELS: Record<AgentAction, string> = {
  start: 'Starting…',
  stop: 'Stopping…',
  restart: 'Restarting…',
}

/** What a button says between the click and the machine's answer.
 *
 *  Describes the request, never the outcome: "Stopping…" is true the moment the
 *  command is sent, whereas flipping the status pill to "Stopped" would claim
 *  something only the machine can report. */
export function inFlightLabel(action: AgentAction): string {
  return IN_FLIGHT_LABELS[action]
}

/** The header button while some of its starts are still in flight. */
export function startingSummary(count: number): string {
  return `Starting ${count}…`
}

export interface ManualStep {
  label: string
  command: string
}

export interface ManualSection {
  title: string
  hint: string
  steps: ManualStep[]
}

/**
 * The typeable equivalent of everything on the page.
 *
 * Not a fallback bolted on for completeness — the `not_answering` case is one
 * the page genuinely cannot fix, and there the keyboard is the only path left.
 * So the section's heading and its steps change with the machine's state:
 * telling a user to "start an agent" when the computer is off is noise, and
 * telling them to reconnect when it is already connected is worse.
 */
export function manualSection(computer: Computer): ManualSection {
  const first = computer.agents[0]?.short_name ?? '<agent>'
  switch (computer.status) {
    case 'not_answering':
      return {
        title: 'Reconnect from the computer',
        hint: 'The buttons above cannot reach the machine until this runs.',
        steps: [
          { label: 'Reconnect it', command: 'clawmeets computer start' },
          { label: 'If that fails, see why', command: 'clawmeets computer logs --tail 50' },
          { label: 'Start every agent in the meantime', command: 'clawmeets start' },
        ],
      }
    case 'off':
      return {
        title: 'When you are back at the computer',
        hint: 'Open it and these agents come back on their own. If they do not, run this.',
        steps: [
          { label: 'Start every agent on this computer', command: 'clawmeets start' },
          { label: 'See what is running', command: 'clawmeets computer status' },
        ],
      }
    case 'revoked':
      return {
        title: 'Connect this computer again',
        // No `--code`: signed in on the machine, `install` fetches its own. A
        // literal `XXXX-XXXX` here gets copied and run verbatim, and fails.
        hint: 'Run this on the machine. It fetches its own code if you are signed in there; if not, it prints the one-line fix.',
        steps: [
          { label: 'Reconnect it', command: 'clawmeets computer install' },
          { label: 'Start every agent meanwhile', command: 'clawmeets start' },
        ],
      }
    default:
      return {
        title: 'Prefer to do it yourself?',
        hint: 'Everything on this page has a command you can run on the machine.',
        steps: [
          { label: 'Start one agent', command: `clawmeets start --agent ${first}` },
          { label: 'Stop one agent', command: `clawmeets stop --agent ${first}` },
          { label: 'See what is running', command: 'clawmeets computer status' },
        ],
      }
  }
}

/** "macOS 15.6 · 5 agents set up here · clawmeets 0.9.3 · clawmeets-daemon 0.4.1"
 *  — the quiet line under the name.
 *
 *  Assembled from whatever the machine actually reported: a computer that cannot
 *  name its own OS still gets a usable line rather than "undefined · undefined". */
export function machineMeta(computer: Computer): string {
  const parts: string[] = []
  const os = [computer.platform, computer.os_version].filter(Boolean).join(' ')
  if (os) parts.push(os)
  if (computer.agent_count > 0) {
    parts.push(`${computer.agent_count} agent${computer.agent_count === 1 ? '' : 's'} set up here`)
  }
  // By package name, so it can be matched against pip / uv / pipx output.
  for (const row of softwareCardCopy(computer).rows) {
    if (row.reported) parts.push(`${row.pkg} ${row.version}`)
  }
  return parts.join(' · ')
}

/** "Checked in 4s ago" / "Last seen 3d ago" — one line, tense matched to state. */
export function lastSeenLine(computer: Computer): string {
  const rel = formatRelativeTime(computer.last_seen_at)
  if (!rel) return 'Has not checked in yet'
  if (computer.status === 'online') return rel === 'now' ? 'Checked in just now' : `Checked in ${rel} ago`
  return `Last seen ${rel === 'now' ? 'just now' : `${rel} ago`}`
}

// --- Terminal ---------------------------------------------------------------

/** The only switch there is, and it is on the machine. Nothing in the browser
 *  turns the terminal on or off: a page that could re-enable a shell the user
 *  turned off at the keyboard would make that choice worthless. */
export const TERMINAL_ENABLE_COMMAND = 'clawmeets computer terminal enable'
export const TERMINAL_DISABLE_COMMAND = 'clawmeets computer terminal disable'

export type TerminalAvailability = 'unreachable' | 'needs_update' | 'off' | 'on'

export interface TerminalCardCopy {
  availability: TerminalAvailability
  /** One line under the card's title. */
  line: string
}

/**
 * Which of four things the terminal card says, and its one line.
 *
 * Reachability comes first because it is the only one of the four that is
 * about right now: `terminal_enabled` is the machine's last report, and a
 * computer that is off cannot open a shell whatever it last said.
 */
export function terminalCardCopy(computer: Computer): TerminalCardCopy {
  if (!isReachable(computer)) {
    return {
      availability: 'unreachable',
      line:
        computer.status === 'not_answering'
          ? `${computer.name} isn't answering, so a terminal can't reach it right now.`
          : computer.status === 'revoked'
            ? unreachableReason(computer)
            : 'Turn this computer on to open a terminal.',
    }
  }
  const enabled = computer.terminal_enabled ?? null
  if (enabled === null) {
    return {
      availability: 'needs_update',
      line: "Update this computer's software to use the terminal.",
    }
  }
  if (!enabled) {
    return { availability: 'off', line: 'Off. It was turned off on this computer.' }
  }
  return { availability: 'on', line: 'On. Runs commands as you on this computer.' }
}

/** The red bar, for as long as a session is open. */
export function terminalActiveLine(name: string): string {
  return `Terminal session active on ${name}`
}

/** Why a session ended, when the socket closed without the machine saying. */
export function terminalDropReason(closeCode: number): string {
  if (closeCode === 4001) return 'This terminal link expired before it was used. Open the terminal again.'
  return 'The connection to this computer was lost, so the session ended.'
}

/** Server copy may carry a `backticked` command; split it so the command can
 *  render as inline code. Odd-indexed parts are the code. */
export function splitInlineCode(text: string): { text: string; code: boolean }[] {
  return text
    .split('`')
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((part) => part.text !== '')
}

// --- ClawMeets software (update) --------------------------------------------

export interface SoftwareCardCopy {
  /** One per package. `pkg` is the name installers know it by — shown beside
   *  the plain label so the user can match it to `pip list` / `uv tool list`. */
  rows: { label: string; pkg: string; version: string; reported: boolean }[]
  /** Under the button: what one click does. */
  hint: string
  /** Shown only while the machine cannot say which ClawMeets it has — an
   *  older connection that can only update itself. */
  staleNote: string | null
}

/** What the "ClawMeets software" card says.
 *
 *  Two packages, one button. The machine upgrades each with whichever of uv,
 *  pipx or pip installed it, so the page never asks how they were installed. */
export function softwareCardCopy(computer: Computer): SoftwareCardCopy {
  const known = (v: string | null | undefined) => (v && v !== 'unknown' ? v : null)
  const app = known(computer.runner_version)
  const connection = known(computer.daemon_version)
  return {
    rows: [
      { label: 'ClawMeets', pkg: 'clawmeets', version: app ?? 'Not reported', reported: app !== null },
      {
        label: 'Connection software',
        pkg: 'clawmeets-daemon',
        version: connection ?? 'Not reported',
        reported: connection !== null,
      },
    ],
    hint:
      'Updates both to the latest release, the same way they were installed (uv, pipx or pip). ' +
      'Agents that are running restart to pick up the new version.',
    staleNote:
      app === null && isReachable(computer)
        ? "This computer's connection software is too old to update ClawMeets. Update once to bring it current, then update again."
        : null,
  }
}

/** The outcome line for the most recent update, or null if the last command
 *  was something else. */
export function updateOutcome(computer: Computer): { ok: boolean; line: string } | null {
  const last = computer.last_command
  if (!last || last.action !== 'update') return null
  return last.ok
    ? { ok: true, line: `Updated. ${last.detail}`.trim() }
    : { ok: false, line: `Couldn't update. ${last.detail}`.trim() }
}

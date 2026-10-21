import type { Computer } from '../../api/endpoints/computers'
import type { InstallRun, InstallStepLabel } from '../../api/endpoints/install'
import type { AgentCard } from '../../types'
import { formatRelativeTime } from '../../utils/formatDate'

/**
 * Every user-visible word on the zero state, and the rules that decide which
 * checklist rows are green.
 *
 * Split out of the components for the two reasons `computerCopy.ts` is:
 *
 * 1. **The rule is the product, so it should be readable in one place.** "A row
 *    turns green only when the server actually observes it" is a claim about
 *    three different signals from three different queries. Spread across JSX it
 *    is unauditable; here it is one function per row.
 * 2. **The vocabulary rule is testable from one file.** Nothing a user reads may
 *    say "runner", "daemon", "host" or "process" — they read about *their
 *    computer*. `computerCopy.BANNED_WORDS` is the shared list and
 *    `welcomeCopy.test.ts` asserts over the strings this module produces.
 *
 * ## No optimistic ticks
 *
 * This is the whole design of the checklist, and it is a deliberate departure
 * from what a progress bar would do. Each row is one of three states:
 *
 * - `done`    — the server OBSERVED it. A live computer socket, a live agent
 *               socket, a model-CLI report from the machine.
 * - `waiting` — nothing observed yet. Not "failed": a user who has not run the
 *               command yet has done nothing wrong, and a page full of red
 *               crosses on first load is a page that says "you broke it".
 * - `problem` — the server observed something that is actively wrong, e.g. the
 *               machine looked for a model CLI and found none signed in. Only
 *               this state gets a remedy line, because only this state has one.
 *
 * `waiting` and `problem` are NOT merged. The difference between "we have not
 * heard yet" and "we heard, and it is wrong" is the whole reason the machine
 * reports `model_cli_ready` as three-valued rather than boolean; collapsing it
 * here would throw that away at the last step.
 */

export type RowState = 'done' | 'waiting' | 'problem'

export interface ChecklistRow {
  key: 'computer' | 'model_cli' | 'assistant'
  label: string
  state: RowState
  /** One short line under the row. Present for `problem`, and for `done` when
   *  there is something worth naming (the machine's own name). Empty otherwise —
   *  a row that is merely waiting has nothing to add that the label does not
   *  already say. */
  detail: string
}

/** The one sentence of mental model. Deliberately one sentence: the old page
 *  explained four things and a user in a hurry read none of them.
 *
 *  It says "the computer where you installed ClawMeets", never "the runner",
 *  because the whole point is that the user is being told where their agents
 *  live in terms of a thing they already understand. */
export const MENTAL_MODEL =
  'Your agents run on the computer where you installed ClawMeets. This web app is the hub connecting them.'

export const HEADLINE = 'Set up your agent team locally'

/** The two install commands, one tab each. Same steps, same token, same
 *  checklist — only the shell differs. `windowsDevMode` is the one prerequisite
 *  the Windows script cannot satisfy for the user, so it sits with the command
 *  rather than in the manual drawer where nobody running the one-liner looks. */
export type InstallOs = 'unix' | 'windows'

export const OS_TABS: { key: InstallOs; label: string; lead: string; note: string }[] = [
  {
    key: 'unix',
    label: 'macOS / Linux',
    lead: 'Paste this into a terminal on the computer you want your agents to run on.',
    note:
      'You will need Claude Code, Codex or Antigravity installed and signed in on that computer.',
  },
  {
    key: 'windows',
    label: 'Windows',
    lead: 'Paste this into PowerShell on the computer you want your agents to run on.',
    note:
      'You will need Claude Code, Codex or Antigravity installed and signed in on that computer. Your agents do not restart by themselves after a reboot on Windows yet — run clawmeets computer start, then clawmeets start.',
  },
]

export const WINDOWS_DEV_MODE = {
  title: 'Turn on Developer Mode first',
  body: 'ClawMeets creates symbolic links when your agents start, which Windows only allows with Developer Mode on (or as an administrator). The command checks this and stops before installing anything if it is off.',
  pathLead: 'Settings → System → For developers → ',
  pathTarget: 'Developer Mode',
  pathTail: ' → On. Or paste this into PowerShell to open that page directly:',
  code: 'start ms-settings:developers',
} as const

/** The tab to open on: Windows for a Windows browser, else macOS / Linux. Only
 *  a default — both tabs are always one click away, so a wrong guess costs a
 *  click rather than hiding anything. */
export function defaultOs(userAgent: string): InstallOs {
  return /windows/i.test(userAgent) ? 'windows' : 'unix'
}

/** The single first action, once every row is green. Not a tour.
 *
 *  My Desk rather than the assistant DM: the desk is where the team's output
 *  arrives and its composer already addresses the assistant, so it is both the
 *  destination and the place to say the first thing. */
export const READY_TITLE = 'Everything is working.'
export const READY_ACTION = 'Open My Desk'
export const READY_HREF = '/desk'

/** Shown instead of the command once the setup is green — the command is spent
 *  and re-running it is not the next thing anyone should do. */
export const READY_NOTE =
  'Ask for something in your own words. Your assistant will plan it and bring in whoever it needs.'

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** The computer the checklist is about: the one that is online, else the newest.
 *
 *  A user can have several. The zero state is about getting ONE working, so it
 *  reports on the one that is talking to us — and falls back to the newest
 *  record so a machine that paired and then went quiet still has its row explain
 *  itself rather than reverting to "waiting", which would read as though the
 *  pairing never happened.
 *
 *  Revoked machines are skipped: they are in the list so the Computers page can
 *  explain why they went quiet, and that is not this page's question. */
export function primaryComputer(computers: Computer[] | undefined): Computer | null {
  const usable = (computers ?? []).filter((c) => c.status !== 'revoked')
  if (usable.length === 0) return null
  return usable.find((c) => c.status === 'online') ?? usable[0]
}

/** "Computer connected" — true only while a socket is open right now.
 *
 *  `status` is decided server-side in `models/host.derive_status`, so this row
 *  cannot disagree with the Computers page about what "off" means. `off` and
 *  `not_answering` are both `problem` rather than `waiting` ONCE A MACHINE
 *  EXISTS: we have heard from it before, so silence now is a fact about it and
 *  not an absence of information. */
export function computerRow(computer: Computer | null): ChecklistRow {
  if (computer === null) {
    return {
      key: 'computer',
      label: 'Your computer is connected',
      state: 'waiting',
      detail: '',
    }
  }
  if (computer.status === 'online') {
    return {
      key: 'computer',
      label: 'Your computer is connected',
      state: 'done',
      // The machine's own name, which is the point of the vocabulary rule: the
      // user reads "MacBook Pro", not a process name.
      detail: computer.name,
    }
  }
  if (computer.status === 'not_answering') {
    return {
      key: 'computer',
      label: 'Your computer is connected',
      state: 'problem',
      detail: `${computer.name} was here a moment ago but is not answering. Run: clawmeets computer start`,
    }
  }
  return {
    key: 'computer',
    label: 'Your computer is connected',
    state: 'problem',
    detail: `${computer.name} is off. Turn it on, and it will reconnect by itself.`,
  }
}

/** "Model CLI found" — reported BY the machine, because nothing else can see it.
 *
 *  Three-valued all the way through: `null` means the machine never told us
 *  (it is older than this feature, or has not connected yet) and stays `waiting`;
 *  `false` means it looked and found nothing usable, which is a real problem with
 *  a real remedy. Installed-but-signed-out already counts as `false` server-side,
 *  which is the finding the old setup flow reported not at all. */
export function modelCliRow(computer: Computer | null): ChecklistRow {
  const label = 'A model is available on it'
  const ready = computer?.model_cli_ready ?? null
  const checked = checkedLine(computer?.model_clis_checked_at)
  if (ready === true) {
    return { key: 'model_cli', label, state: 'done', detail: checked }
  }
  if (ready === false) {
    const remedy =
      'No model CLI is signed in on that computer. Install Claude Code, Codex or Antigravity there and sign in, then run: clawmeets doctor'
    return {
      key: 'model_cli',
      label,
      state: 'problem',
      // The age goes on the warning too: the computer re-checks every few
      // minutes, so a user who just signed in can see whether this answer
      // predates it.
      detail: checked ? `${remedy}. ${checked}.` : remedy,
    }
  }
  return { key: 'model_cli', label, state: 'waiting', detail: '' }
}

/** "Checked 4m ago" — how old the computer's model-CLI answer is. */
export function checkedLine(iso: string | null | undefined): string {
  const rel = formatRelativeTime(iso)
  if (!rel) return ''
  if (rel === 'now') return 'Checked just now'
  if (rel === 'yesterday') return 'Checked yesterday'
  return /^\d/.test(rel) ? `Checked ${rel} ago` : `Checked ${rel}`
}

/** "Assistant online" — a live agent socket, which the server owns.
 *
 *  Two distinct not-yet cases, and they are worth separating: no assistant
 *  exists (the install has not reached that step) versus one exists and is
 *  offline (it exists and is not running, which has a command). */
export function assistantRow(assistant: AgentCard | null): ChecklistRow {
  const label = 'Your assistant is online'
  if (assistant === null) {
    return { key: 'assistant', label, state: 'waiting', detail: '' }
  }
  if (assistant.status === 'online') {
    return { key: 'assistant', label, state: 'done', detail: assistant.name }
  }
  return {
    key: 'assistant',
    label,
    state: 'problem',
    detail: 'Your assistant is set up but not running. Run: clawmeets start',
  }
}

/** The three rows, in the order they become true. */
export function checklist(
  computers: Computer[] | undefined,
  assistant: AgentCard | null,
): ChecklistRow[] {
  const computer = primaryComputer(computers)
  return [computerRow(computer), modelCliRow(computer), assistantRow(assistant)]
}

/** Is the setup working? True only when every row is `done`.
 *
 *  Nothing partial counts. This gates the single first action, and offering
 *  "Open My Desk" to someone whose assistant is not running would send them to a
 *  page where nothing answers — which is the failure this whole surface exists
 *  to stop. */
export function isReady(rows: ChecklistRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.state === 'done')
}

// ---------------------------------------------------------------------------
// The install narrative
// ---------------------------------------------------------------------------

export interface NarratedStep {
  key: string
  label: string
  state: 'pending' | 'running' | 'done' | 'failed'
  detail: string
}

/** The install steps, merged with what the machine has reported.
 *
 *  Every declared step is returned whether or not it has been reported, so the
 *  list has its full height from the first render — a panel that grows a row at a
 *  time reads as a stall, and its jumping is the thing a watching user notices
 *  instead of the progress.
 *
 *  This is the NARRATIVE half of the page and it is kept strictly separate from
 *  `checklist()` above: nothing here can turn a checklist row green. A machine
 *  reporting "all done" while the server has observed nothing renders as exactly
 *  that — a finished narrative above three rows that are still waiting, which is
 *  the honest picture and a genuinely useful diagnostic.
 */
export function narrate(
  declared: InstallStepLabel[],
  run: InstallRun | null | undefined,
): NarratedStep[] {
  const reported = new Map((run?.steps ?? []).map((s) => [s.key, s]))
  return declared.map(({ key, label }) => {
    const step = reported.get(key)
    if (!step) return { key, label, state: 'pending' as const, detail: '' }
    if (step.state === 'ok') return { key, label, state: 'done' as const, detail: '' }
    if (step.state === 'failed') {
      return { key, label, state: 'failed' as const, detail: step.detail }
    }
    if (step.state === 'skipped') {
      return { key, label, state: 'done' as const, detail: step.detail }
    }
    return { key, label, state: 'running' as const, detail: '' }
  })
}

/** Has the machine started reporting? Decides whether the narrative is shown at
 *  all — before the user runs the command there is no story to tell, and an
 *  all-grey list of six steps is noise on the one screen that must be simple. */
export function hasStarted(run: InstallRun | null | undefined): boolean {
  return (run?.steps?.length ?? 0) > 0
}

/** The failed step, if the install stopped. The page surfaces its reason: a user
 *  who closed the terminal has nowhere else to learn why. */
export function failedStep(steps: NarratedStep[]): NarratedStep | null {
  return steps.find((s) => s.state === 'failed') ?? null
}

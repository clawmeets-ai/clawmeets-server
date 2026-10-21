import { describe, expect, it } from 'vitest'
import type { Computer } from '../../api/endpoints/computers'
import type { InstallRun, InstallStepLabel } from '../../api/endpoints/install'
import type { AgentCard } from '../../types'
import { AgentStatus } from '../../types'
import { BANNED_WORDS } from '../computer/computerCopy'
import {
  OS_TABS,
  WINDOWS_DEV_MODE,
  defaultOs,
  HEADLINE,
  MENTAL_MODEL,
  READY_NOTE,
  READY_TITLE,
  assistantRow,
  checklist,
  computerRow,
  failedStep,
  hasStarted,
  isReady,
  modelCliRow,
  narrate,
  primaryComputer,
} from './welcomeCopy'

/**
 * The zero state's rules, tested as the deliverable they are.
 *
 * Three things here are the feature rather than a detail of it:
 *
 * 1. **No optimistic ticks.** A row goes green only on a server OBSERVATION. The
 *    install script reports its own progress, and no amount of that may move a
 *    checklist row — so the narrative and the checklist are tested against each
 *    other, not just separately.
 * 2. **"Waiting" is not "wrong".** A user who has not run the command yet must
 *    not be shown a failure. The distinction survives all the way from the
 *    machine's three-valued `model_cli_ready` to the rendered row, and collapsing
 *    it anywhere in between is the regression.
 * 3. **Vocabulary.** Nothing a user reads may say "runner", "daemon", "host" or
 *    "process" — they read about *their computer*. Swept over every string this
 *    module can produce, reusing the Computers surface's own banned list so the
 *    two cannot drift.
 */

const computer: Computer = {
  id: 'abcdef0123456789',
  owner_user_id: 'u1',
  name: 'MacBook Pro',
  hostname: 'Chengtaos-MacBook-Pro.local',
  platform: 'macOS',
  os_version: '15.6',
  created_at: '2026-09-01T09:00:00Z',
  last_seen_at: new Date().toISOString(),
  revoked_at: null,
  daemon_version: '0.1.0',
  agents: [],
  agents_reported_at: new Date().toISOString(),
  last_command: null,
  connected: true,
  status: 'online',
  running_count: 0,
  agent_count: 0,
  model_cli_ready: true,
  model_clis_checked_at: '',
}

function make(overrides: Partial<Computer>): Computer {
  return { ...computer, ...overrides }
}

const assistant = {
  id: 'a1',
  name: 'chengtao-assistant',
  description: '',
  capabilities: [],
  status: AgentStatus.ONLINE,
  registered_at: '2026-09-01T09:00:00Z',
  last_heartbeat: null,
  discoverable_through_registry: false,
  is_verified: false,
} as AgentCard

function withStatus(status: AgentStatus): AgentCard {
  return { ...assistant, status }
}

// ---------------------------------------------------------------------------
// Which computer the page reports on
// ---------------------------------------------------------------------------

describe('primaryComputer', () => {
  it('prefers the one that is actually talking to us', () => {
    const chosen = primaryComputer([
      make({ id: 'a'.repeat(16), name: 'Old Laptop', status: 'off', connected: false }),
      make({ id: 'b'.repeat(16), name: 'MacBook Pro', status: 'online' }),
    ])
    expect(chosen?.name).toBe('MacBook Pro')
  })

  it('skips machines the user disconnected', () => {
    // They stay in the list so the Computers page can explain why they went
    // quiet. That is not this page's question.
    expect(primaryComputer([make({ status: 'revoked', connected: false })])).toBeNull()
  })

  it('is null when nothing has ever paired', () => {
    expect(primaryComputer([])).toBeNull()
    expect(primaryComputer(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

describe('computerRow', () => {
  it('waits, rather than failing, before anything has paired', () => {
    // The page's first render. A red mark here would open by blaming a user who
    // has not done anything yet.
    expect(computerRow(null).state).toBe('waiting')
  })

  it('goes green only on a live connection, and names the machine', () => {
    const row = computerRow(make({ status: 'online' }))
    expect(row.state).toBe('done')
    // The vocabulary rule made concrete: the user reads what they call the
    // machine.
    expect(row.detail).toBe('MacBook Pro')
  })

  it('treats a machine that has gone quiet as a problem, not as waiting', () => {
    // We have heard from it before, so silence now is a fact about it rather
    // than an absence of information — and it has a different remedy.
    const off = computerRow(make({ status: 'off', connected: false }))
    const quiet = computerRow(make({ status: 'not_answering', connected: false }))
    expect(off.state).toBe('problem')
    expect(quiet.state).toBe('problem')
    expect(off.detail).not.toBe(quiet.detail)
    expect(quiet.detail).toContain('clawmeets computer start')
  })
})

describe('modelCliRow', () => {
  it('waits when the machine has not told us', () => {
    // `null` = never reported (older release, or not connected yet). Rendering
    // that as a failure would nag a user about something we cannot see.
    expect(modelCliRow(make({ model_cli_ready: null })).state).toBe('waiting')
    expect(modelCliRow(null).state).toBe('waiting')
  })

  it('is a problem when the machine looked and found nothing usable', () => {
    const row = modelCliRow(make({ model_cli_ready: false }))
    expect(row.state).toBe('problem')
    // A remedy, not a diagnosis.
    expect(row.detail).toContain('clawmeets doctor')
  })

  it('goes green when the machine reported a usable model', () => {
    expect(modelCliRow(make({ model_cli_ready: true })).state).toBe('done')
  })

  it('says how old the answer is, on green and on the warning', () => {
    const fourMinAgo = new Date(Date.now() - 4 * 60_000).toISOString()
    expect(
      modelCliRow(make({ model_cli_ready: true, model_clis_checked_at: fourMinAgo })).detail,
    ).toBe('Checked 4m ago')
    const problem = modelCliRow(
      make({ model_cli_ready: false, model_clis_checked_at: new Date().toISOString() }),
    )
    expect(problem.detail).toContain('clawmeets doctor')
    expect(problem.detail).toContain('Checked just now')
    // A machine too old to say when it checked gets no age at all, not a wrong one.
    expect(modelCliRow(make({ model_cli_ready: true })).detail).toBe('')
  })

  it('keeps found-none and never-said distinct', () => {
    // This is the whole reason the signal is three-valued end to end.
    expect(modelCliRow(make({ model_cli_ready: false })).state).not.toBe(
      modelCliRow(make({ model_cli_ready: null })).state,
    )
  })
})

describe('assistantRow', () => {
  it('waits when there is no assistant yet', () => {
    expect(assistantRow(null).state).toBe('waiting')
  })

  it('goes green only on a live socket', () => {
    expect(assistantRow(withStatus(AgentStatus.ONLINE)).state).toBe('done')
  })

  it('separates "not set up" from "set up but not running"', () => {
    const offline = assistantRow(withStatus(AgentStatus.OFFLINE))
    expect(offline.state).toBe('problem')
    expect(offline.detail).toContain('clawmeets start')
    expect(assistantRow(null).detail).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

describe('isReady', () => {
  it('needs every row green', () => {
    const rows = checklist([make({ status: 'online', model_cli_ready: true })],
      withStatus(AgentStatus.ONLINE))
    expect(isReady(rows)).toBe(true)
  })

  it('is false while anything is merely waiting', () => {
    // Offering "Open My Desk" here would send the user to a page where nothing
    // answers — the exact failure this surface exists to stop.
    const rows = checklist([make({ status: 'online', model_cli_ready: null })],
      withStatus(AgentStatus.ONLINE))
    expect(isReady(rows)).toBe(false)
  })

  it('is false when the assistant is not running', () => {
    const rows = checklist([make({ status: 'online', model_cli_ready: true })],
      withStatus(AgentStatus.OFFLINE))
    expect(isReady(rows)).toBe(false)
  })

  it('is false on a fresh account with nothing set up', () => {
    expect(isReady(checklist([], null))).toBe(false)
  })

  it('returns exactly three rows, in the order they come true', () => {
    expect(checklist([], null).map((r) => r.key)).toEqual([
      'computer',
      'model_cli',
      'assistant',
    ])
  })
})

// ---------------------------------------------------------------------------
// The narrative, and its strict separation from the checklist
// ---------------------------------------------------------------------------

const declared: InstallStepLabel[] = [
  { key: 'install', label: 'Installing ClawMeets' },
  { key: 'link', label: 'Signing in on this computer' },
  { key: 'computer', label: 'Connecting this computer' },
]

function run(steps: InstallRun['steps']): InstallRun {
  return {
    id: 'abc123abc123',
    username: 'chengtao',
    created_at: '2026-09-01T09:00:00Z',
    expires_at: '2026-09-01T10:00:00Z',
    claimed_at: null,
    steps,
    expired: false,
    claimed: false,
  }
}

describe('narrate', () => {
  it('returns every declared step so the panel has its full height at once', () => {
    // A list that grows a row at a time reads as a stall, and its jumping is
    // what a watching user notices instead of the progress.
    const steps = narrate(declared, null)
    expect(steps).toHaveLength(3)
    expect(steps.every((s) => s.state === 'pending')).toBe(true)
  })

  it('maps what the machine said onto the declared list', () => {
    const steps = narrate(declared, run([
      { key: 'install', state: 'ok', detail: '', at: '' },
      { key: 'link', state: 'started', detail: '', at: '' },
    ]))
    expect(steps.map((s) => s.state)).toEqual(['done', 'running', 'pending'])
  })

  it('keeps a failure reason verbatim', () => {
    const steps = narrate(declared, run([
      { key: 'link', state: 'failed', detail: 'token already used', at: '' },
    ]))
    const failed = failedStep(steps)
    expect(failed?.key).toBe('link')
    // The only place a user who closed the terminal can learn why.
    expect(failed?.detail).toBe('token already used')
  })

  it('treats a skipped step as done, not as trouble', () => {
    const steps = narrate(declared, run([
      { key: 'install', state: 'skipped', detail: 'already installed', at: '' },
    ]))
    expect(steps[0].state).toBe('done')
  })
})

describe('hasStarted', () => {
  it('is false until the machine reports, so the panel stays hidden', () => {
    expect(hasStarted(null)).toBe(false)
    expect(hasStarted(run([]))).toBe(false)
    expect(hasStarted(run([{ key: 'install', state: 'started', detail: '', at: '' }]))).toBe(true)
  })
})

describe('the narrative cannot move the checklist', () => {
  it('a machine claiming every step finished leaves the rows untouched', () => {
    // The core no-optimistic-ticks guarantee. A script that lied — or one that
    // genuinely ran and achieved nothing — renders as a finished narrative above
    // three waiting rows, which is the honest picture.
    const finished = run(declared.map((d) => ({
      key: d.key, state: 'ok' as const, detail: '', at: '',
    })))
    expect(narrate(declared, finished).every((s) => s.state === 'done')).toBe(true)

    const rows = checklist([], null)
    expect(rows.every((r) => r.state === 'waiting')).toBe(true)
    expect(isReady(rows)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('vocabulary', () => {
  /** Every string this module can produce, across every state. */
  function everyString(): string[] {
    const out: string[] = [
      HEADLINE, MENTAL_MODEL, READY_TITLE, READY_NOTE,
      ...OS_TABS.flatMap((t) => [t.label, t.lead, t.note]),
      WINDOWS_DEV_MODE.title, WINDOWS_DEV_MODE.body,
    ]
    const computers: (Computer | null)[] = [
      null,
      make({ status: 'online', model_cli_ready: true }),
      make({ status: 'online', model_cli_ready: false }),
      make({ status: 'online', model_cli_ready: null }),
      make({ status: 'off', connected: false, model_cli_ready: false }),
      make({ status: 'not_answering', connected: false, model_cli_ready: null }),
    ]
    for (const c of computers) {
      for (const row of [computerRow(c), modelCliRow(c)]) {
        out.push(row.label, row.detail)
      }
    }
    for (const a of [null, withStatus(AgentStatus.ONLINE), withStatus(AgentStatus.OFFLINE)]) {
      const row = assistantRow(a)
      out.push(row.label, row.detail)
    }
    for (const step of narrate(declared, run([
      { key: 'link', state: 'failed', detail: '', at: '' },
    ]))) {
      out.push(step.label)
    }
    return out
  }

  it.each(BANNED_WORDS)('never says "%s"', (word) => {
    for (const text of everyString()) {
      expect(text.toLowerCase()).not.toContain(word)
    }
  })

  it('says "your computer" where it would have said the internal name', () => {
    expect(computerRow(null).label.toLowerCase()).toContain('computer')
  })

  it('explains where agents run in one sentence', () => {
    // One sentence is the budget. The old page explained four things and a user
    // in a hurry read none of them.
    expect(MENTAL_MODEL.split('. ').filter(Boolean).length).toBeLessThanOrEqual(2)
    expect(MENTAL_MODEL.toLowerCase()).toContain('computer')
  })
})

describe('defaultOs', () => {
  it('opens on Windows for a Windows browser, macOS / Linux otherwise', () => {
    expect(defaultOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(defaultOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('unix')
    expect(defaultOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('unix')
  })
})

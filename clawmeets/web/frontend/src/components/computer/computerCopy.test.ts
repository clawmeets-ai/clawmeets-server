import { describe, expect, it } from 'vitest'
import type { Computer, ComputerStatus } from '../../api/endpoints/computers'
import {
  BANNED_WORDS,
  agentStateLabel,
  bannerFor,
  isReachable,
  lastSeenLine,
  machineMeta,
  manualSection,
  rowSummary,
  softwareCardCopy,
  splitInlineCode,
  terminalActiveLine,
  terminalCardCopy,
  terminalDropReason,
  unreachableReason,
  updateOutcome,
} from './computerCopy'

/**
 * The words on the Computers surface, tested as the deliverable they are.
 *
 * Two things here are the feature rather than a detail of it:
 *
 * 1. **"On, nothing running" is its own banner.** That state used to be
 *    indistinguishable from "the computer is off" — both were silence in chat —
 *    and the remedies are mutually useless: pressing Start does nothing for an
 *    off machine, and opening your laptop does nothing for one that is already
 *    on. If these two ever produce the same copy, the regression is the original
 *    bug, restored.
 * 2. **Vocabulary.** Nothing a user reads may say "runner", "daemon", "host" or
 *    "process". Sweeping every string this module can produce is the only way to
 *    check that without trusting a review.
 */

const base: Computer = {
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
  agents: [
    { short_name: 'wine', name: 'chengtao-wine', state: 'running', pid: 42 },
    { short_name: 'ops', name: 'chengtao-ops', state: 'crashed', pid: null },
    { short_name: 'tax', name: 'chengtao-tax', state: 'stopped', pid: null },
  ],
  agents_reported_at: new Date().toISOString(),
  last_command: null,
  connected: true,
  status: 'online',
  running_count: 1,
  agent_count: 3,
}

function make(overrides: Partial<Computer>): Computer {
  return { ...base, ...overrides }
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

describe('the banner names WHICH kind of quiet this is', () => {
  it('says nothing when agents are actually running', () => {
    expect(bannerFor(make({ status: 'online', running_count: 1 }))).toBeNull()
  })

  it('on with nothing running is its own state, and points at Start', () => {
    const banner = bannerFor(make({ status: 'online', running_count: 0 }))!
    expect(banner.title).toBe('Your computer is on, but none of your agents are running.')
    expect(banner.body).toContain('Start the ones you need below')
    // Not a warning: nothing is broken, something just needs starting.
    expect(banner.tone).toBe('info')
  })

  it('off promises the queue and disclaims an outage', () => {
    const banner = bannerFor(make({ status: 'off', connected: false, running_count: 0 }))!
    expect(banner.title).toContain('is off, asleep, or not on the internet')
    // The two sentences that stop a user resending work or waiting on us.
    expect(banner.body).toContain("you don't need to send them again")
    expect(banner.body).toContain('not a ClawMeets outage')
  })

  it('not answering sends the user to the keyboard, not to a button', () => {
    const banner = bannerFor(
      make({ status: 'not_answering', connected: false, last_seen_at: ago(12 * 60) }),
    )!
    expect(banner.title).toContain('stopped answering')
    expect(banner.body).toContain("can't reach it right now")
  })

  it('revoked explains itself instead of looking like a fault', () => {
    const banner = bannerFor(
      make({ status: 'revoked', connected: false, revoked_at: ago(60) }),
    )!
    expect(banner.title).toContain('is disconnected from ClawMeets')
    // The reassurance that matters: revoking removed our access, it did not stop
    // anything on the machine.
    expect(banner.body).toContain('Agents on that computer are unaffected')
  })

  it('the on-nothing-running and off banners are never the same words', () => {
    const idle = bannerFor(make({ status: 'online', running_count: 0 }))!
    const off = bannerFor(make({ status: 'off', connected: false, running_count: 0 }))!
    expect(idle.title).not.toBe(off.title)
    expect(idle.body).not.toBe(off.body)
  })
})

describe('reachability gates the buttons honestly', () => {
  it('only an online machine is reachable', () => {
    const states: ComputerStatus[] = ['online', 'not_answering', 'off', 'revoked']
    expect(states.map((status) => isReachable(make({ status })))).toEqual([
      true,
      false,
      false,
      false,
    ])
  })

  it('every unreachable state explains itself, and online says nothing', () => {
    expect(unreachableReason(make({ status: 'online' }))).toBe('')
    for (const status of ['not_answering', 'off', 'revoked'] as ComputerStatus[]) {
      expect(unreachableReason(make({ status })).length).toBeGreaterThan(0)
    }
  })
})

describe('the row summary and the page agree', () => {
  it('reads nothing running as words, not as a zero', () => {
    // "0 of 5" is read as a number. This state needs to be read as a problem.
    expect(rowSummary(make({ status: 'online', running_count: 0 }))).toBe('On · nothing running')
  })

  it('counts running agents when some are up', () => {
    expect(rowSummary(make({ status: 'online', running_count: 2, agent_count: 5 }))).toBe(
      'On · 2 of 5 running',
    )
  })

  it('an off machine carries when it was last seen', () => {
    expect(rowSummary(make({ status: 'off', last_seen_at: ago(3 * 86400) }))).toContain('Off · seen')
  })

  it('a machine with no agents says so rather than claiming nothing runs', () => {
    expect(rowSummary(make({ status: 'online', agent_count: 0, running_count: 0 }))).toBe(
      'On · no agents set up here',
    )
  })
})

describe('an agent that died on its own is not merely "stopped"', () => {
  it('gives crashed its own words', () => {
    expect(agentStateLabel('running')).toBe('Running')
    expect(agentStateLabel('stopped')).toBe('Stopped')
    // The distinction is "I turned it off" vs "something went wrong".
    expect(agentStateLabel('crashed')).toBe('Stopped on its own')
    expect(agentStateLabel('crashed')).not.toBe(agentStateLabel('stopped'))
  })
})

describe('the typeable commands match the state they are offered in', () => {
  it('an unreachable machine leads with reconnecting, not with starting agents', () => {
    const section = manualSection(make({ status: 'not_answering' }))
    expect(section.steps[0].command).toBe('clawmeets computer start')
    expect(section.hint).toContain('cannot reach the machine')
  })

  it('a healthy machine offers the per-agent commands, named after a real agent', () => {
    const section = manualSection(make({ status: 'online' }))
    expect(section.steps[0].command).toBe('clawmeets start --agent wine')
  })

  it('a revoked machine is told to pair again', () => {
    const section = manualSection(make({ status: 'revoked' }))
    expect(section.steps[0].command).toBe('clawmeets computer install')
  })

  it('never offers a command with a placeholder the user would copy verbatim', () => {
    const statuses: ComputerStatus[] = ['online', 'not_answering', 'off', 'revoked']
    for (const status of statuses) {
      for (const step of manualSection(make({ status })).steps) {
        expect(step.command).not.toMatch(/XXXX/)
      }
    }
  })

  it('every command uses the visible `computer` verb, never `daemon`', () => {
    const statuses: ComputerStatus[] = ['online', 'not_answering', 'off', 'revoked']
    for (const status of statuses) {
      for (const step of manualSection(make({ status })).steps) {
        expect(step.command).not.toContain('clawmeets daemon')
      }
    }
  })
})

describe('the machine line degrades instead of printing holes', () => {
  it('names both packages with their versions', () => {
    expect(machineMeta(make({ runner_version: '0.9.3', daemon_version: '0.4.1' }))).toContain(
      'clawmeets 0.9.3 · clawmeets-daemon 0.4.1',
    )
  })

  it('assembles what the machine reported', () => {
    expect(machineMeta(base)).toBe('macOS 15.6 · 3 agents set up here · clawmeets-daemon 0.1.0')
  })

  it('survives a machine that could not name its own OS or version', () => {
    const bare = machineMeta(
      make({ platform: '', os_version: '', daemon_version: 'unknown', agent_count: 1 }),
    )
    expect(bare).toBe('1 agent set up here')
    expect(bare).not.toContain('undefined')
  })

  it('matches tense to state', () => {
    expect(lastSeenLine(make({ status: 'online', last_seen_at: ago(1) }))).toContain('Checked in')
    expect(lastSeenLine(make({ status: 'off', last_seen_at: ago(3 * 86400) }))).toContain('Last seen')
    expect(lastSeenLine(make({ last_seen_at: '' }))).toBe('Has not checked in yet')
  })
})

describe('vocabulary', () => {
  it('nothing this module produces says runner, daemon, host or process', () => {
    const statuses: ComputerStatus[] = ['online', 'not_answering', 'off', 'revoked']
    const strings: string[] = []
    for (const status of statuses) {
      for (const running of [0, 1]) {
        const computer = make({ status, running_count: running })
        strings.push(rowSummary(computer), machineMeta(computer), lastSeenLine(computer))
        strings.push(unreachableReason(computer))
        const banner = bannerFor(computer)
        if (banner) strings.push(banner.title, banner.body)
        const section = manualSection(computer)
        strings.push(section.title, section.hint)
        for (const step of section.steps) strings.push(step.label, step.command)
        for (const terminal_enabled of [true, false, null]) {
          strings.push(terminalCardCopy({ ...computer, terminal_enabled }).line)
        }
      }
    }
    strings.push(terminalActiveLine('MacBook Pro'), terminalDropReason(4001), terminalDropReason(1006))
    for (const state of ['running', 'crashed', 'stopped'] as const) {
      strings.push(agentStateLabel(state))
    }
    for (const c of [base, make({ runner_version: null })]) {
      const copy = softwareCardCopy(c)
      strings.push(copy.hint, ...copy.rows.map((r) => r.label))
      if (copy.staleNote) strings.push(copy.staleNote)
    }

    const offenders: string[] = []
    for (const text of strings) {
      // Package names are what installers call them; the ban is on prose.
      const lowered = text.toLowerCase().replaceAll('clawmeets-daemon', '')
      for (const word of BANNED_WORDS) {
        if (lowered.includes(word)) offenders.push(`${word} -> ${text}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the terminal card', () => {
  it('reachability first: an off computer cannot open a shell whatever it last said', () => {
    const copy = terminalCardCopy(make({ status: 'off', terminal_enabled: true }))
    expect(copy.availability).toBe('unreachable')
    expect(copy.line).toBe('Turn this computer on to open a terminal.')
  })

  it('three-valued: on, turned off on the machine, and too old to say', () => {
    expect(terminalCardCopy(make({ terminal_enabled: true })).availability).toBe('on')
    expect(terminalCardCopy(make({ terminal_enabled: false })).availability).toBe('off')
    expect(terminalCardCopy(make({ terminal_enabled: null })).availability).toBe('needs_update')
    expect(terminalCardCopy(make({})).availability).toBe('needs_update')
  })

  it('splits backticked commands out of server copy', () => {
    expect(splitInlineCode('Turn it off with `clawmeets computer terminal disable`.')).toEqual([
      { text: 'Turn it off with ', code: false },
      { text: 'clawmeets computer terminal disable', code: true },
      { text: '.', code: false },
    ])
    expect(splitInlineCode('no code')).toEqual([{ text: 'no code', code: false }])
  })
})

describe('the ClawMeets software card', () => {
  it('shows both versions the machine reported', () => {
    const copy = softwareCardCopy(make({ runner_version: '0.9.3', daemon_version: '0.4.1' }))
    expect(copy.rows).toEqual([
      { label: 'ClawMeets', pkg: 'clawmeets', version: '0.9.3', reported: true },
      { label: 'Connection software', pkg: 'clawmeets-daemon', version: '0.4.1', reported: true },
    ])
    expect(copy.staleNote).toBeNull()
  })

  it('asks for a second update when an older connection cannot report ClawMeets', () => {
    const copy = softwareCardCopy(make({ status: 'online', runner_version: null }))
    expect(copy.rows[0].version).toBe('Not reported')
    expect(machineMeta(make({ runner_version: null }))).not.toContain('Not reported')
    expect(copy.staleNote).toContain('update again')
    // Nothing to act on while the computer cannot be reached.
    expect(softwareCardCopy(make({ status: 'off', runner_version: null })).staleNote).toBeNull()
  })

  it('reports only the outcome of an update', () => {
    const at = { command_id: 'c1', agent: null, finished_at: '' }
    expect(updateOutcome(make({ last_command: { ...at, action: 'start', ok: false, detail: 'x' } }))).toBeNull()
    expect(
      updateOutcome(make({ last_command: { ...at, action: 'update', ok: true, detail: 'clawmeets 1 → 2' } })),
    ).toEqual({ ok: true, line: 'Updated. clawmeets 1 → 2' })
    expect(
      updateOutcome(make({ last_command: { ...at, action: 'update', ok: false, detail: 'no uv' } })),
    ).toEqual({ ok: false, line: "Couldn't update. no uv" })
  })
})

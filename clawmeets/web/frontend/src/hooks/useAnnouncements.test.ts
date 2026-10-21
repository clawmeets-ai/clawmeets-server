import { describe, it, expect } from 'vitest'
import { group } from './useAnnouncements'
import { validateRecords } from '../utils/versionMatch'
import type { Runner } from '../types'

const old1 = { id: 'a1', name: 'runner-alpha', version: '1.2.9' }
const old2 = { id: 'b2', name: 'runner-beta', version: '1.0.0' }
const current = { id: 'c3', name: 'runner-gamma', version: '1.2.10' }
const unknown = { id: 'd4', name: 'runner-delta', version: null }

const UPGRADE = {
  id: 'upgrade-1-2-9',
  target: { clawmeets_version: '<=1.2.9', match_unknown_version: true },
  severity: 'warning',
  title: 'Upgrade clawmeets',
  body: 'Runners on 1.2.9 or older are missing important functionality.',
}

function records(...raw: unknown[]) {
  return validateRecords(raw)
}

describe('group (§4.5)', () => {
  it('produces ONE entry per announcement id, never one per runner', () => {
    const entries = group(records(UPGRADE), [old1, old2, unknown])
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('upgrade-1-2-9')
    expect(entries[0].affected).toHaveLength(3)
  })

  it('omits announcements matching ZERO runners entirely', () => {
    // An entry with an empty `affected` exists only to tempt the renderer into
    // an empty banner, so it never exists.
    const entries = group(records(UPGRADE), [current])
    expect(entries).toEqual([])
  })

  it('holds the affected.length >= 1 invariant on every returned entry', () => {
    const quiet = { ...UPGRADE, id: 'quiet', target: { clawmeets_version: '>=9.0.0' } }
    const entries = group(records(UPGRADE, quiet), [old1, current])
    expect(entries).toHaveLength(1)
    for (const e of entries) expect(e.affected.length).toBeGreaterThanOrEqual(1)
  })

  it('sorts affected by (name, id)', () => {
    const entries = group(records(UPGRADE), [old2, unknown, old1])
    expect(entries[0].affected.map(r => r.name)).toEqual([
      'runner-alpha', 'runner-beta', 'runner-delta',
    ])
  })

  it('breaks a name tie on id', () => {
    // Two agents CAN share a display name.
    const zed = { id: 'z9', name: 'same-name', version: '1.0.0' }
    const abe = { id: 'a0', name: 'same-name', version: '1.0.0' }
    const entries = group(records(UPGRADE), [zed, abe])
    expect(entries[0].affected.map(r => r.id)).toEqual(['a0', 'z9'])
  })

  it('does not mutate the input snapshot while sorting', () => {
    const snapshot = [old2, old1]
    group(records(UPGRADE), snapshot)
    expect(snapshot).toEqual([old2, old1])
  })

  it('carries severity, title and body through unchanged', () => {
    const [e] = group(records(UPGRADE), [old1])
    expect(e.severity).toBe('warning')
    expect(e.title).toBe('Upgrade clawmeets')
    expect(e.body).toBe(UPGRADE.body)
  })

  it('groups several announcements independently', () => {
    const modern = {
      id: 'modern-only',
      target: { clawmeets_version: '>=1.2.10' },
      severity: 'info',
      title: 'Modern',
      body: 'B',
    }
    const entries = group(records(UPGRADE, modern), [old1, current, unknown])
    expect(entries.map(e => e.id)).toEqual(['upgrade-1-2-9', 'modern-only'])
    expect(entries[0].affected.map(r => r.id)).toEqual(['a1', 'd4'])
    expect(entries[1].affected.map(r => r.id)).toEqual(['c3'])
  })

  it('reads defensively — a malformed runner element is skipped, not rendered', () => {
    const dirty = [old1, null, 'nope', { id: 'x' }, { name: 'y' }, 42] as unknown as Runner[]
    const entries = group(records(UPGRADE), dirty)
    expect(entries[0].affected).toEqual([old1])
  })

  it('an announcement with no version constraint reaches every live runner', () => {
    const all = { ...UPGRADE, id: 'all-hands', target: {} }
    const entries = group(records(all), [old1, current, unknown])
    expect(entries[0].affected).toHaveLength(3)
  })

  it('returns [] when there are no live runners at all', () => {
    expect(group(records(UPGRADE), [])).toEqual([])
  })
})

describe('the day-one case, end to end through validate + group', () => {
  it('the seed announcement reaches every null-version runner', () => {
    // Version reporting exists in no released runner, so on day one every live
    // runner reports null. This is the whole feature working or not working.
    const entries = group(records(UPGRADE), [unknown, { id: 'e5', name: 'runner-epsilon', version: null }])
    expect(entries).toHaveLength(1)
    expect(entries[0].affected).toHaveLength(2)
  })
})

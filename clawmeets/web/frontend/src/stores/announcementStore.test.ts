import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  isVisible,
  loadDismissed,
  remainingRunners,
  storageKey,
  useAnnouncementStore,
} from './announcementStore'
import type { AnnouncementEntry } from '../hooks/useAnnouncements'

const A = { id: 'a1', name: 'runner-one', version: '1.2.9' }
const B = { id: 'b2', name: 'runner-two', version: null }

function entry(affected = [A, B]): AnnouncementEntry {
  return {
    id: 'upgrade-1-2-9',
    severity: 'warning',
    title: 'Upgrade clawmeets',
    body: 'Runners on 1.2.9 or older are missing important functionality.',
    affected,
  }
}

beforeEach(() => {
  localStorage.clear()
  useAnnouncementStore.setState({ dismissed: {}, userId: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('storage key isolation', () => {
  it('is per-user, with an anon bucket for logged-out sessions', () => {
    expect(storageKey('u1')).toBe('claw-announcement-dismissed-v2:u1')
    expect(storageKey('u2')).toBe('claw-announcement-dismissed-v2:u2')
    expect(storageKey(null)).toBe('claw-announcement-dismissed-v2:anon')
    expect(storageKey(undefined)).toBe('claw-announcement-dismissed-v2:anon')
    expect(storageKey('')).toBe('claw-announcement-dismissed-v2:anon')
  })

  it('one user\'s dismissed set never leaks into another\'s on a shared browser', () => {
    const store = useAnnouncementStore.getState()
    store.hydrate('u1')
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [A])
    expect(useAnnouncementStore.getState().dismissed).toEqual({ 'upgrade-1-2-9': ['a1'] })

    useAnnouncementStore.getState().hydrate('u2')
    expect(useAnnouncementStore.getState().dismissed).toEqual({})

    // ...and switching back restores u1's set from storage.
    useAnnouncementStore.getState().hydrate('u1')
    expect(useAnnouncementStore.getState().dismissed).toEqual({ 'upgrade-1-2-9': ['a1'] })
  })
})

describe('dismissal is pair-keyed on (agent_id, announcement_id)', () => {
  it('keeps rendering while ANY affected runner is still undismissed', () => {
    const e = entry()
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [A])

    const d = useAnnouncementStore.getState().dismissed
    // "I've seen that my laptop runner is old" must not silence the same
    // warning for a runner the user hasn't seen yet.
    expect(remainingRunners(e, d)).toEqual([B])
    expect(isVisible(e, d)).toBe(true)
  })

  it('hides only once every affected runner is dismissed', () => {
    const e = entry()
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [A, B])

    const d = useAnnouncementStore.getState().dismissed
    expect(remainingRunners(e, d)).toEqual([])
    expect(isVisible(e, d)).toBe(false)
  })

  it('a NEWLY affected runner RESURFACES a previously dismissed banner', () => {
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [A, B])
    const d = useAnnouncementStore.getState().dismissed

    const C = { id: 'c3', name: 'runner-three', version: '1.0.0' }
    expect(isVisible(entry([A, B, C]), d)).toBe(true)
    expect(remainingRunners(entry([A, B, C]), d)).toEqual([C])
  })

  it('a dismissed runner merely RECONNECTING does not', () => {
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [A, B])
    const d = useAnnouncementStore.getState().dismissed

    // Same ids, new snapshot — its id is already in the dismissed set.
    expect(isVisible(entry([A, B]), d)).toBe(false)
  })

  it('dismissal of one announcement does not touch another', () => {
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [A, B])
    const d = useAnnouncementStore.getState().dismissed

    const other: AnnouncementEntry = { ...entry(), id: 'other-announcement' }
    expect(isVisible(other, d)).toBe(true)
  })

  it('unions rather than replaces on a second dismiss', () => {
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [A])
    useAnnouncementStore.getState().dismiss('upgrade-1-2-9', [B])
    expect(useAnnouncementStore.getState().dismissed['upgrade-1-2-9'].sort()).toEqual(['a1', 'b2'])
  })
})

describe('localStorage is guarded everywhere — degrade to "nothing dismissed", never crash', () => {
  it('absent value → {}', () => {
    expect(loadDismissed('nobody')).toEqual({})
  })

  it('corrupt JSON → {}', () => {
    localStorage.setItem(storageKey('u1'), '{not json')
    expect(loadDismissed('u1')).toEqual({})
  })

  it('foreign-shaped JSON → {}', () => {
    localStorage.setItem(storageKey('u1'), '["an","array"]')
    expect(loadDismissed('u1')).toEqual({})
    localStorage.setItem(storageKey('u1'), '"a string"')
    expect(loadDismissed('u1')).toEqual({})
  })

  it('drops non-string members but keeps the rest of a partly-foreign blob', () => {
    localStorage.setItem(storageKey('u1'), JSON.stringify({ x: ['a1', 7, null], y: 'nope' }))
    expect(loadDismissed('u1')).toEqual({ x: ['a1'] })
  })

  it('getItem THROWING (Safari private mode) → {}, no crash', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => loadDismissed('u1')).not.toThrow()
    expect(loadDismissed('u1')).toEqual({})
  })

  it('setItem THROWING (quota) does not crash dismiss, and in-memory state still holds', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    useAnnouncementStore.setState({ userId: 'u1', dismissed: {} })
    expect(() => useAnnouncementStore.getState().dismiss('x', [A])).not.toThrow()
    expect(useAnnouncementStore.getState().dismissed).toEqual({ x: ['a1'] })
  })
})

describe('pruneDeletedAgents — ASYMMETRIC BY DESIGN', () => {
  it('pruneDeletedAgents([]) is a NO-OP', () => {
    // useMyAgents returns [] while loading AND on failure. Acting on that would
    // wipe every dismissal the user has.
    useAnnouncementStore.setState({ userId: 'u1', dismissed: { x: ['a1', 'b2'] } })
    useAnnouncementStore.getState().pruneDeletedAgents([])
    expect(useAnnouncementStore.getState().dismissed).toEqual({ x: ['a1', 'b2'] })
  })

  it('prunes an AGENT that no longer exists', () => {
    // Its id will never be re-issued, so the entry is dead weight.
    useAnnouncementStore.setState({ userId: 'u1', dismissed: { x: ['a1', 'gone'] } })
    useAnnouncementStore.getState().pruneDeletedAgents(['a1', 'b2'])
    expect(useAnnouncementStore.getState().dismissed).toEqual({ x: ['a1'] })
  })

  it('drops a key whose agents are all gone', () => {
    useAnnouncementStore.setState({ userId: 'u1', dismissed: { x: ['gone'], y: ['a1'] } })
    useAnnouncementStore.getState().pruneDeletedAgents(['a1'])
    expect(useAnnouncementStore.getState().dismissed).toEqual({ y: ['a1'] })
  })

  it('does NOT prune an ANNOUNCEMENT absent from the config', () => {
    // It may be absent only because every affected runner is offline; if it
    // comes back, the user's dismissal must come back with it. The roster says
    // nothing about announcement ids, so nothing here may key off them.
    useAnnouncementStore.setState({ userId: 'u1', dismissed: { 'long-gone-announcement': ['a1'] } })
    useAnnouncementStore.getState().pruneDeletedAgents(['a1'])
    expect(useAnnouncementStore.getState().dismissed).toEqual({ 'long-gone-announcement': ['a1'] })
  })

  it('persists the pruned map', () => {
    useAnnouncementStore.setState({ userId: 'u1', dismissed: { x: ['a1', 'gone'] } })
    useAnnouncementStore.getState().pruneDeletedAgents(['a1'])
    expect(loadDismissed('u1')).toEqual({ x: ['a1'] })
  })
})

describe('hydrate', () => {
  it('is a no-op when the user is unchanged (safe in an effect keyed on userId)', () => {
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('x', [A])
    // A second hydrate for the same user must not reload over live state.
    useAnnouncementStore.getState().hydrate('u1')
    expect(useAnnouncementStore.getState().dismissed).toEqual({ x: ['a1'] })
  })
})

describe('reset (§4.8)', () => {
  it('clears in-memory state but deliberately KEEPS the persisted blob', () => {
    useAnnouncementStore.getState().hydrate('u1')
    useAnnouncementStore.getState().dismiss('x', [A])

    useAnnouncementStore.getState().reset()
    expect(useAnnouncementStore.getState().dismissed).toEqual({})
    expect(useAnnouncementStore.getState().userId).toBeNull()

    // Still true for that user on their next login; the key is already
    // per-user, so nothing leaks through storage.
    expect(loadDismissed('u1')).toEqual({ x: ['a1'] })
  })
})

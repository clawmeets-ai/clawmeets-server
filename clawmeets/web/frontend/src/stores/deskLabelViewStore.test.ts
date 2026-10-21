import { beforeEach, describe, expect, it } from 'vitest'
import { storageKey, useDeskLabelViewStore } from './deskLabelViewStore'

const store = () => useDeskLabelViewStore.getState()

beforeEach(() => {
  localStorage.clear()
  store().reset()
})

describe('deskLabelViewStore', () => {
  it('toggleFilter adds, then removes, preserving pick order', () => {
    store().toggleFilter('office')
    store().toggleFilter('next')
    expect(store().filter).toEqual(['office', 'next'])
    store().toggleFilter('office')
    expect(store().filter).toEqual(['next'])
  })

  it('collapsed is a MAP so an explicit un-fold survives a default-folded group', () => {
    // `undefined` means "the owner has not said" and falls through to the
    // group's own default; an explicit `false` is a choice and has to persist.
    store().toggleCollapsed('infra', true)
    expect(store().collapsed.infra).toBe(false)
    store().toggleCollapsed('infra', false)
    expect(store().collapsed.infra).toBe(true)
  })

  it('noteMerge dedupes and applyReconcile drains the hints', () => {
    store().noteMerge('office', 'work')
    store().noteMerge('office', 'work')
    expect(store().mergeHints).toHaveLength(1)
    store().applyReconcile({ group: null, filter: ['work'], matchAll: false, collapsed: {} })
    expect(store().mergeHints).toEqual([])
    expect(store().filter).toEqual(['work'])
  })

  it('persists group / filter / matchAll / collapsed under the per-user key', () => {
    store().hydrate('user-a')
    store().setGroup('context')
    store().toggleFilter('office')
    store().setMatchAll(true)
    store().toggleCollapsed('office', false)

    const raw = localStorage.getItem(storageKey('user-a'))
    expect(raw).toBeTruthy()
    const blob = JSON.parse(raw!)
    expect(blob).toMatchObject({
      group: 'context',
      filter: ['office'],
      matchAll: true,
      collapsed: { office: true },
    })
  })

  it('mergeHints are NEVER stored — a replayed merge would re-apply itself', () => {
    store().hydrate('user-a')
    // Re-pointed from `'state'`, which `setGroup` can no longer be handed.
    store().setGroup('ticket')
    store().noteMerge('office', 'work')
    const blob = JSON.parse(localStorage.getItem(storageKey('user-a'))!)
    expect(blob.mergeHints).toBeUndefined()
    expect(blob.group).toBe('ticket')
    // …and they are gone after a reload.
    store().hydrate('user-b')
    store().hydrate('user-a')
    expect(store().mergeHints).toEqual([])
    expect(store().group).toBe('ticket')
  })

  it("a stored group:'state' loads as 'ticket', NOT as null", () => {
    // The migration, and the reason it is a coercion rather than a reset: the
    // owner asked for lifecycle grouping and there is a real one now. Loading
    // it as null would switch grouping silently off for every owner who had it
    // on — the same outcome the deleted "your last state was deleted" notice
    // reached, by a quieter road. No storage-key bump: this loader already
    // tolerates values it does not recognise.
    localStorage.setItem(
      storageKey('user-c'),
      JSON.stringify({ group: 'state', filter: ['office'], matchAll: false, collapsed: {} }),
    )
    store().hydrate('user-c')
    expect(store().group).toBe('ticket')
    // and nothing else about their view moved
    expect(store().filter).toEqual(['office'])
  })

  it('a blob written before ticket states loads with an EMPTY state filter', () => {
    // `states` is a new key, so every blob on disk is missing it. Absent must
    // mean "every state", never "no state" — the latter empties the plate under
    // a control the owner never set.
    localStorage.setItem(
      storageKey('user-d'),
      JSON.stringify({ group: null, filter: [], matchAll: false, collapsed: {} }),
    )
    store().hydrate('user-d')
    expect(store().states).toEqual([])
  })

  it('toggleState adds then removes, and a foreign stored value is dropped', () => {
    store().hydrate('user-e')
    store().toggleState('working')
    store().toggleState('completed')
    expect(store().states).toEqual(['working', 'completed'])
    store().toggleState('working')
    expect(store().states).toEqual(['completed'])
    // validated against the closed set, not by `typeof`
    localStorage.setItem(
      storageKey('user-f'),
      JSON.stringify({ states: ['working', 'shipped', 7], filter: [], collapsed: {} }),
    )
    store().hydrate('user-f')
    expect(store().states).toEqual(['working'])
  })

  it('clearFilter clears BOTH axes — one button, and the owner means all of it', () => {
    store().hydrate('user-g')
    store().toggleFilter('office')
    store().toggleState('working')
    store().clearFilter()
    expect(store().filter).toEqual([])
    expect(store().states).toEqual([])
  })

  it('a corrupt blob degrades to an empty view rather than throwing', () => {
    localStorage.setItem(storageKey('user-c'), '{ not json')
    expect(() => store().hydrate('user-c')).not.toThrow()
    expect(store().filter).toEqual([])
  })

  it('a foreign-shaped blob is sanitised field by field', () => {
    localStorage.setItem(
      storageKey('user-d'),
      JSON.stringify({ group: 'nonsense', filter: ['ok', 7], matchAll: 'yes', collapsed: [] }),
    )
    store().hydrate('user-d')
    expect(store().group).toBeNull()
    expect(store().filter).toEqual(['ok'])
    expect(store().matchAll).toBe(false)
    expect(store().collapsed).toEqual({})
  })

  it('user B does not inherit user A filter — a shared browser must not leak', () => {
    store().hydrate('user-a')
    store().toggleFilter('office')
    expect(store().filter).toEqual(['office'])

    store().hydrate('user-b')
    expect(store().filter).toEqual([])

    // …and A's is still there when they come back.
    store().hydrate('user-a')
    expect(store().filter).toEqual(['office'])
  })

  it('hydrate is a no-op for the same user, so it is safe in an effect', () => {
    store().hydrate('user-a')
    store().toggleFilter('office')
    store().hydrate('user-a')
    expect(store().filter).toEqual(['office'])
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { useDeskStore } from './deskStore'
import type { DeskSop } from '../api/endpoints/deskSops'
import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * The desk bus's two *paired* one-shots. `requestSop` / `requestTask` each park
 * a record AND pick the right-rail side in the same update — the rail's tab
 * state is local and defaults to To-do, so an SOP parked without the tab would
 * land behind the wrong tab, and a task parked without it would land behind the
 * SOP tab whenever ⌘K's previous pick had flipped it. That pairing is the whole
 * contract ⌘K relies on, and it is invisible from either consumer.
 */

const SOP = { id: 's1', title: 'Weekly reel batch', body: 'Cut reels.' } as DeskSop
const TASK = { id: 't1', text: 'Approve the render budget' } as DeskTodo

beforeEach(() => {
  useDeskStore.setState({ pendingSop: null, pendingTask: null, pendingRailTab: null })
})

describe('deskStore — pending desk items', () => {
  it('parks an SOP on the SOP tab', () => {
    useDeskStore.getState().requestSop(SOP)
    const s = useDeskStore.getState()
    expect(s.pendingSop).toBe(SOP)
    expect(s.pendingRailTab).toBe('sop')
  })

  it('parks a to-do on the To-do tab', () => {
    useDeskStore.getState().requestTask(TASK)
    const s = useDeskStore.getState()
    expect(s.pendingTask).toBe(TASK)
    expect(s.pendingRailTab).toBe('todo')
  })

  it('a task pick overrides a rail tab an earlier SOP pick left behind', () => {
    useDeskStore.getState().requestSop(SOP)
    useDeskStore.getState().requestTask(TASK)
    expect(useDeskStore.getState().pendingRailTab).toBe('todo')
  })

  it('clearing one pending item leaves the other alone', () => {
    useDeskStore.getState().requestSop(SOP)
    useDeskStore.getState().requestTask(TASK)
    useDeskStore.getState().clearPendingTask()
    expect(useDeskStore.getState().pendingTask).toBeNull()
    // Both consumers clear independently — DeskPage owns two separate effects.
    expect(useDeskStore.getState().pendingSop).toBe(SOP)
    useDeskStore.getState().clearPendingSop()
    expect(useDeskStore.getState().pendingSop).toBeNull()
  })
})

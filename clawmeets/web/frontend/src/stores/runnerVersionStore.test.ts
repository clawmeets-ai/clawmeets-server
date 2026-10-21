import { describe, it, expect, beforeEach } from 'vitest'
import { useRunnerVersionStore } from './runnerVersionStore'

const X = { id: 'a1', name: 'runner-one', version: '1.2.9' }
const Y = { id: 'b2', name: 'runner-two', version: null }

beforeEach(() => {
  useRunnerVersionStore.setState({ runners: null })
})

describe('apply — REPLACE, NEVER MERGE', () => {
  it('apply([X,Y]) then apply([Y]) leaves exactly [Y]', () => {
    // A merge-by-id "improvement" resurrects stale runners forever: X is
    // OFFLINE in the second snapshot, not still-present-but-unmentioned.
    useRunnerVersionStore.getState().apply({ runners: [X, Y] })
    expect(useRunnerVersionStore.getState().runners).toEqual([X, Y])

    useRunnerVersionStore.getState().apply({ runners: [Y] })
    expect(useRunnerVersionStore.getState().runners).toEqual([Y])
  })

  it('accepts an affirmative empty snapshot', () => {
    useRunnerVersionStore.getState().apply({ runners: [X] })
    useRunnerVersionStore.getState().apply({ runners: [] })
    expect(useRunnerVersionStore.getState().runners).toEqual([])
  })
})

describe('apply — a malformed payload leaves state UNTOUCHED (the erase-bug guard)', () => {
  // The server sends NO ENVELOPE AT ALL when an update push fails internally,
  // precisely so a transient error cannot erase banners that are still true.
  // Every case below starts from a POPULATED list, because "it did not throw"
  // is not the property under test — "it did not erase" is.
  const malformed: unknown[] = [
    {},                        // no `runners` key
    { runners: null },
    { runners: 'nope' },
    { runners: 42 },
    { runners: { a: 1 } },     // object, not array
    null,
    undefined,
    'nope',
    42,
  ]

  for (const payload of malformed) {
    it(`ignores ${JSON.stringify(payload) ?? 'undefined'} without erasing a populated list`, () => {
      useRunnerVersionStore.getState().apply({ runners: [X, Y] })
      useRunnerVersionStore.getState().apply(payload)
      expect(useRunnerVersionStore.getState().runners).toEqual([X, Y])
    })
  }

  it('does not hydrate a never-hydrated store either', () => {
    useRunnerVersionStore.getState().apply({})
    expect(useRunnerVersionStore.getState().runners).toBeNull()
  })
})

describe('null (never hydrated) vs [] (server said none)', () => {
  it('are distinguishable', () => {
    // The distinction is what makes "no envelope means keep what you have"
    // expressible, and it is what the banner renders nothing on.
    expect(useRunnerVersionStore.getState().runners).toBeNull()

    useRunnerVersionStore.getState().apply({ runners: [] })
    const after = useRunnerVersionStore.getState().runners
    expect(after).not.toBeNull()
    expect(after).toEqual([])
  })
})

describe('reset (§4.8)', () => {
  it('returns to null, NOT []', () => {
    // After a logout we genuinely have not been told anything; `[]` would
    // assert "this user has zero live runners".
    useRunnerVersionStore.getState().apply({ runners: [X] })
    useRunnerVersionStore.getState().reset()
    expect(useRunnerVersionStore.getState().runners).toBeNull()
  })
})

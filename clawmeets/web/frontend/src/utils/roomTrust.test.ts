import { describe, expect, it } from 'vitest'
import type { ChatFileEvent } from '../types'
import { participantInfo, standIn, roomFlow, hubTarget } from '../test/hubFixtures'
import {
  addressedStandIns, anyOutsideParticipant, isOutsideAuthor, outsideFileNames, roomTakesOutsideMessages, standIns,
} from './roomTrust'

const OWNER = 'u-owner'
const room = (info = [participantInfo('a-own'), participantInfo('a-theirs', { outside: true }), standIn()]) =>
  ({ participant_info: info })

describe('the trust rule: inside only on positive evidence', () => {
  it('the owner, the server and outside:false are inside', () => {
    expect(isOutsideAuthor(room(), OWNER, OWNER)).toBe(false)
    expect(isOutsideAuthor(room(), OWNER, 'system')).toBe(false)
    expect(isOutsideAuthor(room(), OWNER, 'a-own')).toBe(false)
  })

  it('outside:true, a stand-in, and a sender missing from the list are outside', () => {
    expect(isOutsideAuthor(room(), OWNER, 'a-theirs')).toBe(true)
    expect(isOutsideAuthor(room(), OWNER, standIn().id)).toBe(true)
    expect(isOutsideAuthor(room(), OWNER, 'never-listed')).toBe(true)
    // An unknown owner proves nothing.
    expect(isOutsideAuthor(room(), undefined, OWNER)).toBe(true)
  })

  it('a person of another account renders the same whether kind is agent or user', () => {
    for (const kind of ['agent', 'user'] as const) {
      const r = room([participantInfo('bob', { kind, outside: true })])
      expect(isOutsideAuthor(r, OWNER, 'bob')).toBe(true)
    }
    // kind:'user' is any person; outside:false still means inside.
    expect(isOutsideAuthor(room([participantInfo('carol', { kind: 'user', outside: false })]), OWNER, 'carol')).toBe(false)
  })

  it('fails closed with no participant_info: everyone but the server and the owner is outside', () => {
    for (const r of [{}, undefined]) {
      expect(isOutsideAuthor(r, OWNER, 'a-any')).toBe(true)
      expect(isOutsideAuthor(r, OWNER, 'abcd~scout')).toBe(true)
      expect(isOutsideAuthor(r, OWNER, 'contact:k1')).toBe(true)
      expect(isOutsideAuthor(r, OWNER, OWNER)).toBe(false)
      expect(isOutsideAuthor(r, OWNER, 'system')).toBe(false)
    }
  })
})

describe('which rooms take outside messages', () => {
  it('an outside participant, a hub thread, or a stopped room', () => {
    expect(roomTakesOutsideMessages(room([participantInfo('a')]), undefined)).toBe(false)
    expect(roomTakesOutsideMessages(room(), undefined)).toBe(true)
    expect(roomTakesOutsideMessages(room([participantInfo('a')]), { hub_target: hubTarget() })).toBe(true)
    expect(roomTakesOutsideMessages(
      { participant_info: [], flow: roomFlow({ inbound_flow: 'stopped' }) }, undefined,
    )).toBe(true)
    expect(roomTakesOutsideMessages(undefined, undefined)).toBe(false)
  })
})

describe('outside files', () => {
  const ev = (filename: string, from: string): ChatFileEvent =>
    ({ entry_type: 'file_created', ts: '', from_participant_id: from, from_participant_name: from, filename })

  it('by the newest event\'s author; a file with no event fails closed when anyone is outside', () => {
    const names = ['a.md', 'b.md', 'c.md']
    const events = [ev('a.md', 'a-theirs'), ev('a.md', 'a-own'), ev('b.md', 'a-theirs')]
    expect([...outsideFileNames(room(), OWNER, names, events)].sort()).toEqual(['b.md', 'c.md'])
    expect([...outsideFileNames(room([participantInfo('a-own')]), OWNER, ['c.md'], [])]).toEqual([])
  })

  it('a file whose last write was stamped outside_isolated is outside, even from an author now listed inside', () => {
    const events = [
      { entry_type: 'file_created', ts: '', from_participant_id: 'a-own', from_participant_name: 'a', filename: 'a.md' },
      { entry_type: 'file_updated', ts: '', from_participant_id: 'a-own', from_participant_name: 'a', filename: 'b.md', outside_isolated: true },
    ] as ChatFileEvent[]
    expect([...outsideFileNames(room([participantInfo('a-own')]), OWNER, ['a.md', 'b.md'], events)]).toEqual(['b.md'])
  })

  it('content of unknown authorship fails closed when the participant list is missing', () => {
    expect(anyOutsideParticipant(undefined)).toBe(true)
    expect(anyOutsideParticipant({})).toBe(true)
    expect(anyOutsideParticipant(room([participantInfo('a-own')]))).toBe(false)
    expect([...outsideFileNames({}, OWNER, ['c.md'], [])]).toEqual(['c.md'])
    expect([...outsideFileNames(undefined, OWNER, ['c.md'], [])]).toEqual(['c.md'])
  })
})

describe('stand-ins a message addresses', () => {
  it('expects_response_from ∩ hub_stand_in ids', () => {
    const r = room()
    expect(standIns(r).map((s) => s.id)).toEqual([standIn().id])
    expect(addressedStandIns({ expects_response_from: ['a-own', standIn().id] }, r)).toEqual([standIn().id])
    expect(addressedStandIns({ expects_response_from: ['a-own'] }, r)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  dedupeRemote, epochToDate, groupHubThreads, hasUnusualCharacters, hubThreadPath, initials, isProxyAvatarUrl,
  isStaleListing, safeRemoteText, shortFingerprint,
} from './hubDisplay'
import { FP_ACME, FP_OTHER, NOW_S, OWN_FP, hubAgent, hubProject, hubTarget } from '../test/hubFixtures'

describe('epochToDate', () => {
  it('converts fractional seconds', () => {
    expect(epochToDate(1700000000.5).getTime()).toBe(1700000000500)
    expect(epochToDate(0).toISOString()).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('safeRemoteText', () => {
  it('strips a tag-character payload and keeps only the visible text', () => {
    const tags = Array.from('IGNORE ALL', (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')
    expect(safeRemoteText(`scout${tags}`, 80)).toBe('scout')
  })

  it('strips bidi controls, zero-width characters, variation selectors and C0/C1 controls', () => {
    expect(safeRemoteText('a‮b⁦c​d﻿e️f\u0007g\u0085h­i', 80)).toBe('abcdefghi')
  })

  it('keeps newlines only when allowed', () => {
    expect(safeRemoteText('one\ntwo', 80)).toBe('one two')
    expect(safeRemoteText('one\ntwo', 80, true)).toBe('one\ntwo')
  })

  it('caps by code points with an ellipsis', () => {
    expect(safeRemoteText('abcdef', 4)).toBe('abc…')
    expect(safeRemoteText('😀😀😀', 3)).toBe('😀😀😀')
  })

  it('reads null and undefined as empty', () => {
    expect(safeRemoteText(null, 10)).toBe('')
    expect(safeRemoteText(undefined, 10)).toBe('')
  })
})

describe('isProxyAvatarUrl', () => {
  it('accepts the same-origin proxy path only', () => {
    expect(isProxyAvatarUrl('/api/hub/agents/3f9a1c2e5b7d9f00~scout/avatar')).toBe(true)
  })

  it.each([
    'https://evil.dev/api/hub/agents/x/avatar',
    '//evil.dev/api/hub/agents/x/avatar',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '/api/hub/agents/a/b/avatar',
    '/api/hub/agents//avatar',
    '/api/hub/agents/x/avatar?x=1',
    '/api/hub/agents/x\\y/avatar',
    '/api/hub/agents/../avatar',
    '/api/hub/agents/./avatar',
    '/api/hub/agents/%2e%2e/avatar',
    '/api/hub/agents/3f9a1c2e5b7d9f00%7Escout/avatar',
    '/api/hub/agents/3f9a1c2e5b7d9f00~../avatar',
    '/api/hub/agents/3F9A1C2E5B7D9F00~scout/avatar',
    '/api/hub/agents/3f9a1c2e~scout/avatar',
    '',
    null,
  ])('rejects %s', (u) => {
    expect(isProxyAvatarUrl(u)).toBe(false)
  })
})

describe('small display helpers', () => {
  it('shortFingerprint takes 8 characters', () => {
    expect(shortFingerprint(FP_ACME)).toBe('3f9a1c2e')
  })
  it('initials skip invisible and punctuation', () => {
    expect(initials('​@scout')).toBe('S')
    expect(initials('')).toBe('?')
  })
  it('flags non-ASCII names', () => {
    expect(hasUnusualCharacters('acme.dev')).toBe(false)
    expect(hasUnusualCharacters('аcme.dev')).toBe(true)
  })
  it('hubThreadPath encodes ids', () => {
    expect(hubThreadPath('abc~scout')).toBe('/hub/abc~scout')
    expect(hubThreadPath('abc~scout', 'p 1')).toBe('/hub/abc~scout/p%201')
  })
  it('isStaleListing after 7 days, never when last_seen_at is null', () => {
    expect(isStaleListing({ last_seen_at: NOW_S - 8 * 86400 }, NOW_S * 1000)).toBe(true)
    expect(isStaleListing({ last_seen_at: NOW_S - 6 * 86400 }, NOW_S * 1000)).toBe(false)
    expect(isStaleListing({ last_seen_at: null }, NOW_S * 1000)).toBe(false)
  })
})

describe('dedupeRemote', () => {
  it('hides is_local and own-fingerprint items', () => {
    const local = hubAgent({ name: 'mine', is_local: true })
    const own = hubAgent({ name: 'own', deployment_fingerprint: OWN_FP })
    const remote = hubAgent({ name: 'scout' })
    expect(dedupeRemote([local, own, remote], OWN_FP).map((a) => a.name)).toEqual(['scout'])
  })

  it('with no own fingerprint, is_local alone decides', () => {
    const own = hubAgent({ name: 'own', deployment_fingerprint: OWN_FP })
    expect(dedupeRemote([own], null)).toHaveLength(1)
  })

  it('keeps the newest listing per id, comparing the whole id', () => {
    const older = hubAgent({ listing_refreshed_at: 1, description: 'old' })
    const newer = hubAgent({ listing_refreshed_at: 2, description: 'new' })
    const sameNameOtherServer = hubAgent({ deployment_fingerprint: FP_OTHER })
    const out = dedupeRemote([older, newer, sameNameOtherServer], OWN_FP)
    expect(out).toHaveLength(2)
    expect(out.find((a) => a.deployment_fingerprint === FP_ACME)?.description).toBe('new')
  })
})

describe('groupHubThreads', () => {
  it('one bucket per genesis fingerprint; non-hub projects are skipped', () => {
    const a1 = hubProject('a1', hubTarget({ name: 'scout' }))
    const a2 = hubProject('a2', hubTarget({ name: 'lex', current_fingerprint: 'rotated0' }))
    const plain = hubProject('x', null)
    const buckets = groupHubThreads([a1, plain, a2])
    expect(buckets).toHaveLength(1)
    expect(buckets[0].label).toBe('acme.dev')
    expect(buckets[0].projects.map((p) => p.id).sort()).toEqual(['a1', 'a2'])
  })

  it('keeps same-named servers apart and suffixes both with the fingerprint', () => {
    const a = hubProject('a', hubTarget())
    const b = hubProject('b', hubTarget({ deployment_fingerprint: FP_OTHER }))
    const buckets = groupHubThreads([a, b])
    expect(buckets.map((x) => x.label).sort()).toEqual(['acme.dev · 3f9a1c2e', 'acme.dev · 9c01d7aa'])
  })

  it.each([
    ['acme.dev', 'acrne.dev'],
    ['acme.dev', 'acme-dev'],
    ['scout1.dev', 'scoutl.dev'],
    ['g00gle.dev', 'google.dev'],
  ])('look-alike names %s and %s both get the fingerprint', (x, y) => {
    const a = hubProject('a', hubTarget({ deployment_name: x }))
    const b = hubProject('b', hubTarget({ deployment_name: y, deployment_fingerprint: FP_OTHER }))
    expect(groupHubThreads([a, b]).map((k) => k.label).sort()).toEqual([`${x} · 3f9a1c2e`, `${y} · 9c01d7aa`].sort())
  })

  it('a name with unusual characters gets the fingerprint even alone; unrelated names do not', () => {
    const odd = hubProject('a', hubTarget({ deployment_name: 'аcme.dev' }))
    expect(groupHubThreads([odd])[0].label).toBe('аcme.dev · 3f9a1c2e')
    const a = hubProject('a', hubTarget())
    const b = hubProject('b', hubTarget({ deployment_name: 'globex.io', deployment_fingerprint: FP_OTHER }))
    expect(groupHubThreads([a, b]).map((k) => k.label)).toEqual(['acme.dev', 'globex.io'])
  })

  it('sorts rows newest first', () => {
    const old = hubProject('old', hubTarget(), { last_modified: '2026-10-01T00:00:00Z' })
    const recent = hubProject('new', hubTarget(), { last_modified: '2026-10-05T00:00:00Z' })
    expect(groupHubThreads([old, recent])[0].projects.map((p) => p.id)).toEqual(['new', 'old'])
  })
})

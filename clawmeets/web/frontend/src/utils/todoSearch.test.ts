import { describe, expect, it } from 'vitest'
import type { DeskTodo } from '../api/endpoints/deskTodos'
import { matchesTodoSearch, todoQueryTokens, todoSearchFields } from './todoSearch'

const T = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't1',
  owner_user_id: 'u1',
  text: 'Chase the Provi PO',
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  attachments: [],
  ...over,
})

describe('todoQueryTokens', () => {
  it('strips a leading @ so a half-typed label token still searches', () => {
    // The rail's box is also the label autocomplete's input, so `@office` is a
    // normal thing to find mid-query. It has to reach the `office` slug.
    expect(todoQueryTokens('@office')).toEqual(['office'])
    expect(todoQueryTokens('#office')).toEqual(['office'])
    expect(todoQueryTokens('chase @provi')).toEqual(['chase', 'provi'])
  })

  it('drops a bare sigil rather than emitting an empty token', () => {
    // An empty token is a substring of everything, so leaving one in would
    // make `@` alone silently match the whole plate — harmless here, but the
    // same slip in an AND chain is how a filter stops filtering.
    expect(todoQueryTokens('@')).toEqual([])
    expect(todoQueryTokens('chase @')).toEqual(['chase'])
  })
})

describe('todoSearchFields', () => {
  it('covers exactly the text the row paints', () => {
    const t = T({
      draft_recipient_name: 'cara-ops',
      labels: ['office', 'urgent'],
    })
    expect(todoSearchFields(t)).toEqual([
      'Chase the Provi PO',
      'cara-ops',
      'office',
      'urgent',
    ])
  })

  it('excludes the draft prompt', () => {
    // THE RULE: a field is searchable only if a hit in it is VISIBLE on the
    // row. Matching a hidden blob leaves a row on screen with no matching word
    // anywhere on it, which reads as the search being broken.
    const t = T({ draft_prompt: 'zebra' })
    expect(matchesTodoSearch(t, todoQueryTokens('zebra'))).toBe(false)
  })
})

describe('matchesTodoSearch', () => {
  it('matches every word in any order', () => {
    const t = T()
    expect(matchesTodoSearch(t, todoQueryTokens('provi po'))).toBe(true)
    expect(matchesTodoSearch(t, todoQueryTokens('po prov'))).toBe(true)
    expect(matchesTodoSearch(t, todoQueryTokens('provi zzz'))).toBe(false)
  })

  it('reaches the draft recipient and the label slugs', () => {
    const t = T({ draft_recipient_name: 'ana-analyst', labels: ['office'] })
    expect(matchesTodoSearch(t, todoQueryTokens('analyst'))).toBe(true)
    expect(matchesTodoSearch(t, todoQueryTokens('@office'))).toBe(true)
    expect(matchesTodoSearch(t, todoQueryTokens('chase office'))).toBe(true)
  })

  it('survives a row with no labels and no agents', () => {
    expect(matchesTodoSearch(T(), todoQueryTokens('chase'))).toBe(true)
  })

  it('keeps every row when nothing is typed', () => {
    expect(matchesTodoSearch(T(), todoQueryTokens(''))).toBe(true)
  })
})

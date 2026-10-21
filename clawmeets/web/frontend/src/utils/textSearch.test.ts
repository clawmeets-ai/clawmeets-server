import { describe, expect, it } from 'vitest'
import { matchesTokens, searchTokens } from './textSearch'

/**
 * WHAT A TYPED QUERY MEANS, pinned once. Both rails share this module
 * precisely so `marketing ig` cannot come to mean two different things on two
 * tabs of the same panel, so the semantics belong in one test file rather than
 * re-asserted per component.
 */
describe('searchTokens', () => {
  it('splits on any run of whitespace and lowercases', () => {
    expect(searchTokens('  Marketing   IG\tcontent ')).toEqual(['marketing', 'ig', 'content'])
  })

  it('gives an empty list for an empty or blank query', () => {
    expect(searchTokens('')).toEqual([])
    expect(searchTokens('   ')).toEqual([])
  })
})

describe('matchesTokens', () => {
  const FIELDS = ['Marketing:product IG content', 'ana-editor', 'Post {{Count}} reels']

  it('matches every word in any order, as a substring', () => {
    expect(matchesTokens(FIELDS, searchTokens('marketing ig'))).toBe(true)
    expect(matchesTokens(FIELDS, searchTokens('ig marketing'))).toBe(true)
    // Partial words count — this is what makes it feel live as you type.
    expect(matchesTokens(FIELDS, searchTokens('mark ig'))).toBe(true)
  })

  it('is AND, not OR — one unmatched word rejects the row', () => {
    // The behaviour the whole design rests on: a second word NARROWS. Under OR
    // every extra keystroke would widen the results, which reads as broken.
    expect(matchesTokens(FIELDS, searchTokens('marketing zzz'))).toBe(false)
  })

  it('searches across every field, not just the first', () => {
    expect(matchesTokens(FIELDS, searchTokens('editor'))).toBe(true)
    expect(matchesTokens(FIELDS, searchTokens('reels'))).toBe(true)
    expect(matchesTokens(FIELDS, searchTokens('editor reels'))).toBe(true)
  })

  it('never lets a token span two fields', () => {
    // Fields are joined to search them, so the join character matters: a token
    // can contain no whitespace, which is exactly what stops "contentana" from
    // matching across the seam between field 1 and field 2.
    expect(matchesTokens(FIELDS, searchTokens('contentana'))).toBe(false)
  })

  it('ignores null and undefined fields rather than matching "null"', () => {
    expect(matchesTokens(['title', null, undefined], searchTokens('null'))).toBe(false)
    expect(matchesTokens(['title', null, undefined], searchTokens('title'))).toBe(true)
  })

  it('matches everything on an empty token list', () => {
    // Lets a caller pass an unsearched query straight through with no branch.
    expect(matchesTokens([], [])).toBe(true)
    expect(matchesTokens(FIELDS, searchTokens('  '))).toBe(true)
  })
})

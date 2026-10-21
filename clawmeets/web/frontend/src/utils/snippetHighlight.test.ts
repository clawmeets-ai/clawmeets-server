import { describe, expect, it } from 'vitest'
import { splitSnippet } from './snippetHighlight'

/**
 * SEARCH_API_CONTRACT.md §3.5. The offsets are UTF-16 code-unit indices, which
 * is the whole reason this is a util with tests rather than three lines inline:
 * get the index space wrong and every highlight after an emoji is off by one.
 */
describe('splitSnippet', () => {
  it('splits around a single match', () => {
    expect(splitSnippet('a recency weight', [[2, 9]])).toEqual([
      { text: 'a ', match: false },
      { text: 'recency', match: true },
      { text: ' weight', match: false },
    ])
  })

  it('handles two adjacent ranges with no gap between them', () => {
    expect(splitSnippet('recency weight', [[0, 7], [8, 14]])).toEqual([
      { text: 'recency', match: true },
      { text: ' ', match: false },
      { text: 'weight', match: true },
    ])
  })

  it('treats empty offsets as plain text, not as an error', () => {
    expect(splitSnippet('nothing matched literally', [])).toEqual([
      { text: 'nothing matched literally', match: false },
    ])
  })

  it('indexes in UTF-16 code units, so an astral prefix does not shift the match', () => {
    // Two emoji (2 code units each) then "hit" — the contract's worked case.
    // Code-POINT indexing would say the match starts at 2 and slice "🎉h".
    const snippet = '🎉🎉hit'
    expect(splitSnippet(snippet, [[4, 7]])).toEqual([
      { text: '🎉🎉', match: false },
      { text: 'hit', match: true },
    ])
    expect(snippet.slice(4, 7)).toBe('hit')
  })

  it('emits the trailing tail after the last range', () => {
    expect(splitSnippet('abcdef', [[0, 2]])).toEqual([
      { text: 'ab', match: true },
      { text: 'cdef', match: false },
    ])
  })

  it('degrades to plain text on a malformed payload instead of throwing', () => {
    // Out of range, backwards, and zero-width ranges all get dropped rather
    // than producing a scrambled render inside the palette.
    expect(splitSnippet('abc', [[1, 99]])).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
    ])
    expect(splitSnippet('abc', [[2, 3], [0, 1]])).toEqual([
      { text: 'ab', match: false },
      { text: 'c', match: true },
    ])
    expect(splitSnippet('abc', [[1, 1]])).toEqual([{ text: 'abc', match: false }])
  })
})

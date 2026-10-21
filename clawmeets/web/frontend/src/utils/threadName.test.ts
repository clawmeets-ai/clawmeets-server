import { describe, expect, it } from 'vitest'
import {
  THREAD_NAME_MAX_LENGTH,
  normalizeThreadName,
  threadNameErrorMessage,
  threadNameLength,
  validateThreadName,
} from './threadName'

/**
 * These are contract tests against `clawmeets/models/project.py`, not unit
 * tests of a local helper. Every case here has a counterpart on the server; if
 * one side changes, this file is where the drift should show up first.
 *
 * Every special character is written as a `\u` escape on purpose. The subject
 * matter is invisible characters -- a literal copy would be unreadable here and
 * in every diff, exactly as the server's own comment says about its bidi set.
 */

// A single-code-point emoji (U+1F642) -- two UTF-16 units. That gap is the
// whole point of the boundary cases below.
const EMOJI = '\u{1F642}'

describe('threadNameLength', () => {
  it('counts code points, not UTF-16 units', () => {
    const name = `${EMOJI.repeat(3)} standup`
    // `.length` counts the 3 emoji as 6 surrogate halves (14 total);
    // Python's len() -- and we -- count them as 3 characters (11 total).
    expect(name.length).toBe(14)
    expect(threadNameLength(name)).toBe(11)
  })

  it('measures the NORMALIZED value, which is what the server stores', () => {
    // The trailing space and the doubled interior space are normalized away
    // before anything is counted, so the counter can never show a number the
    // server would disagree with.
    expect(threadNameLength('  Trip   plan  ')).toBe(threadNameLength('Trip plan'))
    expect(threadNameLength('  Trip   plan  ')).toBe(9)
  })

  it('counts a combining sequence as the one code point NFC folds it to', () => {
    const decomposed = 'cafe\u0301' // 'e' + COMBINING ACUTE ACCENT
    expect(decomposed.length).toBe(5)
    expect(threadNameLength(decomposed)).toBe(4)
    expect(normalizeThreadName(decomposed)).toBe('caf\u00e9')
  })
})

describe('normalizeThreadName', () => {
  it('collapses whitespace runs and trims both ends', () => {
    expect(normalizeThreadName('  Trip   plan \n')).toBe('Trip plan')
  })

  it('turns a whitespace control into a space rather than deleting it', () => {
    // The server's ratified plan had this backwards, and backend caught it:
    // tab and newline ARE Cc, so stripping every control BEFORE collapsing
    // whitespace glues the words together ("Trip<TAB>plan" -> "Tripplan").
    // Both sides strip only the NON-whitespace controls. U+001C is the same
    // case one step further out -- Python's str.isspace() treats it as
    // whitespace but JS's \s does not, which is why this module spells its
    // whitespace class out instead of using \s.
    expect(normalizeThreadName('Trip\tplan')).toBe('Trip plan')
    expect(normalizeThreadName('Trip\u001cplan')).toBe('Trip plan')
  })

  it('deletes non-whitespace control characters outright', () => {
    expect(normalizeThreadName('Trip\u0007plan')).toBe('Tripplan')
  })

  it('strips bidi overrides, which render as nothing but reorder the text', () => {
    expect(normalizeThreadName('\u202eTrip plan\u202c')).toBe('Trip plan')
  })

  it('preserves ZWJ and VS16, so emoji sequences survive intact', () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'
    expect(normalizeThreadName(family + ' trip')).toBe(family + ' trip')
    expect(normalizeThreadName('\u2764\ufe0f')).toBe('\u2764\ufe0f')
  })
})

describe('validateThreadName', () => {
  it('rejects empty and whitespace-only, including the ideographic space', () => {
    expect(validateThreadName('')).toBe('empty')
    expect(validateThreadName('   ')).toBe('empty')
    expect(validateThreadName('\u3000\u3000')).toBe('empty')
    expect(validateThreadName('\t\n')).toBe('empty')
  })

  it('checks empty before length', () => {
    // A name made only of bidi overrides normalizes to '' -- 'empty', and
    // never a pass.
    expect(validateThreadName('\u202e\u202c')).toBe('empty')
  })

  // The regression guard this milestone asked for by name. A `.length`-based
  // implementation passes both ASCII rows and FAILS the emoji accept-case,
  // because 60 emoji is 120 UTF-16 units -- a length the server accepts.
  it.each([
    ['ASCII', 'a'],
    ['emoji', EMOJI],
    ['CJK', '\u6f22'],
  ])('accepts exactly 60 %s and rejects 61', (_label, ch) => {
    const at60 = ch.repeat(60)
    const at61 = ch.repeat(61)

    expect(threadNameLength(at60)).toBe(THREAD_NAME_MAX_LENGTH)
    expect(validateThreadName(at60)).toBeNull()

    expect(threadNameLength(at61)).toBe(THREAD_NAME_MAX_LENGTH + 1)
    expect(validateThreadName(at61)).toBe('too_long')
  })

  it('measures length after normalization, not before', () => {
    // 61 code points of raw input, but the doubled space collapses to one, so
    // the value the server stores is exactly 60 and must be accepted.
    const raw = 'a'.repeat(30) + '  ' + 'b'.repeat(29)
    expect([...raw].length).toBe(61)
    expect(threadNameLength(raw)).toBe(60)
    expect(validateThreadName(raw)).toBeNull()
  })
})

describe('threadNameErrorMessage', () => {
  it('interpolates the constant rather than re-literalling the number', () => {
    expect(threadNameErrorMessage('too_long')).toBe(
      `Thread name must be ${THREAD_NAME_MAX_LENGTH} characters or fewer.`,
    )
    expect(threadNameErrorMessage('too_long')).toContain('60')
    expect(threadNameErrorMessage('empty')).toBe('Thread name cannot be empty.')
  })
})

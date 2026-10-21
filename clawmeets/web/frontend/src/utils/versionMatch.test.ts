import { describe, it, expect } from 'vitest'
import {
  compareTriple,
  parseSpec,
  parseVersion,
  validateRecords,
  versionMatches,
} from './versionMatch'

describe('parseVersion (§4.1) — strict triple, everything else is UNKNOWN', () => {
  it('parses a clean major.minor.patch triple', () => {
    expect(parseVersion('1.2.10')).toEqual([1, 2, 10])
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0])
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30])
  })

  it('returns null — meaning UNKNOWN, not "zero" and not "invalid" — for everything else', () => {
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('1.2.11.dev3')).toBeNull()
    expect(parseVersion('1.2.10+local')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(null)).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
    expect(parseVersion('v1.2.3')).toBeNull()
    expect(parseVersion(' 1.2.3 ')).toBeNull()
    expect(parseVersion('9f3c1ab')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
  })
})

describe('compareTriple', () => {
  it('compares componentwise: major, then minor, then patch', () => {
    expect(compareTriple([1, 2, 10], [1, 2, 9])).toBeGreaterThan(0)
    expect(compareTriple([1, 2, 9], [1, 2, 10])).toBeLessThan(0)
    expect(compareTriple([1, 3, 0], [1, 2, 99])).toBeGreaterThan(0)
    expect(compareTriple([2, 0, 0], [1, 99, 99])).toBeGreaterThan(0)
    expect(compareTriple([1, 2, 3], [1, 2, 3])).toBe(0)
  })
})

describe('versionMatches (§4.3)', () => {
  // ==========================================================================
  // MANDATORY NAMED TEST (a) — the lexical-compare trap.
  // ==========================================================================
  it('"1.2.10" does NOT match "<=1.2.9" — numeric triple, not string compare', () => {
    // The correct answer: 1.2.10 is NEWER than 1.2.9, so it is not "1.2.9 or older".
    expect(versionMatches({ clawmeets_version: '<=1.2.9' }, '1.2.10')).toBe(false)

    // The lexical answer, asserted right here on purpose. As STRINGS, "1.2.10"
    // sorts BEFORE "1.2.9" ('1' < '9' at the first differing character), so a
    // string compare says 1.2.10 satisfies "<=1.2.9" — the exact opposite of
    // the truth, and 1.2.10 is a CURRENT RELEASE. If someone rewrites
    // compareTriple as a string compare, the assertion above fails and THIS
    // line is sitting next to it with the explanation already attached.
    expect('1.2.10' < '1.2.9').toBe(true)

    // The same trap in the other direction, so neither polarity slips through.
    expect(versionMatches({ clawmeets_version: '<=1.2.9' }, '1.2.9')).toBe(true)
    expect(versionMatches({ clawmeets_version: '<=1.2.9' }, '1.2.8')).toBe(true)
    expect(versionMatches({ clawmeets_version: '>=1.2.10' }, '1.2.9')).toBe(false)
  })

  // ==========================================================================
  // MANDATORY NAMED TEST (b) — the branch that makes day one work.
  // ==========================================================================
  describe('match_unknown_version — the branch that makes day one work', () => {
    // WHY THIS BRANCH EXISTS, and why deleting it is silent:
    //
    // Version reporting exists in NO RELEASED RUNNER. On day one every live
    // runner therefore reports `version: null`. Branch 2 of versionMatches is
    // the ONLY thing that lets an announcement reach them. Delete it and
    // `upgrade-1-2-9` — the seed announcement, the entire point of the feature
    // — reaches EXACTLY ZERO of its intended targets, while every other test in
    // this file still passes green. Same failure signature as a banner that
    // never renders: nothing is red, nothing is logged, nothing ships.
    //
    // It must also sit ABOVE the comparison branch: a null version has no
    // triple to compare, so any ordering that reaches branch 3 first has
    // already lost.

    it('true makes a null-version runner match', () => {
      expect(
        versionMatches({ clawmeets_version: '<=1.2.9', match_unknown_version: true }, null),
      ).toBe(true)
    })

    it('absent does not match', () => {
      expect(versionMatches({ clawmeets_version: '<=1.2.9' }, null)).toBe(false)
    })

    it('explicit false does not match', () => {
      expect(
        versionMatches({ clawmeets_version: '<=1.2.9', match_unknown_version: false }, null),
      ).toBe(false)
    })

    it('an unparseable reported version behaves identically to null (§7 limitation 3)', () => {
      // Documented, NOT fixed: non-triple versions parse as unknown and, under
      // match_unknown_version, MATCH. Noise on source installs, correct
      // direction for everyone else.
      for (const reported of ['1.2.11.dev3', '1.2.10+local', '1.2', '', 'deadbee']) {
        expect(
          versionMatches({ clawmeets_version: '<=1.2.9', match_unknown_version: true }, reported),
        ).toBe(true)
        expect(versionMatches({ clawmeets_version: '<=1.2.9' }, reported)).toBe(false)
      }
    })
  })

  describe('branch 1 — no version constraint matches every live runner', () => {
    it('absent, empty and whitespace-only clawmeets_version all match everything', () => {
      for (const target of [
        {},
        { clawmeets_version: '' },
        { clawmeets_version: '   ' },
      ]) {
        expect(versionMatches(target, '1.2.10')).toBe(true)
        expect(versionMatches(target, '0.1.0')).toBe(true)
        expect(versionMatches(target, null)).toBe(true)
      }
    })
  })

  describe('branch 3 — triple comparison', () => {
    it('exercises all six operators', () => {
      expect(versionMatches({ clawmeets_version: '<1.2.10' }, '1.2.9')).toBe(true)
      expect(versionMatches({ clawmeets_version: '<1.2.10' }, '1.2.10')).toBe(false)
      expect(versionMatches({ clawmeets_version: '>1.2.9' }, '1.2.10')).toBe(true)
      expect(versionMatches({ clawmeets_version: '>1.2.9' }, '1.2.9')).toBe(false)
      expect(versionMatches({ clawmeets_version: '<=1.2.9' }, '1.2.9')).toBe(true)
      expect(versionMatches({ clawmeets_version: '>=1.2.9' }, '1.2.9')).toBe(true)
      expect(versionMatches({ clawmeets_version: '==1.2.9' }, '1.2.9')).toBe(true)
      expect(versionMatches({ clawmeets_version: '==1.2.9' }, '1.2.10')).toBe(false)
      expect(versionMatches({ clawmeets_version: '!=1.2.9' }, '1.2.10')).toBe(true)
      expect(versionMatches({ clawmeets_version: '!=1.2.9' }, '1.2.9')).toBe(false)
    })

    it('ANDs every comma-separated clause', () => {
      const target = { clawmeets_version: '>=1.0.0,<=1.2.9' }
      expect(versionMatches(target, '1.1.0')).toBe(true)
      expect(versionMatches(target, '1.2.9')).toBe(true)
      expect(versionMatches(target, '0.9.9')).toBe(false)   // fails the lower bound
      expect(versionMatches(target, '1.2.10')).toBe(false)  // fails the upper bound
    })

    it('tolerates whitespace around clauses and operators', () => {
      const target = { clawmeets_version: ' >= 1.0.0 , <= 1.2.9 ' }
      expect(versionMatches(target, '1.1.0')).toBe(true)
      expect(versionMatches(target, '1.2.10')).toBe(false)
    })
  })
})

describe('parseSpec (§2.3 grammar) — an operator is REQUIRED', () => {
  it('parses valid specs', () => {
    expect(parseSpec('<=1.2.9')).toEqual([{ op: '<=', version: [1, 2, 9] }])
    expect(parseSpec('>=1.0.0,<=1.2.9')).toEqual([
      { op: '>=', version: [1, 0, 0] },
      { op: '<=', version: [1, 2, 9] },
    ])
  })

  it('tests two-char operators BEFORE one-char ones', () => {
    // Reversed, "<=1.2.9" would parse as "<" + "=1.2.9" and fail on the
    // version — right answer, wrong reason — while ">=" would break outright.
    expect(parseSpec('<=1.2.9')).toEqual([{ op: '<=', version: [1, 2, 9] }])
    expect(parseSpec('>=1.2.9')).toEqual([{ op: '>=', version: [1, 2, 9] }])
  })

  it('returns null (NOT []) for every malformed spec', () => {
    // null means "unparseable, drop the record". [] would mean "no constraints,
    // matches everything" — the exact inversion §4.2 fails closed against.
    for (const bad of ['1.2.9', '~=1.2', 'latest', '>=1.2', '', '   ', '>=1.0.0,', ',<=1.2.9', '<=1.2.9,,>=1.0.0', '=1.2.9']) {
      expect(parseSpec(bad)).toBeNull()
    }
  })
})

describe('validateRecords (§4.2) — FAIL CLOSED', () => {
  const ok = {
    id: 'a',
    target: { clawmeets_version: '<=1.2.9', match_unknown_version: true },
    severity: 'warning',
    title: 'T',
    body: 'B',
  }

  it('accepts the whole response object OR a bare array, and nothing else', () => {
    expect(validateRecords({ announcements: [ok] })).toHaveLength(1)
    expect(validateRecords([ok])).toHaveLength(1)
    expect(validateRecords(null)).toEqual([])
    expect(validateRecords(undefined)).toEqual([])
    expect(validateRecords('nope')).toEqual([])
    expect(validateRecords({})).toEqual([])
    expect(validateRecords({ announcements: 'nope' })).toEqual([])
  })

  it('skips non-object records', () => {
    expect(validateRecords([null, 'x', 3, [], true, ok])).toHaveLength(1)
  })

  it('skips a missing, blank or non-string id', () => {
    expect(validateRecords([{ ...ok, id: undefined }])).toEqual([])
    expect(validateRecords([{ ...ok, id: '' }])).toEqual([])
    expect(validateRecords([{ ...ok, id: '   ' }])).toEqual([])
    expect(validateRecords([{ ...ok, id: 7 }])).toEqual([])
  })

  it('keeps the FIRST of a duplicate id and skips later ones', () => {
    const out = validateRecords([
      { ...ok, id: 'dup', title: 'first' },
      { ...ok, id: 'dup', title: 'second' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('first')
  })

  it('skips a non-string title or body', () => {
    expect(validateRecords([{ ...ok, title: 7 }])).toEqual([])
    expect(validateRecords([{ ...ok, title: undefined }])).toEqual([])
    expect(validateRecords([{ ...ok, body: null }])).toEqual([])
    expect(validateRecords([{ ...ok, body: { text: 'x' } }])).toEqual([])
  })

  it('DROPS a record whose clawmeets_version is present but unparseable', () => {
    // THE LOAD-BEARING ROW. A dropped record matches NOBODY; a record that fell
    // through to branch 1 ("no version constraint") would match EVERY runner.
    for (const spec of ['1.2.9', 'latest', '~=1.2', '>=1.2', 7, ['<=1.2.9']]) {
      expect(validateRecords([{ ...ok, target: { clawmeets_version: spec } }])).toEqual([])
    }
  })

  it('keeps a record whose clawmeets_version is present but EMPTY (branch 1, not a drop)', () => {
    const out = validateRecords([{ ...ok, target: { clawmeets_version: '' } }])
    expect(out).toHaveLength(1)
    expect(out[0].target.clawmeets_version).toBeUndefined()
  })

  it('defaults a missing, blank or non-string severity to "info"', () => {
    expect(validateRecords([{ ...ok, severity: undefined }])[0].severity).toBe('info')
    expect(validateRecords([{ ...ok, severity: '' }])[0].severity).toBe('info')
    expect(validateRecords([{ ...ok, severity: '  ' }])[0].severity).toBe('info')
    expect(validateRecords([{ ...ok, severity: 5 }])[0].severity).toBe('info')
    // A severity we don't recognise is NOT normalised away — the renderer
    // degrades it to neutral styling and still shows the message.
    expect(validateRecords([{ ...ok, severity: 'catastrophe' }])[0].severity).toBe('catastrophe')
  })

  it('normalizes an absent or non-object target to {} and coerces match_unknown_version strictly', () => {
    expect(validateRecords([{ ...ok, target: undefined }])[0].target).toEqual({
      match_unknown_version: false,
    })
    expect(validateRecords([{ ...ok, target: 'nope' }])[0].target).toEqual({
      match_unknown_version: false,
    })
    // Only literal `true` counts — the `=== true` in branch 2 depends on it.
    for (const truthy of ['true', 1, {}, [], 'yes']) {
      const out = validateRecords([{ ...ok, target: { match_unknown_version: truthy } }])
      expect(out[0].target.match_unknown_version).toBe(false)
    }
  })

  it('IGNORES unknown keys at every level, never rejects them', () => {
    // A config written for a NEWER client must not break an OLDER one.
    const out = validateRecords({
      announcements: [{ ...ok, futureField: 'x', target: { ...ok.target, futureTargetField: 1 } }],
      futureRootField: true,
    })
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a')
  })
})

describe('the bare-spec inversion — a dropped record matches NOBODY, not EVERYBODY', () => {
  // The failure mode being guarded is NOT "it matches nobody" — it is that an
  // unparseable spec falls through to branch 1 and matches EVERYBODY. So this
  // asserts non-match against three differently-versioned runners, including a
  // null-version one with match_unknown_version: true, which is the case most
  // likely to slip through.
  for (const spec of ['1.2.9', '~=1.2', 'latest', '>=1.2']) {
    it(`a record specifying ${JSON.stringify(spec)} reaches no runner at all`, () => {
      const records = validateRecords([
        {
          id: 'x',
          target: { clawmeets_version: spec, match_unknown_version: true },
          severity: 'warning',
          title: 'T',
          body: 'B',
        },
      ])
      // Dropped at validation, so there is nothing left to match with.
      expect(records).toEqual([])
    })
  }
})

import { describe, expect, it } from 'vitest'
import type { DeskSop } from '../api/endpoints/deskSops'
import { groupSops, sopDisplayName, splitSopTitle } from './sopSection'

/**
 * The rail's sections come from the stored title and nothing else, so the
 * interesting cases are all about where a prefix stops being a prefix: prose
 * with a colon in it, a colon at either end, a prefix longer than a section
 * name would ever be. Getting those wrong invents sections the owner never
 * asked for, which is worse than missing one — a miss just leaves the SOP in
 * "Yours", where they can still find it.
 */

function sop(title: string, id = title): DeskSop {
  return {
    id,
    owner_user_id: 'u1',
    title,
    body: 'b',
    created_at: '',
    updated_at: '',
  }
}

const headings = (sops: DeskSop[]) => groupSops(sops).map((s) => s.label)

describe('splitSopTitle', () => {
  it('splits on the prefix and hands back the bare name', () => {
    expect(splitSopTitle('Marketing:product IG content')).toEqual({
      section: 'Marketing',
      name: 'product IG content',
    })
  })

  it('tolerates spacing around the colon on both sides', () => {
    expect(splitSopTitle('  Marketing :  product IG content ')).toEqual({
      section: 'Marketing',
      name: 'product IG content',
    })
  })

  it('splits on the FIRST colon only, so the name may contain more', () => {
    expect(splitSopTitle('Marketing:Q3: the reset')).toEqual({
      section: 'Marketing',
      name: 'Q3: the reset',
    })
  })

  it.each([
    ['Weekly reel batch', 'no colon at all'],
    [':leading', 'a colon with nothing before it is not a section'],
    ['trailing:', 'a section with no name is not a filing'],
    ['Marketing:   ', 'whitespace is not a name'],
    [`${'x'.repeat(33)}:body`, 'a prefix past the cap is prose, not filing'],
    [
      'Reminder to chase the Q3 invoice before Friday: it slips otherwise',
      'a sentence that merely contains a colon',
    ],
  ])('leaves %j unprefixed (%s)', (title) => {
    const split = splitSopTitle(title)
    expect(split.section).toBeNull()
    // The name is the whole title, trimmed — never a truncated half.
    expect(split.name).toBe(title.trim())
  })

  it('takes a prefix right up to the cap', () => {
    const at = 'x'.repeat(32)
    expect(splitSopTitle(`${at}:body`).section).toBe(at)
  })

  it('rejects a prefix that spans a line break', () => {
    expect(splitSopTitle('line one\nline two:body').section).toBeNull()
  })
})

describe('sopDisplayName', () => {
  it('is the title minus its prefix, and the whole title without one', () => {
    expect(sopDisplayName('Marketing:product IG content')).toBe('product IG content')
    expect(sopDisplayName('Weekly reel batch')).toBe('Weekly reel batch')
  })
})

describe('groupSops', () => {
  it('puts unprefixed SOPs in Yours and prefixed ones under their prefix', () => {
    const groups = groupSops([sop('Weekly reel batch'), sop('Marketing:product IG content')])
    expect(groups.map((g) => [g.label, g.sops.length])).toEqual([
      ['Yours', 1],
      ['Marketing', 1],
    ])
  })

  it('ranks Yours first and SYSTEM last, alphabetical in between', () => {
    expect(
      headings([
        sop('SYSTEM:Create new project'),
        sop('Ops:restock'),
        sop('Weekly reel batch'),
        sop('Marketing:product IG content'),
      ]),
    ).toEqual(['Yours', 'Marketing', 'Ops', 'SYSTEM'])
  })

  it('leads with SYSTEM on a fresh account, since nothing outranks it yet', () => {
    // What a brand-new owner sees: the seeded library and nothing else.
    expect(headings([sop('SYSTEM:Personalize assistant')])).toEqual(['SYSTEM'])
  })

  it('folds prefixes differing only in case, keeping the first spelling', () => {
    const groups = groupSops([sop('Marketing:one'), sop('marketing:two')])
    expect(groups.length).toBe(1)
    expect(groups[0].label).toBe('Marketing')
    expect(groups[0].sops.length).toBe(2)
  })

  it('orders rows inside a section by name, not by the incoming newest-first', () => {
    // The library arrives newest-first, which reshuffles the whole rail every
    // time an SOP is written. A section is a reference list you scan, so it
    // reads alphabetically. ("Recently used" is built elsewhere, from
    // `recentIds`, and keeps its recency order.)
    const groups = groupSops([sop('Ops:c'), sop('Ops:a'), sop('Ops:b')])
    expect(groups[0].sops.map((s) => s.title)).toEqual(['Ops:a', 'Ops:b', 'Ops:c'])
  })

  it('sorts on the display name, case- and accent-insensitively, numbers by value', () => {
    // `SOP 10` after `SOP 2`, not before it, and a lowercase title does not
    // sort below every capitalised one the way a raw < would put it.
    const groups = groupSops([sop('Ops:SOP 10'), sop('Ops:apple'), sop('Ops:SOP 2')])
    expect(groups[0].sops.map((s) => s.title)).toEqual(['Ops:apple', 'Ops:SOP 2', 'Ops:SOP 10'])
  })

  it('breaks ties on id so two rows with the same name cannot flicker', () => {
    // Duplicate display names are legal; a comparator returning 0 for them
    // would leave their order to the input, i.e. to newest-first.
    const groups = groupSops([sop('Ops:same', 'z'), sop('Ops:same', 'a')])
    expect(groups[0].sops.map((s) => s.id)).toEqual(['a', 'z'])
  })

  it('orders the unprefixed "Yours" section by name too', () => {
    // No prefix means the display name IS the title; the sort must still run.
    const groups = groupSops([sop('zebra'), sop('apple')])
    expect(groups[0].sops.map((s) => s.title)).toEqual(['apple', 'zebra'])
  })

  it('yields no sections for an empty library', () => {
    // A section IS its rows, so there is nothing to render empty.
    expect(groupSops([])).toEqual([])
  })
})

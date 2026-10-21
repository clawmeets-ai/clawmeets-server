import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Deviation, PlanSummary } from '../../api/endpoints/projectPlans'
import {
  BAND_ORDER,
  bandsPresent,
  defaultOpenBands,
  isGated,
  planFoldMeta,
  planPill,
  type BandId,
  type BandInput,
} from './deskBands'

const DEV: Deviation = {
  id: 'n-dev',
  by: 'content_writer',
  comment: 'shipped 4 slides, the plan says 6',
  section: 'goal',
  base_section: '## Goal\nShip six slides.\n',
}

function plan(over: Partial<PlanSummary> = {}): PlanSummary {
  return {
    surface: 'regular',
    phase: 'executing',
    revision: 3,
    accepted: false,
    accepted_revision: null,
    open_notes_for_you: 0,
    deviation: null,
    ...over,
  }
}

function card(over: Partial<BandInput> = {}): BandInput {
  return { plan: plan(), reportPublishedAt: null, ...over }
}

/**
 * §4(c)'s DECISION TABLE, verbatim, as the fixture every structural assertion
 * below runs across. Adding a state means adding a row here, which is what
 * makes "at most one fetching band is expanded" a property of the table rather than of
 * the eight cases someone happened to think of.
 */
const TABLE: { name: string; item: BandInput; open: BandId[] }[] = [
  {
    name: 'deviation while spec-ing — the alarm overrides the phase',
    item: card({ plan: plan({ phase: 'spec-ing', open_notes_for_you: 1, deviation: DEV }) }),
    open: ['plan'],
  },
  {
    name: 'deviation while executing',
    item: card({ plan: plan({ open_notes_for_you: 2, deviation: DEV }) }),
    open: ['plan'],
  },
  {
    name: 'deviation on a COMPLETE project with a report — still the plan',
    item: card({
      plan: plan({ phase: 'complete', open_notes_for_you: 1, deviation: DEV }),
      reportPublishedAt: '2035-01-01T00:00:00Z',
    }),
    open: ['plan'],
  },
  {
    name: 'spec-ing, notes for you — the plan is what is waiting on you',
    item: card({ plan: plan({ phase: 'spec-ing', open_notes_for_you: 2 }) }),
    open: ['plan'],
  },
  {
    name: "spec-ing, 0 for you, agent spoke last — the agent's message is the question",
    item: card({ plan: plan({ phase: 'spec-ing' }) }),
    open: ['response'],
  },
  {
    name: 'spec-ing, 0 for you, you spoke last — the response would only echo you',
    item: card({ plan: plan({ phase: 'spec-ing' }), quoteIsYours: true }),
    open: ['plan'],
  },
  {
    name: 'executing, gated — the release control is in that band',
    item: card({ plan: plan({ open_notes_for_you: 1 }) }),
    open: ['plan'],
  },
  {
    name: "executing, 0 for you — the agent's message is the live thing",
    item: card({ plan: plan({ open_notes_for_you: 0 }) }),
    open: ['response'],
  },
  {
    name: "complete with a report — the outcome, and the agent's last word on it",
    item: card({
      plan: plan({ phase: 'complete' }),
      reportPublishedAt: '2035-01-01T00:00:00Z',
    }),
    open: ['report', 'response'],
  },
  {
    name: 'complete with NO report — the band is omitted, so it cannot be opened',
    item: card({ plan: plan({ phase: 'complete' }) }),
    open: ['plan'],
  },
  {
    name: 'failed — the last message says what stopped',
    item: card({ plan: plan({ phase: 'failed' }) }),
    open: ['response'],
  },
  {
    name: 'no plan (a DM) — the only band present',
    item: card({ plan: null }),
    open: ['response'],
  },
  {
    name: 'front-desk — no plan band renders at all',
    item: card({
      plan: plan({ surface: 'frontdesk', phase: null, revision: null, accepted: null }),
    }),
    open: ['response'],
  },
  {
    name: 'a plan-LESS project that has a report — the report is still reachable',
    item: card({ plan: null, reportPublishedAt: '2035-01-01T00:00:00Z' }),
    open: ['report', 'response'],
  },
]

describe('§4(c) — at most ONE fetching band is default-expanded, in every state', () => {
  it.each(TABLE)('$name', ({ item, open }) => {
    expect(defaultOpenBands(item)).toEqual(open)
  })

  it('every default-open band is one that is actually present', () => {
    // The failure this guards is silent: returning `plan` on a front-desk card
    // seeds `opened` with a key no band reads, and the card renders with EVERY
    // band folded — no error, no test, just a card that says nothing until it
    // is clicked.
    for (const { name, item } of TABLE) {
      const open = defaultOpenBands(item)
      expect(open.length, name).toBeGreaterThan(0)
      for (const id of open) expect(bandsPresent(item), name).toContain(id)
    }
  })

  it('report and plan never open together — at most one fetch per card', () => {
    // Report and plan each fire a request when expanded; response does not.
    for (const { name, item } of TABLE) {
      const fetching = defaultOpenBands(item).filter((id) => id !== 'response')
      expect(fetching.length, name).toBeLessThanOrEqual(1)
    }
  })

  it('a report-bearing card opens exactly REPORT and RESPONSE unless a deviation is open', () => {
    for (const { name, item } of TABLE) {
      if (item.reportPublishedAt == null || item.plan?.deviation) continue
      expect(defaultOpenBands(item), name).toEqual(['report', 'response'])
    }
  })
})

describe('fixed order — REPORT, PLAN, RESPONSE, in every card', () => {
  it('BAND_ORDER is the order, and nothing re-derives it', () => {
    expect([...BAND_ORDER]).toEqual(['report', 'plan', 'response'])
  })

  it('every state renders its present bands in that relative order', () => {
    for (const { name, item } of TABLE) {
      const got = bandsPresent(item)
      expect(got, name).toEqual(BAND_ORDER.filter((id) => got.includes(id)))
    }
  })

  it('an absent band is an OMITTED ROW, never a placeholder', () => {
    // The contract `bandsPresent` offers the card: what is not in the list is
    // not rendered at all. A placeholder would have to appear here to be drawn.
    expect(bandsPresent(card({ plan: plan({ phase: 'complete' }) }))).toEqual(['plan', 'response'])
    expect(bandsPresent(card({ plan: null }))).toEqual(['response'])
    expect(bandsPresent(card({ plan: plan({ surface: 'frontdesk' }) }))).toEqual(['response'])
  })

  it('RESPONSE is present on every shape, which is what makes the default total', () => {
    for (const { name, item } of TABLE) {
      expect(bandsPresent(item), name).toContain('response')
    }
  })
})

describe('front-desk is tested on `surface` DIRECTLY', () => {
  it('gets no plan band, no matter what else the summary carries', () => {
    const fd = plan({ surface: 'frontdesk', phase: null, revision: null, open_notes_for_you: 4 })
    expect(bandsPresent(card({ plan: fd }))).not.toContain('plan')
    // ...including with an open deviation, which must not open a band that does
    // not render.
    expect(bandsPresent(card({ plan: { ...fd, deviation: DEV } }))).not.toContain('plan')
    expect(defaultOpenBands(card({ plan: { ...fd, deviation: DEV } }))).toEqual(['response'])
  })

  it('and never through an `is_dm_shaped`-style helper, by name', () => {
    // Structural, on the source. That helper answers TRUE for both `dm` and
    // `frontdesk`, so a branch built on it would LOOK like it named the two
    // shapes while actually collapsing them into one predicate — which is the
    // exact defect this surface was rewritten to remove. A comment may discuss
    // it; code may not call it.
    const src = readFileSync(resolve(process.cwd(), 'src/components/desk/deskBands.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    for (const banned of ['is_dm_shaped', 'isDmShaped', 'is_dm_project', 'isDmProject']) {
      expect(src, banned).not.toContain(banned)
    }
    // ...and it compares against the literal the ruling names.
    expect(src).toContain("'frontdesk'")
  })
})

describe('the gated state — one conjunction, and its divergence from the server', () => {
  it('regular + executing + an open note for you', () => {
    expect(isGated(plan({ open_notes_for_you: 1 }))).toBe(true)
  })

  it('is false at zero notes, while spec-ing, on front-desk, and with no plan', () => {
    expect(isGated(plan({ open_notes_for_you: 0 }))).toBe(false)
    expect(isGated(plan({ phase: 'spec-ing', open_notes_for_you: 1 }))).toBe(false)
    expect(isGated(plan({ phase: 'complete', open_notes_for_you: 1 }))).toBe(false)
    expect(isGated(plan({ surface: 'frontdesk', open_notes_for_you: 1 }))).toBe(false)
    expect(isGated(null)).toBe(false)
  })

  it('invents no `halted` member, and reads only members that exist', () => {
    const s = plan()
    expect('halted' in s).toBe(false)
    expect(Object.keys(s).sort()).toEqual([
      'accepted',
      'accepted_revision',
      'deviation',
      'open_notes_for_you',
      'phase',
      'revision',
      'surface',
    ])
  })

  /**
   * THE DIVERGENT WINDOW — the `PlanBand.tsx:55` finding, pinned rather than
   * closed.
   *
   * The SERVER's execution gate (`models/agent.py::_plan_execution_blocked`) is
   * a FOUR-conjunct predicate: this one AND `_shared_context_has_peer`. Inside
   * Q12's stand-down window — a project whose `shared-context` still holds the
   * coordinator alone — the server is NOT blocking and will let one workroom
   * through, while this predicate is true.
   *
   * The fourth conjunct reads a chatroom's participant list. `PlanSummary`'s
   * seven members do not carry it, and deriving it in the browser is the exact
   * defect this project spent seven waves removing — with this derivation being
   * the one that would gate whether work may start. So the divergence is not
   * closed here; it is BOUNDED by what the card is allowed to say.
   */
  it('is a SUPERSET of the server gate, and the copy it drives never over-claims', () => {
    const inQ12Window = plan({ open_notes_for_you: 1 })
    expect(isGated(inQ12Window)).toBe(true)

    // Comments stripped: the rule is about what the card RENDERS, and the
    // comment beside the held line necessarily quotes the copy it replaced.
    const src = readFileSync(resolve(process.cwd(), 'src/components/desk/PlanBand.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    // The shipped copy asserted a fact about the SERVER — "work is held until
    // you answer" — which is false in the window above. Nothing this surface
    // renders may claim the server is refusing work.
    expect(src).not.toContain('work is held')
    expect(src).not.toContain('Held —')
    // What it says instead is true in every state the three conjuncts describe:
    // whose answer is outstanding.
    expect(src).toContain('Waiting on your answer.')
  })
})

describe('the deviation is ALREADY INSIDE the count — nothing adds to it', () => {
  it('the pill reports the server integer unchanged, deviation or not', () => {
    expect(planPill(plan({ open_notes_for_you: 2 })).text).toBe('2 for you')
    // Two notes, ONE of which IS the deviation. A `+ (deviation ? 1 : 0)` would
    // read 3 here — and 3 is not a mis-drawn badge, it is a different number
    // from the one the server's execution gate reads.
    expect(planPill(plan({ open_notes_for_you: 2, deviation: DEV })).kind).toBe('deviation')
    expect(planFoldMeta(plan({ open_notes_for_you: 2 })).meta).toBe('2 changes waiting on you')
    expect(planFoldMeta(plan({ open_notes_for_you: 1 })).meta).toBe('1 change waiting on you')
  })

  it('no expression anywhere combines `deviation` with the integer arithmetically', () => {
    // Structural, on code with comments stripped, because the whole point is
    // that this is easy to write and invisible once written.
    const src = readFileSync(resolve(process.cwd(), 'src/components/desk/deskBands.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    expect(src).not.toMatch(/open_notes_for_you\s*[+\-]/)
    expect(src).not.toMatch(/[+\-]\s*\(?\s*(plan\.)?deviation/)
    expect(src).not.toMatch(/deviation\s*\?\s*1\s*:\s*0/)
  })
})

describe('the four pill outcomes, and red reserved for one of them', () => {
  it('deviation -> off-contract, warn', () => {
    const p = planPill(plan({ open_notes_for_you: 1, deviation: DEV }))
    expect(p).toMatchObject({ kind: 'deviation', text: 'off-contract', tone: 'warn' })
  })

  it('notes for you, no deviation -> accent, NEVER red', () => {
    const p = planPill(plan({ open_notes_for_you: 3 }))
    expect(p).toMatchObject({ kind: 'count', tone: 'attn' })
    expect(p.tone).not.toBe('warn')
    expect(planFoldMeta(plan({ open_notes_for_you: 3 })).tone).toBe('attn')
  })

  it('accepted AT THE CURRENT REVISION is what `accepted_revision` is on the wire for', () => {
    expect(planPill(plan({ accepted: true, accepted_revision: 3, revision: 3 })).kind).toBe(
      'accepted',
    )
    // Accepted, then edited. Without the second member this is indistinguishable
    // from the row above.
    expect(planPill(plan({ accepted: true, accepted_revision: 2, revision: 3 })).kind).toBe(
      'uptodate',
    )
  })

  it('nothing MISSING is ever drawn red', () => {
    // No plan, front-desk, no report — every absence state. None of them can
    // reach a `warn` tone, because none of them reaches `planPill` at all
    // (no plan band renders) and the card's only other red is the same predicate.
    for (const { name, item } of TABLE) {
      if (!item.plan || item.plan.surface === 'frontdesk') {
        expect(bandsPresent(item), name).not.toContain('plan')
        continue
      }
      const tone = planFoldMeta(item.plan).tone
      if (tone === 'warn') expect(!!item.plan.deviation, name).toBe(true)
    }
  })

  it('every carrier fires off `!!plan.deviation` and nothing else', () => {
    // One predicate, five carriers. Flip only `deviation` and every red thing
    // moves together; flip anything else and none of them does.
    const calm = plan({ open_notes_for_you: 2 })
    const loud = { ...calm, deviation: DEV }
    expect(planPill(calm).tone).not.toBe('warn')
    expect(planFoldMeta(calm).tone).not.toBe('warn')
    expect(planPill(loud).tone).toBe('warn')
    expect(planFoldMeta(loud).tone).toBe('warn')
    // ...and the count did not move, because the deviation was already in it.
    expect(planPill(calm).text).toBe('2 for you')
    expect(loud.open_notes_for_you).toBe(calm.open_notes_for_you)
  })
})

describe('the folded row renders from `PlanSummary` alone — it costs no request', () => {
  it('null `revision` is null-checked, never printed', () => {
    const meta = planFoldMeta(plan({ revision: null, accepted: null })).meta
    expect(meta).not.toContain('null')
    expect(meta).not.toContain('undefined')
  })

  it('the plain arm names the contract rather than a lifecycle word', () => {
    expect(planFoldMeta(plan({ accepted: true, accepted_revision: 3 })).meta).toBe(
      'rev 3 · accepted — agents are held to it',
    )
    expect(planFoldMeta(plan()).meta).toBe('rev 3 · up to date — agents are held to it')
  })

  it('an unaccepted plan in review says acceptance is pending, never "held to it"', () => {
    const f = planFoldMeta(plan({ phase: 'spec-ing', revision: 4 }))
    expect(f).toEqual({
      meta: 'rev 4 · awaiting your acceptance',
      cta: 'Review & accept',
      tone: 'attn',
    })
    // Notes for you and a deviation still outrank it.
    expect(planFoldMeta(plan({ phase: 'spec-ing', open_notes_for_you: 1 })).cta).toBe('Review')
    expect(planFoldMeta(plan({ phase: 'spec-ing', deviation: DEV })).tone).toBe('warn')
  })

  it('the raw `spec-ing` token is never a string this module emits', () => {
    for (const { item } of TABLE) {
      if (!item.plan || item.plan.surface === 'frontdesk') continue
      const f = planFoldMeta(item.plan)
      expect(f.meta).not.toContain('spec-ing')
      expect(f.cta).not.toContain('spec')
      expect(planPill(item.plan).text).not.toContain('spec-ing')
    }
  })
})

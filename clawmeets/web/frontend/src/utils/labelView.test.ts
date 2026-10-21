import { describe, expect, it } from 'vitest'
import type { DeskLabel } from '../api/endpoints/deskLabels'
import type { DeskTodo } from '../api/endpoints/deskTodos'
import {
  CHIP_CAP,
  RESIDUAL_KEY,
  chipsFor,
  cycleColor,
  diagnoseRegistry,
  displayName,
  effectiveGroup,
  groupTodos,
  labelCounts,
  matches,
  nextColor,
  normalizeSlug,
  reconcileView,
  registryWritable,
  resolveLabel,
  toRegistry,
  unknownAxisReason,
  unregisteredSlugs,
  type LabelView,
  type RegistryState,
} from './labelView'

/**
 * THE PORT OF THE MOCK'S BEHAVIOUR CHECKS.
 *
 * These are the acceptance target for the whole feature, and they run as unit
 * tests rather than DOM tests only because the projection layer was extracted
 * pure — which was the point of extracting it.
 */

/** ONE KIND. The `kind` parameter is gone with the state axis, and the fixture
 *  below keeps all nine rows rather than dropping four — which is the point of
 *  the edit rather than a convenience. An owner who minted Next / Wait For /
 *  Scheduled / Some Day still HAS those rows: nothing on disk is deleted, the
 *  server coerces a stored `state` row to a context on read, and the browser
 *  must render them as ordinary contexts. This fixture is that owner. */
const L = (slug: string, color: DeskLabel['color'], name = slug): DeskLabel => ({
  slug,
  name,
  kind: 'context',
  color,
  created_at: '1970-01-01T00:00:00+00:00',
  updated_at: '1970-01-01T00:00:00+00:00',
})

/** The mock's nine-label fixture, in its array order. The last four arrived as
 *  `kind: "state"` before the retirement and arrive as contexts now. */
const LABELS: DeskLabel[] = [
  L('office', 'blue'),
  L('home', 'green'),
  L('phone', 'teal'),
  L('computer', 'pink'),
  L('errands', 'plum'),
  L('next', 'indigo', 'Next'),
  L('wait-for', 'amber', 'Wait For'),
  L('scheduled', 'blue', 'Scheduled'),
  L('someday', 'slate', 'Some Day'),
]

let seq = 0
const T = (labels: string[], over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: `t-${++seq}`,
  owner_user_id: 'u1',
  text: `task ${seq}`,
  // `status` is GONE from the wire, replaced by two independent fields. All
  // four are typed REQUIRED, which is why every fixture in the suite moved at
  // once rather than one at a time.
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  attachments: [],
  labels,
  ...over,
})

const reg = (state: RegistryState = 'ready', labels = LABELS) => toRegistry(labels, state)
const view = (over: Partial<LabelView> = {}): LabelView => ({
  group: null,
  filter: [],
  matchAll: false,
  states: [],
  ...over,
})

describe('resolveLabel — the one rule the feature hangs on', () => {
  it('returns the registry row when the registry is held and knows the slug', () => {
    // RE-POINTED, not adjusted: `next` was the fixture's canonical STATE row.
    // After the retirement the registry returns it as a context, and the row
    // itself — slug, name, colour, position — is otherwise untouched. That is
    // the whole shape of the retirement in one assertion.
    const l = resolveLabel('next', reg())
    expect(l).toEqual({
      slug: 'next',
      name: 'Next',
      kind: 'context',
      color: 'indigo',
      registered: true,
    })
  })

  it('an unknown slug on a held registry is a CONTEXT and is NOT registered', () => {
    // R2: accepted on the wire, never silent. Dashed, colourless, "+ add it".
    expect(resolveLabel('offce', reg())).toEqual({
      slug: 'offce',
      name: 'offce',
      kind: 'context',
      color: null,
      registered: false,
    })
  })

  it.each(['cold', 'unavailable'] as RegistryState[])(
    'off-ready (%s) every slug is kind:unknown and registered:TRUE',
    (state) => {
      // registered:true is the whole chip fix. We do not KNOW it isn't
      // registered, so we must not say it isn't — otherwise the "not in your
      // list" treatment lands on the owner's entire vocabulary at once.
      for (const slug of ['office', 'next', 'offce']) {
        const l = resolveLabel(slug, reg(state))
        expect(l.kind).toBe('unknown')
        expect(l.registered).toBe(true)
        expect(l.color).toBeNull()
      }
    },
  )

  it('provisional resolves from the cached list, kinds intact', () => {
    // kind is the registry's most stable field; a cached list groups
    // correctly, not merely plausibly. There is one kind left, so the assertion
    // is weaker than it was — but a cached row still resolving as REGISTERED is
    // the half that was ever load-bearing.
    expect(resolveLabel('next', reg('provisional')).kind).toBe('context')
    expect(resolveLabel('next', reg('provisional')).registered).toBe(true)
  })

  it('an unknown label gets NO sigil — a sigil is a claim about the axis', () => {
    expect(displayName(resolveLabel('office', reg()))).toBe('@office')
    // WAS `!Next`. The `!` sigil retired with the axis it named: it existed to
    // say "this is the other kind, press ! to reach it", and there is no other
    // kind and no second key. One kind, one sigil.
    expect(displayName(resolveLabel('next', reg()))).toBe('@Next')
    expect(displayName(resolveLabel('office', reg('unavailable')))).toBe('office')
  })
})

describe('matches — a flat OR over the chosen slugs, or AND under matchAll', () => {
  const office = T(['office', 'next'])
  const home = T(['home', 'next'])
  const both = T(['office', 'home', 'next'])
  const officeWaiting = T(['office', 'wait-for'])
  const bare = T([])

  it('an empty filter passes everything', () => {
    expect(matches(bare, view(), reg())).toBe(true)
  })

  it('ORs across the chosen slugs', () => {
    const v = view({ filter: ['office', 'home'] })
    expect(matches(office, v, reg())).toBe(true)
    expect(matches(home, v, reg())).toBe(true)
    expect(matches(bare, v, reg())).toBe(false)
  })

  it('two slugs that used to be different KINDS now simply OR', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "ANDs across
    // kinds — a context filter and a state filter both bind", and it was the
    // behaviour `kind` existed to produce. With one kind the refinement is gone
    // and the correct answer is a flat OR — which is what is asserted here
    // rather than deleted, because "these two no longer AND" is exactly the
    // fact a reader six weeks from now needs.
    //
    // What REPLACED the narrowing it used to buy is the state filter, which is
    // a different axis entirely and is tested in `ticketView.test.ts`
    // ('the state term ANDs with the label filter').
    const v = view({ filter: ['office', 'next'] })
    expect(matches(office, v, reg())).toBe(true)
    // carries @office; under the old kinds its `!wait-for` rejected it
    expect(matches(officeWaiting, v, reg())).toBe(true)
    // carries @next but not @office — an OR, so it passes
    expect(matches(home, v, reg())).toBe(true)
    expect(matches(bare, v, reg())).toBe(false)
  })

  it('matchAll flips the WHOLE filter to strict AND', () => {
    // Was "ONLY the context half". There is no other half.
    const v = view({ filter: ['office', 'home'], matchAll: true })
    expect(matches(both, v, reg())).toBe(true)
    expect(matches(office, v, reg())).toBe(false)
  })

  it('matchAll now binds two slugs that used to be exempt from it', () => {
    // The deleted assertion here was "matchAll leaves the state half as OR —
    // AND across states is unsatisfiable", which was true because a to-do
    // carried at most one state. `next` and `wait-for` are ordinary contexts
    // now, a to-do may carry both, and AND over them is satisfiable — so the
    // exemption is not merely unnecessary, it would be wrong.
    //
    // The unsatisfiable-AND argument DID survive, on the axis that still has
    // the property: a to-do has exactly one ticket state, which is why the
    // state filter has no ALL/AND toggle. Asserted in `ticketView.test.ts`.
    const v = view({ filter: ['next', 'wait-for'], matchAll: true })
    expect(matches(officeWaiting, v, reg())).toBe(false)
    expect(matches(T(['next', 'wait-for']), v, reg())).toBe(true)
  })

  it('20/5 — the fixture-scale check the mock grades on, on one axis now', () => {
    // 20 items carry @computer; 5 of those also carry @wait-for.
    const plate = [
      ...Array.from({ length: 15 }, () => T(['computer', 'next'])),
      ...Array.from({ length: 5 }, () => T(['computer', 'wait-for'])),
      ...Array.from({ length: 10 }, () => T(['home', 'next'])),
    ]
    const ctxOnly = plate.filter((t) => matches(t, view({ filter: ['computer'] }), reg()))
    expect(ctxOnly).toHaveLength(20)
    // WAS 5, by ANDing across the two kinds. One kind means a flat OR, so the
    // second slug can only ever WIDEN — here to the 20 carrying @computer, all
    // five @wait-for rows already being among them. The way back to 5 is
    // matchAll, asserted below, which is a control the owner can actually see.
    const across = plate.filter((t) =>
      matches(t, view({ filter: ['computer', 'wait-for'] }), reg()),
    )
    expect(across).toHaveLength(20)
    // …and the widening is real where the sets differ: @home ∪ @wait-for.
    const wider = plate.filter((t) => matches(t, view({ filter: ['home', 'wait-for'] }), reg()))
    expect(wider).toHaveLength(15)
    const strict = plate.filter((t) =>
      matches(t, view({ filter: ['computer', 'wait-for'], matchAll: true }), reg()),
    )
    expect(strict).toHaveLength(5)
  })

  it('off-ready it degrades to a FLAT OR — and does NOT become pass-everything', () => {
    // The negative is the important half: with kind unreadable both partitions
    // come back empty, every predicate passes, and the filter silently stops
    // filtering while the chip still reads "Filter 2".
    const v = view({ filter: ['office', 'next'] })
    expect(matches(office, v, reg('unavailable'))).toBe(true)
    expect(matches(officeWaiting, v, reg('unavailable'))).toBe(true)
    expect(matches(bare, v, reg('unavailable'))).toBe(false)
    expect(matches(T(['home']), v, reg('unavailable'))).toBe(false)
  })

  it('off-ready ignores matchAll — there is no context partition to strengthen', () => {
    const v = view({ filter: ['office', 'home'], matchAll: true })
    expect(matches(office, v, reg('cold'))).toBe(true)
  })
})

describe('chipsFor — order, pinning and the +N cap', () => {
  it('registered contexts in REGISTRY order', () => {
    // WAS "state first, then registered contexts": the state arm of the
    // ordering is gone, so a row is one run in registry array position. `next`
    // sits at index 5 and now sorts AFTER `office` (0) and `errands` (4) rather
    // than jumping the queue for being a state.
    //
    // The ticket chip did not take over that leading position through this
    // function — it cannot reach it. `TicketChip` imports neither this module
    // nor `LabelChip`, so it is never a member of `show`, is never counted
    // toward CHIP_CAP, and never falls under `+N`. Its leading position is
    // rendered by `TodoItem`, outside this array.
    const t = T(['errands', 'office', 'next'])
    const { show } = chipsFor(t, view(), reg())
    expect(show.map((l) => l.slug)).toEqual(['office', 'errands', 'next'])
  })

  it('unregistered contexts sort LAST so the row keeps its colour rhythm', () => {
    const t = T(['offce', 'office', 'next'])
    const { show } = chipsFor(t, view(), reg())
    expect(show.map((l) => l.slug)).toEqual(['office', 'next', 'offce'])
  })

  it('a filtered label PINS to the front — a filter never hides why a row matched', () => {
    const t = T(['office', 'computer', 'next'])
    const { show } = chipsFor(t, view({ filter: ['computer'] }), reg())
    expect(show[0].slug).toBe('computer')
  })

  it('over the cap it shows CAP-1 and reports the rest', () => {
    // "Sort out the standing desk cable mess" — five labels, the mock's
    // overflow row.
    const t = T(['office', 'home', 'errands', 'computer', 'someday'])
    const { show, more } = chipsFor(t, view(), reg())
    expect(show).toHaveLength(CHIP_CAP - 1)
    expect(more).toBe(5 - (CHIP_CAP - 1))
    // `someday` led this row for being a state; it is index 8 in the registry
    // now, so the two survivors are the first two in array order. The CAP
    // arithmetic itself is untouched — deliberately, because the ticket chip
    // must never change it.
    expect(show.map((l) => l.slug)).toEqual(['office', 'home'])
  })

  it('exactly CAP chips do NOT overflow', () => {
    const { show, more } = chipsFor(T(['office', 'home', 'next']), view(), reg())
    expect(show).toHaveLength(3)
    expect(more).toBe(0)
  })

  it('a pinned chip survives the cap — it is never truncated away', () => {
    const t = T(['office', 'home', 'errands', 'computer', 'someday'])
    const { show, more } = chipsFor(t, view({ filter: ['computer'] }), reg())
    expect(show[0].slug).toBe('computer')
    expect(more).toBe(5 - (CHIP_CAP - 1))
  })

  it('a ticket state is NOT reachable from here, at any state', () => {
    // The containment criterion, asserted where it would break first. A row
    // reading Working with no labels yields NO chips and NO overflow: the chip
    // it renders is produced by `TicketChip` outside this path entirely, so
    // nothing here can count it, cap it, or hide it under `+N`.
    const working = T([], { state: 'working', association_count: 3 })
    const { show, more } = chipsFor(working, view(), reg())
    expect(show).toEqual([])
    expect(more).toBe(0)
    // And a row AT the cap stays at the cap: the ticket chip does not consume
    // one of the three slots.
    const full = T(['office', 'home', 'errands'], { state: 'completed' })
    expect(chipsFor(full, view(), reg()).show).toHaveLength(CHIP_CAP)
    expect(chipsFor(full, view(), reg()).more).toBe(0)
  })

  it('expanded shows everything and reports no overflow', () => {
    const t = T(['office', 'home', 'errands', 'computer', 'someday'])
    const { show, more } = chipsFor(t, view(), reg(), true)
    expect(show).toHaveLength(5)
    expect(more).toBe(0)
  })

  it('off-ready the row keeps STORED order and chips do not vanish', () => {
    // Without the off-ready branch the kind filters match neither value and
    // every chip silently disappears from the row.
    const t = T(['errands', 'office', 'next'])
    const { show } = chipsFor(t, view(), reg('unavailable'))
    expect(show.map((l) => l.slug)).toEqual(['errands', 'office', 'next'])
  })

  it('off-ready still pins the filtered chip first', () => {
    const t = T(['errands', 'office', 'next'])
    const { show } = chipsFor(t, view({ filter: ['next'] }), reg('unavailable'))
    expect(show[0].slug).toBe('next')
  })

  it('a row with no labels yields no chips', () => {
    expect(chipsFor(T([]), view(), reg()).show).toEqual([])
  })

  it('a row whose labels key is absent entirely does not throw', () => {
    const legacy = { ...T([]), labels: undefined }
    expect(chipsFor(legacy, view(), reg()).show).toEqual([])
  })
})

describe('groupTodos — duplication, order and the residual', () => {
  const plate = [
    T(['office', 'next']),
    T(['office', 'home', 'next']),
    T(['home', 'wait-for']),
    T([]),
    T(['infra']),
  ]

  it('a to-do appears under EVERY label it carries on the axis', () => {
    const groups = groupTodos(plate, 'context', reg())
    const office = groups.find((g) => g.key === 'office')!
    const home = groups.find((g) => g.key === 'home')!
    expect(office.items).toHaveLength(2)
    expect(home.items).toHaveLength(2)
    // the second row is in both, and it is the SAME record
    expect(office.items[1].id).toBe(home.items[0].id)
  })

  it('group order is registry array position', () => {
    const groups = groupTodos(plate, 'context', reg())
    const registered = groups.filter((g) => g.tone === '').map((g) => g.key)
    // NINE groups, not five: the four rows the owner minted as states arrive as
    // ordinary contexts after the retirement, so they group here too — in their
    // stored registry positions, which are unchanged. Nothing was deleted from
    // the registry to produce this, and nothing should be.
    expect(registered).toEqual([
      'office',
      'home',
      'phone',
      'computer',
      'errands',
      'next',
      'wait-for',
      'scheduled',
      'someday',
    ])
  })

  it('unregistered groups sort LAST and open collapsed', () => {
    const groups = groupTodos(plate, 'context', reg())
    const unreg = groups.filter((g) => g.tone === 'unreg')
    expect(unreg.map((g) => g.key)).toEqual(['infra'])
    expect(unreg[0].collapsedByDefault).toBe(true)
    // …after every registered group and before the residual
    const keys = groups.map((g) => g.key)
    expect(keys.indexOf('infra')).toBeGreaterThan(keys.indexOf('errands'))
    expect(keys.indexOf('infra')).toBeLessThan(keys.indexOf(RESIDUAL_KEY))
  })

  it('grouping by context puts the residual LAST and quiet', () => {
    const groups = groupTodos(plate, 'context', reg())
    expect(groups[groups.length - 1].key).toBe(RESIDUAL_KEY)
    expect(groups[groups.length - 1].tone).toBe('resid')
  })

  it('there is NO "Unprocessed · no state" pile any more, on any axis', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "grouping by
    // state puts the residual FIRST and nagging" and asserted a red
    // `tone: 'inbox'` group named "Unprocessed · no state", holding everything
    // that carried no state label.
    //
    // It is a DELETION rather than a re-point, and the reason is the one that
    // made this a replacement instead of an adjustment: that group was computed
    // from label MEMBERSHIP. Once nothing carries a state label its membership
    // is the entire plate — so left in place it would swallow every to-do into
    // one red pile, which is pixel-identical to the failure screen it was
    // written to prevent.
    //
    // WHAT REPLACED IT: `groupByTicketState`, which partitions on the required
    // `state` field, yields exactly three groups and no residual at all,
    // because NEW IS THE INBOX. Asserted in `ticketView.test.ts`.
    const groups = groupTodos(plate, 'context', reg())
    expect(groups.some((g) => g.tone === ('inbox' as unknown))).toBe(false)
    expect(groups.some((g) => g.name.includes('Unprocessed'))).toBe(false)
    // The one residual left is the context one, and it is LAST and quiet.
    const resid = groups.filter((g) => g.key === RESIDUAL_KEY)
    expect(resid).toHaveLength(1)
    expect(resid[0].tone).toBe('resid')
  })

  it('off-ready there are no groups at all — the axis is unreadable', () => {
    expect(groupTodos(plate, 'context', reg('unavailable'))).toEqual([])
  })

  it('group → ungroup leaves the plate order byte-identical', () => {
    // The strongest property of the whole shape: grouping is a pure
    // projection, so there is nothing to restore because nothing changed.
    const before = plate.map((t) => t.id)
    groupTodos(plate, 'context', reg())
    expect(plate.map((t) => t.id)).toEqual(before)
  })
})

describe('labelCounts — DISTINCT, never the sum of group counts', () => {
  it('counts each to-do once per slug', () => {
    const plate = [T(['office', 'next']), T(['office', 'home']), T([])]
    const counts = labelCounts(plate)
    expect(counts.get('office')).toBe(2)
    expect(counts.get('home')).toBe(1)
    expect(counts.get('next')).toBe(1)
    expect(counts.get('nope')).toBeUndefined()
  })

  it('a duplicated slug on one row still counts once for that row', () => {
    expect(labelCounts([T(['office', 'office'])]).get('office')).toBe(1)
  })

  it('the sum over groups exceeds the plate — which is why the header uses this', () => {
    const plate = [T(['office', 'home']), T(['office', 'home'])]
    const counts = labelCounts(plate)
    expect(counts.get('office')! + counts.get('home')!).toBe(4)
    expect(plate).toHaveLength(2)
  })
})

describe('nextColor — least-used, ties by palette order', () => {
  it('an empty registry takes the first palette token', () => {
    expect(nextColor([])).toBe('blue')
  })

  it('after the six seed rows the sequence is pink, then plum, then blue', () => {
    // blue/green/teal/indigo/amber/slate are taken; pink and plum are free,
    // and pink comes first in PALETTE.
    const seed = [
      L('office', 'blue'),
      L('home', 'green'),
      L('phone', 'teal'),
      L('next', 'indigo'),
      L('wait-for', 'amber'),
      L('someday', 'slate'),
    ]
    const first = nextColor(seed)
    expect(first).toBe('pink')
    const withPink = [...seed, L('a', first)]
    const second = nextColor(withPink)
    expect(second).toBe('plum')
    const withPlum = [...withPink, L('b', second)]
    // every token used once now, so the tie-break picks PALETTE[0]
    expect(nextColor(withPlum)).toBe('blue')
  })

  it('delete-then-create lands on a FREE token, not on one in use', () => {
    // The case that kills PALETTE[count % 8]: nine labels, delete one, create
    // one, and the modulo lands back on a token in use while others sit free.
    const nine = LABELS
    const afterDelete = nine.filter((l) => l.slug !== 'errands') // frees `plum`
    expect(nextColor(afterDelete)).toBe('plum')
  })

  it('a colourless row does not consume a token', () => {
    expect(nextColor([L('x', null)])).toBe('blue')
  })

  it('cycleColor walks the palette and wraps', () => {
    expect(cycleColor('blue')).toBe('green')
    expect(cycleColor('plum')).toBe('blue')
    expect(cycleColor(null)).toBe('blue')
  })
})

describe('normalizeSlug — the server rule, not the contract prose', () => {
  it.each([
    ['@Office', 'office'],
    ['Wait For', 'wait-for'],
    ['Someday/Maybe', 'someday-maybe'],
    ['  Deep   Work  ', 'deep-work'],
    ['!waiting-on-bank', 'waiting-on-bank'],
    ['@@office', 'office'],
  ])('%s → %s', (raw, slug) => {
    expect(normalizeSlug(raw)).toEqual({ slug, fault: null })
  })

  it('REPLACES illegal runs with "-" rather than dropping them', () => {
    // Contract §8 step 5 says "drop"; that prose contradicts the contract's own
    // worked example and the shipped server. Dropping would give
    // "somedaymaybe" — this is the check that keeps the right one.
    expect(normalizeSlug('Someday/Maybe').slug).toBe('someday-maybe')
    expect(normalizeSlug('Someday/Maybe').slug).not.toBe('somedaymaybe')
  })

  it('REFUSES a slug over 32 chars rather than truncating it', () => {
    // The mock's `.slice(0, 32)` would send a value the server 400s.
    const long = 'a'.repeat(40)
    expect(normalizeSlug(long)).toEqual({ slug: long, fault: 'slug_too_long' })
    expect(normalizeSlug('a'.repeat(32)).fault).toBeNull()
  })

  it.each(['', '@', '@ ', '///', '---'])('%s is invalid_slug', (raw) => {
    expect(normalizeSlug(raw).fault).toBe('invalid_slug')
  })

  it('a name already in the registry is a DUPLICATE, not a cross-kind clash', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "clashWith
    // finds a name already taken by the OTHER kind, both directions", and it
    // guarded the rule that `!office` must not silently attach the context
    // @office — the flat slug namespace was shared by two kinds, so either one
    // could have got there first.
    //
    // `clashWith` is DELETED along with the second kind: with one kind it could
    // only ever return null. WHAT REPLACED IT is the check that was always
    // underneath it — a registry that already has the slug — which the picker
    // and the manage sheet now read directly, and which the server names
    // `labels.duplicate`.
    expect(reg().index.has('next')).toBe(true)
    expect(reg().index.has('office')).toBe(true)
    expect(reg().index.has('brand-new')).toBe(false)
  })
})

describe('unregisteredSlugs', () => {
  it('lists them in first-seen plate order, deduped', () => {
    const plate = [T(['infra']), T(['office', 'offce']), T(['infra'])]
    expect(unregisteredSlugs(plate, reg())).toEqual(['infra', 'offce'])
  })

  it('off-ready the answer is NONE, not all', () => {
    // Otherwise every "not in your list" surface offers to add back the
    // owner's own labels and each tap 409s.
    const plate = [T(['office', 'infra'])]
    expect(unregisteredSlugs(plate, reg('unavailable'))).toEqual([])
  })
})

describe('diagnoseRegistry — the three content answers must not collapse', () => {
  it('rows present → populated', () => {
    expect(diagnoseRegistry(reg(), [T(['office'])])).toBe('populated')
  })

  it('zero rows and a bare plate → empty, which is an ANSWER not a failure', () => {
    // `{"labels": []}` is a legitimate 200 from an owner running no vocabulary.
    expect(diagnoseRegistry(reg('ready', []), [T([]), T([])])).toBe('empty')
  })

  it('zero rows but a LABELLED plate → orphaned, the corrupt-looks-missing trap', () => {
    // An entirely unparseable registry answers with zero rows, never the seed,
    // so it is indistinguishable from a deliberately emptied one EXCEPT by
    // this: emptying detaches on the way out, so labels still on the plate
    // mean the list did not come back.
    expect(diagnoseRegistry(reg('ready', []), [T(['office'])])).toBe('orphaned')
  })
})

describe('reconcileView — runs on a FRESH registry only', () => {
  const base = {
    group: null,
    filter: [],
    matchAll: false,
    states: [],
    collapsed: {},
  } as const

  it('a merge REPLACES the slug with its target and dedupes', () => {
    const r = reconcileView(
      { ...base, filter: ['office', 'work'] },
      [L('work', 'blue')],
      new Set(),
      [{ from: 'office', into: 'work' }],
    )
    expect(r.next.filter).toEqual(['work'])
    expect(r.notice).toContain('“office” was merged into @work')
  })

  it('a merge in ANOTHER TAB is followed too — that is what `into` buys', () => {
    // The receiving tab has only {action:'merge', slug, into} from the wire.
    const r = reconcileView(
      { ...base, filter: ['office'] },
      [L('work', 'blue')],
      new Set(),
      [{ from: 'office', into: 'work' }],
    )
    expect(r.next.filter).toEqual(['work'])
  })

  it('a delete DROPS the slug and names it in a notice', () => {
    const r = reconcileView(
      { ...base, filter: ['office'] },
      [L('home', 'green')],
      new Set(),
    )
    expect(r.next.filter).toEqual([])
    expect(r.notice).toContain('office')
    expect(r.notice).toContain('filter cleared')
  })

  it('a partial delete says the filter changed rather than that it cleared', () => {
    const r = reconcileView(
      { ...base, filter: ['office', 'home'] },
      [L('home', 'green')],
      new Set(),
    )
    expect(r.next.filter).toEqual(['home'])
    expect(r.notice).toContain('removed from your filter')
  })

  it('an UNREGISTERED slug still on the plate is NOT treated as deleted', () => {
    // Without the plate argument every agent-written filter chip is cleared on
    // the next refetch — a filter the owner set, silently destroyed.
    const r = reconcileView(
      { ...base, filter: ['infra'] },
      [L('home', 'green')],
      new Set(['infra']),
    )
    expect(r.next.filter).toEqual(['infra'])
    expect(r.notice).toBeNull()
  })

  it('G3 — the "your last state was deleted" branch is GONE, not adapted', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "grouping by
    // state with zero states falls back to ungrouped, with a notice", and it
    // guarded a real behaviour: delete your last state row and grouping by
    // state had nothing left to project onto, so it switched off and SAID SO.
    //
    // After the retirement `!labels.some(l => l.kind === 'state')` is ALWAYS
    // true. Left in place, that branch would fire on the first refetch for
    // every owner who had grouping on, switch it off, and announce a deletion
    // that never happened. So the branch is deleted rather than adapted, and
    // this test is inverted to hold it deleted.
    //
    // WHAT REPLACED IT: nothing, and nothing is required to. Ticket grouping
    // reads no registry row, so there is no row whose deletion could take it
    // away — which is the same fact `effectiveGroup`'s exemption encodes.
    const r = reconcileView({ ...base, group: 'ticket' }, [L('home', 'green')], new Set())
    expect(r.next.group).toBe('ticket')
    expect(r.notice).toBeNull()
    // …and with an entirely empty registry, which is where the deleted branch
    // would have been loudest.
    const empty = reconcileView({ ...base, group: 'ticket' }, [], new Set())
    expect(empty.next.group).toBe('ticket')
    expect(empty.notice).toBeNull()
  })

  it('`states` rides through untouched — it is not the registry\'s to reconcile', () => {
    // Not decoration: the caller writes this whole object back to storage, so a
    // dropped key here silently unpersists the owner's state filter on the next
    // registry refetch.
    const r = reconcileView(
      { ...base, filter: ['office'], states: ['working', 'completed'] },
      [L('home', 'green')],
      new Set(),
    )
    expect(r.next.states).toEqual(['working', 'completed'])
  })

  it('a collapsed TICKET group key survives a refetch', () => {
    // A ticket key names no label, so neither the registry nor the plate can
    // vouch for it — and the dead-key sweep would drop it, unfolding the
    // owner's folded Done group on every refetch.
    const r = reconcileView(
      { ...base, collapsed: { '__tk:completed': true, office: true } },
      [L('home', 'green')],
      new Set(),
    )
    expect(r.next.collapsed).toEqual({ '__tk:completed': true })
  })

  it('grouping by context with nothing to project onto falls back SILENTLY', () => {
    const r = reconcileView({ ...base, group: 'context' }, [], new Set())
    expect(r.next.group).toBeNull()
    expect(r.notice).toBeNull()
  })

  it('a context group survives on unregistered slugs alone', () => {
    const r = reconcileView({ ...base, group: 'context' }, [], new Set(['infra']))
    expect(r.next.group).toBe('context')
  })

  it('a dead collapsed key is dropped INERTLY — no notice', () => {
    const r = reconcileView(
      { ...base, collapsed: { office: true, home: false, [RESIDUAL_KEY]: true } },
      [L('home', 'green')],
      new Set(),
    )
    expect(r.next.collapsed).toEqual({ home: false, [RESIDUAL_KEY]: true })
    expect(r.notice).toBeNull()
  })

  it('a steady-state refetch changes nothing and reports changed:false', () => {
    const r = reconcileView({ ...base, filter: ['home'] }, [L('home', 'green')], new Set())
    expect(r.changed).toBe(false)
    expect(r.notice).toBeNull()
  })

  it('matchAll is carried through untouched', () => {
    const r = reconcileView(
      { ...base, filter: ['home'], matchAll: true },
      [L('home', 'green')],
      new Set(),
    )
    expect(r.next.matchAll).toBe(true)
  })
})

describe('effectiveGroup — suppressed off-ready, except where it need not be', () => {
  it('renders the stored LABEL axis when the registry is held', () => {
    // Re-pointed from `'state'`, which is no longer a value this can hold.
    expect(effectiveGroup(view({ group: 'context' }), 'ready')).toBe('context')
    expect(effectiveGroup(view({ group: 'context' }), 'provisional')).toBe('context')
  })

  it('suppresses the LABEL axis while the registry is missing, so it returns by itself', () => {
    expect(effectiveGroup(view({ group: 'context' }), 'unavailable')).toBeNull()
    expect(effectiveGroup(view({ group: 'context' }), 'cold')).toBeNull()
  })

  it('G2 — `ticket` is EXEMPT from the suppression, in every registry state', () => {
    // The exemption is the whole reason ticket grouping is worth having:
    // suppressed alongside `context`, the one axis that still functions would
    // vanish at exactly the moment it is the only one left. It partitions on a
    // field that arrives with the to-do, so a dead registry costs it nothing.
    for (const st of ['ready', 'provisional', 'cold', 'unavailable'] as RegistryState[]) {
      expect(effectiveGroup(view({ group: 'ticket' }), st)).toBe('ticket')
    }
  })
})

describe('unknownAxisReason — `cold` is "not yet", `unavailable` is "not going to"', () => {
  it('does not report a failure that has not happened', () => {
    expect(unknownAxisReason('cold')).toBe('Still loading your labels…')
    expect(unknownAxisReason('cold')).not.toMatch(/didn't load/)
  })

  it('does report one that has', () => {
    expect(unknownAxisReason('unavailable')).toMatch(/didn't load/)
  })
})

describe('registryWritable — the guard on every create surface', () => {
  it('allows a create against a registry we can read', () => {
    expect(registryWritable('ready', 'populated')).toBe(true)
    expect(registryWritable('ready', 'empty')).toBe(true)
    // An empty registry is an ANSWER. Refusing to create there would leave a
    // first-time owner with no way to get a first label.
  })

  it('refuses one against an ORPHANED registry', () => {
    // Zero rows over a labelled plate means the list did not come back — and
    // `create_label` would append to that empty list and save it over the file.
    expect(registryWritable('ready', 'orphaned')).toBe(false)
    expect(registryWritable('provisional', 'orphaned')).toBe(false)
  })

  it('refuses one when the axis is unknown at all', () => {
    expect(registryWritable('cold', 'empty')).toBe(false)
    expect(registryWritable('unavailable', 'empty')).toBe(false)
  })
})

describe('reconcile notices name a label the way the rail names it', () => {
  const base = { group: null, filter: [], matchAll: false, collapsed: {} } as const

  it('gives the merge target its sigil and quotes the label that is gone', () => {
    // `@work` is alive and resolvable; `office` has no row left to read a kind
    // from, so a sigil there would assert an axis we just lost.
    const r = reconcileView(
      { ...base, filter: ['office'] },
      [L('work', 'blue')],
      new Set(),
      [{ from: 'office', into: 'work' }],
    )
    expect(r.notice).toBe('“office” was merged into @work — your filter followed it.')
  })

  it('quotes a deleted label rather than inventing a sigil for it', () => {
    const r = reconcileView({ ...base, filter: ['office'] }, [], new Set(), [])
    expect(r.notice).toBe('Label “office” was deleted — filter cleared.')
  })

  it('agrees with itself in the plural', () => {
    const r = reconcileView({ ...base, filter: ['office', 'shed'] }, [], new Set(), [])
    expect(r.notice).toBe('Labels “office”, “shed” were deleted — filter cleared.')
  })

  it('announces a merge AND a delete that land in the same refetch', () => {
    // Two tabs, two hands, one poll. An early return on the merge branch would
    // swallow the delete — and a filter chip that vanishes with no notice is
    // the one thing §1.1's notice exists to prevent.
    const r = reconcileView(
      { ...base, filter: ['office', 'shed'] },
      [L('work', 'blue')],
      new Set(),
      [{ from: 'office', into: 'work' }],
    )
    expect(r.next.filter).toEqual(['work'])
    expect(r.notice).toContain('“office” was merged into @work')
    expect(r.notice).toContain('“shed” was deleted')
  })
})

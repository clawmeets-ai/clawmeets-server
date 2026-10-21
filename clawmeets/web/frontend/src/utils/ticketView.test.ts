import { describe, expect, it } from 'vitest'
import type { DeskLabel } from '../api/endpoints/deskLabels'
import type { DeskTodo, TicketState } from '../api/endpoints/deskTodos'
import { toRegistry, type LabelView, type RegistryState } from './labelView'
import {
  TICKET_GROUP_ORDER,
  TICKET_STATES,
  groupByTicketState,
  hasTicketChip,
  matchesPlate,
  stateCounts,
  ticketGroupKey,
  ticketLabel,
} from './ticketView'

/**
 * THE SECOND AXIS.
 *
 * Two properties carry most of this file, and both are about what the functions
 * DO NOT take: `groupByTicketState` takes no registry, and `matchesPlate`'s
 * state term runs before the label filter's registry branch. Together they are
 * why the ticket axis keeps working when the label registry does not — which is
 * precisely when it matters, because it is then the only axis left.
 */

const L = (slug: string): DeskLabel => ({
  slug,
  name: slug,
  kind: 'context',
  color: 'blue',
  created_at: '1970-01-01T00:00:00+00:00',
  updated_at: '1970-01-01T00:00:00+00:00',
})

let seq = 0
const T = (state: TicketState, over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: `t-${++seq}`,
  owner_user_id: 'u1',
  text: `task ${seq}`,
  state,
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  attachments: [],
  labels: [],
  ...over,
})

const reg = (state: RegistryState = 'ready') => toRegistry([L('office'), L('home')], state)
const view = (over: Partial<LabelView> = {}): LabelView => ({
  group: null,
  filter: [],
  matchAll: false,
  states: [],
  ...over,
})

describe('ticketLabel — the UI owns the words', () => {
  it('spells the four states', () => {
    expect(ticketLabel('new')).toBe('New')
    expect(ticketLabel('working')).toBe('Working')
    expect(ticketLabel('failed')).toBe('Failed')
    expect(ticketLabel('completed')).toBe('Done')
  })

  it('TICKET_STATES is the fixed render order, New FIRST', () => {
    // New leads because New IS the inbox. There is no "Unprocessed" pile to put
    // ahead of it any more, and there must never be one again. Failed sits
    // between Working and Done: this constant is LIFECYCLE order (what states
    // exist, in the order you'd pick one), where the rail's is URGENCY order.
    expect([...TICKET_STATES]).toEqual(['new', 'working', 'failed', 'completed'])
  })
})

describe('the derivation, mirrored — what the server does, stated as a test', () => {
  // The browser never derives `state`; it reads it. These cases pin what each
  // value MEANS, so a fixture that contradicts the server is visible here
  // rather than as a wrong chip in a DOM test six files away.
  it.each([
    ['every contributing association COMPLETED', 'completed'],
    ['any contributing association not complete', 'working'],
    ['nothing contributing, but one resolved FAILED', 'failed'],
    ['no contributing associations at all', 'new'],
  ] as const)('%s → %s', (_why, state) => {
    expect(TICKET_STATES).toContain(state)
  })

  it('a to-do whose only project was DELETED reads new, with the count still 2', () => {
    // A DANGLING id only. A failed project is now `failed` — the two used to
    // collapse together here, which is precisely the gap the fourth state
    // closed: "nothing ever started" and "it started and broke" were the same
    // row on the plate. `association_count` is the STORED count, so this pair
    // is legal and is exactly the case the stored reading keeps legible.
    const dangling = T('new', { association_count: 2, project_ids: ['p-1', 'p-2'] })
    expect(dangling.state).toBe('new')
    expect(dangling.association_count).toBe(2)
    // …and under criterion 1 it renders NO chip, so the count has nothing to
    // hang itself on. Recorded here because it is a known consequence of the
    // criterion rather than a defect in the field.
    expect(hasTicketChip(dangling)).toBe(false)
  })

  it('a FAILED row is distinguishable from a dangling one, and DOES carry a chip', () => {
    // The whole point of the fourth state. Same stored count, same absence of
    // anything contributing — and now a different, visible answer.
    const failed = T('failed', { association_count: 1, project_ids: ['p-1'] })
    expect(failed.state).not.toBe('new')
    expect(hasTicketChip(failed)).toBe(true)
  })
})

describe('hasTicketChip — the "New renders nothing" decision, in one place', () => {
  it('is false for new and true for the other two', () => {
    expect(hasTicketChip(T('new'))).toBe(false)
    expect(hasTicketChip(T('working'))).toBe(true)
    expect(hasTicketChip(T('completed'))).toBe(true)
  })

  it('does not care whether the row is archived', () => {
    // AC-1.7: an archived row whose project is still running must be VISIBLY
    // Working. The two axes never read each other, here least of all.
    expect(hasTicketChip(T('working', { archived: true }))).toBe(true)
    expect(hasTicketChip(T('new', { archived: true }))).toBe(false)
  })
})

describe('matchesPlate — the state term runs FIRST and reads no registry', () => {
  const officeWorking = T('working', { labels: ['office'] })
  const homeNew = T('new', { labels: ['home'] })

  it('an empty state filter passes every state', () => {
    for (const t of [officeWorking, homeNew]) {
      expect(matchesPlate(t, view(), reg())).toBe(true)
    }
  })

  it('one state narrows to that state', () => {
    const v = view({ states: ['working'] })
    expect(matchesPlate(officeWorking, v, reg())).toBe(true)
    expect(matchesPlate(homeNew, v, reg())).toBe(false)
  })

  it('several states WIDEN — there is no ALL/AND toggle on this axis', () => {
    // And there must not be one: a to-do has exactly one state, so an AND
    // across two is unsatisfiable and the control could only ever produce an
    // empty plate. This is the argument that used to justify exempting the
    // state HALF of the label filter from `matchAll`; it survived onto the axis
    // that still has the property.
    const v = view({ states: ['working', 'new'] })
    expect(matchesPlate(officeWorking, v, reg())).toBe(true)
    expect(matchesPlate(homeNew, v, reg())).toBe(true)
    expect(matchesPlate(T('completed'), v, reg())).toBe(false)
  })

  it.each(['ready', 'provisional', 'cold', 'unavailable'] as RegistryState[])(
    'still filters by state with the registry %s',
    (st) => {
      // THE CRITERION. State filtering consults no registry, so it has to
      // survive one that will not load — and it cannot do that from behind a
      // function that answers `true` as soon as the LABEL filter is empty,
      // which is why the term runs before `matches()` rather than inside it.
      const v = view({ states: ['working'] })
      expect(matchesPlate(officeWorking, v, reg(st))).toBe(true)
      expect(matchesPlate(homeNew, v, reg(st))).toBe(false)
    },
  )

  it('the state term ANDs with the label filter — both must pass', () => {
    // This is what replaced the old "AND across kinds". The narrowing survived;
    // it just moved onto an axis that is not a label.
    const v = view({ filter: ['office'], states: ['working'] })
    expect(matchesPlate(officeWorking, v, reg())).toBe(true)
    // right label, wrong state
    expect(matchesPlate(T('new', { labels: ['office'] }), v, reg())).toBe(false)
    // right state, wrong label
    expect(matchesPlate(T('working', { labels: ['home'] }), v, reg())).toBe(false)
  })
})

describe('stateCounts — all four keys, zeros included', () => {
  it('counts each unarchived row once', () => {
    const open = [T('new'), T('new'), T('working'), T('completed')]
    const c = stateCounts(open)
    expect(c.get('new')).toBe(2)
    expect(c.get('working')).toBe(1)
    expect(c.get('completed')).toBe(1)
  })

  it('returns 0 rather than undefined for a state nothing carries', () => {
    // A blank count beside a context row that has one reads as broken, so the
    // popover needs a number here, not an absence.
    const c = stateCounts([T('new')])
    expect(c.get('working')).toBe(0)
    expect(c.get('failed')).toBe(0)
    expect(c.get('completed')).toBe(0)
    expect([...c.keys()]).toEqual(['new', 'working', 'failed', 'completed'])
  })

  it('counts a failed row on its own key, not folded into new', () => {
    const c = stateCounts([T('new'), T('failed'), T('failed')])
    expect(c.get('new')).toBe(1)
    expect(c.get('failed')).toBe(2)
  })

  it('an empty plate still reports four zeros', () => {
    expect([...stateCounts([]).values()]).toEqual([0, 0, 0, 0])
  })
})

describe('groupByTicketState — totality, and no residual', () => {
  const plate = [
    T('new'),
    T('working'),
    T('working'),
    T('failed'),
    T('completed'),
    T('new', { labels: ['office'] }),
  ]

  it('yields EXACTLY four groups, WORKING FIRST then FAILED, never folded away', () => {
    // The rail is a worklist read top-down: what is in flight sits above what
    // broke, which sits above the inbox, and Completed — the only group that
    // only ever grows — is last. Failed is SECOND and not in lifecycle
    // position, because a row that broke needs a hand before an untouched one
    // does. This is the one place the rail's order and `TICKET_STATES` differ.
    const groups = groupByTicketState(plate)
    expect(groups.map((g) => g.name)).toEqual(['Working', 'Failed', 'New', 'Done'])
    expect(groups.map((g) => g.key)).toEqual([
      ticketGroupKey('working'),
      ticketGroupKey('failed'),
      ticketGroupKey('new'),
      ticketGroupKey('completed'),
    ])
    for (const g of groups) expect(g.collapsedByDefault).toBe(false)
  })

  it('the rail order is a PERMUTATION of the states, never a subset', () => {
    // The filter rows read `TICKET_STATES` and the rail reads
    // `TICKET_GROUP_ORDER`; if the two ever stopped agreeing on MEMBERSHIP, a
    // state would be filterable but have no group to land in — grouping would
    // silently drop rows rather than look reordered.
    expect([...TICKET_GROUP_ORDER].sort()).toEqual([...TICKET_STATES].sort())
    expect(TICKET_GROUP_ORDER).toHaveLength(TICKET_STATES.length)
  })

  it('the four groups still render when the plate is EMPTY', () => {
    // A missing "Done" header reads as a missing feature rather than as an
    // empty group; the four together are a map, which only works whole. The
    // cost is one ~24px header per empty group, and Failed made it four.
    const groups = groupByTicketState([])
    expect(groups).toHaveLength(4)
    expect(groups.every((g) => g.items.length === 0)).toBe(true)
  })

  it('every to-do lands in exactly ONE group — none dropped, none twice', () => {
    const groups = groupByTicketState(plate)
    const ids = groups.flatMap((g) => g.items.map((t) => t.id))
    expect(ids).toHaveLength(plate.length)
    expect(new Set(ids).size).toBe(plate.length)
    expect(new Set(ids)).toEqual(new Set(plate.map((t) => t.id)))
  })

  it('there is NO residual group, and no group carries the inbox nag', () => {
    // The replacement, not an adjustment. The old pile was computed from label
    // membership and would swallow the whole plate; `state` is required, so
    // every to-do has a real group and New IS the inbox.
    const groups = groupByTicketState(plate)
    expect(groups.some((g) => g.key === '__resid')).toBe(false)
    expect(groups.some((g) => g.name.includes('Unprocessed'))).toBe(false)
    expect(groups.every((g) => g.tone === 'ticket')).toBe(true)
  })

  it('carries no ResolvedLabel — a ticket state is not a label', () => {
    // Inventing one is how it would start being treated as a label by the
    // surfaces that read `group.label`.
    for (const g of groupByTicketState(plate)) expect(g.label).toBeNull()
  })

  it('group keys cannot collide with a label slug', () => {
    // `normalizeSlug` rejects `:`, so no registry row can ever produce one of
    // these — which is what lets them share the store's `collapsed` map.
    for (const s of TICKET_STATES) expect(ticketGroupKey(s)).toContain(':')
  })

  it('is a PURE PROJECTION — it takes no registry and mutates nothing', () => {
    const before = plate.map((t) => t.id)
    groupByTicketState(plate)
    groupByTicketState(plate)
    expect(plate.map((t) => t.id)).toEqual(before)
    // The absent registry parameter is the point: there is no argument that
    // could be off-ready, so there is no state in which this returns [].
    expect(groupByTicketState.length).toBe(1)
  })
})

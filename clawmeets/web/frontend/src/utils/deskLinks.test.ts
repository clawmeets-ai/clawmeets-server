import { describe, expect, it } from 'vitest'
import { NO_PAIR, resolveLinkedPair, sameHover, type DeskHover } from './deskLinks'
import type { DeskTodo } from '../api/endpoints/deskTodos'

/**
 * THE JOIN'S RULES, as cheap unit tests.
 *
 * `DeskPage.crossHighlight.test.tsx` and `MyDeskRailPanel.crossHighlight.test.tsx`
 * still prove the thing only a render can prove — that `project_ids` lines up
 * with a card's `projectId` in the shape the app actually draws, and that the
 * classes land on the right elements. What they are a slow way to test is the
 * BRANCHING, which is pure and has four edge cases that each need their own
 * fixture. Those live here now that the join is a function two trees call.
 *
 * The reference-stability cases are not pedantry: this function runs on every
 * pointer crossing, in two React trees, and its results are memo dependencies
 * in both. A fresh `new Set()` for "nothing is lit" would repaint the whole
 * sidebar every time the pointer left a row.
 */

const TODO = (
  id: string,
  project_ids: string[],
  over: Partial<DeskTodo> = {},
): DeskTodo => ({
  id,
  owner_user_id: 'u1',
  text: id,
  state: 'new',
  archived: false,
  association_count: project_ids.length,
  project_ids,
  created_at: '',
  updated_at: '',
  attachments: [],
  ...over,
})

const TODOS: DeskTodo[] = [
  TODO('t-both', ['p-alpha', 'p-beta']),
  TODO('t-alpha', ['p-alpha']),
  TODO('t-none', []),
  TODO('t-dangling', ['p-gone']),
  TODO('t-filed', ['p-alpha'], { archived: true }),
]

const PLATED: ReadonlySet<string> = new Set(['p-alpha', 'p-beta', 'p-lonely'])

const ids = (s: ReadonlySet<string>) => [...s].sort()

describe('resolveLinkedPair', () => {
  it('returns the shared empty pair when nothing is hovered', () => {
    expect(resolveLinkedPair(null, TODOS, PLATED)).toBe(NO_PAIR)
  })

  describe('hovering a card', () => {
    const onAlpha: DeskHover = { side: 'card', projectId: 'p-alpha' }

    it('lights every live to-do listing that projectId, and marks the card too', () => {
      const pair = resolveLinkedPair(onAlpha, TODOS, PLATED)
      expect(ids(pair.linkedTodoIds)).toEqual(['t-alpha', 't-both'])
      // The hovered end wears the mark as well, or the highlight reads as
      // "look over there" rather than as a pair.
      expect(ids(pair.linkedProjectIds)).toEqual(['p-alpha'])
    })

    it('excludes ARCHIVED rows even though their ids match', () => {
      // `t-filed` lists p-alpha. The drawer is a record of filed-away work, not
      // the plate, and it is collapsed by default anyway.
      expect(ids(resolveLinkedPair(onAlpha, TODOS, PLATED).linkedTodoIds)).not.toContain('t-filed')
    })

    it('leaves a card no live to-do points at dark on BOTH ends', () => {
      // The non-empty gate, and the whole reason this is not a CSS `:hover`
      // rule: an unpaired card must stay unmarked, or the accent stops meaning
      // "paired" and starts meaning "the pointer is here".
      const pair = resolveLinkedPair({ side: 'card', projectId: 'p-lonely' }, TODOS, PLATED)
      expect(pair).toBe(NO_PAIR)
    })

    it('stays dark for a card whose ONLY to-do is archived', () => {
      // The gate is applied after the archived filter, not before it — so a
      // card with one filed-away row is as unpaired as one with no rows.
      const onlyFiled = [TODO('t-filed', ['p-alpha'], { archived: true })]
      expect(resolveLinkedPair({ side: 'card', projectId: 'p-alpha' }, onlyFiled, PLATED)).toBe(
        NO_PAIR,
      )
    })
  })

  describe('hovering a to-do', () => {
    it('lights the row’s project_ids VERBATIM, plated or not', () => {
      // `project_ids` keeps the ids of deleted projects forever, so the set is
      // not filtered against the plate: an unmatched id simply lights no card.
      // Nothing renders a match count anywhere, for exactly that reason.
      const pair = resolveLinkedPair({ side: 'todo', todoId: 't-both' }, TODOS, PLATED)
      expect(ids(pair.linkedProjectIds)).toEqual(['p-alpha', 'p-beta'])
      expect(ids(pair.linkedTodoIds)).toEqual(['t-both'])
    })

    it('asks the STRICTER question for the row’s own mark', () => {
      // Carrying an id is not the same as having a partner on screen. The row
      // publishes its dead id (lighting nothing) but stays dark itself, exactly
      // as the cards it fails to light do.
      const pair = resolveLinkedPair({ side: 'todo', todoId: 't-dangling' }, TODOS, PLATED)
      expect(ids(pair.linkedProjectIds)).toEqual(['p-gone'])
      expect(ids(pair.linkedTodoIds)).toEqual([])
    })

    it('returns the empty pair for a row carrying no ids at all', () => {
      expect(resolveLinkedPair({ side: 'todo', todoId: 't-none' }, TODOS, PLATED)).toBe(NO_PAIR)
    })

    it('returns the empty pair for a row that is no longer in the list', () => {
      // The plate refetches under a live pointer; a hover can outlive its row.
      expect(resolveLinkedPair({ side: 'todo', todoId: 't-deleted' }, TODOS, PLATED)).toBe(NO_PAIR)
    })
  })

  describe('reference stability', () => {
    it('hands back the SAME pair object every time nothing is lit', () => {
      // Two calls from two different trees, on two different unpaired hovers,
      // must be `Object.is`-identical or every consumer's memo invalidates.
      const a = resolveLinkedPair(null, TODOS, PLATED)
      const b = resolveLinkedPair({ side: 'card', projectId: 'p-lonely' }, TODOS, PLATED)
      expect(a).toBe(b)
    })
  })
})

describe('sameHover', () => {
  it('treats two structurally equal hovers as the same', () => {
    // The guard that makes a repeated `setHover` a true no-op in the store.
    // Without it every re-entry hands the sidebar a fresh object literal.
    expect(sameHover({ side: 'card', projectId: 'p1' }, { side: 'card', projectId: 'p1' })).toBe(
      true,
    )
    expect(sameHover({ side: 'todo', todoId: 't1' }, { side: 'todo', todoId: 't1' })).toBe(true)
    expect(sameHover(null, null)).toBe(true)
  })

  it('separates the two sides even when the ids collide', () => {
    // Project ids and to-do ids are different id spaces, but nothing stops a
    // fixture — or a future id scheme — from producing the same string.
    expect(sameHover({ side: 'card', projectId: 'x' }, { side: 'todo', todoId: 'x' })).toBe(false)
  })

  it('separates a hover from no hover, and different ids from each other', () => {
    expect(sameHover({ side: 'card', projectId: 'p1' }, null)).toBe(false)
    expect(sameHover(null, { side: 'card', projectId: 'p1' })).toBe(false)
    expect(sameHover({ side: 'card', projectId: 'p1' }, { side: 'card', projectId: 'p2' })).toBe(
      false,
    )
  })
})

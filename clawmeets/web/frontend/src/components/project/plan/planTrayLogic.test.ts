import { describe, expect, it } from 'vitest'
import type {
  PlanIndex,
  PlanNote,
  PlanSection,
  PlanVersion,
} from '../../../api/endpoints/projectPlans'
import {
  acceptRow,
  addressees,
  commentList,
  appliedTextRow,
  decisionRow,
  dropTextRows,
  editAsNote,
  duplicateHeadings,
  editRow,
  foldedReason,
  groupComments,
  heldTextRow,
  lastToucherOf,
  openDeviation,
  isAlarming,
  openDeviations,
  openForYou,
  openNotesOn,
  pendingNotes,
  preambleText,
  proposerClause,
  removeRow,
  resolveCollision,
  sectionOwnText,
  sectionText,
  stackRows,
  toWire,
  versionLine,
  visibleSections,
  type TrayRow,
} from './planTrayLogic'

/* The body below is the shape the server's grammar produces: a leading `# `
 * TITLE that is NOT a section (its extent would span the whole document), two
 * `##` sections and a `###` nested inside the second. Every offset here is
 * what the server would compute; nothing in the client derives one. */
const BODY = [
  '# Project Plan: demo', // 0..21
  '',
  '## Goal', // 22
  'Ship the thing.',
  '',
  '## Milestones', // 55
  '',
  '### M1', // 70
  '- [x] one',
  '- [ ] two',
  '',
].join('\n')

const goalStart = BODY.indexOf('## Goal')
const msStart = BODY.indexOf('## Milestones')
const m1Start = BODY.indexOf('### M1')

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: goalStart, char_end: msStart },
  {
    id: 'milestones',
    heading: 'Milestones',
    depth: 2,
    boxes: [1, 2],
    char_start: msStart,
    char_end: BODY.length,
  },
  { id: 'm1', heading: 'M1', depth: 3, boxes: [1, 2], char_start: m1Start, char_end: BODY.length },
]

function note(over: Partial<PlanNote> = {}): PlanNote {
  return {
    id: 'n1',
    section: 'goal',
    to: 'user',
    by: 'content_writer',
    at: '2026-08-23T10:00:00Z',
    status: 'open',
    kind: 'proposal',
    layer: 'spec',
    comment: 'tighten this',
    proposal: '## Goal\nShip the thing well.\n\n',
    base_section: '## Goal\nShip the thing.\n\n',
    quote: '',
    reply_to: '',
    round: '',
    conflict: false,
    resolved_by: '',
    resolved_at: '',
    resolution: '',
    revision: 3,
    has_proposal: true,
    sent: false,
    replies: [],
    section_missing: false,
    section_new: false,
    section_changed: false,
    display_diff: '',
    ...over,
  }
}

describe('sectionText — the one place the client indexes into the body', () => {
  it('slices on the offsets the SERVER derived, never on a heading it found', () => {
    expect(sectionText(BODY, SECTIONS[0])).toBe('## Goal\nShip the thing.\n\n')
  })

  it('the document TITLE is not among the sections and so has no extent here', () => {
    // A leading `# ` heading on a document with deeper headings is the title.
    // Its extent would span the whole document, so a "replace this section"
    // against it would overwrite everything. The server never sends one.
    expect(SECTIONS.some((s) => s.depth === 1)).toBe(false)
    expect(SECTIONS.every((s) => s.char_start >= goalStart)).toBe(true)
  })

  it('a nested section is INSIDE its parent extent as well as beside it', () => {
    // The premise of everything below. The server's `parse_sections` returns a
    // nested heading twice on purpose — as its own section, and as part of its
    // parent's character range — so a renderer handed the flat list at full
    // extent draws `### M1` under `## Milestones` AND again on its own.
    const ms = SECTIONS[1]
    const m1 = SECTIONS[2]
    expect(m1.char_start).toBeGreaterThan(ms.char_start)
    expect(m1.char_end).toBeLessThanOrEqual(ms.char_end)
    expect(sectionText(BODY, ms)).toContain(sectionText(BODY, m1))
  })
})

describe('sectionOwnText — the overlap is drawn once, by the child', () => {
  it('a parent stops at the first nested section the pane also draws', () => {
    // `## Milestones` in this document IS one line followed by a sub-heading,
    // so its own text is that line. The milestone body belongs to `### M1`.
    expect(sectionOwnText(BODY, SECTIONS[1], SECTIONS)).toBe('## Milestones\n\n')
  })

  it('the whole-document pane prints every character EXACTLY ONCE', () => {
    // The regression this function exists for. Before it, the sum of the
    // rendered extents exceeded the body by the length of every nested
    // section — 12,619 characters on the plan that surfaced this.
    const drawn =
      preambleText(BODY, SECTIONS) +
      SECTIONS.map((s) => sectionOwnText(BODY, s, SECTIONS)).join('')
    expect(drawn).toBe(BODY)
  })

  it('a FOCUSED parent prints its children in full — nothing else draws them', () => {
    // The word "visible" in the rule. On a section pane `shownSections` is
    // `[current]`, so there is no child on screen to give the overlap to and
    // truncating would hide the milestones the user clicked in to read.
    expect(sectionOwnText(BODY, SECTIONS[1], [SECTIONS[1]])).toBe(
      sectionText(BODY, SECTIONS[1]),
    )
  })

  it('a leaf section is untouched, on either pane', () => {
    expect(sectionOwnText(BODY, SECTIONS[0], SECTIONS)).toBe(sectionText(BODY, SECTIONS[0]))
    expect(sectionOwnText(BODY, SECTIONS[2], SECTIONS)).toBe(sectionText(BODY, SECTIONS[2]))
  })

  it('is always a PREFIX of the full extent, which is what keeps a splice correct', () => {
    // `onBlockEdit` seeds `spliceBlock` from the FULL section text while remark
    // reports its block ranges against the rendered string. That is only sound
    // because the rendered string is a prefix: an offset pair inside a prefix
    // indexes the same characters inside the whole string.
    for (const s of SECTIONS) {
      expect(sectionText(BODY, s).startsWith(sectionOwnText(BODY, s, SECTIONS))).toBe(true)
    }
  })

  it('nests on OFFSETS, not on depth or on slug', () => {
    // Two sections that share a heading de-duplicate as `x` / `x-2`, and a
    // document may skip a heading level. Neither is consulted: containment is
    // the extents, which the server always derives correctly.
    const skipped: PlanSection[] = [
      { ...SECTIONS[1], id: 'ms' },
      { ...SECTIONS[2], id: 'ms-2', heading: 'Milestones', depth: 5 },
    ]
    expect(sectionOwnText(BODY, skipped[0], skipped)).toBe('## Milestones\n\n')
  })
})

describe('visibleSections — a staged parent absorbs its children', () => {
  it('an untouched tray draws every section the server sent', () => {
    expect(visibleSections(SECTIONS, () => false)).toEqual(SECTIONS)
  })

  it('a section nested in a STAGED one is not drawn beside it', () => {
    // Staged text is the parent's WHOLE extent, descendants included, so
    // drawing `### M1` separately would print it twice again — this bug, one
    // edit later. Its notes fall to the side rail until the edit resolves.
    const visible = visibleSections(SECTIONS, (slug) => slug === 'milestones')
    expect(visible.map((s) => s.id)).toEqual(['goal', 'milestones'])
  })

  it('staging a LEAF hides nothing — it has no descendants to absorb', () => {
    expect(visibleSections(SECTIONS, (slug) => slug === 'm1')).toEqual(SECTIONS)
  })

  it('the staged parent then renders in full, because no child is visible', () => {
    const visible = visibleSections(SECTIONS, (slug) => slug === 'milestones')
    expect(sectionOwnText(BODY, SECTIONS[1], visible)).toBe(sectionText(BODY, SECTIONS[1]))
  })
})

describe('AC-6.6 — raw editing IS section changes', () => {
  it('two sections edited give TWO rows', () => {
    const a = editRow(SECTIONS[0], sectionText(BODY, SECTIONS[0]), '## Goal\nShip it well.\n\n')
    const b = editRow(SECTIONS[1], sectionText(BODY, SECTIONS[1]), '## Milestones\n\nnew\n')
    expect([a, b].filter(Boolean)).toHaveLength(2)
  })

  it('whitespace changed in one section gives ONE row', () => {
    const base = sectionText(BODY, SECTIONS[0])
    const a = editRow(SECTIONS[0], base, base + '\n')
    const b = editRow(SECTIONS[1], sectionText(BODY, SECTIONS[1]), sectionText(BODY, SECTIONS[1]))
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(a!.section).toBe('goal')
  })

  it('nothing changed gives NO row — the phantom-write trap', () => {
    // An editor that emits a row on every blur produces a revision, a changelog
    // entry and a FILE_UPDATED for a section nobody changed.
    for (const s of SECTIONS) {
      expect(editRow(s, sectionText(BODY, s), sectionText(BODY, s))).toBeNull()
    }
  })

  it('a nested edit reports the nested section and NOT its parent', () => {
    // Change detection is own-text: editing `### M1` is one row for `m1`, not
    // that row plus `## Milestones`, whose extent contains it.
    const row = editRow(SECTIONS[2], sectionText(BODY, SECTIONS[2]), '### M1\n- [x] one\n- [x] two\n')
    expect(row!.section).toBe('m1')
    expect([row].filter((r) => r?.section === 'milestones')).toHaveLength(0)
  })

  it("`base` is the document's CURRENT text, which is what makes the write land", () => {
    const base = sectionText(BODY, SECTIONS[0])
    const row = editRow(SECTIONS[0], base, '## Goal\nnew\n')!
    expect(row.base).toBe(base)
  })
})

describe('AC-6.3 — staging writes zero bytes and carries no status', () => {
  it('an accept row is a proposal to accept; the note is untouched', () => {
    const n = note()
    const row = acceptRow(n, sectionText(BODY, SECTIONS[0]))
    expect(row.kind).toBe('accept')
    expect(row.note_id).toBe('n1')
    expect(n.status).toBe('open')
  })

  it('reject / ask / dismiss carry no text at all', () => {
    for (const kind of ['reject', 'ask', 'dismiss'] as const) {
      const row = decisionRow(kind, note(), 'because')
      expect(row.text).toBe('')
      expect(row.base).toBe('')
      expect(row.kind).toBe(kind)
    }
  })
})

describe('U5 — two accepted proposals on one section', () => {
  // Two DIFFERENT proposals for the same section — the whole reason the
  // collision exists. A proposal is a whole-section replacement, so two accepts
  // cannot compose; under the old per-block model they did and there was
  // nothing to decide.
  const first = acceptRow(
    note({ id: 'n1', by: 'content_writer', proposal: '## Goal\nWriter text.\n' }),
    'held',
  )
  const second = acceptRow(
    note({ id: 'n2', by: 'reel_editor', proposal: '## Goal\nEditor text.\n' }),
    'held',
  )

  it('detects the collision at STAGING time, on an unsent tray', () => {
    expect(heldTextRow([first], 'goal')?.id).toBe(first.id)
  })

  it('consults neither staleness nor any force flag — there is nothing to consult', () => {
    // A row whose `base` is text nobody ever wrote is still detected, because a
    // tray is never validated against the document. This is the cross-batch
    // mechanism's opposite number and it must not reach into it.
    const invented = acceptRow(note({ id: 'n3' }), 'text nobody ever wrote')
    expect(heldTextRow([invented], 'goal')?.id).toBe(invented.id)
  })

  it("`Keep @held's` never stages the second", () => {
    const out = resolveCollision([first], first, second, 'held')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(first.id)
  })

  it("`Take @new's` KEEPS the first, marked superseded and undoable", () => {
    const out = resolveCollision([first], first, second, 'next')
    expect(out).toHaveLength(2)
    expect(out.find((r) => r.id === first.id)!.superseded_by).toBe(second.id)
    // Removing the second restores the first: nothing typed is discarded.
    const undone = removeRow(out, second.id)
    expect(undone).toHaveLength(1)
    expect(undone[0].superseded_by).toBeUndefined()
  })

  it('`Write my own` produces ONE edit row, section-scoped', () => {
    const out = resolveCollision([first], first, second, 'own', 'my reconciled text')
    const fresh = out.filter((r) => !r.superseded_by)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].kind).toBe('edit')
    expect(fresh[0].section).toBe('goal')
    expect(fresh[0].text).toBe('my reconciled text')
    expect(fresh[0].note_id).toBe('')
  })

  it('each of the three choices yields a DIFFERENT section body', () => {
    const held = resolveCollision([first], first, second, 'held')
    const next = resolveCollision([first], first, second, 'next')
    const own = resolveCollision([first], first, second, 'own', 'mine')
    const landing = (rows: TrayRow[]) => rows.filter((r) => !r.superseded_by).map((r) => r.text)
    expect(new Set([...landing(held), ...landing(next), ...landing(own)]).size).toBe(3)
  })

  /**
   * KEEP BOTH — the outcome that discards nothing, and now the one that can say
   * so. `recordsFolds` is the LAST argument and it selects ONE thing: what
   * happens to the row that lost the section.
   *
   * The winner is the same on both branches — a single `accept` row carrying
   * the FOLD, appended last, so `_collapse_text_rows` (last text row per
   * section wins) applies it. What moved is the loser.
   *
   * TRUE — the loser STAYS a text row, carrying `folded: true`. That is the
   * whole change: a second text row on one section is exactly what the server
   * collapses, and the boolean is what turns that collapse's force-close from
   * `rejected` + "superseded by @{by}'s proposal on the same section" — false
   * about a proposal whose lines are in the document — into `folded` + "your
   * text is in the section that landed".
   *
   * FALSE — the argument the code used to make unconditionally, and it is still
   * right against a server that has never heard of the field: such a server
   * drops the boolean with a 200 and closes the note `rejected` on text that
   * landed, which is worse than the dismissal this client writes itself.
   */
  it('`Keep both` stages ONE text row on a server that does not record folds', () => {
    const out = stackRows([first], first, note({ id: 'n1', by: 'content_writer' }), second, 'both texts', 'folded in', false)
    const text = out.filter((r) => r.kind === 'edit' || r.kind === 'accept')
    expect(text).toHaveLength(1)
    expect(text[0].kind).toBe('accept')
    expect(text[0].note_id).toBe('n2')
    expect(text[0].text).toBe('both texts')
    // The winner is LAST, which is the row the server applies.
    expect(out[out.length - 1].id).toBe(text[0].id)
  })

  it('`Keep both` stages TWO text rows, the loser carrying the fold bit, when the server records folds', () => {
    const out = stackRows([first], first, note({ id: 'n1', by: 'content_writer' }), second, 'both texts', 'folded in', true)
    const text = out.filter((r) => r.kind === 'edit' || r.kind === 'accept')
    expect(text).toHaveLength(2)
    // The loser is FIRST and is still the `accept` row it always was — same
    // note, same base, same text. One bit is all that changed.
    const loser = text[0]
    expect(loser.id).toBe(first.id)
    expect(loser.kind).toBe('accept')
    expect(loser.note_id).toBe('n1')
    expect(loser.text).toBe(first.text)
    expect(loser.base).toBe(first.base)
    expect(loser.folded).toBe(true)
    expect(loser.folded_by).toBe(text[1].id)
    // The winner is LAST and NEVER carries the bit: it is the row that lands.
    const winner = out[out.length - 1]
    expect(winner.note_id).toBe('n2')
    expect(winner.text).toBe('both texts')
    expect(winner.folded).toBeUndefined()
    // No dismissal, and no sentence: the server derives and writes both.
    expect(out.some((r) => r.kind === 'dismiss')).toBe(false)
    expect(JSON.stringify(out)).not.toContain('folded in')
  })

  it('closes the folded-away note as a DISMISS carrying the reason on a server that does not record folds', () => {
    const out = stackRows([first], first, note({ id: 'n1', by: 'content_writer' }), second, 'both texts', foldedReason('reel_editor'), false)
    const closed = out.find((r) => r.note_id === 'n1')!
    expect(closed.kind).toBe('dismiss')
    expect(closed.comment).toContain("Folded into @reel_editor's change")
    expect(closed.comment).toContain('your text is in the section that landed')
    // Not a text row, so `_collapse_text_rows` never sees it and the server
    // never writes its own `superseded` sentence over this one.
    expect(closed.superseded_by).toBeUndefined()
    expect(out.some((r) => r.superseded_by)).toBe(false)
  })

  /** AN ABSENT FLAG IS A FALSE FLAG, asserted against the same tray rather than
   *  argued: `records_folds` is omitted by every server that predates it, and
   *  `PlanEditor`'s `?? false` is what turns that omission into this branch. */
  it('behaves identically when the capability is absent as when it is false', () => {
    const args = [[first], first, note({ id: 'n1', by: 'content_writer' }), second, 'both texts', foldedReason('reel_editor')] as const
    const explicit = stackRows(...args, false)
    // The shape a payload with no `records_folds` produces, through the one
    // coalesce that reads it.
    const index = { records_folds: undefined } as unknown as PlanIndex
    const absent = stackRows(...args, index.records_folds ?? false)
    const shape = (rows: TrayRow[]) =>
      rows.map((r) => [r.kind, r.note_id, r.text, r.comment, r.folded, r.folded_by])
    expect(shape(absent)).toEqual(shape(explicit))
  })

  it('still sends five legal kinds and nothing else, on either server', () => {
    for (const recordsFolds of [false, true]) {
      const out = stackRows([first], first, note({ id: 'n1' }), second, 'both texts', 'folded in', recordsFolds)
      const wire = toWire(out)
      expect(wire.every((e) => ['edit', 'accept', 'reject', 'ask', 'dismiss'].includes(e.kind))).toBe(
        true,
      )
      // The capable branch adds an `accept`, never a sixth kind — and `folded`
      // rides on exactly one entry, the loser, never on the winner.
      const bits = wire.filter((e) => e.folded === true)
      expect(bits).toHaveLength(recordsFolds ? 1 : 0)
      if (recordsFolds) expect(bits[0].note_id).toBe('n1')
      expect(JSON.stringify(wire)).not.toContain('folded_by')
    }
  })

  /** A HELD ROW WITH NO NOTE IS DROPPED, no branch required — and the drop is
   *  branch-INDEPENDENT, which is what this case now proves. Two callers land
   *  here: the user's own `edit` row — whose text is already inside the fold,
   *  with no note to close — and the SYNTHETIC current-text row the
   *  `section_changed` path builds, which is in no tray at all. Keeping such a
   *  row on the capable branch would leave a live text row with no `note_id`,
   *  and the server would read `folded` off it on behalf of nobody. */
  it.each([false, true])(
    'drops a held row that names no note instead of closing one (records_folds=%s)',
    (recordsFolds) => {
      const mine = editRow(SECTIONS[0], 'held', '## Goal\nMy own text.\n')!
      const out = stackRows([mine], mine, undefined, second, 'both texts', 'folded in', recordsFolds)
      expect(out).toHaveLength(1)
      expect(out[0].note_id).toBe('n2')
    },
  )

  /** A stack of THREE composes by the same rule, and this is the case the
   *  contract's rejection of a wire-borne `folded_into` is argued from: by the
   *  time C lands, any winner A had snapshotted at staging time is gone. On the
   *  capable branch nothing is snapshotted onto the wire at all. */
  it('stacks a third proposal onto the second, on a server that does not record folds', () => {
    const third = acceptRow(note({ id: 'n3', by: 'devops', proposal: '## Goal\nDevops text.\n' }), 'held')
    const two = stackRows([first], first, note({ id: 'n1' }), second, 'a+b', 'folded in', false)
    const winner = two[two.length - 1]
    const three = stackRows(two, winner, note({ id: 'n2' }), third, 'a+b+c', 'folded in', false)
    expect(three.filter((r) => r.kind === 'accept')).toHaveLength(1)
    expect(three.filter((r) => r.kind === 'dismiss').map((r) => r.note_id)).toEqual(['n1', 'n2'])
    expect(three[three.length - 1].text).toBe('a+b+c')
  })

  it('stacks a third proposal onto the second when the server records folds', () => {
    const third = acceptRow(note({ id: 'n3', by: 'devops', proposal: '## Goal\nDevops text.\n' }), 'held')
    const two = stackRows([first], first, note({ id: 'n1' }), second, 'a+b', 'folded in', true)
    // THE PREDICATE IS LOAD-BEARING, AND THIS IS WHERE. The loser is still a
    // live `accept` row on `goal`, so a `.find()` that did not skip folded rows
    // would hand the third fold the FIRST proposal instead of the text
    // currently standing — and A's change would be dropped from the compose.
    const winner = heldTextRow(two, 'goal')!
    expect(winner.id).toBe(two[two.length - 1].id)
    expect(winner.note_id).toBe('n2')

    const three = stackRows(two, winner, note({ id: 'n2' }), third, 'a+b+c', 'folded in', true)
    expect(three.filter((r) => r.kind === 'accept')).toHaveLength(3)
    expect(three.filter((r) => r.folded).map((r) => r.note_id)).toEqual(['n1', 'n2'])
    expect(three.some((r) => r.kind === 'dismiss')).toBe(false)
    // Only the last row lands, and it alone is clean.
    expect(three[three.length - 1].text).toBe('a+b+c')
    expect(three[three.length - 1].folded).toBeUndefined()
    expect(heldTextRow(three, 'goal')!.id).toBe(three[three.length - 1].id)
  })

  /** `✕` ON THE WINNER GIVES THE SECTION ITS TEXT ROW BACK — the symmetric twin
   *  of the un-supersede case above, and not optional. Without it the tray
   *  keeps an ORPHAN carrying `folded: true` as the section's only text row:
   *  the server would collapse to it, APPLY it, and close its note as folded
   *  into a change that was never written. */
  it('un-folds the loser when the winner is removed', () => {
    const out = stackRows([first], first, note({ id: 'n1' }), second, 'both texts', 'folded in', true)
    const undone = removeRow(out, out[out.length - 1].id)
    expect(undone).toHaveLength(1)
    expect(undone[0].id).toBe(first.id)
    // DELETED, not set false — `folded` reaches the wire only ever as `true`.
    expect('folded' in undone[0]).toBe(false)
    expect('folded_by' in undone[0]).toBe(false)
    expect(heldTextRow(undone, 'goal')!.id).toBe(first.id)
  })

  it('`superseded` NEVER reaches the wire — DraftEntry.kind is five values', () => {
    const out = resolveCollision([first], first, second, 'next')
    const wire = toWire(out)
    expect(wire.every((e) => ['edit', 'accept', 'reject', 'ask', 'dismiss'].includes(e.kind))).toBe(
      true,
    )
    expect(wire.some((e) => 'superseded_by' in e)).toBe(false)
    expect(JSON.stringify(wire)).not.toContain('superseded')
  })

  /** `folded_by` IS THE SAME PROMISE AS `superseded_by`, and it is the half of
   *  the pair the contract cares about: the BOOLEAN crosses the wire, the row
   *  id never does. A row id is a client-side counter that resets on every page
   *  load, and the tray is rehydrated from the server's stored draft — so a
   *  stored id and a fresh one collide, and the winner is the row that gets
   *  silently regenerated. `folded` carries no identity for exactly that
   *  reason; the winner is the server's to derive. */
  it('`folded_by` NEVER reaches the wire, but `folded` does', () => {
    const out = stackRows([first], first, note({ id: 'n1' }), second, 'both texts', 'folded in', true)
    expect(out.some((r) => r.folded_by)).toBe(true)
    const wire = toWire(out)
    expect(wire.some((e) => 'folded_by' in e)).toBe(false)
    expect(JSON.stringify(wire)).not.toContain('folded_by')
    expect(JSON.stringify(wire)).toContain('"folded":true')
  })
})

describe('the row a REFUSED SUBMIT is about', () => {
  /* THE OTHER END OF U5, and the reason `heldTextRow` is not enough on its own.
   *
   * Once a collision is settled with `Take @{new}'s` the tray holds two text
   * rows for one section. `toWire` sends both — `superseded_by` is a label, not
   * a wire kind — and `_collapse_text_rows` keeps the LAST one and resolves the
   * earlier `rejected`. So the row the server writes, refuses and reports
   * staleness for is the LAST one, and the post-refusal panel has to offer that
   * row and no other. Offering the first re-bases a proposal the user already
   * discarded, leaves the winner stale, and earns the identical `409` on the
   * next Send with nothing on screen that has moved. */
  const loser = acceptRow(
    note({ id: 'n1', by: 'content_writer', proposal: '## Goal\nWriter text.\n' }),
    'the section as it read then',
  )
  const winner = acceptRow(
    note({ id: 'n2', by: 'reel_editor', proposal: '## Goal\nEditor text.\n' }),
    'the section as it read then',
  )
  const settled = resolveCollision([loser], loser, winner, 'next')

  it('is the LAST non-superseded text row — the one `_collapse_text_rows` keeps', () => {
    expect(settled).toHaveLength(2)
    expect(appliedTextRow(settled, 'goal')?.id).toBe(winner.id)
  })

  it('SURVIVES THE MIRROR, WHICH THE `superseded_by` LABEL DOES NOT', () => {
    /* THE CASE THAT MAKES "last wins" THE RULE RATHER THAN A HARDENING.
     *
     * `superseded_by` never reaches the wire, so the tray the server hands
     * back has NO label on it — and the editor adopts that array wholesale on
     * any mount that has not been typed into (the desk's compact editor, the
     * project tab reopened, a remount after the PUT). Both rows come back
     * live, and every predicate that leans on the label is answering off
     * information that no longer exists.
     *
     * ORDER IS ALL THAT SURVIVES, and order is exactly what the server's rule
     * reads. `heldTextRow` takes the FIRST match and now names the discarded
     * proposal; `appliedTextRow` takes the last and still names the row the
     * submit will write. */
    const adopted = toWire(settled) as TrayRow[]
    expect(adopted.some((r) => r.superseded_by)).toBe(false)
    expect(heldTextRow(adopted, 'goal')?.id).toBe(loser.id)
    expect(appliedTextRow(adopted, 'goal')?.id).toBe(winner.id)
  })

  it('agrees with `toWire` about which row lands', () => {
    // The client's answer and the server's rule read off the same array.
    const wire = toWire(settled).filter((e) => e.section === 'goal' && e.kind === 'accept')
    expect(wire[wire.length - 1].id).toBe(appliedTextRow(settled, 'goal')!.id)
  })

  it('finds an accepted DELETE, whose text is legitimately empty', () => {
    // `proposes_delete` stages an ordinary `accept` row with `text: ''`. A
    // truthiness test skips it and the refusal panel then has no row to offer
    // for a section whose only staged change is its removal.
    const del = acceptRow(note({ id: 'n9', proposal: '', proposes_delete: true }), 'old text')
    expect(del.text).toBe('')
    expect(appliedTextRow([del], 'goal')?.id).toBe(del.id)
  })

  it('has no answer for a section carrying only decisions', () => {
    const ask = decisionRow('ask', note({ id: 'n4' }), 'why?')
    expect(appliedTextRow([ask], 'goal')).toBeUndefined()
  })
})

describe("`Keep what it says now` drops the section's staged text WHOLE", () => {
  /* The refusal panel's first button means "this section keeps the document's
   * text". `removeRow` cannot express that once a collision has been settled:
   * its `✕` un-supersedes the row the winner overtook, which is right when the
   * user is undoing the choice and wrong here — it resurrects a proposal they
   * already discarded and stages it, unreviewed, against the section they just
   * said to leave alone. */
  const loser = acceptRow(note({ id: 'n1', proposal: '## Goal\nA.\n' }), 'then')
  const winner = acceptRow(note({ id: 'n2', proposal: '## Goal\nB.\n' }), 'then')
  const settled = resolveCollision([loser], loser, winner, 'next')

  it('leaves nothing that would write to the section', () => {
    const out = dropTextRows(settled, 'goal')
    expect(out.filter((r) => r.kind === 'edit' || r.kind === 'accept')).toHaveLength(0)
  })

  it('is NOT what `removeRow` does — that resurrects the loser', () => {
    const undone = removeRow(settled, winner.id)
    expect(undone).toHaveLength(1)
    expect(undone[0].superseded_by).toBeUndefined()
    expect(appliedTextRow(undone, 'goal')?.id).toBe(loser.id)
  })

  it('leaves decisions on the same section alone — they write no bytes', () => {
    const ask = decisionRow('ask', note({ id: 'n3' }), 'why?')
    const out = dropTextRows([...settled, ask], 'goal')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(ask.id)
  })

  it('touches no other section', () => {
    const elsewhere = acceptRow(note({ id: 'n5', section: 'milestones' }), 'then')
    expect(dropTextRows([...settled, elsewhere], 'goal')).toEqual([elsewhere])
  })
})

describe('✕ removes exactly one', () => {
  it('leaves the section’s other rows alone', () => {
    const a = acceptRow(note({ id: 'n1' }), 'x')
    const b = decisionRow('ask', note({ id: 'n2' }), 'q')
    expect(removeRow([a, b], a.id)).toHaveLength(1)
    expect(removeRow([a, b], a.id)[0].id).toBe(b.id)
  })
})

describe('§6.C — the inverted mapping and the empty list', () => {
  const version = (over: Partial<PlanVersion>): PlanVersion => ({
    revision: 6,
    sha: 's',
    by: 'coordinator',
    at: '2026-08-23T10:00:00Z',
    version: 12,
    proposed_by: [],
    note: '',
    ...over,
  })

  it('wire `by` renders as the APPLIER and `proposed_by` as the proposer', () => {
    // A straight by->by port reads "@coordinator's proposal, applied by
    // @coordinator" on every specialist-originated revision, and looks
    // plausible, because the only appliers are ever the owner and the keeper.
    const line = versionLine(version({ by: 'coordinator', proposed_by: ['content_writer'] }))
    expect(line).toBe("@content_writer's proposal, applied by @coordinator")
    expect(line).not.toBe("@coordinator's proposal, applied by @content_writer")
  })

  it('two proposers are BOTH named — picking [0] drops a real contributor', () => {
    expect(proposerClause(['content_writer', 'reel_editor'])).toBe(
      "@content_writer and @reel_editor's proposals",
    )
  })

  it('three or more take the serial comma form, plural', () => {
    expect(proposerClause(['a', 'b', 'c'])).toBe("@a, @b and @c's proposals")
  })

  it('an EMPTY list is the one-name form with no proposer clause at all', () => {
    // Empty is a fact about authorship — a keeper's own edit, a tick, a
    // coordinator write — not missing data. It is also what every
    // pre-migration round reads as, which is what makes "zero migration" true
    // on screen.
    expect(proposerClause([])).toBe('')
    const line = versionLine(version({ by: 'coordinator', proposed_by: [] }))
    expect(line).toBe('applied by @coordinator')
    expect(line).not.toContain('proposed')
    expect(line).not.toContain("'s proposal")
  })
})

describe('the one integer', () => {
  it('counts open notes addressed to the literal `user`, and nothing else', () => {
    const notes = [
      note({ id: 'a', to: 'user', status: 'open' }),
      note({ id: 'b', to: 'user', status: 'open', kind: 'deviation' }),
      note({ id: 'c', to: 'user', status: 'applied' }),
      note({ id: 'd', to: 'content_writer', status: 'open' }),
      note({ id: 'e', to: '', status: 'open' }), // recorded, never sent
    ]
    expect(openForYou(notes)).toBe(2)
  })

  it('the DEVIATION is INSIDE the count, never beside it', () => {
    // The single most likely bug on the card: `+ (deviation ? 1 : 0)`
    // double-counts the number the execution gate reads, which is a defeated
    // guard rather than a miscount.
    const withDev = [
      note({ id: 'a', to: 'user', status: 'open' }),
      note({ id: 'b', to: 'user', status: 'open', kind: 'deviation' }),
    ]
    const dev = withDev.find((n) => n.kind === 'deviation')
    expect(openForYou(withDev)).toBe(2)
    expect(openForYou(withDev) + (dev ? 1 : 0)).not.toBe(openForYou(withDev))
  })

  it('a section dot counts every open note on that section, not only yours', () => {
    const notes = [
      note({ id: 'a', section: 'goal', to: 'user', status: 'open' }),
      note({ id: 'b', section: 'goal', to: 'content_writer', status: 'open' }),
      note({ id: 'c', section: 'goal', status: 'dismissed' }),
      note({ id: 'd', section: 'milestones', status: 'open' }),
    ]
    expect(openNotesOn(notes, 'goal')).toBe(2)
  })
})

describe('the duplicate-heading warning is DERIVED', () => {
  it('two sections sharing a heading IS the warning; there is no wire member', () => {
    const dupes = duplicateHeadings([
      ...SECTIONS,
      { id: 'goal-2', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 1 },
    ])
    expect([...dupes]).toEqual(['Goal'])
    // De-duplication is `x` / `x-2` — a HYPHEN, not a tilde.
    expect('goal-2').toMatch(/-2$/)
  })

  it('no duplicates means no warning', () => {
    expect(duplicateHeadings(SECTIONS).size).toBe(0)
  })
})

describe('addressees, and who last touched a section', () => {
  it('a superseded row addresses nobody', () => {
    const a = { ...acceptRow(note({ id: 'n1', by: 'x' }), 't'), superseded_by: 'z' }
    const b = acceptRow(note({ id: 'n2', by: 'y' }), 't')
    expect(addressees([a, b], [note({ id: 'n1', by: 'x' }), note({ id: 'n2', by: 'y' })])).toEqual([
      'y',
    ])
  })

  it('the held author on a refused row is read from the activity log, not invented', () => {
    const index = {
      keeper: 'coordinator',
      history: [
        { seq: 1, at: 't1', by: 'coordinator', verb: 'create', section: '', detail: '' },
        { seq: 2, at: 't2', by: 'reel_editor', verb: 'write', section: 'goal', detail: '' },
      ],
    } as unknown as PlanIndex
    expect(lastToucherOf(index, 'goal')).toBe('reel_editor')
    // Nothing touched `milestones`: fall back to the keeper rather than name
    // the wrong person on a decision control.
    expect(lastToucherOf(index, 'milestones')).toBe('coordinator')
  })
})

/* THE BATCH'S NOTE HALF.
 *
 * `POST …/plan/notes` records a note and delivers nothing; only a submit that
 * NAMES it in `note_ids` puts it in front of anybody. So "what is pending" is a
 * question about the notes payload, and every case below is a note that must
 * NOT be named — naming any of them sends something nobody asked to send. */
describe('pendingNotes — what rides the next Send', () => {
  it('your open, addressed, unsent note is pending', () => {
    expect(pendingNotes([note({ id: 'a', by: 'user', to: 'coordinator' })]).map((n) => n.id)).toEqual(
      ['a'],
    )
  })

  it("an agent's note to you is NOT pending — your decision on it is a tray row", () => {
    // The double-send this excludes: the note would be a row's `note_id` AND a
    // named id in one submit, and the server would address it twice.
    expect(pendingNotes([note({ id: 'a', by: 'content_writer', to: 'user' })])).toEqual([])
  })

  it('a note recorded and never addressed stays recorded', () => {
    // `to === ''` is §5.4's "recorded, never sent". Naming it makes the server
    // address it to the KEEPER, which is not what recording it meant.
    expect(pendingNotes([note({ id: 'a', by: 'user', to: '' })])).toEqual([])
  })

  it('a note you addressed to yourself reaches nobody new', () => {
    expect(pendingNotes([note({ id: 'a', by: 'user', to: 'user' })])).toEqual([])
  })

  it('a note already out is not offered again', () => {
    expect(pendingNotes([note({ id: 'a', by: 'user', to: 'coordinator', sent: true })])).toEqual([])
  })

  it('a closed note is not pending, whatever closed it', () => {
    const closed = (['answered', 'applied', 'rejected', 'dismissed'] as const).map((status) =>
      note({ id: status, by: 'user', to: 'coordinator', status }),
    )
    expect(pendingNotes(closed)).toEqual([])
  })

  /* THE OTHER DIRECTION OF THE DOUBLE-SEND, and the one authorship alone does
   * not cover. Your own note stays `open` and unsent while a decision on it is
   * only STAGED — that is the whole of AC-6.3 — so the notes payload still
   * reads it as pending. The tray has to say otherwise. */
  it('a note the tray already decides on is in the batch ONCE, as that decision', () => {
    const mine = note({ id: 'mine', by: 'user', to: 'backend' })
    expect(pendingNotes([mine]).map((n) => n.id)).toEqual(['mine'])
    // Withdrawing it must not deliver it: staged, it is a dismiss row and
    // nothing more.
    expect(pendingNotes([mine], [decisionRow('dismiss', mine)])).toEqual([])
  })

  it('undoing the decision puts the note back in the batch', () => {
    const mine = note({ id: 'mine', by: 'user', to: 'backend' })
    const row = decisionRow('dismiss', mine)
    expect(pendingNotes([mine], removeRow([row], row.id)).map((n) => n.id)).toEqual(['mine'])
  })

  it('a SUPERSEDED row still counts — it rides the submit with its note_id', () => {
    // `Take @{new}'s` leaves the overtaken row in the tray, individually
    // undoable, and the server resolves it `rejected`. Reading only live rows
    // would let its note ride a second time as a named id.
    const mine = note({ id: 'mine', by: 'user', to: 'backend', has_proposal: true })
    const held = acceptRow(mine, 'text as it stands')
    const next = acceptRow(note({ id: 'theirs', by: 'backend', to: 'user' }), 'text as it stands')
    const rows = resolveCollision([held], held, next, 'next')
    expect(rows.find((r) => r.id === held.id)?.superseded_by).toBe(next.id)
    expect(pendingNotes([mine], rows)).toEqual([])
  })

  it('a decision on someone ELSE\'s note leaves your own comment pending', () => {
    const inbound = note({ id: 'n1', by: 'backend', to: 'user' })
    const mine = note({ id: 'mine', by: 'user', to: 'coordinator' })
    expect(pendingNotes([inbound, mine], [decisionRow('dismiss', inbound)]).map((n) => n.id)).toEqual(
      ['mine'],
    )
  })

  it('an edit row carries no note_id and decides nothing', () => {
    const mine = note({ id: 'mine', by: 'user', to: 'backend' })
    const edit = editRow(SECTIONS[0], 'Ship the thing.', 'Ship it sooner.')!
    expect(edit.note_id).toBe('')
    expect(pendingNotes([mine], [edit]).map((n) => n.id)).toEqual(['mine'])
  })
})

describe('addressees — a batch reaches both halves', () => {
  it('a pending note contributes who it was written TO, not its author', () => {
    // The direction split the server makes: a decision goes back to the note's
    // AUTHOR, a named note goes to its ADDRESSEE.
    const mine = note({ id: 'mine', by: 'user', to: 'designer' })
    expect(addressees([], [mine], [mine])).toEqual(['designer'])
  })

  it('rows first, then notes, first-wins on a name that appears in both', () => {
    const inbound = note({ id: 'n1', by: 'content_writer', to: 'user' })
    const mine = note({ id: 'mine', by: 'user', to: 'content_writer' })
    const row = acceptRow(inbound, 't')
    expect(addressees([row], [inbound, mine], [mine])).toEqual(['content_writer'])
  })

  it('with no rows and no pending notes, nobody is addressed', () => {
    expect(addressees([], [], [])).toEqual([])
  })
})

/**
 * `openDeviation` — the SAME SELECTION the server makes, over the SAME ARRAY.
 *
 * The server builds `PlanSummary.deviation` with `_open_deviation`, which walks
 * `plan.notes` in reverse and returns the first `kind === 'deviation'` with
 * `status === 'open'`. `GET …/plan` ships that same note list unfiltered as
 * `PlanIndex.notes`. So this is not a second derivation of a fact the server
 * owns — it is the same rule applied to the same input, which is what lets the
 * editor render the alarm off the index while the desk card's chip reads the
 * summary, without the two ever disagreeing.
 */
describe('the open deviation', () => {
  it('NEWEST WINS — a fresh deviation is what the surface shows', () => {
    const notes = [
      note({ id: 'old', kind: 'deviation', status: 'open' }),
      note({ id: 'new', kind: 'deviation', status: 'open' }),
    ]
    expect(openDeviation(notes)?.id).toBe('new')
  })

  it('ignores a CLOSED deviation, in every status the wire has for one', () => {
    for (const status of ['answered', 'applied', 'rejected', 'dismissed'] as const) {
      expect(openDeviation([note({ id: 'd', kind: 'deviation', status })])).toBeUndefined()
    }
  })

  it('and falls back to an older OPEN one when the newest is closed', () => {
    const notes = [
      note({ id: 'old', kind: 'deviation', status: 'open' }),
      note({ id: 'new', kind: 'deviation', status: 'dismissed' }),
    ]
    expect(openDeviation(notes)?.id).toBe('old')
  })

  it('ignores every other kind — a comment is not the work going off-contract', () => {
    for (const kind of ['note', 'proposal', 'reply'] as const) {
      expect(openDeviation([note({ id: 'n', kind, status: 'open' })])).toBeUndefined()
    }
  })

  it('DOES NOT FILTER ON ADDRESSEE, and that is deliberate', () => {
    // A deviation raised against someone else is still the work going
    // off-contract, and the card has always shown it. The server applies no
    // `to` filter either — this is the half of the rule most likely to be
    // "tidied" into agreeing with `openForYou`, which is a different question.
    expect(openDeviation([note({ id: 'd', kind: 'deviation', status: 'open', to: 'content_writer' })])?.id).toBe('d')
    expect(openDeviation([note({ id: 'd', kind: 'deviation', status: 'open', to: '' })])?.id).toBe('d')
  })

  it('answers undefined on an empty list rather than throwing', () => {
    expect(openDeviation([])).toBeUndefined()
  })

  /** THE LIST AND THE HEAD ARE ONE SCAN. The alarm renders every open
   *  deviation; the desk card's `off-contract` chip is about the newest one.
   *  Two questions, one selection — `openDeviation` IS `openDeviations[0]`, so
   *  the two surfaces cannot come to disagree about which note they mean. */
  it('EVERY open deviation, newest first — and the singular is its head', () => {
    const notes = [
      note({ id: 'old', kind: 'deviation', status: 'open' }),
      note({ id: 'mid', kind: 'deviation', status: 'dismissed' }),
      note({ id: 'plain', kind: 'note', status: 'open' }),
      note({ id: 'new', kind: 'deviation', status: 'open' }),
    ]
    expect(openDeviations(notes).map((n) => n.id)).toEqual(['new', 'old'])
    expect(openDeviation(notes)).toBe(openDeviations(notes)[0])
  })

  it('an empty list, not a throw, when nothing is off-contract', () => {
    expect(openDeviations([])).toEqual([])
    expect(openDeviations([note({ id: 'n', kind: 'note', status: 'open' })])).toEqual([])
  })

  /** A DETAIL-LAYER DEPARTURE IS A RECORD AND NOT AN ALARM. The keeper could
   *  have made that edit with `plan update` and no refusal, so the server does
   *  not count it in `open_notes_for_you` and the project is not stopped — and
   *  an alarm that fires where the gate does not is a red box over a project
   *  nothing is blocking. `kind` still says `deviation`; only the red moves. */
  it('leaves a DETAIL-layer deviation out of the alarm, and keeps the word', () => {
    const dev = note({ id: 'd', kind: 'deviation', status: 'open', layer: 'detail' })
    expect(openDeviations([dev])).toEqual([])
    expect(openDeviation([dev])).toBeUndefined()
    expect(isAlarming(dev)).toBe(false)
    expect(dev.kind).toBe('deviation')
  })

  it('is ONE predicate — the box, the row and the desk chip cannot disagree', () => {
    expect(isAlarming(note({ kind: 'deviation', status: 'open', layer: 'spec' }))).toBe(true)
    expect(isAlarming(note({ kind: 'deviation', status: 'dismissed' }))).toBe(false)
    expect(isAlarming(note({ kind: 'note', status: 'open' }))).toBe(false)
  })
})

/** `openForYou` MUST EQUAL `open_notes_for_you`, and that number grew a third
 *  term. A detail-layer note still renders and still sends — it just stops
 *  being something waiting on the user, so the desk pill and the gate let go
 *  of it. Losing the term here would put a bigger count on the plan tab than
 *  the desk card shows for the same plan. */
describe('the notes waiting on you', () => {
  it('skips a note filed against a section the keeper could just have written', () => {
    const notes = [
      note({ id: 'a', to: 'user', status: 'open', layer: 'spec' }),
      note({ id: 'b', to: 'user', status: 'open', layer: 'detail' }),
    ]
    expect(openForYou(notes)).toBe(1)
  })
})


/* ---------------------------------------------------------------------------
 * `editAsNote` / `commentList` — the tray's items, as the comments they are.
 * ------------------------------------------------------------------------- */

function editRowFor(over: Partial<TrayRow> = {}): TrayRow {
  return {
    id: 'e1',
    kind: 'edit',
    section: 'milestones',
    text: '## Milestones\n\nfour of them now\n',
    base: '## Milestones\n\ntwo of them\n',
    note_id: '',
    comment: '',
    to: '',
    at: '2026-08-23T12:00:00Z',
    ...over,
  }
}

describe('editAsNote — a staged row, as the comment it is', () => {
  it('RENAMES FIELDS THE ROW ALREADY HAS and invents none', () => {
    const n = editAsNote(editRowFor())
    // `base` IS `base_section` and `text` IS `proposal` — which is exactly the
    // pair a real proposal note carries, and is why the projection is
    // structural rather than cosmetic.
    expect(n.base_section).toBe('## Milestones\n\ntwo of them\n')
    expect(n.proposal).toBe('## Milestones\n\nfour of them now\n')
    expect(n.section).toBe('milestones')
    expect(n.by).toBe('user')
    expect(n.has_proposal).toBe(true)
    expect(n.status).toBe('open')
  })

  it('ITS ID IS THE ROW’S, so the ✕ and the scroll anchor need no translation', () => {
    expect(editAsNote(editRowFor({ id: 'e9' })).id).toBe('e9')
  })

  it('`display_diff` IS EMPTY ON PURPOSE — the branch that reads it is never taken', () => {
    // `diffSeries` draws `note.proposal ? renderDiff(...) : note.display_diff`,
    // so a projection carrying a proposal renders through the existing path
    // with nothing added. An empty string here is correct, not missing.
    const n = editAsNote(editRowFor())
    expect(n.display_diff).toBe('')
    expect(n.proposal).not.toBe('')
  })

  it('summarises to the FIRST NON-EMPTY LINE, which is what the tray row printed', () => {
    expect(editAsNote(editRowFor()).comment).toBe('## Milestones')
  })

  it('AN ORPHANED DECISION PROJECTS TOO, and writes nothing', () => {
    // A reject whose note was resolved underneath it still rides the submit, so
    // it must still be drawn and still be undoable. It proposes no text.
    const n = editAsNote(decisionRow('reject', note({ id: 'gone' }), 'not this one'))
    expect(n.has_proposal).toBe(false)
    expect(n.proposal).toBe('')
    expect(n.comment).toBe('not this one')
  })
})

describe('commentList — one list, one order, one join', () => {
  it('DEVIATIONS FIRST, then the rest newest-first, then the projections', () => {
    const notes = [
      note({ id: 'a', kind: 'note', comment: 'oldest' }),
      note({ id: 'b', kind: 'note', comment: 'newest' }),
      note({ id: 'd', kind: 'deviation', comment: 'off contract' }),
    ]
    const items = commentList(notes, [editRowFor()], [])
    expect(items.map((i) => i.note.id)).toEqual(['d', 'b', 'a', 'e1'])
    // Order is the ONE place an edit is still treated as its own thing, and it
    // is a reading decision rather than a type: an alarm belongs at the top and
    // your own uncontroversial rewrite does not.
    expect(items[3].derived).toBe(true)
    expect(items.slice(0, 3).every((i) => !i.derived)).toBe(true)
  })

  it('JOINS ON RAW ROWS — a SUPERSEDED accept is still on its comment', () => {
    // `stagedFor` skips superseded rows. Joining on it here would drop a row
    // that still rides the submit under its `note_id` and is still individually
    // undoable — it would exist nowhere on screen and still go out.
    const n = note({ id: 'n1' })
    const staged: TrayRow = { ...acceptRow(n, 'now'), superseded_by: 'r9' }
    const items = commentList([n], [staged], [])
    expect(items).toHaveLength(1)
    expect(items[0].staged?.superseded_by).toBe('r9')
  })

  it('A ROW WHOSE NOTE IS GONE IS STILL LISTED — never invisible and still sent', () => {
    const orphan = decisionRow('reject', note({ id: 'resolved-elsewhere' }))
    const items = commentList([], [orphan], [])
    expect(items).toHaveLength(1)
    expect(items[0].derived).toBe(true)
    expect(items[0].staged?.id).toBe(orphan.id)
  })

  it('`pending` IS PASSED IN, not recomputed — one answer to “is it out yet?”', () => {
    const mine = note({ id: 'n1', by: 'user', to: 'backend' })
    const items = commentList([mine], [], pendingNotes([mine], []))
    expect(items[0].pending).toBe(true)
    // And a note with a decision staged on it is in the batch as that decision,
    // never as a pending note as well.
    const decided = [decisionRow('dismiss', mine)]
    const after = commentList([mine], decided, pendingNotes([mine], decided))
    expect(after[0].pending).toBe(false)
    expect(after[0].staged?.kind).toBe('dismiss')
  })

  it('THE CONTAINMENT RULE — no derived item ever carries a REAL note id', () => {
    // The projection is display-only and safe exactly as long as it stays
    // inside this return value. Two call sites key on a real note id and would
    // break on a synthetic one: the submit's `note_ids`, where the server has no
    // note to fan out to, and `openNotesOn`, which paints the section rail's dot
    // and speaks its count. This is the rule stated as a test rather than
    // remembered as a comment.
    const notes = [note({ id: 'n1' }), note({ id: 'n2', kind: 'deviation' })]
    const rows = [editRowFor(), acceptRow(notes[0], 'now')]
    const items = commentList(notes, rows, [])
    const real = new Set(notes.map((n) => n.id))
    for (const i of items) {
      if (i.derived) expect(real.has(i.note.id)).toBe(false)
    }
    // And every row in the tray is accounted for exactly once, so nothing in
    // the batch is undrawn and nothing is drawn twice.
    const drawn = items.map((i) => i.staged?.id).filter(Boolean)
    expect(new Set(drawn).size).toBe(rows.length)
  })

  it('KEYS ARE UNIQUE ACROSS BOTH KINDS', () => {
    const notes = [note({ id: 'n1' }), note({ id: 'n2' })]
    const items = commentList(notes, [editRowFor(), editRowFor({ id: 'e2' })], [])
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
  })
})

/**
 * THE DIRECTION SPLIT, AS A PURE FUNCTION.
 *
 * `commentList` owns the ORDER — alarms first, then the rest newest-first,
 * then the projected rows — and this owns nothing but the partition. The two
 * properties worth pinning are therefore *"`user` comes first"* and *"nothing
 * else moved and nothing was dropped"*, because a split that reordered or lost
 * a row would break the complete navigator it exists to make legible.
 */
describe('groupComments', () => {
  const item = (id: string, to: string, layer: 'spec' | 'detail' = 'spec') => ({
    key: id,
    note: note({ id, to, layer }),
    staged: null,
    pending: false,
    derived: false,
  })

  it('puts `user` first and keeps every other group in first-appearance order', () => {
    const groups = groupComments([
      item('a', 'keeper'),
      item('b', 'user'),
      item('c', 'backend'),
      item('d', 'keeper'),
    ])
    expect(groups.map((g) => g.to)).toEqual(['user', 'keeper', 'backend'])
    expect(groups[1].items.map((i) => i.key)).toEqual(['a', 'd'])
  })

  it('keeps relative order inside a group and loses no item', () => {
    const items = [item('a', 'keeper'), item('b', 'user'), item('c', 'keeper')]
    const groups = groupComments(items)
    expect(groups.flatMap((g) => g.items).map((i) => i.key).sort()).toEqual(['a', 'b', 'c'])
    expect(groups.find((g) => g.to === 'keeper')!.items.map((i) => i.key)).toEqual(['a', 'c'])
  })

  it('groups an unaddressed note under `""` rather than folding it into a guess', () => {
    // `''` is *recorded, never sent* — a real thing to file and the one group
    // nobody is waiting on. The caller renders it as its own heading; a
    // two-way mine/theirs split would have had to guess.
    const groups = groupComments([item('a', ''), item('b', 'user')])
    expect(groups.map((g) => g.to)).toEqual(['user', ''])
  })

  it('emits no `user` group when nothing is addressed to you', () => {
    expect(groupComments([item('a', 'keeper')]).map((g) => g.to)).toEqual(['keeper'])
    expect(groupComments([])).toEqual([])
  })

  /* THE REPORTED BUG, AS A NUMBER. A desk card reading `2 for you` over a list
     of three rows. Both were right: the pill is `open_notes_for_you`, which
     counts spec-layer notes because that is what the execution gate reads, and
     this list filters by nothing so it can stay a complete navigator. What was
     missing is the group saying which subset the pill means. */
  it('counts only the rows that hold the work, and lists all of them', () => {
    const groups = groupComments([
      item('spec-1', 'user'),
      item('spec-2', 'user'),
      item('detail-1', 'user', 'detail'),
    ])
    expect(groups[0].items.map((i) => i.key)).toEqual(['spec-1', 'spec-2', 'detail-1'])
    expect(groups[0].holding).toBe(2)
  })

  it('agrees with `openForYou`, which is the number the gate reads', () => {
    // ONE PREDICATE, TWO READERS — `holdsTheWork`. A `holding` that could
    // disagree with `openForYou` would be the second count the server's own
    // model file calls "the defect rather than a shortcut".
    const items = [
      item('a', 'user'),
      item('b', 'user', 'detail'),
      item('c', 'keeper'),
      item('d', ''),
    ]
    const groups = groupComments(items)
    expect(groups.find((g) => g.to === 'user')!.holding).toBe(
      openForYou(items.map((i) => i.note)),
    )
  })

  it('reports 0 holding for every group that is not yours', () => {
    // `holdsTheWork`'s first term is `to === 'user'`, so this falls out of the
    // predicate rather than out of a branch here that could drift from it.
    const groups = groupComments([item('a', 'keeper'), item('b', '')])
    expect(groups.map((g) => g.holding)).toEqual([0, 0])
  })

  it('does not count a closed note, however it is addressed', () => {
    const closed = {
      key: 'x',
      note: note({ id: 'x', to: 'user', status: 'answered' as const }),
      staged: null,
      pending: false,
      derived: false,
    }
    const groups = groupComments([item('a', 'user'), closed])
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].holding).toBe(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * CLICK-TO-EDIT, END TO END, THROUGH THE REAL EDITOR AND THE FAKE SERVER.
 *
 * `planBlocks.test.tsx` pins the string surgery; this pins what the gestures do
 * to the TRAY, which is the only thing that ever reaches a route. Everything is
 * asserted against `server.draft` — the rows as they were mirrored to
 * `PUT /plan/draft` — rather than against the tray's pixels, because the wire
 * is what a submit will actually apply.
 *
 * The three claims worth stating up front, because each of them is a bug if it
 * fails quietly:
 *   - ONE SECTION, ONE ROW, however many blocks are touched.
 *   - `base` IS THE PRISTINE TEXT, captured once, so AC-6.5's stale-submit
 *     check still fires after a run of block edits.
 *   - EDITING BACK TO WHAT THE DOCUMENT SAYS LEAVES NO ROW (AC-6.6, one level
 *     down from the section editor's blur).
 */

const routes = { current: null as ReturnType<typeof routeTo> | null }

vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return {
    ...actual,
    get: (path: string) => routes.current!.get(path),
    post: (path: string, body?: unknown) => routes.current!.post(path, body),
    put: (path: string, body?: unknown) => routes.current!.put(path, body),
    del: (path: string) => routes.current!.del(path),
  }
})

vi.mock('./PlanDiff', () => ({
  PlanDiff: ({ text }: { text: string }) =>
    createElement('pre', { className: 'plan-diff', 'data-testid': 'plan-diff' }, text),
}))

const { PlanEditor } = await import('./PlanEditor')

const PID = 'p-1'

const BODY = [
  '# Project Plan: demo',
  '',
  '## Goal',
  '',
  'The keeper writes the **first** plan.',
  '',
  'And nobody else does.',
  '',
  '## Milestones',
  '',
  '- [ ] ship the thing',
  '- [x] write it down',
  '',
].join('\n')

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'milestones', heading: 'Milestones', depth: 2, boxes: [1, 2], char_start: 0, char_end: 0 },
]

let server: FakePlanServer
let qc: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, children)

beforeEach(() => {
  server = new FakePlanServer(BODY, SECTIONS)
  routes.current = routeTo(server, PID)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})

afterEach(() => {
  cleanup()
  qc.clear()
})

async function editor(density: 'full' | 'compact' = 'full') {
  const view = render(createElement(PlanEditor, { projectId: PID, density }), { wrapper })
  await screen.findByTestId('plan-body')
  return view
}

/** The rendered block whose text starts with `text`. */
function block(container: HTMLElement, tag: string, text: string): HTMLElement {
  const el = [...container.querySelectorAll(`.plan-sec ${tag}.plan-b`)].find((b) =>
    (b.textContent ?? '').includes(text),
  )
  if (!el) throw new Error(`no ${tag} containing ${JSON.stringify(text)}`)
  return el as HTMLElement
}

/** Every rendered block of `tag` whose text contains `text`, OUTERMOST FIRST.
 *
 *  Nesting is the whole subject of change 2, and `block` above cannot express
 *  it: an outer list item and the inner one under it both "contain" the inner
 *  text, so a helper that returns the first match silently answers a question
 *  about the child with the parent. Document order IS outermost-first for
 *  nested elements, so `[0]` is the container and `.at(-1)` is the innermost. */
function blocksWith(container: HTMLElement, tag: string, text: string): HTMLElement[] {
  return [...container.querySelectorAll(`.plan-sec ${tag}.plan-b`)].filter((b) =>
    (b.textContent ?? '').includes(text),
  ) as HTMLElement[]
}

/** Click the prose. jsdom reports no selection by default, which is exactly the
 *  "this click was not the end of a drag" case the editor opens on. */
function clickProse(el: HTMLElement) {
  fireEvent.click(el)
}

/** A document whose Milestones section is an OUTLINE — the shape change 2
 *  exists for, and the one no per-line editor can restructure. */
const OUTLINE = [
  '# Project Plan: demo',
  '',
  '## Goal',
  '',
  'The keeper writes the **first** plan.',
  '',
  '## Milestones',
  '',
  '- outer item',
  '  - inner one',
  '  - inner two',
  '- second item',
  '',
].join('\n')

const SUBTREE = '- outer item\n  - inner one\n  - inner two'

/** Type into the open block field and commit with Enter. */
async function typeAndCommit(value: string, label = /Markdown for this/) {
  const ta = (await screen.findByLabelText(label)) as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  return ta
}

const editRows = () => server.draft.filter((r) => r.kind === 'edit')

describe('a paragraph opens as its own raw Markdown and stages the whole section', () => {
  it('seeds the field with the block, not the section', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    const ta = (await screen.findByLabelText(/Markdown for this paragraph/)) as HTMLTextAreaElement
    // The RAW text — the asterisks remark consumed for display are back.
    expect(ta.value).toBe('The keeper writes the **first** plan.')
  })

  it('stages ONE edit row carrying the whole section, spliced', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    await typeAndCommit('The KEEPER writes the **first** plan.')

    await waitFor(() => expect(editRows()).toHaveLength(1))
    const row = editRows()[0]
    expect(row.section).toBe('goal')
    expect(row.text).toBe(server.sectionText('goal').replace('The keeper', 'The KEEPER'))
    // The rest of the section is byte-identical — the separator survived.
    expect(row.text).toContain('\n\nAnd nobody else does.\n')
    // `base` is what the document says NOW: the stale check has something real
    // to compare against.
    expect(row.base).toBe(server.sectionText('goal'))
  })

  it('touching nothing stages nothing — a blur on an unchanged block is not a write', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    const ta = await screen.findByLabelText(/Markdown for this paragraph/)
    fireEvent.blur(ta)
    await waitFor(() => expect(screen.queryByLabelText(/Markdown for this/)).toBeNull())
    expect(editRows()).toHaveLength(0)
  })

  it('Escape cancels and beats the blur it causes', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    const ta = await screen.findByLabelText(/Markdown for this paragraph/)
    fireEvent.change(ta, { target: { value: 'something else entirely' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    fireEvent.blur(ta)
    await waitFor(() => expect(screen.queryByLabelText(/Markdown for this/)).toBeNull())
    expect(editRows()).toHaveLength(0)
  })

  it('a blur commits, matching the section editor’s "staged when you finish"', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'And nobody else'))
    const ta = await screen.findByLabelText(/Markdown for this paragraph/)
    fireEvent.change(ta, { target: { value: 'And nobody else may.' } })
    fireEvent.blur(ta)
    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(editRows()[0].text).toContain('And nobody else may.')
  })
})

describe('ONE SECTION, ONE ROW — a second block edit composes with the first', () => {
  it('both edits land in a single row, and `base` never moves', async () => {
    const { container } = await editor()
    const pristine = server.sectionText('goal')

    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    await typeAndCommit('The KEEPER writes the **first** plan.')
    await waitFor(() => expect(editRows()).toHaveLength(1))

    // The document now renders the amended text, which is what the second
    // block's offsets are derived from.
    await waitFor(() =>
      expect(block(container as HTMLElement, 'p', 'KEEPER')).toBeTruthy(),
    )
    clickProse(block(container as HTMLElement, 'p', 'And nobody else'))
    await typeAndCommit('And NOBODY else does.')

    await waitFor(() => expect(editRows()[0].text).toContain('NOBODY'))
    expect(editRows()).toHaveLength(1)
    const row = editRows()[0]
    // The FIRST edit is still there — this is the case a naive splice against
    // the pristine text loses.
    expect(row.text).toContain('The KEEPER writes')
    expect(row.base).toBe(pristine)
  })

  it('editing a block back to what the document says removes the row entirely', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    await typeAndCommit('The KEEPER writes the **first** plan.')
    await waitFor(() => expect(editRows()).toHaveLength(1))

    await waitFor(() => expect(block(container as HTMLElement, 'p', 'KEEPER')).toBeTruthy())
    clickProse(block(container as HTMLElement, 'p', 'KEEPER'))
    await typeAndCommit('The keeper writes the **first** plan.')

    await waitFor(() => expect(editRows()).toHaveLength(0))
  })

  it('a second SECTION gets its own row — the collision rule is per section', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    await typeAndCommit('The KEEPER writes the **first** plan.')
    await waitFor(() => expect(editRows()).toHaveLength(1))

    clickProse(block(container as HTMLElement, 'li', 'ship the thing'))
    await typeAndCommit('- [ ] ship the whole thing')
    await waitFor(() => expect(editRows()).toHaveLength(2))
    expect(editRows().map((r) => r.section).sort()).toEqual(['goal', 'milestones'])
  })
})

describe('ticking a box is an ordinary section edit', () => {
  it('the document’s checkbox is a real control and stages `- [x]`', async () => {
    const { container } = await editor()
    const li = block(container as HTMLElement, 'li', 'ship the thing')
    const box = li.querySelector('button[role="checkbox"]') as HTMLElement
    expect(box.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(box)
    await waitFor(() => expect(editRows()).toHaveLength(1))
    const row = editRows()[0]
    expect(row.section).toBe('milestones')
    expect(row.text).toContain('- [x] ship the thing')
    // Only that character moved.
    expect(row.text).toContain('- [x] write it down')
  })

  it('an already-ticked box unticks, and a plain item has no box at all', async () => {
    const { container } = await editor()
    const done = block(container as HTMLElement, 'li', 'write it down')
    expect(done.querySelector('button[role="checkbox"]')!.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(done.querySelector('button[role="checkbox"]') as HTMLElement)
    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(editRows()[0].text).toContain('- [ ] write it down')

    expect(
      block(container as HTMLElement, 'p', 'The keeper writes').querySelector(
        'button[role="checkbox"]',
      ),
    ).toBeNull()
  })

  it('clicking the box does not also open the editor', async () => {
    const { container } = await editor()
    const li = block(container as HTMLElement, 'li', 'ship the thing')
    fireEvent.click(li.querySelector('button[role="checkbox"]') as HTMLElement)
    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(screen.queryByLabelText(/Markdown for this/)).toBeNull()
  })
})

/**
 * THE BLOCK IS THE KEYBOARD PATH NOW, AND THE BUBBLE IS THE QUOTE PATH.
 *
 * The per-block PENCIL is gone. It was the only keyboard route into a block
 * edit, so it did not leave before the replacement arrived: the editable block
 * itself is a tab stop, carries the pencil's own accessible name byte for byte,
 * opens on Enter and closes on Escape with focus back where it started.
 */
describe('the block itself is the keyboard path, and the bubble is the quote path', () => {
  it('the pencil is GONE from every editable block', async () => {
    const { container } = await editor()
    expect(container.querySelector('[data-testid^="plan-block-edit-"]')).toBeNull()
    // ...and no button anywhere still offers the name it used to carry, which
    // is the assertion that would catch it merely being renamed.
    expect(screen.queryAllByRole('button', { name: /^Edit this / })).toHaveLength(0)
  })

  it('an editable block is a TAB STOP carrying the pencil’s exact name', async () => {
    const { container } = await editor()
    const li = block(container as HTMLElement, 'li', 'ship the thing')
    expect(li.getAttribute('tabindex')).toBe('0')
    expect(li.getAttribute('aria-label')).toBe('Edit this list item')
    // The paragraph is the ARIA wrinkle: `aria-label` is prohibited on role
    // `paragraph`, so an editable <p> — and only a <p> — also carries
    // `role="group"`, which permits naming.
    const p = block(container as HTMLElement, 'p', 'The keeper writes')
    expect(p.getAttribute('tabindex')).toBe('0')
    expect(p.getAttribute('role')).toBe('group')
    expect(p.getAttribute('aria-label')).toBe('Edit this paragraph')
  })

  it('Enter on the block opens the same field the prose click opens', async () => {
    const { container } = await editor()
    const li = block(container as HTMLElement, 'li', 'ship the thing')
    fireEvent.keyDown(li, { key: 'Enter' })
    const ta = (await screen.findByLabelText(/Markdown for this list item/)) as HTMLTextAreaElement
    expect(ta.value).toBe('- [ ] ship the thing')
  })

  it('Escape closes it, stages nothing, and puts focus back on the block', async () => {
    const { container } = await editor()
    const li = block(container as HTMLElement, 'li', 'ship the thing')
    fireEvent.keyDown(li, { key: 'Enter' })
    const ta = await screen.findByLabelText(/Markdown for this list item/)
    fireEvent.change(ta, { target: { value: '- [ ] ship it TOMORROW' } })
    fireEvent.keyDown(ta, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByLabelText(/Markdown for this/)).toBeNull())
    expect(server.draft).toHaveLength(0)
    // A keyboard user who cancels must not be dumped at the top of the
    // document; focus returns to the block they opened.
    expect(document.activeElement).toBe(
      block(container as HTMLElement, 'li', 'ship the thing'),
    )
  })

  it('Enter on a control INSIDE the block is that control’s Enter, not the block’s', async () => {
    // The keyboard mirror of the click rule. The comment bubble and the tick
    // button live inside the block; an Enter that lands on one of them must not
    // also open the block's editor underneath it.
    const { container } = await editor()
    const li = block(container as HTMLElement, 'li', 'ship the thing')
    const bubble = li.querySelector('[data-testid^="plan-block-comment-"]') as HTMLElement
    fireEvent.keyDown(bubble, { key: 'Enter' })
    expect(screen.queryByLabelText(/Markdown for this/)).toBeNull()
  })

  it('the Comment button opens the composer over the block, and lights the block', async () => {
    const { container } = await editor()
    const p = block(container as HTMLElement, 'p', 'The keeper writes')
    fireEvent.click(p.querySelector('[data-testid^="plan-block-comment-"]') as HTMLElement)
    const pop = await screen.findByTestId('plan-quote-pop')
    // WHICH BLOCK THIS IS ABOUT IS ANSWERED ON THE DOCUMENT, NOT IN THE
    // POPOVER. This assertion used to read the composer's italic reprint of the
    // quoted words; the reprint is gone, because the words are already on
    // screen and the popover was saying them a second time. The block itself
    // says it now, and it is still the block whose bubble was pressed.
    expect(p.getAttribute('data-plan-commenting')).toBe('true')
    expect(p.className).toContain('plan-b--commenting')
    // And nothing reprints them: no quote block, and the composer does not
    // carry the line's text anywhere inside it.
    expect(screen.queryByTestId('plan-pop-quote')).toBeNull()
    expect(pop.textContent).not.toContain('The keeper writes the first plan.')
    expect(container.querySelector('.plan-body')!.contains(pop)).toBe(true)
  })

  it('the comment it files is an ordinary quoted note, on the right section', async () => {
    const { container } = await editor()
    const li = block(container as HTMLElement, 'li', 'ship the thing')
    fireEvent.click(li.querySelector('[data-testid^="plan-block-comment-"]') as HTMLElement)
    fireEvent.change(await screen.findByLabelText('What do you want to say about this?'), {
      target: { value: 'when?' },
    })
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(server.notes).toHaveLength(1))
    expect(server.notes[0].section).toBe('milestones')
    expect(server.notes[0].quote).toBe('ship the thing')
  })

  it('a block with no editable range still offers the bubble — a table can be discussed', async () => {
    server.body = '# T\n\n## Goal\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    const { container } = await editor()
    const table = container.querySelector('table.plan-b') as HTMLElement
    // A REFUSAL IS NOT A TAB STOP. A table has no editable range — splicing one
    // rewrites its grammar rather than its content — so it must not be
    // focusable and must not be named as though it opened an editor. It is
    // still discussable, and since notes became block-scoped the whole table is
    // the unit that gets discussed: the cells inside it are not blocks any more.
    expect(table.getAttribute('tabindex')).toBeNull()
    expect(table.getAttribute('aria-label')).toBeNull()
    fireEvent.keyDown(table, { key: 'Enter' })
    expect(screen.queryByLabelText(/Markdown for this/)).toBeNull()
    // The bubble is a SIBLING, in the wrapper: a `<span>` inside a `<table>` is
    // fostered straight back out by the HTML parser.
    const fig = table.parentElement!
    expect(fig.className).toContain('plan-b-fig')
    expect(fig.querySelector(':scope > .plan-b-tools [data-testid^="plan-block-comment-"]'))
      .not.toBeNull()
    expect(container.querySelector('td [data-testid^="plan-block-comment-"]')).toBeNull()
  })
})

/**
 * HIERARCHICAL EDITING (AC-3.1, AC-3.2) — a container is edited as its whole
 * nested subtree, and the click picks which of the nested blocks that is.
 *
 * `planBlocks.test.tsx` pins the ranges; this pins the GESTURE, because the
 * range was never the hard part. Blocks nest in the DOM, so a click inside an
 * inner item is a click on every editable ancestor of it, and without a rule
 * the change ships three textareas for one click.
 */
describe('a container opens as its whole subtree, and the innermost block wins', () => {
  it("clicking a parent's OWN line opens the bullet and everything under it", async () => {
    server.body = OUTLINE
    const { container } = await editor()
    const outer = blocksWith(container as HTMLElement, 'li', 'inner one')[0]
    clickProse(outer)
    const ta = (await screen.findByLabelText(/Markdown for this/)) as HTMLTextAreaElement
    expect(ta.value).toBe(SUBTREE)
    // ONE field, not one per ancestor.
    expect(screen.getAllByLabelText(/Markdown for this/)).toHaveLength(1)
  })

  it('a click on a nested child opens ONLY that child', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    const inner = blocksWith(container as HTMLElement, 'li', 'inner one').at(-1)!
    clickProse(inner)
    const ta = (await screen.findByLabelText(/Markdown for this/)) as HTMLTextAreaElement
    expect(ta.value).toBe('- inner one')
    // The ancestor did NOT also open: the click stopped at the innermost block.
    expect(screen.getAllByLabelText(/Markdown for this/)).toHaveLength(1)
  })

  it("a blockquote's bar opens the quote with its markers; its text opens the paragraph", async () => {
    server.body = '# T\n\n## Goal\n\n> said so\n> and more\n'
    const { container } = await editor()

    const bq = container.querySelector('blockquote.plan-b') as HTMLElement
    clickProse(bq)
    let ta = (await screen.findByLabelText(/Markdown for this/)) as HTMLTextAreaElement
    // The `> ` markers are IN the range, which is what makes adding or removing
    // a line of the quote possible at all.
    expect(ta.value).toBe('> said so\n> and more')
    fireEvent.keyDown(ta, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText(/Markdown for this/)).toBeNull())

    clickProse(block(container as HTMLElement, 'p', 'said so'))
    ta = (await screen.findByLabelText(/Markdown for this paragraph/)) as HTMLTextAreaElement
    expect(ta.value).toBe('said so\n> and more')
    expect(screen.getAllByLabelText(/Markdown for this/)).toHaveLength(1)
  })

  it('committing a subtree re-orders its children and stages ONE section row', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    clickProse(blocksWith(container as HTMLElement, 'li', 'inner one')[0])
    const ta = await screen.findByLabelText(/Markdown for this/)
    fireEvent.change(ta, { target: { value: '- outer item\n  - inner two\n  - inner one' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(editRows()).toHaveLength(1))
    const row = editRows()[0]
    expect(row.section).toBe('milestones')
    expect(row.text).toContain('- outer item\n  - inner two\n  - inner one')
    // The SIBLING the subtree did not cover is byte-identical — the swallow
    // stops at the container's own last character.
    expect(row.text).toContain('\n- second item\n')
    expect(row.base).toBe(server.sectionText('milestones'))
  })

  it('a subtree edit that deletes a child really deletes it from the section', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    clickProse(blocksWith(container as HTMLElement, 'li', 'inner one')[0])
    const ta = await screen.findByLabelText(/Markdown for this/)
    fireEvent.change(ta, { target: { value: '- outer item\n  - inner one' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(editRows()[0].text).not.toContain('inner two')
    expect(editRows()[0].text).toContain('- second item')
  })

  it("a container task item's own box becomes a REAL control, and flips only itself", async () => {
    // A SIDE EFFECT OF THE ALLOW, WORTH PINNING RATHER THAN DISCOVERING. The
    // checkbox is drawn only when the block has a range (`taskChecked(src)` is
    // `null` otherwise), so before change 2 an outline parent carrying a box
    // rendered remark-gfm's DISABLED input — a plan whose top-level milestones
    // have sub-items could not tick them. It can now.
    server.body = '# T\n\n## Milestones\n\n- [ ] outer item\n  - [ ] inner one\n'
    const { container } = await editor()
    const outer = blocksWith(container as HTMLElement, 'li', 'inner one')[0]
    const box = outer.querySelector('button[role="checkbox"]') as HTMLElement
    expect(box.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(box)
    await waitFor(() => expect(editRows()).toHaveLength(1))
    // The FIRST marker in the subtree is the container's own, and the nested
    // item's box did not move with it.
    expect(editRows()[0].text).toContain('- [x] outer item\n  - [ ] inner one')
    // And it did not also open the subtree editor underneath itself.
    expect(screen.queryByLabelText(/Markdown for this/)).toBeNull()
  })

  it('the nested item keeps its own box, which flips independently', async () => {
    server.body = '# T\n\n## Milestones\n\n- [ ] outer item\n  - [ ] inner one\n'
    const { container } = await editor()
    const inner = blocksWith(container as HTMLElement, 'li', 'inner one').at(-1)!
    fireEvent.click(inner.querySelector('button[role="checkbox"]') as HTMLElement)
    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(editRows()[0].text).toContain('- [ ] outer item\n  - [x] inner one')
  })

  it('editing a nested child leaves its parent and siblings byte-identical', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    clickProse(blocksWith(container as HTMLElement, 'li', 'inner one').at(-1)!)
    await typeAndCommit('- inner ONE')
    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(editRows()[0].text).toBe(
      server.sectionText('milestones').replace('- inner one', '- inner ONE'),
    )
  })
})

/**
 * THE CELL IS STILL REFUSED (AC-3.3) — and for a reason that has nothing to do
 * with nesting, which is why it survives a change that lifted every other one.
 */
describe('a table cell is not the unit of editing, nested or not', () => {
  it('a click on a top-level cell opens nothing at all', async () => {
    server.body = '# T\n\n## Goal\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    const { container } = await editor()
    // `td.plan-b` is gone: a cell is not a block component at all now, so it
    // carries no class, no handler and no tab stop of its own.
    const cell = [...container.querySelectorAll('td')][0] as HTMLElement
    expect(cell.className).not.toContain('plan-b')
    clickProse(cell)
    expect(screen.queryByLabelText(/Markdown for this/)).toBeNull()
    expect(cell.getAttribute('tabindex')).toBeNull()
  })

  it('a table nested in a list item is reached through the ITEM, which does not splice a cell', async () => {
    server.body = '# T\n\n## Goal\n\n- outer\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n'
    const { container } = await editor()
    const cell = [...container.querySelectorAll('td')][0] as HTMLElement
    // Neither the cell nor the table attaches a click handler, so the click
    // rises to the nearest EDITABLE ancestor rather than dying. What opens is
    // the item's whole subtree — the only inline route to a nested table, and
    // one that rewrites content without touching the table's grammar.
    clickProse(cell)
    const ta = (await screen.findByLabelText(/Markdown for this/)) as HTMLTextAreaElement
    expect(ta.value).toContain('| 1 | 2 |')
    expect(ta.value.startsWith('- outer')).toBe(true)
  })
})

/**
 * THE DRAG-SELECT GUARD IS GONE, AND ITS ABSENCE IS THE POINT (AC-3.6, reversed).
 *
 * The block's click handler used to read `window.getSelection()` and bail out
 * when it was non-empty, because a drag-select was the OTHER capture gesture
 * and a drag ends in a click — so one mouse gesture had to arbitrate between
 * two features by inspecting global selection state. There is one capture
 * gesture now and it is a button, so a selection on prose can only mean the
 * reader is selecting text, which is what the editor is for. The test below is
 * the old one with its expectation inverted rather than a new one, so the
 * reversal is legible in the diff.
 *
 * IT MATTERS MOST ON A CONTAINER, which is where the old guard earned its keep:
 * an inner bullet is inside an editable outer item, so the innermost-wins rule
 * has to still pick the inner one when a selection is live.
 */
describe('a selection means EDIT — the block opens whether or not text is selected', () => {
  it('a click that ends a selection opens the INNERMOST item, not the container', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    const spy = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'inner one' } as unknown as Selection)
    try {
      clickProse(blocksWith(container as HTMLElement, 'li', 'inner one').at(-1)!)
    } finally {
      spy.mockRestore()
    }
    const ta = (await screen.findByLabelText(/Markdown for this/)) as HTMLTextAreaElement
    expect(ta.value.trim()).toBe('- inner one')
  })
})

/**
 * WHAT A CONTAINER IS CALLED (AC-3.8), and it is not what a line is called.
 *
 * `Edit this list item` is a promise about scope that a container breaks: Enter
 * there opens the bullet and everything indented under it. A reader who cannot
 * see the indentation has only this string, so it says so.
 *
 * THE ROLES ARE THE PART WORTH READING TWICE. `listitem` and `blockquote` both
 * take a name from the author, so a container keeps its native role and is
 * named directly — M2's `role="group"` workaround stays exclusive to `<p>`,
 * where `aria-label` is prohibited, and a `<p>` can never be a container.
 */
describe('a container names its own scope, and keeps its native role', () => {
  it('the outer item says it opens the subtree; the inner one still says line', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    const [outer, inner] = [
      blocksWith(container as HTMLElement, 'li', 'inner one')[0],
      blocksWith(container as HTMLElement, 'li', 'inner one').at(-1)!,
    ]
    expect(outer.getAttribute('aria-label')).toBe(
      'Edit this list item and everything nested inside it',
    )
    expect(inner.getAttribute('aria-label')).toBe('Edit this list item')
    // Both are tab stops — a subtree edit is reachable by keyboard.
    expect(outer.getAttribute('tabindex')).toBe('0')
    expect(inner.getAttribute('tabindex')).toBe('0')
    // NO `role="group"` on either: `listitem` takes a name from the author, so
    // the paragraph's workaround is not borrowed where it is not needed.
    expect(outer.getAttribute('role')).toBeNull()
    expect(inner.getAttribute('role')).toBeNull()
  })

  it('a blockquote container is named for the quote, and keeps its own role', async () => {
    server.body = '# T\n\n## Goal\n\n> said so\n> and more\n'
    const { container } = await editor()
    const bq = container.querySelector('blockquote.plan-b') as HTMLElement
    expect(bq.getAttribute('aria-label')).toBe('Edit this quote and everything nested inside it')
    expect(bq.getAttribute('tabindex')).toBe('0')
    // `blockquote` takes a name from the author, so no role is added here either.
    expect(bq.getAttribute('role')).toBeNull()
    // The paragraph inside it is a leaf and keeps the M2 wording and workaround.
    const inner = block(container as HTMLElement, 'p', 'said so')
    expect(inner.getAttribute('aria-label')).toBe('Edit this paragraph')
    expect(inner.getAttribute('role')).toBe('group')
  })

  it('Enter on the container opens the subtree, and the field is named for it too', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    const outer = blocksWith(container as HTMLElement, 'li', 'inner one')[0]
    fireEvent.keyDown(outer, { key: 'Enter' })
    const ta = (await screen.findByLabelText(
      'Markdown for this list item and everything nested inside it',
    )) as HTMLTextAreaElement
    expect(ta.value).toBe(SUBTREE)
  })

  it('Enter on a nested child is the CHILD’s Enter, not its parent’s', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    fireEvent.keyDown(blocksWith(container as HTMLElement, 'li', 'inner one').at(-1)!, {
      key: 'Enter',
    })
    const ta = (await screen.findByLabelText('Markdown for this list item')) as HTMLTextAreaElement
    expect(ta.value).toBe('- inner one')
    expect(screen.getAllByLabelText(/Markdown for this/)).toHaveLength(1)
  })

  it('a leaf paragraph’s name and role are unchanged, byte for byte', async () => {
    const { container } = await editor()
    const p = block(container as HTMLElement, 'p', 'The keeper writes')
    expect(p.getAttribute('aria-label')).toBe('Edit this paragraph')
    expect(p.getAttribute('role')).toBe('group')
    expect(p.getAttribute('tabindex')).toBe('0')
  })
})

/**
 * A NOTE WHOSE QUOTE LIVES INSIDE AN EDITED SUBTREE (AC-3.4).
 *
 * THE PREMISE THE BRIEF STARTED FROM WAS WRONG AND THIS IS WHERE IT IS PROVED.
 * A note carries a `quote` and a `section` and nothing else about its position —
 * no block id, no content hash, no stored offset — so rewriting a parent shifts
 * nothing and orphans nothing. What a rewrite can do is remove the quoted text,
 * and then the note is LOOSE, which is the same outcome any single-line edit has
 * always had. A subtree edit makes it MORE LIKELY, not different in kind.
 *
 * Both halves are asserted here because "no note is lost" is the claim the
 * decision to add no id rests on.
 */
describe('a note inside a rewritten subtree is never lost', () => {
  const note = (over: Partial<PlanNote>): PlanNote => ({
    id: 'n1',
    section: 'milestones',
    to: 'user',
    by: 'backend',
    at: 't',
    status: 'open',
    kind: 'note',
    layer: 'spec',
    comment: 'a note',
    proposal: '',
    base_section: '',
    quote: '',
    reply_to: '',
    round: '',
    conflict: false,
    resolved_by: '',
    resolved_at: '',
    resolution: '',
    revision: 1,
    has_proposal: false,
    sent: false,
    replies: [],
    section_missing: false,
    section_new: false,
    section_changed: false,
    display_diff: '',
    ...over,
  })

  /** Rewrite the outer item's whole subtree to `next`. */
  async function rewriteSubtree(container: HTMLElement, next: string) {
    clickProse(blocksWith(container, 'li', 'inner one')[0])
    const ta = await screen.findByLabelText(/Markdown for this/)
    fireEvent.change(ta, { target: { value: next } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
  }

  it('stays UNDER ITS LINE when the quoted text survived the rewrite', async () => {
    server.body = OUTLINE
    server.notes = [note({ id: 'a', quote: 'inner one' })]
    const { container } = await editor()
    await screen.findByTestId('plan-anchored-a')

    // The subtree is re-ordered and its sibling deleted — everything about the
    // note's surroundings moves. The quoted text does not.
    await rewriteSubtree(container as HTMLElement, '- outer item REWRITTEN\n  - inner one')
    await waitFor(() => expect(editRows()).toHaveLength(1))

    expect(screen.getByTestId('plan-anchored-a')).toBeTruthy()
    expect(container.querySelector('[data-testid="plan-loose-notes"]')).toBeNull()
    // The paint still lands on the INNER item and nowhere else, which is what
    // "under its line" means once the line has moved — and it is the same
    // assertion that proves innermost-wins, since the outer item's own text no
    // longer contains its child's words.
    const painted = [...container.querySelectorAll('.plan-noted')]
    expect(painted.map((m) => (m.textContent ?? '').replace(/\s+/g, ' ').trim()))
      .toEqual(['inner one'])
    expect(painted[0].closest('li')!.textContent).toContain('inner one')
  })

  it('goes to the END OF ITS OWN SECTION when the rewrite removed the quoted text', async () => {
    server.body = OUTLINE
    server.notes = [note({ id: 'a', quote: 'inner one' })]
    const { container } = await editor()
    await screen.findByTestId('plan-anchored-a')

    await rewriteSubtree(container as HTMLElement, '- outer item\n  - something else')
    await waitFor(() => expect(editRows()).toHaveLength(1))

    const why = await screen.findByTestId('plan-unanchored-a')
    expect(why.textContent).toContain('no longer in this section')
    expect(container.querySelectorAll('.plan-noted')).toHaveLength(0)
    // ITS OWN section, not the bottom of the document. The loose bucket is a
    // child of the section the note belongs to, which is what makes that
    // structural rather than arithmetic.
    expect(screen.getByTestId('plan-sec-milestones').contains(why)).toBe(true)
    // …and the note itself is still on screen. Looseness costs position, never
    // the note — which is the whole reason no id was introduced to prevent it.
    expect(screen.getByTestId('plan-loose-notes').textContent).toContain('a note')
  })

  it('stays anchored while the subtree containing it is OPEN in the editor', async () => {
    server.body = OUTLINE
    server.notes = [note({ id: 'a', quote: 'inner one' })]
    const { container } = await editor()
    await screen.findByTestId('plan-anchored-a')

    clickProse(blocksWith(container as HTMLElement, 'li', 'inner one')[0])
    await screen.findByLabelText(/Markdown for this/)
    // The block claims its notes BEFORE it decides to render a textarea, so
    // starting to edit an outline does not dump every note about it into the
    // loose bucket for as long as the field is open.
    expect(screen.getByTestId('plan-anchored-a')).toBeTruthy()
    expect(container.querySelector('[data-testid="plan-loose-notes"]')).toBeNull()
  })
})

/**
 * THE Cmd+Enter INVARIANT (AC-3.7) — `Cmd/Ctrl+Enter` saves the edit INTO THE
 * BATCH, closes the field and stages a row in the tray. It never submits;
 * `Send review` in the tray is the only submit.
 *
 * IT IS ASSERTED ON A CONTAINER AS WELL AS ON A LINE, and the container is the
 * case that had to be added rather than re-pointed. Change 3 gave the BLOCK its
 * own Enter handler, so a keydown escaping the open textarea to that handler is
 * one way this breaks — and change 2 stacked editable blocks inside one another,
 * so a container's textarea now sits inside TWO more Enter handlers than a
 * leaf's does. That is the arrangement M3 newly creates, so that is the
 * arrangement the lock has to cover; the wrapped-paragraph case below is kept
 * beside it rather than replaced, because a leaf breaking and a subtree
 * breaking are different bugs.
 */
describe('Cmd+Enter stages the block edit and never submits', () => {
  it('on a MULTILINE block, where a bare Enter means a newline', async () => {
    // The multiline branch is the one that can ONLY be committed this way — a
    // bare Enter there is a newline the user wanted — so it is the one worth
    // pinning. A wrapped paragraph is the everyday case of it.
    server.body = '# T\n\n## Goal\n\nThe keeper writes\nthe first plan.\n'
    const { container } = await editor()
    const para = block(container as HTMLElement, 'p', 'The keeper writes')
    fireEvent.keyDown(para, { key: 'Enter' })
    const ta = await screen.findByLabelText(/Markdown for this/)
    expect((ta as HTMLTextAreaElement).value).toContain('\n')
    fireEvent.change(ta, { target: { value: 'The keeper writes\nit rewritten.' } })

    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })

    // Saved INTO THE BATCH and the field is closed...
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(screen.queryByLabelText(/Markdown for this/)).toBeNull()
    expect(server.draft[0].kind).toBe('edit')
    expect(server.draft[0].text).toContain('it rewritten.')
    // ...and NOTHING was submitted. No round, no message, no revision.
    expect(server.rounds).toBe(0)
    expect(server.revision).toBe(1)
    expect(server.body).not.toContain('it rewritten.')
    // `Send review` is still there, waiting to be the thing that submits.
    expect(screen.getByRole('button', { name: /^Send review/ })).toBeTruthy()
  })

  it('on a CONTAINER SUBTREE, which is the arrangement change 2 newly creates', async () => {
    server.body = OUTLINE
    const { container } = await editor()
    const outer = blocksWith(container as HTMLElement, 'li', 'inner one')[0]
    fireEvent.keyDown(outer, { key: 'Enter' })
    const ta = (await screen.findByLabelText(/Markdown for this/)) as HTMLTextAreaElement
    expect(ta.value).toBe(SUBTREE)
    // A subtree is MULTILINE by construction, so a bare Enter here is a newline
    // the user wanted and Cmd+Enter is the only gesture that can commit it.
    fireEvent.change(ta, { target: { value: '- outer item\n  - inner two\n  - inner one' } })

    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })

    // Saved INTO THE BATCH and the field is closed...
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(screen.queryByLabelText(/Markdown for this/)).toBeNull()
    expect(server.draft[0].kind).toBe('edit')
    expect(server.draft[0].section).toBe('milestones')
    expect(server.draft[0].text).toContain('- inner two\n  - inner one')

    // ...and A ROW IS STAGED IN THE TRAY, which is where the user sees that the
    // edit is waiting rather than gone.
    const staged = [...container.querySelectorAll('[data-row-kind="edit"]')]
    expect(staged).toHaveLength(1)
    expect(staged[0].textContent).toContain('milestones')

    // ...and NOTHING was submitted. No round, no message, no revision.
    expect(server.rounds).toBe(0)
    expect(server.revision).toBe(1)
    expect(server.messages).toHaveLength(0)
    expect(server.body).toBe(OUTLINE)
    // `Send review` is still there, waiting to be the thing that submits.
    expect(screen.getByRole('button', { name: /^Send review/ })).toBeTruthy()
  })
})

describe('a selection on a paragraph opens its editor too', () => {
  it('a click that ends a selection opens the field rather than refusing it', async () => {
    // The leaf case of the reversal above. It used to assert `toBeNull()`.
    const { container } = await editor()
    const p = block(container as HTMLElement, 'p', 'The keeper writes')
    const spy = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'The keeper writes' } as unknown as Selection)
    try {
      fireEvent.click(p)
    } finally {
      spy.mockRestore()
    }
    expect(await screen.findByLabelText(/Markdown for this paragraph/)).toBeTruthy()
  })
})

describe('the same write path on both mounts — the desk card is not a viewer', () => {
  it('the compact mount edits a block and stages the same row', async () => {
    const { container } = await editor('compact')
    expect(container.querySelector('[data-density]')!.getAttribute('data-density')).toBe('compact')
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    await typeAndCommit('The KEEPER writes the **first** plan.')
    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(editRows()[0].section).toBe('goal')
  })
})

describe('an anchored note survives the line it is about being edited', () => {
  const note = (over: Partial<PlanNote>): PlanNote => ({
    id: 'n1',
    section: 'goal',
    to: 'user',
    by: 'backend',
    at: 't',
    status: 'open',
    kind: 'note',
    layer: 'spec',
    comment: 'a note',
    proposal: '',
    base_section: '',
    quote: '',
    reply_to: '',
    round: '',
    conflict: false,
    resolved_by: '',
    resolved_at: '',
    resolution: '',
    revision: 1,
    has_proposal: false,
    sent: false,
    replies: [],
    section_missing: false,
    section_new: false,
    section_changed: false,
    display_diff: '',
    ...over,
  })

  it('stays under its block while the block is being edited', async () => {
    server.notes = [note({ id: 'a', quote: 'The keeper writes' })]
    const { container } = await editor()
    await screen.findByTestId('plan-anchored-a')
    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    await screen.findByLabelText(/Markdown for this paragraph/)
    // Still anchored, still not in the loose bucket.
    expect(screen.getByTestId('plan-anchored-a')).toBeTruthy()
    expect(container.querySelector('[data-testid="plan-loose-notes"]')).toBeNull()
  })

  it('goes loose — truthfully — once the staged edit removes the line it quotes', async () => {
    server.notes = [note({ id: 'a', quote: 'The keeper writes' })]
    const { container } = await editor()
    await screen.findByTestId('plan-anchored-a')

    clickProse(block(container as HTMLElement, 'p', 'The keeper writes'))
    await typeAndCommit('Somebody else writes it.')

    await waitFor(() => expect(screen.getByTestId('plan-unanchored-a')).toBeTruthy())
    // THE SENTENCE IS READ OFF THE AMENDED SOURCE. The line really is gone from
    // what is on screen, so the app is not asserting something the user can see
    // is false.
    expect(screen.getByTestId('plan-unanchored-a').textContent).toContain('no longer in this section')
    expect(container.querySelectorAll('.plan-noted')).toHaveLength(0)
  })
})

describe('a TRUNCATED parent still splices against its whole extent', () => {
  /* The document body draws a section stopped at the first nested section it is
   * also drawing, so `## Milestones` gives up the text `### M1` prints. What is
   * on screen for the parent is therefore a PREFIX of the text a splice seeds
   * from — and this suite exists because that prefix is the string remark
   * reported its block ranges against. A range inside a prefix is the same
   * range inside the whole string, so `spliceBlock` may keep seeding from the
   * full section text and carry the untouched descendant tail across verbatim.
   * If that ever stops being true, an edit to a parent silently eats its
   * children. */
  const NESTED = [
    '# Project Plan: demo',
    '',
    '## Milestones',
    '',
    'The milestones, in order.',
    '',
    '### M1',
    '',
    '- [ ] ship the thing',
    '',
  ].join('\n')

  const NESTED_SECTIONS: PlanSection[] = [
    { id: 'milestones', heading: 'Milestones', depth: 2, boxes: [0, 1], char_start: 0, char_end: 0 },
    { id: 'm1', heading: 'M1', depth: 3, boxes: [0, 1], char_start: 0, char_end: 0 },
  ]

  beforeEach(() => {
    server = new FakePlanServer(NESTED, NESTED_SECTIONS)
    routes.current = routeTo(server, PID)
  })

  it('editing the parent’s own prose keeps the nested section byte-identical', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'p', 'The milestones, in order.'))
    await typeAndCommit('The milestones, in ORDER.')

    await waitFor(() => expect(editRows()).toHaveLength(1))
    const row = editRows()[0]
    expect(row.section).toBe('milestones')
    // The staged text is the WHOLE extent — heading, own prose, and the `### M1`
    // subtree the parent never drew — with only the edited block changed.
    expect(row.text).toBe(server.sectionText('milestones').replace('in order.', 'in ORDER.'))
    expect(row.text).toContain('### M1\n\n- [ ] ship the thing')
    // `base` is the pristine FULL text, so AC-6.5's stale check is unweakened
    // by the parent rendering short.
    expect(row.base).toBe(server.sectionText('milestones'))
  })

  it('the parent does not draw the child’s blocks — the child does', async () => {
    const { container } = await editor()
    // One checkbox on screen, not two: `- [ ] ship the thing` lives in `### M1`
    // and is drawn there alone, though it is inside the parent's extent too.
    expect(blocksWith(container as HTMLElement, 'li', 'ship the thing')).toHaveLength(1)
    expect(blocksWith(container as HTMLElement, 'p', 'The milestones, in order.')).toHaveLength(1)
  })

  it('a click in the child stages the CHILD’s row, not the parent’s', async () => {
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'li', 'ship the thing'))
    await typeAndCommit('- [ ] ship the WHOLE thing')

    await waitFor(() => expect(editRows()).toHaveLength(1))
    expect(editRows()[0].section).toBe('m1')
    expect(editRows()[0].text).toContain('ship the WHOLE thing')
  })
})

/** The plan format this system writes: every criterion ends on an evidence
 *  comment, addressed to the agent that has to satisfy it. */
const EVIDENCED = [
  '# Project Plan: demo',
  '',
  '## Goal',
  '',
  'The keeper writes the **first** plan.',
  '',
  '## Milestones',
  '',
  '- [ ] **AC-1.1** — A user with valid credentials receives a session',
  '      that survives a server restart.',
  '      <!-- evidence: tests/test_auth_session.py::test_survives_restart -->',
  '- [ ] **AC-1.2** — A reader can name the formats gaining traction.',
  '      <!-- evidence: deliverables/ig/trends.md -->',
  '',
].join('\n')

/**
 * THE EVIDENCE COMMENT IS THE AGENTS' LAYER — HIDDEN ON SCREEN, PRESENT IN THE
 * TEXTAREA.
 *
 * Both halves are load-bearing and they pull in opposite directions. The reader
 * must not see `<!-- evidence: … -->`: the spec digest folds it out so swapping a
 * test is not a change the user has to accept, `plan show --clean` folds it out
 * of the reading view, and `plan_markdown._is_anchorable` refuses to anchor a
 * note to a comment-only line on the stated grounds that it cannot be found in
 * the rendered DOM. The WRITING agent must still see it, because editing the
 * criterion is how the evidence gets updated.
 *
 * That is why the fix is a rehype plugin and not the server's comment-free body:
 * a block edit splices on remark's raw character offsets into the string the
 * renderer parsed, so removing comments from the INPUT would shift every offset
 * after them and corrupt the splice. Removing them from the OUTPUT leaves the
 * offsets untouched — which is exactly what the round trip below asserts.
 */
describe('an evidence comment is hidden from the reader and kept for the writer', () => {
  it('does not render the comment', async () => {
    server.body = EVIDENCED
    const { container } = await editor()
    expect(container.textContent).toContain('survives a server restart.')
    expect(container.textContent).not.toContain('evidence:')
    expect(container.textContent).not.toContain('<!--')
  })

  it('leaves no blank line where the comment was', async () => {
    server.body = EVIDENCED
    const { container } = await editor()
    // remark-breaks turns the newline that put the comment on its own line into
    // a <br>. Dropping only the comment would leave that <br> as a stray blank
    // line under every criterion — the reason `skipHtml` alone is not the fix.
    const li = block(container as HTMLElement, 'li', 'survives a server restart')
    expect(li.textContent!.trimEnd().endsWith('restart.')).toBe(true)
  })

  it('opens the criterion WITH its evidence line — the offsets never moved', async () => {
    server.body = EVIDENCED
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'li', 'survives a server restart'))
    const ta = (await screen.findByLabelText(/Markdown for this list item/)) as HTMLTextAreaElement
    expect(ta.value).toBe(
      [
        '- [ ] **AC-1.1** — A user with valid credentials receives a session',
        '      that survives a server restart.',
        '      <!-- evidence: tests/test_auth_session.py::test_survives_restart -->',
      ].join('\n'),
    )
  })

  it('stages a splice that keeps the section byte-identical around the edit', async () => {
    server.body = EVIDENCED
    const { container } = await editor()
    clickProse(block(container as HTMLElement, 'li', 'survives a server restart'))
    const ta = (await screen.findByLabelText(/Markdown for this list item/)) as HTMLTextAreaElement
    fireEvent.change(ta, {
      target: {
        value: [
          '- [ ] **AC-1.1** — A user with valid credentials receives a session',
          '      that survives a server restart.',
          '      <!-- evidence: tests/test_auth_session.py::test_survives_reboot -->',
        ].join('\n'),
      },
    })
    // A block whose source already spans lines takes Cmd/Ctrl+Enter — a bare
    // Enter is a newline there. Every criterion in this format is multi-line.
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(editRows()).toHaveLength(1))
    const row = editRows()[0]
    expect(row.section).toBe('milestones')
    expect(row.text).toBe(
      server.sectionText('milestones').replace('test_survives_restart', 'test_survives_reboot'),
    )
    // The criterion BELOW is untouched, comment included — the proof that a
    // hidden node did not shift the range that was spliced.
    expect(row.text).toContain('      <!-- evidence: deliverables/ig/trends.md -->')
  })
})

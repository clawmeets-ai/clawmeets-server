import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './plan/planTestServer'

/* The whole endpoint module runs for real — including its `404 -> null` and
 * `409 -> PlanStaleError` translations. Only the four HTTP verbs are swapped,
 * for a fake server that enforces the parts of the contract a client must not
 * be trusted to fake: all-or-nothing writes, one submit is one revision, and a
 * note's status moving only through the resolve route. */
const routes = { current: null as ReturnType<typeof routeTo> | null }

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return {
    ...actual,
    get: (path: string) => routes.current!.get(path),
    post: (path: string, body?: unknown) => routes.current!.post(path, body),
    put: (path: string, body?: unknown) => routes.current!.put(path, body),
    del: (path: string) => routes.current!.del(path),
  }
})

// diff2html pulls a CSS bundle and a full renderer for a panel none of these
// assertions read. The stub keeps the suite about the tab's behaviour.
vi.mock('./plan/PlanDiff', () => ({
  PlanDiff: ({ text }: { text: string }) =>
    createElement('pre', { 'data-testid': 'plan-diff' }, text),
}))

const { ProjectPlanTab } = await import('./ProjectPlanTab')

const PID = 'p-1'

const BODY = [
  '# Project Plan: demo',
  '',
  '## Goal',
  'Ship the thing.',
  '',
  '## Guardrails',
  'Do not break it.',
  '',
  '## Milestones',
  '',
  '### M1',
  '- [x] one',
  '- [ ] two',
  '',
].join('\n')

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'guardrails', heading: 'Guardrails', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'milestones', heading: 'Milestones', depth: 2, boxes: [1, 2], char_start: 0, char_end: 0 },
  { id: 'm1', heading: 'M1', depth: 3, boxes: [1, 2], char_start: 0, char_end: 0 },
]

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n',
    section: 'goal',
    to: 'user',
    by: 'content_writer',
    at: '2026-08-23T10:00:00Z',
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
  }
}

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

function mount() {
  return render(createElement(ProjectPlanTab, { projectId: PID, active: true }), { wrapper })
}

async function openSection(slug: string) {
  const el = await waitFor(() => {
    const found = document.querySelector(`[data-section="${slug}"]`)
    if (!found) throw new Error(`section rail has no ${slug} yet`)
    return found as HTMLElement
  })
  fireEvent.click(el)
}

/** Stage a dismiss for every open note the pane is showing, wherever it hangs.
 *
 *  IT USED TO HAVE TO BE CAREFUL, AND NO LONGER DOES. There was a second
 *  dismissal on every row — `Dismiss now`, which posted the resolve route — so a
 *  helper that clicked whichever the query returned first would have been
 *  asserting about the wrong mechanism entirely. After change 9 there is one
 *  `Dismiss` and it stages, like everything else on the row, so the scoping is
 *  now about WHICH NOTES rather than which control.
 *
 *  SO THE SCOPE IS THE PANE, NOT THE PAGE-BOTTOM LIST, and it had to move. This
 *  used to hang off `plan-notes` on the reasoning that a note anchored in the
 *  document body carries the same bar and sweeping both would change what these
 *  tests are about. That list is no longer WHERE these notes are: a note naming
 *  a section that resolves now renders inside that section (`PlanEditor`'s
 *  `bodyRoots`), so the old scope swept an empty list and staged nothing while
 *  every caller went on asserting a tray. What kept the sweep honest was never
 *  the list — it is `openSection`, which is what decides which notes are drawn
 *  at all, and every caller here opens one first.
 *
 *  The revision banner is excluded by hand because it carries its own
 *  `Dismiss`, and dismissing the banner is a different act on a different
 *  thing. Re-queries between clicks because each stage re-renders the row it
 *  acted on. */
async function dismissEveryNote(): Promise<void> {
  const tab = await screen.findByTestId('project-plan-tab')
  for (;;) {
    const btn = within(tab)
      .queryAllByRole('button', { name: 'Dismiss' })
      .find((b) => !b.closest('[data-testid="plan-revision-banner"]'))
    if (!btn) return
    fireEvent.click(btn)
  }
}

/** OPEN THE COMPOSER ON A BLOCK — the one capture gesture there is.
 *
 *  This replaced a stubbed drag-select: notes are block-scoped, so the quote is
 *  the block's own text and the capture is a click on its bubble. `:scope >` on
 *  the toolbar matters for a container — an outline item's own bubble flows
 *  after its nested list, so a plain descendant query finds the inner item's. */
function commentOn(container: HTMLElement, text: string) {
  const target = [...container.querySelectorAll('.plan-sec .plan-b')].find(
    (b) => (b.textContent ?? '').includes(text.slice(0, 12)) && !b.querySelector('.plan-b'),
  ) as HTMLElement
  fireEvent.click(target.querySelector(':scope > .plan-b-tools > .plan-b-tool')!)
}

function trayRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-row-id]')) as HTMLElement[]
}

/** Edit one section's raw Markdown and stage it. Two sections edited means two
 *  visits, which is the shape of the surface: one section is selected at a
 *  time, so a row can only ever be about the section that was open. */
async function rawEdit(slug: string, text: string) {
  await openSection(slug)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit raw Markdown' }))
  const ta = document.getElementById(`raw-${slug}`) as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Stage this section' }))
}

describe('AC-6.2 — the tab renders the index', () => {
  it('shows per-section tabs in DOCUMENT ORDER with unresolved-note dots', async () => {
    server.notes = [note({ id: 'a', section: 'goal' }), note({ id: 'b', section: 'goal' })]
    mount()
    await screen.findByTestId('project-plan-tab')

    const rail = Array.from(document.querySelectorAll('[data-section]')).map(
      (el) => (el as HTMLElement).dataset.section,
    )
    expect(rail).toEqual(['goal', 'guardrails', 'milestones', 'm1'])

    const goal = document.querySelector('[data-section="goal"]')!
    expect(goal.querySelector('[data-note-dot]')?.getAttribute('data-note-dot')).toBe('2')
  })

  it('the document TITLE gets no section tab — its extent would span everything', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    expect(document.querySelectorAll('[data-section]')).toHaveLength(4)
    expect(document.querySelector('[data-section="project-plan-demo"]')).toBeNull()
  })

  it('header counts come from the index, not from a client recount', async () => {
    server.notes = [
      note({ id: 'a', to: 'user' }),
      note({ id: 'b', to: 'content_writer' }),
      note({ id: 'c', to: '' }),
    ]
    mount()
    expect((await screen.findByTestId('plan-open-for-you')).textContent).toContain('1 waiting')
    expect((await screen.findByTestId('plan-revision')).textContent).toContain('revision 1')
  })

  it('renders the acceptance state the wire carries and no field it does not', async () => {
    server.accepted = true
    server.acceptedRevision = 1
    mount()
    const pill = await screen.findByTestId('plan-accepted')
    expect(pill.textContent).toBe('Accepted at revision 1')
    // `PlanIndex` carries no `accepted_by` / `accepted_at`, so the header does
    // not claim to know who accepted it or when. Rendering what the wire
    // carries beats inventing a field.
    expect(pill.textContent).not.toMatch(/by @/)
  })
})

describe('a nested section is drawn ONCE, not by its parent as well', () => {
  /* `parse_sections` returns a nested heading TWICE — as its own entry in the
   * flat list, and inside its parent's `char_start`/`char_end`. The whole-
   * document pane draws every entry, so drawing each at full extent printed
   * every milestone under `## Milestones` and again under `### M1`. On the
   * plan that surfaced this, 12,619 characters appeared twice; 70 of the 100
   * stored plans have the `###`-under-`##` shape that triggers it. */

  it('the whole-document pane prints the milestone body exactly once', async () => {
    mount()
    const body = await screen.findByTestId('plan-body')
    expect(within(body).getAllByText('one')).toHaveLength(1)
    expect(within(body).getAllByText('two')).toHaveLength(1)
    // and it is the CHILD that keeps it — `### M1` is a section of its own and
    // owns its content; the parent gives up the overlap.
    // A heading's accessible name carries its inline quote button, so these
    // match the heading TEXT rather than the role's computed name.
    expect(within(body).getAllByText('M1')).toHaveLength(1)
    expect(within(body).getAllByText('Milestones')).toHaveLength(1)
  })

  it('draws the document, not a subset — every section still renders', async () => {
    mount()
    const body = await screen.findByTestId('plan-body')
    // Truncating the parent must not cost the document any text. Guardrails
    // sits BETWEEN two sections and Goal before them, so a truncation that
    // over-reached would take one of them with it.
    expect(within(body).getByText('Ship the thing.')).toBeTruthy()
    expect(within(body).getByText('Do not break it.')).toBeTruthy()
    expect(within(body).getByText('Guardrails')).toBeTruthy()
  })

  it('a FOCUSED parent prints its children in full — nothing else is on screen', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    fireEvent.click(document.querySelector('[data-section="milestones"]')!)

    const body = await screen.findByTestId('plan-body')
    // The section pane renders exactly `[current]`, so `### M1` is not drawn
    // separately and `## Milestones` must carry it. Truncating unconditionally
    // would show the user a bare heading and hide what they clicked in to read.
    await waitFor(() => expect(within(body).getAllByText('one')).toHaveLength(1))
    expect(within(body).getAllByText('two')).toHaveLength(1)
    expect(within(body).queryByText('Ship the thing.')).toBeNull()
  })
})

describe('AC-6.3 — nothing lands before you submit', () => {
  it('accepting adds ONE row and writes zero bytes', async () => {
    server.notes = [
      note({
        id: 'n1',
        kind: 'proposal',
        proposal: '## Goal\nShip it beautifully.\n\n',
        base_section: server.sectionText('goal'),
        has_proposal: true,
      }),
    ]
    const bodyBefore = server.body
    mount()
    await openSection('goal')
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

    expect(trayRows()).toHaveLength(1)
    expect(trayRows()[0].dataset.rowKind).toBe('accept')
    expect(server.body).toBe(bodyBefore)
    expect(server.revision).toBe(1)
    // The note is still OPEN: a staged accept is a PROPOSAL to accept.
    expect(server.notes[0].status).toBe('open')
  })

  /** Driven through `Reply`, which is the only label for this act since `Ask`
   *  was collapsed into it — same `ask` tray row, same server outcome, so the
   *  `rowKind` assertion below is unchanged and is the point: the wire did not
   *  move when the button did. */
  it('asking writes zero bytes and leaves the note open', async () => {
    server.notes = [note({ id: 'n1' })]
    const before = server.body
    mount()
    await openSection('goal')
    fireEvent.click(await screen.findByTestId('plan-note-reply-n1'))
    fireEvent.change(await screen.findByLabelText('Reply to @content_writer'), {
      target: { value: 'why?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }))

    expect(trayRows()).toHaveLength(1)
    expect(trayRows()[0].dataset.rowKind).toBe('ask')
    expect(server.body).toBe(before)
    expect(server.revision).toBe(1)
    expect(server.notes[0].status).toBe('open')
  })
})

describe('AC-6.6 — raw editing is section changes', () => {
  it('editing TWO sections adds TWO rows', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    await rawEdit('goal', '## Goal\nShip it fast.\n\n')
    await rawEdit('guardrails', '## Guardrails\nDo not break anything.\n\n')
    expect(trayRows()).toHaveLength(2)
    expect(trayRows().map((r) => r.dataset.rowKind)).toEqual(['edit', 'edit'])
  })

  it('changing WHITESPACE in one section adds ONE row', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    await rawEdit('goal', server.sectionText('goal') + '  ')
    expect(trayRows()).toHaveLength(1)
  })

  it('changing NOTHING adds NO row — the phantom-write trap', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    // An editor that stages on every blur produces a revision, a changelog
    // entry and a FILE_UPDATED for a section nobody changed.
    await rawEdit('goal', server.sectionText('goal'))
    expect(trayRows()).toHaveLength(0)
    expect(screen.queryByTestId('plan-tray')).toBeNull()
  })

  it('editing a NESTED section reports that section and not its parent', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    await rawEdit('m1', '### M1\n- [x] one\n- [x] two\n')
    expect(trayRows()).toHaveLength(1)
    expect(trayRows()[0].textContent).toContain('m1')
    expect(trayRows()[0].textContent).not.toContain('milestones')
  })
})

describe('✕ removes exactly one row', () => {
  it('leaves the others in place', async () => {
    server.notes = [note({ id: 'n1' }), note({ id: 'n2' })]
    mount()
    await openSection('goal')
    await dismissEveryNote()
    expect(trayRows()).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: /^Remove/ })[0])
    expect(trayRows()).toHaveLength(1)
  })
})

describe('AC-6.4 — one submit, one revision, one send', () => {
  it('four notes across two addressees plus two edits → ONE revision, TWO messages, empty tray', async () => {
    server.notes = [
      note({ id: 'n1', by: 'content_writer' }),
      note({ id: 'n2', by: 'content_writer' }),
      note({ id: 'n3', by: 'reel_editor' }),
      note({ id: 'n4', by: 'reel_editor' }),
    ]
    mount()
    await openSection('goal')
    await dismissEveryNote()
    await rawEdit('goal', '## Goal\nShip it fast.\n\n')
    await rawEdit('guardrails', '## Guardrails\nDo not break anything.\n\n')
    expect(trayRows()).toHaveLength(6)

    // The document MOVES under the browser while the tray is open — the sync
    // arrives MID-TRAY, not before it — and the submit still succeeds, because
    // each row carries its own `base` and the foreign write touched a section
    // no row is about.
    server.foreignWrite('milestones', '## Milestones\n\n### M1\n- [x] one\n- [x] two\n')
    await qc.invalidateQueries({ queryKey: ['project-plan', PID] })
    await screen.findByTestId('plan-revision-banner')
    expect(trayRows()).toHaveLength(6)

    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())

    // ONE write for the batch, on top of the one foreign write. The client
    // never predicted a number; the revision came back from the server.
    expect(server.revision).toBe(3)
    expect(server.versions).toHaveLength(1)
    expect(server.messages.filter((m) => m.round === 'r-1')).toHaveLength(2)
    expect(server.draft).toEqual([])
  })

  it('the converse: a submit of ONLY decisions appends no write and moves revision by ZERO', async () => {
    server.notes = [note({ id: 'n1' }), note({ id: 'n2' })]
    const bodyBefore = server.body
    mount()
    await openSection('goal')
    await dismissEveryNote()
    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())

    expect(server.revision).toBe(1)
    expect(server.body).toBe(bodyBefore)
    expect(server.versions).toHaveLength(0)
    expect(server.notes.every((n) => n.status === 'dismissed')).toBe(true)
  })
})

describe('AC-6.5 — a refused submit loses nothing', () => {
  async function stageThenCollide() {
    mount()
    await screen.findByTestId('project-plan-tab')
    await rawEdit('goal', '## Goal\nMy text.\n\n')
    expect(trayRows()).toHaveLength(1)
    // Somebody else rewrites the same section while the row is staged.
    server.foreignWrite('goal', '## Goal\nTheir text.\n\n', 'reel_editor')
    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    return screen.findByTestId('plan-stale-reconcile')
  }

  it('every row survives with the user’s text, beside what the section says now', async () => {
    const panel = await stageThenCollide()
    expect(trayRows()).toHaveLength(1)
    // `getAllByText`: the control renders BOTH directions of the question as
    // diffs — what taking the row does, and what keeping the current text does
    // — so each side's line appears in both, once as an addition and once as a
    // removal. The claim is unchanged: neither text was lost.
    expect(within(panel).getAllByText(/My text\./).length).toBeGreaterThan(0)
    expect(within(panel).getAllByText(/Their text\./).length).toBeGreaterThan(0)
    // The three-way control, with the fixed labels.
    // The held author is read out of the activity log, which arrives with the
    // refetch the refusal triggered — so this waits rather than asserting
    // against the pre-refusal index.
    expect(await within(panel).findByRole('button', { name: "Keep @reel_editor's" })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Write my own' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Take yours' })).toBeTruthy()
    // One conflict note per stale section, so a refusal is never a dead end.
    expect(within(panel).getByText(/n-conflict-goal/)).toBeTruthy()
    // And nothing landed.
    expect(server.body).toContain('Their text.')
    expect(server.body).not.toContain('My text.')
  })

  it('re-submitting after resolving SUCCEEDS', async () => {
    await stageThenCollide()
    fireEvent.click(screen.getByRole('button', { name: 'Take yours' }))
    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
    expect(server.body).toContain('My text.')
    expect(server.body).not.toContain('Their text.')
  })

  it('`Keep @held’s` drops the row and their text stands', async () => {
    await stageThenCollide()
    fireEvent.click(await screen.findByRole('button', { name: "Keep @reel_editor's" }))
    expect(trayRows()).toHaveLength(0)
    expect(server.body).toContain('Their text.')
  })

  it('`Write my own` stages ONE reconciled edit, section-scoped', async () => {
    const panel = await stageThenCollide()
    fireEvent.click(within(panel).getByRole('button', { name: 'Write my own' }))
    const ta = document.getElementById('collide-own-goal') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '## Goal\nBoth of ours.\n\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage my text' }))

    expect(trayRows()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
    expect(server.body).toContain('Both of ours.')
    // Section-scoped: the sections it was not about are untouched.
    expect(server.body).toContain('## Guardrails\nDo not break it.')
  })
})

describe('U5 — two accepts on one section, at staging time', () => {
  it('offers the three-way control BEFORE the second row is staged', async () => {
    const base = server.sectionText('goal')
    server.notes = [
      note({
        id: 'n1',
        by: 'content_writer',
        kind: 'proposal',
        proposal: '## Goal\nWriter text.\n\n',
        base_section: base,
        has_proposal: true,
      }),
      note({
        id: 'n2',
        by: 'reel_editor',
        kind: 'proposal',
        proposal: '## Goal\nEditor text.\n\n',
        base_section: base,
        has_proposal: true,
      }),
    ]
    mount()
    await openSection('goal')
    fireEvent.click((await screen.findAllByRole('button', { name: 'Accept' }))[0])
    expect(trayRows()).toHaveLength(1)

    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0])
    // The second is NOT staged — the decision comes first, on an unsent tray.
    expect(trayRows()).toHaveLength(1)
    expect(screen.getByRole('button', { name: "Keep @content_writer's" })).toBeTruthy()
    expect(screen.getByRole('button', { name: "Take @reel_editor's" })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: "Take @reel_editor's" }))
    // The superseded row STAYS, greyed and individually undoable.
    expect(trayRows()).toHaveLength(2)
    expect(trayRows().filter((r) => r.dataset.superseded === 'yes')).toHaveLength(1)
  })

  it('the superseded row never reaches the wire as a sixth kind', async () => {
    const base = server.sectionText('goal')
    server.notes = [
      note({ id: 'n1', by: 'a', kind: 'proposal', proposal: '## Goal\nA.\n\n', base_section: base, has_proposal: true }),
      note({ id: 'n2', by: 'b', kind: 'proposal', proposal: '## Goal\nB.\n\n', base_section: base, has_proposal: true }),
    ]
    mount()
    await openSection('goal')
    fireEvent.click((await screen.findAllByRole('button', { name: 'Accept' }))[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0])
    fireEvent.click(screen.getByRole('button', { name: "Take @b's" }))

    await waitFor(() => expect(server.draft).toHaveLength(2))
    expect(server.draft.every((e) => ['edit', 'accept', 'reject', 'ask', 'dismiss'].includes(e.kind))).toBe(true)
    expect(JSON.stringify(server.draft)).not.toContain('superseded')
  })
})

describe('AC-6.7 — the refresh signal is proportionate', () => {
  it('with an empty tray and no typing the reload is SILENT', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    server.foreignWrite('goal', '## Goal\nMoved.\n\n')
    await qc.invalidateQueries({ queryKey: ['project-plan', PID] })
    await waitFor(() => expect(screen.getByText(/Moved\./)).toBeTruthy())
    expect(screen.queryByTestId('plan-revision-banner')).toBeNull()
  })

  it('with a tray it shows a non-blocking banner naming revision and author, discarding no row', async () => {
    server.notes = [note({ id: 'n1' })]
    mount()
    await openSection('goal')
    await dismissEveryNote()
    expect(trayRows()).toHaveLength(1)

    server.foreignWrite('guardrails', '## Guardrails\nNew rule.\n\n', 'clawmeets-backend')
    await qc.invalidateQueries({ queryKey: ['project-plan', PID] })

    const banner = await screen.findByTestId('plan-revision-banner')
    expect(banner.textContent).toContain('revision 2')
    expect(banner.textContent).toContain('@clawmeets-backend')
    // Non-blocking: the tray is still there, unchanged, and dismissible.
    expect(trayRows()).toHaveLength(1)
    expect(screen.getByTestId('plan-tray')).toBeTruthy()
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('plan-revision-banner')).toBeNull()
    expect(trayRows()).toHaveLength(1)
  })
})

describe('N9 / C1 — the status still moves server-side, now inside the submit', () => {
  it('a staged dismiss moves nothing until the batch lands, then the SERVER moves it', async () => {
    server.notes = [note({ id: 'n1', to: 'user', comment: 'answer me' })]
    mount()
    expect((await screen.findByTestId('plan-open-for-you')).textContent).toContain('1 waiting')

    // ON THE NOTE ITSELF, and it STAGES. `Dismiss now` is gone; the note is
    // closed by the submit, in the same transaction as the write.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByTestId('plan-open-for-you').textContent).toContain('1 waiting')
    expect(server.notes[0].status).toBe('open')

    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))

    await waitFor(() =>
      expect(screen.getByTestId('plan-open-for-you').textContent).toContain('0 waiting'),
    )
    // The SERVER moved it. Not a local flag, not an optimistic decrement.
    expect(server.notes[0].status).toBe('dismissed')
    expect(server.openForYou()).toBe(0)
  })
})

describe('a proposal card renders the diff the SERVER produced', () => {
  it('and the write path sends TEXT, never a diff', async () => {
    server.notes = [
      note({
        id: 'n1',
        kind: 'proposal',
        proposal: '## Goal\nnew\n\n',
        base_section: server.sectionText('goal'),
        has_proposal: true,
      }),
    ]
    mount()
    await openSection('goal')
    expect((await screen.findByTestId('plan-diff')).textContent).toContain('goal (base)')

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
    expect(server.body).toContain('## Goal\nnew')
    expect(server.body).not.toContain('+++')
  })
})

/**
 * AC-2.17 — THE ACCEPTANCE STRIP MOVED INTO THE EDITOR, and what this file still
 * owns is the COUNT. The tab's header used to carry the button, the acceptance
 * chip and the "changed since approval" warning; the editor is mounted directly
 * below that header, so leaving any of them there would have put two of each on
 * one screen.
 *
 * The count is asserted rather than the layout trusted, because a duplicate
 * MOUNT renders perfectly and a source grep cannot see it. The strip's own
 * behaviour — the readout, the pointer, the drift warning — is
 * `PlanAcceptance.test.tsx`'s, where it moved with the code.
 */
describe('AC-2.17 — exactly one acceptance strip on the screen, and it is the editor’s', () => {
  it('one strip, one acceptance chip, one changed-since warning', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    expect(screen.getAllByTestId('plan-acceptance')).toHaveLength(1)
    expect(screen.getAllByTestId('plan-accepted')).toHaveLength(1)
    // It is inside the EDITOR, not in the tab header above it.
    expect(screen.getByTestId('plan-acceptance').closest('[data-testid="plan-editor"]')).toBeTruthy()
    // The header keeps its numbers and nothing else.
    expect(screen.getByTestId('plan-revision').textContent).toContain('revision 1')
    expect(screen.getByTestId('plan-open-for-you')).toBeTruthy()
  })

  it('an unaccepted plan offers NO Approve button and NO pointer either', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull()
    // THE POINTER WENT WITH THE MECHANISM IT DESCRIBED. It read "accept the
    // approval note below — it writes 'User approves the plan.' into this
    // plan's Approval section", which is three lines of mechanism, above the
    // fold, about a control the reader cannot see from here. The confirm note
    // says what dismissing it does, in its own row, where the click is.
    expect(screen.queryByTestId('plan-approve-pointer')).toBeNull()
    expect(screen.getByTestId('plan-accepted').textContent).toBe('Not accepted')
  })

  // AND AN ACCEPTED ONE OFFERS NOTHING EITHER. Revoke was the last control on
  // this strip and it went the way Approve did: an accepted plan is not
  // un-decided, it is renegotiated by applying the next note. The strip is a
  // readout, so the accepted case has to assert an ABSENCE too — the state most
  // likely to grow a button back is the one that used to have one.
  it('an accepted plan offers no control at all — the chip alone', async () => {
    server.accepted = true
    server.acceptedRevision = 1
    mount()
    await screen.findByTestId('project-plan-tab')
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
    expect(screen.getByTestId('plan-accepted').textContent).toContain('Accepted at revision 1')
    expect(
      within(screen.getByTestId('plan-acceptance')).queryAllByRole('button'),
    ).toHaveLength(0)
  })
})

/**
 * THE TAB IS TRANSPORT — driven through the SELECTION POPOVER, which is the only
 * composer there is now. `PlanNoteComposer` is deleted: both of these used to
 * drive its `Comment` field and its `Addressees, comma separated` input, and the
 * second is the natural place to keep the sibling-notes claim, because the
 * popover's free-text addressee field takes the same comma-separated list.
 */
describe('the tab is transport', () => {
  it('the bottom-of-page composer is gone, and nothing replaced it in place', async () => {
    mount()
    await screen.findByTestId('project-plan-tab')
    expect(screen.queryByTestId('plan-composer')).toBeNull()
    expect(screen.queryByLabelText('Comment')).toBeNull()
    expect(screen.queryByLabelText('Addressees, comma separated')).toBeNull()
    expect(screen.queryByRole('button', { name: 'File note' })).toBeNull()
    // The notes LIST stays — it is where every un-quoted note the CLI files
    // renders, and deleting it would strand all of them.
    expect(screen.getByTestId('plan-notes')).toBeTruthy()
  })

  it('a note is filed through the route and refreshes from the server', async () => {
    const { container } = mount()
    await screen.findByTestId('project-plan-tab')
    commentOn(container as HTMLElement, 'Ship the thing')
    await screen.findByTestId('plan-quote-pop')
    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'a question' },
    })
    // NOTHING TO CHOOSE. The note channel connects the user and the
    // coordinator, so the composer names the recipient and files to them.
    fireEvent.click(screen.getByText('File note'))

    await waitFor(() => expect(server.notes).toHaveLength(1))
    expect(server.notes[0].comment).toBe('a question')
    expect(server.notes[0].to).toBe('coordinator')
    expect(server.notes[0].section).toBe('goal')
    // A note writes no plan bytes and is never refused for staleness.
    expect(server.revision).toBe(1)
  })

  /**
   * AC-7.4 / AC-7.5 — THE ADDRESSEE CONTROL IS GONE, AND THIS IS WHAT REPLACED
   * TWO TESTS THAT DROVE IT.
   *
   * One of them removed the `@coordinator` chip and picked `you` off the
   * roster; the other typed `content_writer, reel_editor` into the free-text
   * field to pin that a list of addressees fans out into independent sibling
   * notes. Under the two-party rule the first is not something the UI should
   * offer and the second would be REFUSED by the server, so both gestures are
   * unreachable here.
   *
   * THE WIRE FACT THEY PINNED IS STILL TRUE AND STILL EXERCISED — `POST
   * /plan/notes` still takes `to: list[str]` and still files one sibling per
   * name, because one note with one status cannot say "two agreed, one
   * objected". It is reached from `clawmeets plan note` now, and its coverage
   * lives with the route rather than here. What this pins is the browser's
   * half: exactly one addressee, and no control that could produce a second.
   *
   * AND THE COMPOSER NO LONGER SAYS SO OUT LOUD, which is the last step of the
   * same argument rather than a new one. A control that asks a question with
   * one answer became a sentence stating the answer; a sentence stating an
   * answer that never varies became nothing at all. The recipient is unchanged
   * and the assertion that matters is the one below the fold: `to` on the wire
   * is still exactly `['coordinator']`.
   */
  it('the composer offers ONE recipient and no way to address anyone else', async () => {
    const { container } = mount()
    await screen.findByTestId('project-plan-tab')
    commentOn(container as HTMLElement, 'Ship the thing')
    const pop = await screen.findByTestId('plan-quote-pop')

    // Neither asked NOR said — the addressee row came off the surface.
    expect(screen.queryByTestId('plan-pop-to')).toBeNull()
    expect(pop.textContent).not.toContain('@coordinator')
    // Every control the picker offered, absent.
    expect(pop.querySelector('.plan-pop-chip')).toBeNull()
    expect(pop.querySelector('.plan-roster')).toBeNull()
    expect(screen.queryByLabelText('Address it to')).toBeNull()
    expect(screen.queryByLabelText('Find an agent')).toBeNull()
    expect(screen.queryByText('someone else')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove @coordinator' })).toBeNull()

    fireEvent.change(screen.getByLabelText('What do you want to say about this?'), {
      target: { value: 'thoughts?' },
    })
    fireEvent.click(screen.getByText('File note'))
    await waitFor(() => expect(server.notes).toHaveLength(1))
    expect(server.notes.map((n) => n.to)).toEqual(['coordinator'])
  })
})

/**
 * THE OFF-CONTRACT ALARM ON THE PLAN TAB — the reported bug, and the reason it
 * looked like the tab could not send a review at all.
 *
 * `Send review` was never missing from this surface: `PlanTray` returns `null`
 * with an empty tray at BOTH densities, so the button appears once something is
 * staged and not before. What the tab lacked was any route to staging something
 * — no alarm saying the work had gone off-contract, and no jump to the note
 * that needed the decision. It opened on `all`, so on a plan of any length the
 * note was several scrolls down; the reader saw no button and concluded the tab
 * could not send. The desk card walked you into it (it passed the deviation's
 * section in as `initialSection`) and the tab did not.
 *
 * Both halves now live in `PlanEditor`, so BOTH mounts have them from one piece
 * of code. These four assert the tab's half; `PlanBand.test.tsx` still asserts
 * the card's.
 */
describe('the deviation is visible and decidable ON THE TAB', () => {
  const dev = (over: Partial<PlanNote> = {}) =>
    note({
      id: 'n-dev',
      kind: 'deviation',
      section: 'milestones',
      to: 'user',
      by: 'content_writer',
      comment: 'shipped 4 slides, the plan says 6',
      base_section: '## Milestones\nSix slides.\n',
      ...over,
    })

  it('the ALARM renders ONE LINE per deviation — a summary, the locator, who raised it', async () => {
    server.notes = [dev()]
    mount()

    const el = await screen.findByTestId('plan-comment-list')
    const row = within(el).getByTestId('plan-comment-row')
    expect(row.dataset.commentId).toBe('n-dev')
    expect(row.textContent).toContain('shipped 4 slides') // the summary
    expect(row.textContent).toContain('milestones') // the contract locator
    expect(row.textContent).toContain('@content_writer') // who noticed
    // The Plan's own text for the clause is NOT quoted here — the row is one
    // line, and the pane is seeded to this section, so the clause is on screen
    // beside it in full.
    await screen.findByTestId('plan-notes')
    expect(document.body.textContent).toContain('Six slides.')

    // STILL NOT A DECISION. The row is a button because it ROUTES; the only
    // controls that resolve anything are the note's own, below it.
    for (const b of within(el).queryAllByRole('button')) {
      expect(b.dataset.testid ?? b.getAttribute('data-testid')).toBe('plan-comment-row')
    }
    expect(within(el).getByTestId('plan-comment-list-where').textContent).toContain(
      'nothing reaches the plan or its addressees until you submit',
    )
  })

  /** THE ONE-LINER IS A BOUND, NOT A PREFERENCE — a 6,000-character deviation
   *  comment used to render whole, take the height the tray needed, and push
   *  `Send review` off the bottom of a clipped box with no scrollbar anywhere
   *  that could reach it. jsdom has no layout engine, so what is assertable
   *  here is the input to that: the row's text is short whatever the comment
   *  says. `PlanEditor.mounts.test.tsx` holds the layout half. */
  it('a huge comment still renders ONE SHORT LINE in the alarm', async () => {
    const huge =
      'The milestone says six slides but the deck ships four. ' + 'x'.repeat(6000)
    server.notes = [dev({ comment: huge })]
    mount()

    const row = await screen.findByTestId('plan-comment-row')
    const summary = row.textContent ?? ''
    expect(summary.length).toBeLessThan(200)
    expect(summary).toContain('The milestone says six slides but the deck ships four.')
    expect(summary).not.toContain('xxxxxxxxxx')
    // The note card below still carries the comment in FULL — the alarm
    // summarises, it does not replace.
    const note = await screen.findByTestId('plan-note-comment')
    expect(note.textContent).toBe(huge)
  })

  /** EVERY OPEN DEVIATION, not just the newest. The single-note form was the
   *  desk chip's fact borrowed for a list's job: the chip said `off-contract`
   *  and the count counted both, while the only surface that names deviations
   *  showed one. */
  it('a SECOND open deviation gets its own row', async () => {
    server.notes = [dev(), dev({ id: 'n-dev2', section: 'goal', comment: 'scope grew' })]
    mount()

    const el = await screen.findByTestId('plan-comment-list')
    const rows = within(el).getAllByTestId('plan-comment-row')
    expect(rows.map((r) => r.dataset.commentId)).toEqual(['n-dev2', 'n-dev'])
  })

  /** CLICK A ROW, LAND ON ITS NOTE. The alarm's copy promises the decision is
   *  "below"; this is the mechanism that makes that literal for a deviation
   *  that is NOT the one the pane was seeded to. */
  it('clicking a row selects that deviation SECTION and focuses its note', async () => {
    server.notes = [dev(), dev({ id: 'n-dev2', section: 'goal', comment: 'scope grew' })]
    mount()

    // Seeded to the NEWEST — `goal` — so `milestones` is the one a click has
    // to travel to.
    const el = await screen.findByTestId('plan-comment-list')
    await waitFor(() =>
      expect(document.querySelector('[data-section="goal"]')?.getAttribute('aria-current')).toBe(
        'true',
      ),
    )

    const older = within(el)
      .getAllByTestId('plan-comment-row')
      .find((r) => r.dataset.commentId === 'n-dev')!
    fireEvent.click(older)

    await waitFor(() =>
      expect(
        document.querySelector('[data-section="milestones"]')?.getAttribute('aria-current'),
      ).toBe('true'),
    )
    // And the note it points at is on screen, lit up.
    const target = await screen.findByTestId('plan-note-acts-n-dev')
    expect(document.querySelector('[data-note-id="n-dev"]')?.className).toContain(
      'plan-note--focused',
    )
    expect(target).toBeTruthy()
  })

  it('and the tab OPENS ON THE CLAUSE IN QUESTION rather than on the whole document', async () => {
    // A second note, on a DIFFERENT section, is what makes this assertion
    // about the pane rather than about the note merely existing: the
    // whole-document view shows both, the deviation's section shows one.
    server.notes = [dev(), note({ id: 'n-other', section: 'goal', to: 'user' })]
    mount()
    await screen.findByTestId('plan-comment-list')

    // The rail marks the deviation's own section current — not `all`, which is
    // what this mount always used to open on.
    await waitFor(() =>
      expect(
        document.querySelector('[data-section="milestones"]')?.getAttribute('aria-current'),
      ).toBe('true'),
    )
    expect(document.querySelector('[data-section="goal"]')?.getAttribute('aria-current')).toBe(
      null,
    )

    // And the pane is genuinely scoped to it: the deviation's note is on
    // screen, the other section's is not. Asserted over the WHOLE TAB rather
    // than over the page-bottom list, because that list is no longer where
    // either of them would render — each names a section, so each hangs inside
    // the section it names, and the claim being made here is about which
    // section the pane DREW, not about which container the note landed in.
    const tab = await screen.findByTestId('project-plan-tab')
    expect(within(tab).getByTestId('plan-note-acts-n-dev')).toBeTruthy()
    expect(within(tab).queryByTestId('plan-note-acts-n-other')).toBeNull()
  })

  it('the header says `off-contract`, BESIDE the count and never folded into it', async () => {
    server.notes = [note({ id: 'a', to: 'user' }), dev()]
    mount()

    expect(await screen.findByTestId('plan-tab-offcontract')).toBeTruthy()
    // Two chips, never one sum. The deviation is already one of the notes the
    // execution gate counts, so adding it again would defeat that guard.
    expect(screen.getByTestId('plan-open-for-you').textContent).toBe('2 waiting on you')
  })

  /** NO DEVIATION, NO ALARM — BUT STILL A NAVIGATOR, and that is the change
   *  this case exists to pin. The box used to be the deviation alarm and
   *  nothing else, so on a plan with an open question and no deviation the
   *  fastest thing in the editor rendered nothing at all. It lists every open
   *  comment now; what `presence is the predicate` governs is the ALARM, which
   *  is a mode of the list rather than the list itself. */
  it('no deviation: the list still routes, but nothing is red and no chip shows', async () => {
    server.notes = [note({ id: 'a', to: 'user' })]
    mount()
    await screen.findByTestId('plan-notes')
    const list = await screen.findByTestId('plan-comment-list')
    expect(list.className).not.toContain('plan-cl--alarm')
    expect(within(list).getByTestId('plan-comment-row').dataset.commentId).toBe('a')
    expect(screen.queryByTestId('plan-tab-offcontract')).toBeNull()
  })

  it('NOTHING OPEN, NOTHING RENDERED — presence is still the whole predicate', async () => {
    server.notes = []
    mount()
    await screen.findByTestId('plan-notes')
    expect(screen.queryByTestId('plan-comment-list')).toBeNull()
  })

  /** THE ONE THAT PROVES THE REPORTED BUG IS GONE. Land on the tab, decide the
   *  deviation, send the batch — without ever touching the section rail, which
   *  is what the reader could not find their way to before. */
  it('a deviation is decidable END TO END from the tab, rail untouched', async () => {
    server.notes = [dev()]
    mount()

    // Everything needed is on screen on arrival: the alarm, and the note's own
    // action bar under it.
    await screen.findByTestId('plan-comment-list')
    const acts = await screen.findByTestId('plan-note-acts-n-dev')
    fireEvent.click(within(acts).getByRole('button', { name: 'Dismiss' }))

    // It STAGES — nothing about a note reaches a route on the click.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('dismiss')
    expect(server.notes[0].status).toBe('open')

    // And the tray — with `Send review` in it — is now there. It was absent
    // before because nothing had been staged, not because the mount lacked it.
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    await waitFor(() => expect(server.notes[0].status).toBe('dismissed'))
    expect(server.openForYou()).toBe(0)
    // The list and the chip clear with it — the plan has no open comment left,
    // so there is nothing to navigate to.
    await waitFor(() => expect(screen.queryByTestId('plan-comment-list')).toBeNull())
    expect(screen.queryByTestId('plan-tab-offcontract')).toBeNull()
  })
})

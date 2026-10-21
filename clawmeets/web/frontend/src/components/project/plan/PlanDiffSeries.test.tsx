import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * THE SERIES, AND THE STACK, DRIVEN THROUGH THE REAL EDITOR.
 *
 * The thing being fixed is a SEQUENCE, not a render: two proposals on one
 * section used to draw as two independent cards, each with a small, clean,
 * plausible-looking diff, and nothing on screen said they were mutually
 * exclusive until the user clicked Accept on the second and a modal appeared.
 * The claim of this change is that the reveal moves EARLIER and that both
 * changes can now land — neither of which a component mounted in isolation can
 * demonstrate, because both depend on the tray moving between renders.
 *
 * `PlanDiff` is stubbed as a `<pre>` of the raw unified diff: `diff2html` is not
 * under test, and the diff TEXT is exactly what these assertions are about.
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
    createElement('pre', { 'data-testid': 'plan-diff' }, text),
}))

const { PlanEditor } = await import('./PlanEditor')

const PID = 'p-1'

/* A section with FOUR independently editable lines, because that is what makes
 * two proposals compose. On a one-line section every proposal collides with
 * every other and the stack has nothing to prove. */
const MILESTONES = [
  '## Milestones',
  '',
  '- [ ] **M1** — spec',
  '- [ ] **M2** — build',
  '- [ ] **M3** — polish',
  '- [ ] **M4** — ship',
  '',
].join('\n')
const BODY = ['# Project Plan: demo', '', MILESTONES].join('\n')

const SECTIONS: PlanSection[] = [
  { id: 'milestones', heading: 'Milestones', depth: 2, boxes: [0, 4], char_start: 0, char_end: 0 },
]

/** @backend ticks M1. */
const BACKEND_TEXT = MILESTONES.replace('- [ ] **M1** — spec', '- [x] **M1** — spec (done)')
/** @frontend ticks M4 — a different line, three away, so the fold fits. */
const FRONTEND_TEXT = MILESTONES.replace('- [ ] **M4** — ship', '- [x] **M4** — ship (done)')
/** @devops rewrites M1 — the SAME line @backend ticked, so the fold refuses. */
const DEVOPS_TEXT = MILESTONES.replace('- [ ] **M1** — spec', '- [ ] **M1** — spec and scope')

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n-1',
    section: 'milestones',
    to: 'user',
    by: 'backend',
    at: 't',
    status: 'open',
    kind: 'proposal',
    layer: 'spec',
    comment: '',
    proposal: BACKEND_TEXT,
    base_section: MILESTONES,
    quote: '',
    reply_to: '',
    round: '',
    conflict: false,
    resolved_by: '',
    resolved_at: '',
    resolution: '',
    revision: 1,
    has_proposal: true,
    proposes_delete: false,
    bootstrap: false,
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
/** Every `GET` the editor makes, counted — the "no request" claim below is the
 *  whole reason the series is generated in the browser, so it is asserted
 *  rather than asserted-about. */
let gets = 0

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, children)

beforeEach(() => {
  server = new FakePlanServer(BODY, SECTIONS)
  const real = routeTo(server, PID)
  gets = 0
  routes.current = {
    ...real,
    get: (path: string) => {
      gets += 1
      return real.get(path)
    },
  }
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})

afterEach(() => {
  cleanup()
  qc.clear()
})

const card = async (id: string) => {
  const acts = await screen.findByTestId(`plan-note-acts-${id}`)
  return acts.closest('.plan-note') as HTMLElement
}

const accept = async (id: string) =>
  fireEvent.click(
    within(await screen.findByTestId(`plan-note-acts-${id}`)).getByRole('button', {
      name: 'Accept',
    }),
  )

async function withTwoProposals(second = FRONTEND_TEXT) {
  server.notes.push(
    note({ id: 'n1', by: 'backend', proposal: BACKEND_TEXT }),
    note({ id: 'n2', by: 'frontend', proposal: second }),
  )
  render(createElement(PlanEditor, { projectId: PID, density: 'full' }), { wrapper })
  await screen.findByTestId('plan-body')
}

describe('the reveal moves earlier — a card names its rival before any click', () => {
  /**
   * THE DEFECT THIS CHANGE IS ABOUT. Two proposals used to render as two cards
   * with no cross-talk at all: the only aggregate on the surface was
   * `openNotesOn`, a count that treats a comment and a proposal alike. That a
   * proposal is a whole-section replacement — and therefore that these two
   * cannot both be staged — was invisible until Accept was clicked.
   */
  it('says who else has proposed here, on both cards, with nothing staged', async () => {
    await withTwoProposals()
    expect((await card('n1')).textContent).toContain('@frontend has also proposed a change')
    expect((await card('n2')).textContent).toContain('@backend has also proposed a change')
    expect(server.draft).toHaveLength(0)
  })

  /** THE CONSEQUENCE IS ONE CLICK AWAY AND NOT ON SCREEN BY DEFAULT. Three
   *  proposals on one section would otherwise stack six diffs in a note row, so
   *  the rival steps sit behind a disclosure — named in words, not counted. */
  it('keeps the rival diff behind a disclosure until it is opened', async () => {
    await withTwoProposals()
    const first = await card('n1')
    expect(within(first).getAllByTestId('plan-diff')).toHaveLength(1)

    fireEvent.click(within(first).getByTestId('plan-diff-series-toggle'))

    const diffs = within(first).getAllByTestId('plan-diff')
    expect(diffs).toHaveLength(2)
    // @frontend's tick, added — and @backend's own, taken away. THAT is the
    // fact the two independent cards hid.
    expect(diffs[1].textContent).toContain('+- [x] **M4** — ship (done)')
    expect(diffs[1].textContent).toContain('-- [x] **M1** — spec (done)')
  })

  /** A LONE PROPOSAL IS UNTOUCHED, which is the compatibility promise: one
   *  step renders bare, with no disclosure and no summary line. */
  it('adds nothing at all to a lone proposal', async () => {
    server.notes.push(note({ id: 'n1', by: 'backend', proposal: BACKEND_TEXT }))
    render(createElement(PlanEditor, { projectId: PID, density: 'full' }), { wrapper })
    await screen.findByTestId('plan-body')
    const only = await card('n1')
    expect(within(only).getAllByTestId('plan-diff')).toHaveLength(1)
    expect(within(only).queryByTestId('plan-diff-series-toggle')).toBeNull()
  })
})

describe("accepting one re-heads the others, with no request", () => {
  /**
   * THE REASON THE SERIES IS GENERATED IN THE BROWSER. Accepting writes ZERO
   * bytes — it stages a tray row — so the SERVER still believes the section
   * reads as it did, and `section_changed` is `false` on every note. A
   * server-generated series would keep drawing @frontend's proposal against the
   * old text. The tray's text is the head here, so the card re-draws on the
   * next render.
   */
  it("diffs the second proposal against the first's staged text", async () => {
    await withTwoProposals()
    const before = gets
    await accept('n1')
    await screen.findByTestId('plan-tray')

    const second = await card('n2')
    await waitFor(() =>
      expect(within(second).getByTestId('plan-diff-series-toggle').textContent).toContain(
        'This section has moved',
      ),
    )
    fireEvent.click(within(second).getByTestId('plan-diff-series-toggle'))
    const diffs = within(second).getAllByTestId('plan-diff')
    // Read against what the tray now holds: taking @frontend's alone would undo
    // @backend's tick.
    expect(diffs[1].textContent).toContain('-- [x] **M1** — spec (done)')
    expect(diffs[1].textContent).toContain('+- [x] **M4** — ship (done)')
    // The server was not asked anything to produce that.
    expect(gets).toBe(before)
  })
})

describe('Keep both — a stack of two proposals on one section', () => {
  /**
   * THE ASK, END TO END: accept @backend's, read @frontend's against it, and
   * take that too, so BOTH land. ONE row LANDS, carrying both ticks —
   * `_collapse_text_rows` keeps the LAST text row per section and `apply_edits`
   * splices its text verbatim, so nothing about the write path is softened to
   * make this work.
   *
   * THE WINNER IS THE SAME ROW ON BOTH BRANCHES, WHICH IS WHY THIS RUNS TWICE.
   * `records_folds` selects what happens to the row that LOST the section — a
   * dismissal on one branch, a live row carrying one boolean on the other — and
   * it must not touch the text that lands. Reading the LAST text row rather
   * than the only one is what makes that claim testable instead of assumed.
   */
  it.each([false, true])('stages a row carrying both changes (records_folds=%s)', async (recordsFolds) => {
    server.recordsFolds = recordsFolds
    await withTwoProposals()
    await accept('n1')
    await screen.findByTestId('plan-tray')
    await accept('n2')

    const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
    fireEvent.click(within(collide).getByRole('button', { name: 'Keep both' }))

    await waitFor(() => expect(server.draft.filter((r) => r.kind === 'accept')).toHaveLength(recordsFolds ? 2 : 1))
    const accepts = server.draft.filter((r) => r.kind === 'accept')
    const winner = accepts[accepts.length - 1]
    expect(winner.note_id).toBe('n2')
    expect(winner.text).toContain('- [x] **M1** — spec (done)')
    expect(winner.text).toContain('- [x] **M4** — ship (done)')
    // Untouched lines are untouched, and the section keeps its shape.
    expect(winner.text).toContain('- [ ] **M2** — build')
    expect(winner.text).toBe(
      MILESTONES.replace('- [ ] **M1** — spec', '- [x] **M1** — spec (done)').replace(
        '- [ ] **M4** — ship',
        '- [x] **M4** — ship (done)',
      ),
    )
  })

  /**
   * WHAT THE FOLDED-AWAY AUTHOR IS TOLD WHEN THE SERVER CANNOT SAY IT, AND WHY
   * IT IS A DISMISSAL THERE.
   *
   * A second `accept` row on one section is what the server collapses away and
   * then force-closes `rejected` with "superseded by @{by}'s proposal on the
   * same section" — false about a proposal whose lines are in the document. A
   * `dismiss` row is not a text row, so it is never collapsed, and `_close_note`
   * stores this sentence on `note.resolution`.
   *
   * IT DID NOT "DELIVER IT", AND SAYING SO WAS THE OTHER HALF OF THE BUG. This
   * comment used to claim `_close_note` delivered the sentence to the agent. It
   * did not: the reason was stored and no surface in the repo read the field
   * back out, so the folded-away author was told nothing at all — the same was
   * true of a plain reject's comment and an `ask`'s question. Delivery arrived
   * with the batch-message change that shipped beside the fold record, so the
   * claim is true NOW and was false when it was written.
   */
  it("tells the folded-away author the truth in the user's own sentence, on a server that does not record folds", async () => {
    server.recordsFolds = false
    await withTwoProposals()
    await accept('n1')
    await screen.findByTestId('plan-tray')
    await accept('n2')
    const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
    fireEvent.click(within(collide).getByRole('button', { name: 'Keep both' }))

    await waitFor(() => expect(server.draft).toHaveLength(2))
    const closed = server.draft.find((r) => r.note_id === 'n1')!
    expect(closed.kind).toBe('dismiss')
    expect(closed.comment).toContain("Folded into @frontend's change")
  })

  /**
   * THE RECORD, ARRIVING BACK FROM A SUBMIT — which is the only way to prove
   * it. The tray assertion above says what the client SENT; this says what the
   * server MADE of it, through a fake that now collapses text rows and runs the
   * superseded loop as the real one does. A hand-stuffed `status: 'folded'` on
   * a fixture would prove that the chip renders a string, not that a fold ever
   * produces one.
   *
   * NOTHING THE CLIENT WROTE IS IN THE ANSWER. The client sent one boolean on
   * the losing row; the winner's name in the sentence is the server's, derived
   * from its own collapse.
   */
  it('records the fold as the sixth status, with the reason the server wrote', async () => {
    await withTwoProposals()
    await accept('n1')
    await screen.findByTestId('plan-tray')
    await accept('n2')
    const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
    fireEvent.click(within(collide).getByRole('button', { name: 'Keep both' }))

    // TWO text rows reach the wire, loser first, and the bit rides on the loser
    // alone. No dismissal, no sentence, no author name from this side.
    await waitFor(() => expect(server.draft).toHaveLength(2))
    expect(server.draft.map((r) => r.kind)).toEqual(['accept', 'accept'])
    expect(server.draft[0].note_id).toBe('n1')
    expect(server.draft[0].folded).toBe(true)
    expect(server.draft[1].folded).toBeUndefined()
    expect(JSON.stringify(server.draft)).not.toContain('folded_by')

    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))

    await waitFor(() => expect(server.draft).toHaveLength(0))
    const folded = server.notes.find((n) => n.id === 'n1')!
    expect(folded.status).toBe('folded')
    expect(folded.resolution).toBe(
      "folded into @frontend's change on the same section — your text is in the section that landed",
    )
    // The winner landed, and BOTH sets of lines are in the document.
    expect(server.notes.find((n) => n.id === 'n2')!.status).toBe('applied')
    expect(folded.status).not.toBe('rejected')
    expect(folded.status).not.toBe('dismissed')
  })

  /** THE COST IS STATED WHERE THE DECISION IS MADE, and the sentence is now one
   *  that is true whichever server is on the other end — which is why it is
   *  asserted in both flag positions rather than one. It names NO status word:
   *  `dismissed` would be false against a server that records folds, `folded`
   *  false against one that does not, and "closed carrying a reason that says
   *  their text was folded into the section that landed" is true of both. That
   *  is what keeps the capability flag out of this component entirely. */
  it.each([false, true])(
    'says on the control that the folded-away text landed (records_folds=%s)',
    async (recordsFolds) => {
      server.recordsFolds = recordsFolds
      await withTwoProposals()
      await accept('n1')
      await screen.findByTestId('plan-tray')
      await accept('n2')
      const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
      const cost = within(collide).getByTestId('plan-collide-stack-cost')
      expect(cost.textContent).toContain('both edits land in one write')
      expect(cost.textContent).toContain('folded into the section that landed')
      expect(cost.textContent).toContain('not that it was dropped')
      // The retired claim is gone, and nothing replaced it with a status word
      // that only one of the two servers would make true.
      expect(cost.textContent).not.toContain('no way to record')
      expect(cost.textContent).not.toContain('as dismissed')
    },
  )

  /**
   * IT DEGRADES RATHER THAN GUESSES. @devops rewrites the same line @backend
   * ticked, so there is no correct automatic answer and the button is not
   * offered — which is exactly the case the pick-one control has always been
   * for. An absent button with no explanation is indistinguishable from a
   * feature that does not exist, so the control says why.
   *
   * RUN IN BOTH FLAG POSITIONS TO SAY THAT THE FLAG HAS NOTHING TO DO WITH IT.
   * Whether two proposals COMPOSE is a question about diffs; whether the fold
   * can be RECORDED is a question about the server. A capability flag that
   * started deciding which button appears would be answering the first question
   * with the second.
   */
  it.each([false, true])(
    'withholds `Keep both` when the two proposals touch the same line (records_folds=%s)',
    async (recordsFolds) => {
    server.recordsFolds = recordsFolds
    await withTwoProposals(DEVOPS_TEXT)
    await accept('n1')
    await screen.findByTestId('plan-tray')
    await accept('n2')

    const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
    expect(within(collide).queryByRole('button', { name: 'Keep both' })).toBeNull()
    expect(within(collide).getByTestId('plan-collide-stack-refused').textContent).toContain(
      'change the same lines',
    )
    // And the three original choices are all still there.
    expect(within(collide).getByRole('button', { name: "Keep @backend's" })).toBeTruthy()
    expect(within(collide).getByRole('button', { name: 'Write my own' })).toBeTruthy()
    expect(within(collide).getByRole('button', { name: "Take @frontend's" })).toBeTruthy()
    },
  )

  /** `Take @{new}'s` STILL DISCARDS, and the sentence that says so is still
   *  there. Adding an outcome must not quietly retire one. */
  it('leaves the pick-one outcome exactly as it was', async () => {
    await withTwoProposals()
    await accept('n1')
    await screen.findByTestId('plan-tray')
    await accept('n2')
    const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
    expect(collide.textContent).toContain(
      'the discarded proposal is closed as rejected with a reason — never as applied',
    )
    fireEvent.click(within(collide).getByRole('button', { name: "Take @frontend's" }))
    // Two accept rows, the loser first — the server collapses to the last.
    await waitFor(() => expect(server.draft.filter((r) => r.kind === 'accept')).toHaveLength(2))
  })
})

describe('the go-note may not be folded away', () => {
  /**
   * THE ASSERTION IS THE SAME; THE REASON FOR IT HAS CHANGED, AND THE OLD ONE
   * WOULD NOW ARGUE THE GUARD AWAY.
   *
   * It used to read: a fold DISMISSES the held note, and `_refuse_go_note_close`
   * refuses every close but Accept, so the button would always 409. On a server
   * that records folds the note closes `folded`, not `dismissed` — so anyone
   * checking the old reason against the new status would conclude the guard is
   * obsolete.
   *
   * IT IS NOT. The execution gate counts notes that are OPEN, so EVERY way of
   * closing the go-note releases it and `folded` is simply a new way. Only the
   * user APPLYING it may release that gate, because applying it is what
   * approves the plan. The refusal is about closing, not about which word — and
   * that is why this holds in both flag positions.
   */
  it.each([false, true])(
    'offers no `Keep both` when the held row is the plan-approval note (records_folds=%s)',
    async (recordsFolds) => {
    server.recordsFolds = recordsFolds
    server.notes.push(
      note({ id: 'n1', by: 'coordinator', bootstrap: true, proposal: BACKEND_TEXT }),
      note({ id: 'n2', by: 'frontend', proposal: FRONTEND_TEXT }),
    )
    render(createElement(PlanEditor, { projectId: PID, density: 'full' }), { wrapper })
    await screen.findByTestId('plan-body')
    await accept('n1')
    await screen.findByTestId('plan-tray')
    await accept('n2')

    const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
    expect(within(collide).queryByRole('button', { name: 'Keep both' })).toBeNull()
    expect(within(collide).getByTestId('plan-collide-stack-refused').textContent).toContain(
      'can only be accepted',
    )
    },
  )
})

describe('a proposal written against an older section', () => {
  /**
   * THE SAME FOLD, AGAINST THE DOCUMENT. Here the held side is the section as
   * it stands rather than somebody's proposal, so fitting the change onto it
   * RE-BASES the proposal instead of overwriting whatever moved — and nothing
   * is closed, because the held side is nobody's note.
   */
  it("fits the proposal onto the current text rather than overwriting it", async () => {
    // The document already carries @backend's tick; @frontend's note was
    // written against the section before it.
    server.body = BODY.replace(MILESTONES, BACKEND_TEXT)
    server.notes.push(
      note({
        id: 'n2',
        by: 'frontend',
        proposal: FRONTEND_TEXT,
        base_section: MILESTONES,
        section_changed: true,
      }),
    )
    render(createElement(PlanEditor, { projectId: PID, density: 'full' }), { wrapper })
    await screen.findByTestId('plan-body')
    await accept('n2')

    const collide = await screen.findByRole('group', { name: 'Two versions of milestones' })
    fireEvent.click(within(collide).getByRole('button', { name: "Fit @frontend's onto it" }))

    await waitFor(() => expect(server.draft).toHaveLength(1))
    // Both ticks survive: what the document already said, and what @frontend
    // proposed. Staging their text verbatim would have reverted the first.
    expect(server.draft[0].text).toContain('- [x] **M1** — spec (done)')
    expect(server.draft[0].text).toContain('- [x] **M4** — ship (done)')
    // Nothing was dismissed — there was no second note in the question.
    expect(server.draft.every((r) => r.kind === 'accept')).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * A SETTLED COLLISION, THEN A REFUSED SUBMIT — the two mechanisms meeting.
 *
 * Each half was covered on its own and the combination was not, which is why
 * this survived. `Take @{new}'s` deliberately KEEPS the losing row: it stays in
 * the tray, struck through and individually undoable, so the choice can be
 * taken back. `toWire` strips only the `superseded_by` label, so BOTH rows go
 * to the server, and `_collapse_text_rows` keeps the LAST one and resolves the
 * earlier `rejected`. The winner is therefore the only row the submit writes,
 * and the only row a `409` can be about.
 *
 * THE BUG. The post-refusal panel took the FIRST text row for the section, so
 * it offered the DISCARDED proposal, labelled as the user's own text, beside
 * what the section says now. Re-basing it left the winner's `base` stale, so
 * the next Send earned the identical `409` — and the panel picked the same
 * discarded row again. A loop with no way out of the UI, on the one screen
 * whose entire promise is *nothing was applied and nothing was lost*.
 *
 * Driven end to end rather than through the panel in isolation: the loop is a
 * property of the second Send, and only a real tray reaching a real refusal
 * twice can show that the second one is not the first one repeated.
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

const GOAL = ['## Goal', '', 'Ship six slides.', ''].join('\n')
const BODY = ['# Project Plan: demo', '', GOAL].join('\n')

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

const WRITER_TEXT = ['## Goal', '', 'Ship six slides, tightly.', ''].join('\n')
const EDITOR_TEXT = ['## Goal', '', 'Ship six slides, and a reel.', ''].join('\n')
/** What some other agent lands on the section while the tray sits staged. */
const MOVED = ['## Goal', '', 'Ship four slides.', ''].join('\n')

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n-1',
    section: 'goal',
    to: 'user',
    by: 'content_writer',
    at: 't',
    status: 'open',
    kind: 'proposal',
    layer: 'spec',
    comment: 'tighten this',
    proposal: WRITER_TEXT,
    base_section: GOAL,
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

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, children)

/* NO IDENTITY IS SEEDED, deliberately. `canDecide` is the fake's own switch and
 * every control this suite touches — Accept, Send review, the refusal panel —
 * reads it rather than the auth store. The Approve control is what needs an
 * owner, and nothing here goes near it. */

beforeEach(() => {
  server = new FakePlanServer(BODY, SECTIONS)
  routes.current = routeTo(server, PID)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})

afterEach(() => {
  cleanup()
  qc.clear()
})

const accept = async (noteId: string) =>
  fireEvent.click(
    within(await screen.findByTestId(`plan-note-acts-${noteId}`)).getByRole('button', {
      name: 'Accept',
    }),
  )

/**
 * Two proposals on `goal`, both accepted, the collision settled with
 * `Take @reel_editor's` — so the tray holds the writer's row superseded and the
 * editor's row live, in that order.
 */
async function settledOnTheEditors() {
  server.notes.push(
    note({ id: 'n1', by: 'content_writer', proposal: WRITER_TEXT }),
    note({ id: 'n2', by: 'reel_editor', proposal: EDITOR_TEXT }),
  )
  render(createElement(PlanEditor, { projectId: PID, density: 'full' }), { wrapper })
  await screen.findByTestId('plan-body')

  await accept('n1')
  await screen.findByTestId('plan-tray')
  await accept('n2')

  const collide = await screen.findByRole('group', { name: 'Two versions of goal' })
  fireEvent.click(within(collide).getByRole('button', { name: "Take @reel_editor's" }))
  await waitFor(() =>
    expect(screen.queryByRole('group', { name: 'Two versions of goal' })).toBeNull(),
  )
  // Both rows are on the wire: the label that marks one superseded is this
  // client's and never leaves it.
  await waitFor(() => expect(server.draft.filter((r) => r.kind === 'accept')).toHaveLength(2))
}

/** The refusal panel. */
function refusalPanel() {
  return screen.getByTestId('plan-stale-reconcile')
}

/** The per-section controls still waiting on a decision inside it.
 *
 *  Asked of the CONTROLS rather than of the panel, because resolving the last
 *  row empties `stale.rows` without nulling `stale` — the banner stays up
 *  saying nothing was applied and naming the conflict notes the refusal filed,
 *  which is still true and still worth reading. */
const undecided = () => screen.queryAllByRole('group', { name: 'Two versions of goal' })

describe('a refused submit, after a collision was settled', () => {
  it('offers the row the SERVER will apply, not the one the user discarded', async () => {
    await settledOnTheEditors()

    // Another agent moves the section while the tray sits staged.
    server.body = BODY.replace(GOAL, MOVED)

    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    const panel = await screen.findByTestId('plan-stale-reconcile')

    // ONE panel, for the one row the submit was about.
    expect(within(panel).getAllByRole('group', { name: 'Two versions of goal' })).toHaveLength(1)
    // …and the text it calls the user's own is the WINNER's. `getAllByText`,
    // because the control now renders BOTH directions of the question as diffs
    // — what taking the row does and what keeping the current text does — so
    // each side's line appears twice, once green and once red. The claim under
    // test is unchanged: the winner's text is what is offered, and the
    // discarded row's is nowhere.
    expect(within(panel).getAllByText(/and a reel/).length).toBeGreaterThan(0)
    expect(within(panel).queryByText(/tightly/)).toBeNull()
    // The other side is what the section says now, which is what the user is
    // being asked to read the row against.
    expect(within(panel).getAllByText(/Ship four slides/).length).toBeGreaterThan(0)
  })

  it('re-basing lands on the SECOND Send — the refusal is not a loop', async () => {
    await settledOnTheEditors()
    server.body = BODY.replace(GOAL, MOVED)

    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    await screen.findByTestId('plan-stale-reconcile')

    fireEvent.click(within(refusalPanel()).getByRole('button', { name: 'Take yours' }))
    await waitFor(() => expect(undecided()).toHaveLength(0))

    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))

    // It went out. Under the bug this was the identical 409, forever: the panel
    // re-based the discarded row, the winner kept its stale `base`, and nothing
    // on screen had moved.
    await waitFor(() => expect(server.rounds).toBe(1))
    expect(screen.queryByTestId('plan-stale-reconcile')).toBeNull()
    expect(server.sectionText('goal')).toBe(EDITOR_TEXT)
  })

  it('`Keep` leaves the section alone rather than resurrecting the discarded row', async () => {
    /**
     * THE ESCAPE HATCH THAT USED TO COST SOMETHING. Dropping the row the panel
     * offered did break the loop — the next Send found the other one — but it
     * got there by removing a row the user never chose to remove, and `✕`
     * semantics then UN-superseded the loser, staging a proposal they had
     * already discarded against the very section they had just said to leave
     * alone. "Keep what it says now" means the section keeps its text, whole.
     */
    await settledOnTheEditors()
    server.body = BODY.replace(GOAL, MOVED)

    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))
    const panel = await screen.findByTestId('plan-stale-reconcile')
    fireEvent.click(within(panel).getByRole('button', { name: /^Keep / }))
    await waitFor(() => expect(undecided()).toHaveLength(0))

    // NOTHING that would write to `goal` is left staged — not the row the
    // panel offered, and not the one it superseded. Under `removeRow` the
    // discarded writer proposal came back live here, staged against a section
    // the user had just said to leave alone.
    await waitFor(() =>
      expect(server.draft.filter((r) => r.kind === 'edit' || r.kind === 'accept')).toHaveLength(0),
    )
    expect(JSON.stringify(server.draft)).not.toContain('tightly')
    // The tray had nothing else in it, so there is no longer anything to send.
    expect(screen.queryByTestId('plan-tray')).toBeNull()
    expect(server.rounds).toBe(0)
    // The section still reads what the other agent left there.
    expect(server.sectionText('goal')).toBe(MOVED)
  })
})

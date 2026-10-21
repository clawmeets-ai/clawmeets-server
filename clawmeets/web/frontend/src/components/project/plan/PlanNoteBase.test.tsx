import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * "THE PLAN SAID, WHEN THIS WAS RAISED" — AGAINST THE TRAY, NOT AGAINST THE
 * SERVER.
 *
 * A note's `base_section` is a snapshot of its section, taken when the note was
 * filed. The card quotes it back, and that quote is worth its space only while
 * nothing else on screen still says it — otherwise the reader is being shown
 * the same paragraph twice and asked to notice it is the same.
 *
 * "Nothing else says it" has two halves, and the row's own suite pins the pair
 * as a truth table (`PlanNoteRow.test.tsx`). This file exists for the half that
 * CANNOT be asked of the row: whether the document pane still reads the way the
 * author saw it. The pane renders `pendingText` — the TRAY's staged text
 * whenever the tray holds any — so the honest comparison is against a string
 * only `PlanEditor` has.
 *
 * THE TRAP THIS FILE IS REALLY ABOUT. The obvious implementation is the wire's
 * `note.section_changed`, which the server already computes and ships. It is
 * the server's comparison against what it has STORED, so it stays `false` for
 * the whole time an accepted proposal is sitting in the tray — which is exactly
 * when the pane has stopped saying what the snapshot says, and exactly when the
 * quote becomes the only copy of it. A gate reading the wire would delete the
 * quote at the one moment it is load-bearing, and would do it silently.
 *
 * `planDiffs` chose the same way, in as many words, for step [1] of a note's
 * series. This is that decision, made once more, one div higher.
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

/** The section extents EXACTLY as `sectionText` will slice them back out —
 *  trailing blank line included, because that is what a real `base_section`
 *  snapshot carries and the whole file turns on the two strings matching. */
const GOAL = ['## Goal', '', 'Ship six slides.', '', ''].join('\n')
const RISKS = ['## Risks', '', 'None.', ''].join('\n')
const BODY = `# Project Plan: demo\n\n${GOAL}${RISKS}`

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'risks', heading: 'Risks', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

/** What accepting @content_writer's proposal puts in the tray for `goal`. */
const WRITER_TEXT = ['## Goal', '', 'Ship six slides, tightly.', '', ''].join('\n')
/** …and for `risks`, which the deviation is not about. */
const RISKS_TEXT = ['## Risks', '', 'The venue.', ''].join('\n')

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n-1',
    section: 'goal',
    to: 'user',
    by: 'content_writer',
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

/** A comment-only deviation whose snapshot is EXACTLY what the document says.
 *  No proposal, so its series is empty and the card draws no diff — the quote
 *  is gated on the document alone. */
const DEV = note({
  id: 'n-dev',
  kind: 'deviation',
  by: 'content_writer',
  comment: 'shipped four, the plan says six',
  base_section: GOAL,
})

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

const quote = () => screen.queryByTestId('plan-note-base')

const accept = async (noteId: string) =>
  fireEvent.click(
    within(await screen.findByTestId(`plan-note-acts-${noteId}`)).getByRole('button', {
      name: 'Accept',
    }),
  )

async function mounted() {
  render(createElement(PlanEditor, { projectId: PID, density: 'full' }), { wrapper })
  await screen.findByTestId('plan-body')
}

describe('the snapshot quote, on a section the tray is holding text for', () => {
  it('is absent while the document still says it', async () => {
    server.notes.push(DEV)
    await mounted()
    // The card IS on screen — it just has nothing extra to say.
    await screen.findByTestId('plan-note-acts-n-dev')
    expect(quote()).toBeNull()
  })

  /** THE ASSERTION THE WHOLE FILE IS FOR. Accepting @content_writer's proposal
   *  writes nothing — it stages a row — so the SERVER still has `## Goal / Ship
   *  six slides.` and still reports `section_changed: false` for the deviation.
   *  The pane, meanwhile, is now showing the writer's text. The quote is the
   *  only place the clause the deviation departed from still exists, and it
   *  comes back. */
  it('comes back the moment a staged accept changes what the pane reads', async () => {
    server.notes.push(
      DEV,
      note({ id: 'n-prop', base_section: GOAL, proposal: WRITER_TEXT, has_proposal: true }),
    )
    await mounted()
    expect(quote()).toBeNull()

    await accept('n-prop')
    await screen.findByTestId('plan-tray')

    await waitFor(() => expect(quote()).not.toBeNull())
    expect(quote()!.textContent).toContain('Ship six slides.')

    // AND THE WIRE STILL SAYS NOTHING CHANGED. The amber warning is drawn off
    // `note.section_changed`, and it is not on the card — which is the proof
    // that the quote above it was NOT gated on the same field. Had it been,
    // this is where it would have stayed hidden.
    expect(screen.queryByText(/This section changed since/)).toBeNull()
    expect(server.notes.find((n) => n.id === 'n-dev')!.section_changed).toBe(false)
  })

  /** The other direction, so the gate is pinned as a COMPARISON rather than as
   *  "is the tray non-empty". A staged row for `risks` leaves `goal` reading
   *  exactly as the deviation's author saw it, and the quote stays off. */
  it('stays absent when the tray holds text for some other section', async () => {
    server.notes.push(
      DEV,
      note({
        id: 'n-risk',
        section: 'risks',
        base_section: RISKS,
        proposal: RISKS_TEXT,
        has_proposal: true,
      }),
    )
    await mounted()
    // The editor opens ON the deviation's own section, so the risks note is off
    // this pane entirely until the whole document is showing.
    fireEvent.click(screen.getByRole('button', { name: 'Whole document' }))

    await accept('n-risk')
    await screen.findByTestId('plan-tray')

    // The deviation card IS on screen — this is a quote that is absent, not a
    // card that is.
    expect(screen.getByTestId('plan-note-acts-n-dev')).toBeTruthy()
    expect(quote()).toBeNull()
  })
})

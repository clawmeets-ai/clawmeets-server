import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../../api/client'
import type { PlanSection } from '../../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * THE WINDOW BETWEEN THE WRITE LANDING AND THE SCREEN CATCHING UP.
 *
 * Every other suite in this directory asserts on WHAT WENT ON THE WIRE and on
 * where the screen settles. This one is about the interval in between, which
 * has its own failure mode and which none of them can see: they await the
 * refetch as a matter of course, so the moment the button is wrong has already
 * passed by their first assertion.
 *
 * THE BUG IT PINS. A submit's two halves are read off DIFFERENT payloads.
 * `rows` is local and clears synchronously; `pending` is derived from the
 * REFETCHED plan index (`isPendingNote` ends on `!n.sent`, and `sent` is the
 * server's fact — no local flag mirrors it, deliberately, for the same reason
 * nothing decrements `open_notes_for_you`). `refresh()` invalidates five keys
 * and `user-projects` — a short list, and what the desk card's phase rail reads
 * — comes back before `project-plan`, which carries the whole document. So
 * `setBusy(false)` firing on the POST's return re-armed Send over a tray still
 * rendering notes the server had already sent, next to a rail already reading
 * EXECUTE. Clicking there re-named a sent note and earned a `409`: a red "could
 * not be sent" banner one click after a success.
 *
 * HOW IT IS MADE DETERMINISTIC. The window is real but short, so the fake's
 * `GET …/plan` is gated on a promise the test resolves by hand. That does not
 * manufacture the bug — it holds open the interval the network already
 * produces, and every assertion below is one a user could have hit inside it.
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

const { PlanEditor } = await import('./PlanEditor')

const PID = 'p-1'

const BODY = ['# Project Plan: demo', '', '## Goal', '', 'The keeper writes the plan.', ''].join(
  '\n',
)

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

let server: FakePlanServer
let qc: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, children)

/**
 * Hold every `GET …/plan` AFTER this call until the returned `release` runs.
 *
 * Only the plan index is gated, and that is the point rather than a shortcut:
 * the other four keys `refresh` invalidates are left to resolve at their own
 * speed, which is exactly the ordering the real network produces and the
 * ordering the bug lived in.
 */
function gatePlanFetch(): { release: () => void; released: () => boolean } {
  let open = false
  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = () => {
      open = true
      resolve()
    }
  })
  const realGet = routes.current!.get
  routes.current!.get = async (path: string) => {
    if (path === `/projects/${PID}/plan`) await gate
    return realGet(path)
  }
  return { release: unblock, released: () => open }
}

beforeEach(() => {
  server = new FakePlanServer(BODY, SECTIONS)
  routes.current = routeTo(server, PID)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})

afterEach(() => {
  cleanup()
  qc.clear()
})

async function editorWithPendingNote() {
  // A note YOU wrote, addressed out, filed and not yet delivered — the tray's
  // note half, and the half that survives `setRows([])`.
  server.notes = [
    {
      id: 'n1',
      section: 'goal',
      to: 'backend',
      by: 'user',
      at: 't',
      status: 'open',
      kind: 'note',
      comment: 'who decided this?',
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
    },
  ]
  const view = render(createElement(PlanEditor, { projectId: PID, density: 'compact' }), { wrapper })
  await screen.findByTestId('plan-body')
  await screen.findByTestId('plan-tray')
  return view
}

function send() {
  return screen.getByRole('button', { name: /^(Send review|Sending)/ })
}

describe('the tray stays shut between the write landing and the index catching up', () => {
  it('Send stays disabled while the payload it is read from is still in flight', async () => {
    await editorWithPendingNote()
    const gate = gatePlanFetch()

    fireEvent.click(screen.getByRole('button', { name: 'Send review · 1' }))

    // The WRITE is done: the server has marked the note sent and written to
    // @backend. This is the exact instant the rail flips to EXECUTE off the
    // shorter `user-projects` payload.
    await waitFor(() => expect(server.notes[0].sent).toBe(true))
    expect(server.messages).toEqual([{ to: 'backend', round: 'r-1' }])

    // …and the index the tray reads has NOT landed, so the tray is still up
    // with the sent note in it. The button must not be offering to send it
    // again. Before the fix it read `Send review · 1` and was live here.
    expect(gate.released()).toBe(false)
    expect(screen.getByTestId('plan-tray')).toBeTruthy()
    expect(send().textContent).toBe('Sending…')
    expect((send() as HTMLButtonElement).disabled).toBe(true)

    gate.release()

    // The index lands, the note is no longer pending, and the tray goes with
    // it — the settled state the other suites assert, reached the same way.
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
  })

  it('a click inside that window cannot reach the route a second time', async () => {
    // The consequence, stated as behaviour rather than as an attribute: the
    // second submit is what earned the `409` and the red banner. `messages`
    // counts deliveries, so a re-send is visible even if the refusal were
    // swallowed.
    await editorWithPendingNote()
    const gate = gatePlanFetch()

    fireEvent.click(screen.getByRole('button', { name: 'Send review · 1' }))
    await waitFor(() => expect(server.notes[0].sent).toBe(true))

    fireEvent.click(send())
    fireEvent.click(send())

    gate.release()
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())

    expect(server.rounds).toBe(1)
    expect(server.messages).toEqual([{ to: 'backend', round: 'r-1' }])
    expect(screen.queryByText(/already out/)).toBeNull()
  })

  it('Discard cannot run underneath the submit that is writing the tray', async () => {
    /**
     * THE SAME SHAPE ON A DIFFERENT WINDOW, and the window is the earlier one.
     * `Discard` clears the rows and fires `DELETE …/plan/draft`; run under the
     * `PUT …/plan/draft` a submit opens with, it deletes the tray the submit is
     * mid-way through writing and the two race for the server's copy. That
     * window is between the click and the POST returning — by the time the
     * refetch is outstanding `setRows([])` has already emptied the row half, so
     * this one gates the REVIEW call rather than the index.
     */
    server.notes = []
    // The FULL mount here, and only because its section rail is a nav of
    // buttons where the compact one collapses to a <select> — the shortest way
    // to reach `Edit raw Markdown` and stage a row. Discard is the same button
    // on both, rendered by the same `PlanTray`.
    render(createElement(PlanEditor, { projectId: PID, density: 'full' }), { wrapper })
    await screen.findByTestId('plan-body')
    fireEvent.click(await screen.findByRole('button', { name: /^Goal/ }))
    fireEvent.click(await screen.findByText('Edit raw Markdown'))
    fireEvent.change(await screen.findByLabelText('Raw Markdown for Goal'), {
      target: { value: '## Goal\n\nThe keeper writes it differently.\n' },
    })
    fireEvent.click(screen.getByText('Stage this section'))
    const tray = await screen.findByTestId('plan-tray')
    expect((within(tray).getByText('Discard tray') as HTMLButtonElement).disabled).toBe(false)

    let letReviewLand = () => {}
    const held = new Promise<void>((resolve) => {
      letReviewLand = resolve
    })
    const realPost = routes.current!.post
    routes.current!.post = async (path: string, body?: unknown) => {
      if (path === `/projects/${PID}/plan/review`) await held
      return realPost(path, body)
    }

    fireEvent.click(screen.getByRole('button', { name: /^Send review/ }))

    // Mid-submit: the draft has been PUT and the review has not come back.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(screen.getByRole('button', { name: /^Sending/ })).toBeTruthy()
    const discard = screen.getByRole('button', { name: 'Discard tray' })
    expect((discard as HTMLButtonElement).disabled).toBe(true)
    // And it is disabled in the sense that matters — clicking does nothing.
    fireEvent.click(discard)
    expect(server.draft).toHaveLength(1)

    letReviewLand()
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
    expect(server.revision).toBe(2)
  })

  it('a refetch that FAILS still settles the submit rather than hanging it', async () => {
    /**
     * THE BOUND THE FIX RESTS ON, and the reason `refresh` carries no `.catch`.
     *
     * Waiting on a refetch is only safe if the wait always ends.
     * `invalidateQueries` delegates to `refetchQueries`, which swallows each
     * query's error itself, so this resolves on a 503 exactly as it does on a
     * 200 and `setBusy(false)` is reached either way. Nothing is caught here
     * because nothing is thrown here.
     *
     * The editor's own error gate is the second layer and is what the user
     * actually sees: a plan query in `error` replaces the whole component, so
     * there is no stranded Send to find even in the case this test rules out.
     * Asserting on the settled screen is how the hanging await is detected —
     * an await that never resolved would leave the pane on its last good
     * render, not on the error one.
     */
    await editorWithPendingNote()
    const realGet = routes.current!.get
    routes.current!.get = async (path: string) => {
      if (path === `/projects/${PID}/plan`) throw new ApiError(503, 'the index is unavailable')
      return realGet(path)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Send review · 1' }))

    // The write landed once and only once.
    await waitFor(() => expect(server.notes[0].sent).toBe(true))
    expect(server.messages).toEqual([{ to: 'backend', round: 'r-1' }])

    // …and the screen moved on rather than sitting in `Sending…` forever.
    expect(await screen.findByText('The plan could not be loaded.')).toBeTruthy()
    expect(screen.queryByTestId('plan-tray')).toBeNull()
  })
})

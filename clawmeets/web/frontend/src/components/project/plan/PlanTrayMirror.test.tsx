import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DraftEntry, PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * THE TRAY IS A MIRROR OF THE SERVER'S, NOT A COPY TAKEN ONCE.
 *
 * THE BUG IT PINS, and it was reported from a real desk. The user staged three
 * rows, pressed `Send review · 3`, the review went out and the coordinator
 * started working — and the tray still showed all three rows under a live
 * `Send review · 3`. The plan sidecar said the send had landed: `draft: null`,
 * one round, three sends. Only the browser disagreed, and it disagreed forever.
 *
 * WHAT MADE IT REACHABLE IS THE SUBMIT ITSELF. `POST …/plan/review` opens the
 * `PendingWork` batch inside `submit_review`, which pushes `ACTIVE_WORK_CHANGE`;
 * `useDeskUpdates` flips the card's lane to `progress` on that envelope alone;
 * `DeskPage` renders Review and Working as two separate lists, so the card
 * becomes a new element and the whole editor unmounts — all of it BEFORE the
 * POST's own response comes back. The success branch's `setRows([])` then lands
 * on a dead component, and the fresh mount hydrated off the react-query cache,
 * which still held the pre-submit draft. Under a one-shot `hydrated` latch that
 * was the end of the story: a refetch could never replace those rows.
 *
 * SO THE TEST UNMOUNTS MID-SUBMIT, which is not a contrivance — it is the one
 * thing the product does on every successful send from the desk. The
 * `QueryClient` here keeps react-query's DEFAULT `gcTime` for the same reason:
 * `gcTime: 0`, which the sibling suites use, drops the cache on unmount and
 * would quietly delete the stale payload the bug is made of.
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

const BODY = [
  '# Project Plan: demo',
  '',
  '## Goal',
  '',
  'The keeper writes the plan.',
  '',
  '## Guardrails',
  '',
  'Do not break it.',
  '',
].join('\n')

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'guardrails', heading: 'Guardrails', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n',
    section: 'goal',
    to: 'user',
    by: 'coordinator',
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
  }
}

function row(over: Partial<DraftEntry>): DraftEntry {
  return {
    id: 'r',
    kind: 'dismiss',
    section: 'goal',
    text: '',
    base: '',
    note_id: 'n1',
    comment: '',
    to: '',
    at: 't',
    ...over,
  }
}

/** The desk's own batch, as it stood when the report came in: one dismissal and
 *  two replies, against three notes the coordinator addressed to the user. */
function threeStagedRows() {
  server.notes = [
    note({ id: 'n1', section: 'guardrails' }),
    note({ id: 'n2', section: 'goal' }),
    note({ id: 'n3', section: 'goal' }),
  ]
  server.draft = [
    row({ id: 'r1', kind: 'dismiss', section: 'guardrails', note_id: 'n1' }),
    row({ id: 'r2', kind: 'ask', section: 'goal', note_id: 'n2', comment: 'follow your recommendation', to: 'coordinator' }),
    row({ id: 'r3', kind: 'ask', section: 'goal', note_id: 'n3', comment: 'fix all five', to: 'coordinator' }),
  ]
}

let server: FakePlanServer
let qc: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, children)

beforeEach(() => {
  server = new FakePlanServer(BODY, SECTIONS)
  routes.current = routeTo(server, PID)
  // DEFAULT `gcTime` ON PURPOSE — see the file header. Only `retry` is pinned.
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  cleanup()
  qc.clear()
})

function editor() {
  return render(createElement(PlanEditor, { projectId: PID, density: 'compact' }), { wrapper })
}

function send() {
  return screen.getByRole('button', { name: /^(Send review|Sending)/ })
}

/** Hold every `GET …/plan` issued after this call until `release` runs, so the
 *  interval where the cache is the only payload a new mount has is long enough
 *  to unmount and remount inside. */
function gatePlanFetch(): { release: () => void } {
  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const realGet = routes.current!.get
  routes.current!.get = async (path: string) => {
    if (path === `/projects/${PID}/plan`) await gate
    return realGet(path)
  }
  return { release: unblock }
}

describe('a tray the user has not touched follows the server tray', () => {
  it('a mount that appears mid-submit does not keep the batch that submit sent', async () => {
    threeStagedRows()
    editor()
    await screen.findByTestId('plan-tray')
    expect(send().textContent).toBe('Send review · 3')

    const gate = gatePlanFetch()
    fireEvent.click(send())

    // The write has landed: one round out, and the server tray is empty. This
    // is the instant `ACTIVE_WORK_CHANGE` reaches the desk in production.
    await waitFor(() => expect(server.rounds).toBe(1))
    expect(server.draft).toEqual([])

    // The lane move, which is the only part of the desk this suite models: the
    // card changes list, so the editor is unmounted and a new one is mounted
    // against the same cache while the plan index is still in flight.
    cleanup()
    editor()

    gate.release()

    // The tray is GONE. Before the fix the new mount latched the three rows out
    // of the stale cache and the payload that arrived next — carrying no draft
    // at all — could not take them back.
    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
    // And the batch was never offered a second time.
    expect(server.rounds).toBe(1)
  })

  it('a draft that goes away under an untouched tray takes the tray with it', async () => {
    // The same property without a submit anywhere near it: another tab sent the
    // batch, or discarded it. This mount owns none of these rows, so it has no
    // claim on them.
    threeStagedRows()
    editor()
    await screen.findByTestId('plan-tray')
    expect(send().textContent).toBe('Send review · 3')

    server.draft = []
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['project-plan', PID] })
    })

    await waitFor(() => expect(screen.queryByTestId('plan-tray')).toBeNull())
  })

  it('but a row THIS client staged survives a payload that does not carry it', async () => {
    // AC-6.7, and the reason the mirror is gated on ownership rather than on
    // being merely un-submitted. `persist` is fire-and-forget, so a sync can
    // always overtake the `PUT` that mirrors a freshly staged row — and a
    // refetch that discarded the user's staged text would be a worse bug than
    // the one this file exists for.
    server.notes = [note({ id: 'n1', section: 'guardrails' })]
    editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await screen.findByTestId('plan-tray')
    await waitFor(() => expect(server.draft).toHaveLength(1))

    // A payload that predates the `PUT`: no draft on it at all.
    server.draft = []
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['project-plan', PID] })
    })

    expect(screen.getByTestId('plan-tray')).toBeTruthy()
    expect(send().textContent).toBe('Send review · 1')
  })
})

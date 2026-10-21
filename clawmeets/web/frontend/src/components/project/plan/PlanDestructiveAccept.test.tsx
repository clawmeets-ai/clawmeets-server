import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { useAuthStore } from '../../../stores/authStore'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * THE ONE ACCEPT THAT DESTROYS SOMETHING.
 *
 * A refused DELETE reaches the desk as a note whose `proposal` is empty and
 * whose `proposes_delete` is true, and the server folds that flag into
 * `has_proposal` — so it renders EXACTLY the same `Accept` as a text proposal.
 * `proposes_delete` had been on the wire since it was added and was read nowhere
 * in this app, so one click removed a whole section with no confirmation and
 * nothing that put it back. On the incident this was written for that was a
 * 17,705-character `## Milestones` carrying four milestones and 27 acceptance
 * criteria, and the note's own sentence — since corrected — told the user there
 * was nothing to accept.
 *
 * Driven through the editor rather than `PlanNoteRow` in isolation, because the
 * guard is deliberately NOT on the row: it sits at the top of `onAccept`, above
 * the two collision branches, which can stage the row later without passing back
 * through the row's handler at all.
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
const OWNER = 'u-1'

const GUARDRAILS = ['## Guardrails', '', '- No new dependency.', ''].join('\n')
const BODY = [
  '# Project Plan: demo',
  '',
  '## Goal',
  '',
  'Ship the thing.',
  '',
  GUARDRAILS,
  '## Approval',
  '',
  '_Not yet approved._',
  '',
].join('\n')

const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'guardrails', heading: 'Guardrails', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'approval', heading: 'Approval', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n-1',
    section: 'guardrails',
    to: 'user',
    by: 'alice-devops',
    at: 't',
    status: 'open',
    kind: 'deviation',
    layer: 'spec',
    comment: 'Accept it and `guardrails` is DELETED from the plan.',
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

let server: FakePlanServer
let qc: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: qc }, children)

function signIn(id: string | null) {
  useAuthStore.setState({
    user: id
      ? { id, username: 'reader', created_at: '2026-01-01T00:00:00Z' }
      : null,
  })
}

beforeEach(() => {
  server = new FakePlanServer(BODY, SECTIONS)
  routes.current = routeTo(server, PID)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  signIn(OWNER)
})

afterEach(() => {
  cleanup()
  qc.clear()
  signIn(null)
})

async function editorWith(n: PlanNote) {
  server.notes.push(n)
  const view = render(
    createElement(PlanEditor, { projectId: PID, density: 'full' }),
    { wrapper },
  )
  await screen.findByTestId('plan-acceptance')
  return view
}

const deleteNote = () =>
  note({ proposes_delete: true, base_section: GUARDRAILS, display_diff: '-## Guardrails' })

describe('an Accept that deletes a section asks first', () => {
  it('renders the same Accept as any proposal, so the guard cannot live on the button', async () => {
    await editorWith(deleteNote())
    // The premise. If this ever goes back to being withheld, the confirm below
    // is dead code and the note is undecidable again — which is the bug
    // `proposes_delete` was added to fix.
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeTruthy()
  })

  it('stages nothing when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await editorWith(deleteNote())
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

    expect(confirm).toHaveBeenCalledTimes(1)
    const asked = confirm.mock.calls[0][0] as string
    expect(asked).toContain('DELETES')
    expect(asked).toContain('guardrails')
    expect(asked).toContain('cannot be undone')
    // The section's size is in the question, because "a section" and "17,705
    // characters" are different decisions.
    expect(asked).toContain(String(GUARDRAILS.length))

    // NOTHING STAGED AND NOTHING PUT. The tray is the whole of the outcome
    // here: `onAccept` returns before `acceptRow`, so there is no row to
    // persist and no `PUT /plan/draft` to make.
    expect(screen.queryByTestId('plan-tray')).toBeNull()
    expect(server.draft).toHaveLength(0)
  })

  it('stages exactly one accept row when it is confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await editorWith(deleteNote())
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

    expect(confirm).toHaveBeenCalledTimes(1)
    // THE ROW IS ON ITS COMMENT, not in the tray: a decision is drawn on the
    // note it decides, and the tray is the send bar.
    const list = await screen.findByTestId('plan-comment-list')
    const staged = list.querySelectorAll('[data-row-kind="accept"]')
    expect(staged).toHaveLength(1)
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].section).toBe('guardrails')
    // The row a delete stages is `text: ''` — that is what `replace_section`
    // applies as a removal, and it is why the question above had to be asked.
    expect(server.draft[0].text).toBe('')
  })

  it('does not ask on an ordinary text proposal', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await editorWith(
      note({
        proposal: '## Guardrails\n\n- One new dependency.\n',
        base_section: GUARDRAILS,
        display_diff: '+- One new dependency.',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

    expect(confirm).not.toHaveBeenCalled()
    const list = await screen.findByTestId('plan-comment-list')
    expect(list.querySelectorAll('[data-row-kind="accept"]')).toHaveLength(1)
  })
})

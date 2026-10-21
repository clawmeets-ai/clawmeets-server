import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { useAuthStore } from '../../../stores/authStore'
import { FakePlanServer, routeTo } from './planTestServer'

/**
 * ACCEPTANCE, AFTER BOTH BUTTONS WERE DELETED.
 *
 * THE STRIP IS A READOUT AND POSTS NOTHING. Approve went first — accepting a
 * plan is accepting the go-note the server files against `## Approval`, in the
 * tray, with the same Accept every other proposal note has. Revoke followed it,
 * because an accepted plan is not un-decided: it is renegotiated by applying the
 * next note. So the suite drives an approval END TO END THROUGH THE TRAY and
 * then asserts there is no second door in EITHER direction — no control on the
 * strip at all, at either density, accepted or not.
 *
 * AND ACCEPTANCE FOLLOWS THE DOCUMENT, which is what replaced the undo. Every
 * owner-applied note re-stamps, so the chip tracks the plan instead of freezing
 * at the revision the go-note closed on, and *"the plan changed since
 * approval"* comes to mean the one thing it can still mean: it moved WITHOUT
 * you. Asserted here as a round trip, because a frozen revision renders
 * perfectly and only a second apply can catch it.
 *
 * REJECT AND DISMISS ARE NOT OFFERED ON THE GO-NOTE, and that is a safety
 * property rather than a tidiness one: the execution gate counts notes that are
 * OPEN, so every close releases the coordinator and only one of them means yes.
 *
 * Driven through the whole editor rather than the component in isolation, for
 * the claims that only exist in relation to everything else.
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

/** THE SEED SHAPE, INCLUDING `## Approval`. That section is not decoration
 *  here: the go-note is a proposal LOCATED BY HEADING, so a document without it
 *  gives the note nothing to apply to and the editor correctly reads the
 *  section as having moved. A fixture that left it out would be testing a plan
 *  the server refuses to leave in that state. */
const BODY = [
  '# Project Plan: demo',
  '',
  '## Goal',
  '',
  'Ship the thing.',
  '',
  '## Approval',
  '',
  '_Not yet approved._',
  '',
].join('\n')
const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  { id: 'approval', heading: 'Approval', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n',
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

/** Who is reading. The control compares the EFFECTIVE principal against
 *  `project.created_by`, so the identity is set where the app sets it rather
 *  than mocked at the hook — the hook is the app's one answer to "whose data is
 *  this?" and stubbing it would stop testing that this control asks it. */
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

async function editor(density: 'full' | 'compact' = 'full') {
  const view = render(createElement(PlanEditor, { projectId: PID, density }), { wrapper })
  await screen.findByTestId('plan-acceptance')
  // ONE QUERY, AND THE WAIT IS THE WHOLE OF IT. This used to wait on the
  // `['project', PID]` payload as well, because the strip compared the reader
  // against `created_by` to decide whether Revoke was live. There is no control
  // and no comparison now — the strip renders off `PlanIndex` alone — so that
  // query is never fetched and waiting on it would hang forever.
  return view
}

/** Every button ON THE STRIP — the assertion this suite makes most often is
 *  that there are none, and a name-based query can only rule out the names it
 *  is given. */
const stripButtons = () =>
  within(screen.getByTestId('plan-acceptance')).queryAllByRole('button')

/** Approve the plan the way the app does: dismiss the confirm note, then
 *  submit. `Dismiss` and not `Accept` — the note carries no proposal, so there
 *  is nothing to accept and the server refuses every verb but this one. */
async function acceptViaGoNote() {
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
  fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
  await waitFor(() => expect(server.accepted).toBe(true))
}

describe('AC-2.18 — the readout, and nothing on it is clickable', () => {
  it('accepted state drives the strip, at BOTH densities, with no control in either state', async () => {
    for (const density of ['full', 'compact'] as const) {
      await editor(density)
      // UNACCEPTED: no control, and NO POINTER EITHER. The strip used to carry
      // a sentence naming where the act was ("accept the approval note below —
      // it writes 'User approves the plan.' into this plan's Approval
      // section"): three lines of mechanism, above the fold, about a control
      // the reader could not see from here. The confirm note now says what
      // dismissing it does, in its own row, where the click is.
      expect(stripButtons()).toHaveLength(0)
      expect(screen.getByTestId('plan-accepted').textContent).toBe('Not accepted')
      expect(screen.queryByTestId('plan-approve-pointer')).toBeNull()
      cleanup()
      qc.clear()
    }
    server.accepted = true
    server.acceptedRevision = 1
    for (const density of ['full', 'compact'] as const) {
      await editor(density)
      // ACCEPTED: still no control. This is the state that used to carry
      // Revoke, so it is the one most likely to grow a button back.
      expect(stripButtons()).toHaveLength(0)
      expect(screen.getByTestId('plan-accepted').textContent).toBe('Accepted at revision 1')
      expect(screen.queryByTestId('plan-approve-pointer')).toBeNull()
      // `density` picks the LAYOUT and never whether something exists — the
      // moment it did, the desk mount would be a fork rather than the same
      // component.
      expect(screen.getByTestId('plan-acceptance').className).toContain(
        density === 'compact' ? 'plan-approve--compact' : 'plan-approve',
      )
      cleanup()
      qc.clear()
    }
  })

  it('the changed-since warning renders on the strip, where the reader is already looking', async () => {
    server.accepted = true
    server.acceptedRevision = 1
    const idx = server.index.bind(server)
    server.index = () => ({ ...idx(), changed_since_acceptance: true })
    await editor('compact')
    const strip = screen.getByTestId('plan-acceptance')
    expect(within(strip).getByTestId('plan-changed-since').textContent).toContain(
      'The plan changed since approval',
    )
    // The desk mount never had this warning at all before the move.
    expect(strip.closest('[data-density="compact"]')).toBeTruthy()
    // It is a statement, not an invitation: there is nothing here to press.
    expect(stripButtons()).toHaveLength(0)
  })
})

/**
 * THE PERMISSION QUESTION IS GONE FROM THIS STRIP, AND ONLY FROM THIS STRIP.
 *
 * It used to ask whether the reader could decide, so it could disable Revoke
 * with a reason rather than offer a button that 403s. With no control there is
 * nothing to gate, and the strip does not read the project payload at all — it
 * takes no `projectId`, which is the tell.
 *
 * The right to decide did not go anywhere: it moved WHOLE to the tray, where
 * `may_decide` gates Accept on the go-note and on every note after it. What is
 * asserted here is the half that is this file's — that the readout is for every
 * reader, and that a non-owner is not shown a control they would be refused for
 * pressing, because nobody is shown one.
 */
describe('AC-2.19 — every reader sees the state, no reader sees a control', () => {
  it('a reader who is not the owner gets the chip and nothing to press', async () => {
    server.accepted = true
    server.acceptedRevision = 1
    signIn('someone-else')
    await editor()
    expect(screen.getByTestId('plan-accepted').textContent).toBe('Accepted at revision 1')
    expect(stripButtons()).toHaveLength(0)
  })

  it('an unauthenticated reader gets the same readout, and still nothing to press', async () => {
    // The old control compared two ids and `undefined === undefined` would have
    // handed it to a stranger. There is no comparison left to get wrong.
    server.accepted = true
    server.acceptedRevision = 1
    signIn(null)
    server.createdBy = ''
    await editor()
    expect(screen.getByTestId('plan-accepted').textContent).toBe('Accepted at revision 1')
    expect(stripButtons()).toHaveLength(0)
  })
})

describe('AC-2.23 — approving is dismissing the confirm note, and there is no second door', () => {
  it('dismissing the confirm note and submitting is what accepts the plan', async () => {
    server.notes = [server.goNote()]
    await editor()
    expect(screen.getByTestId('plan-accepted').textContent).toBe('Not accepted')
    const bodyBefore = server.body

    await acceptViaGoNote()

    // The note closed as DISMISSED, and the strip now reads the plan back as
    // accepted — one act, reported on both surfaces.
    expect(server.notes[0].status).toBe('dismissed')
    // REVISION 1, AND THAT IS THE CHANGE. Accepting used to WRITE the document
    // — `## Approval` stopped saying "not yet approved" — so the batch carried
    // a write, §2.5 incremented, and the stamp had to be taken against the text
    // the write LEFT. Confirming writes nothing now, so the batch lands at the
    // revision it started from and the two bodies are the same body.
    expect(await screen.findByTestId('plan-accepted')).toHaveProperty(
      'textContent',
      'Accepted at revision 1',
    )
    expect(server.body).toBe(bodyBefore)
  })

  it('there is NO Approve control anywhere on the editor, at either density', async () => {
    // The regression this guards is a second door onto one act, three inches
    // from the first: an Approve button on the strip AND the act on the note.
    for (const density of ['full', 'compact'] as const) {
      server.notes = [server.goNote()]
      await editor(density)
      expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Confirm$/ })).toBeNull()
      // ...and the one control that IS the act lives in the note's own row.
      const dismiss = screen.getByRole('button', { name: 'Dismiss' })
      expect(dismiss.closest('.plan-note-acts')).toBeTruthy()
      cleanup()
      qc.clear()
    }
  })

  it('ACCEPT AND REJECT ARE NOT OFFERED ON THE CONFIRM NOTE — only Dismiss and Reply', async () => {
    // **THE INVERSION.** The gate counts notes that are OPEN, so EVERY close
    // releases the coordinator and only one of them means yes. That close used
    // to be Accept, because the note was a proposal against `## Approval` and
    // saying yes meant applying its diff; Dismiss was withheld for the same
    // reason Reject is. There is no section and no diff now, so Dismiss — the
    // verb already on every other row — is the act, and Accept goes onto the
    // withheld list beside Reject: a proposal-less accept would close the note
    // `applied`, release the gate, and never stamp the acceptance.
    //
    // Accept and Reject need no flag to be withheld here — both are gated on
    // `has_proposal`, which is false — but the flag stays on Reject because the
    // reason is the gate rather than the absent diff.
    //
    // Saying no is a Reply, which reaches the coordinator and leaves the gate up.
    server.notes = [server.goNote()]
    await editor()
    const acts = await screen.findByTestId(`plan-note-acts-${server.notes[0].id}`)
    expect(within(acts).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    expect(within(acts).queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(within(acts).queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(within(acts).getByRole('button', { name: /Reply/ })).toBeTruthy()
  })

  it('an ORDINARY proposal note still offers all four — the exemption is one flag wide', async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user', kind: 'proposal', has_proposal: true, proposal: 'x' })]
    await editor()
    const acts = await screen.findByTestId('plan-note-acts-n1')
    expect(within(acts).getByRole('button', { name: 'Accept' })).toBeTruthy()
    expect(within(acts).getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(within(acts).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })
})

/**
 * ACCEPTANCE FOLLOWS THE DOCUMENT — WHAT REPLACED THE UNDO.
 *
 * With Revoke deleted the stamps only ever move forward, so if they moved only
 * ONCE the chip would freeze at the revision the go-note closed on and every
 * later change would read as unapproved drift. The owner applying a deviation
 * note is the DESIGNED way an accepted spec changes: a keeper's own attempt is
 * refused and filed as one. So applying it re-stamps, and the amber clears.
 *
 * Driven as a ROUND TRIP rather than off a hand-set index, because a frozen
 * revision renders perfectly — only a second apply can catch it.
 */
describe('AC-2.24 — every owner apply re-signs the plan', () => {
  it('applying a later proposal advances the chip and clears the changed-since warning', async () => {
    server.notes = [server.goNote()]
    await editor()
    await acceptViaGoNote()
    expect(await screen.findByTestId('plan-accepted')).toHaveProperty(
      'textContent',
      'Accepted at revision 1',
    )

    // The plan now moves under the acceptance — exactly what a deviation is.
    // `changed_since_acceptance` is a DIGEST comparison the server makes and
    // the fake does not model, so it is driven from here: true while the
    // deviation is outstanding, false once the owner has signed it off.
    let drifted = true
    const idx = server.index.bind(server)
    server.index = () => ({ ...idx(), changed_since_acceptance: drifted })
    server.notes = [
      ...server.notes,
      note({
        id: 'n-dev',
        section: 'goal',
        by: 'backend',
        to: 'user',
        kind: 'deviation',
        has_proposal: true,
        proposal: '## Goal\n\nShip a different thing.\n',
        base_section: '## Goal\n\nShip the thing.\n',
      }),
    ]
    qc.clear()
    cleanup()
    await editor()
    expect(screen.getByTestId('plan-changed-since')).toBeTruthy()

    // The owner signs it off — an ordinary Accept on an ordinary proposal,
    // which is where the confirmation and every later decision now differ: the
    // confirm note has no diff and is dismissed, this one has a diff and is
    // accepted. Applying it writes, so the revision moves.
    drifted = false
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(server.acceptedRevision).toBe(2))

    // THE CHIP TRACKS THE DOCUMENT, not the first acceptance...
    await waitFor(() =>
      expect(screen.getByTestId('plan-accepted').textContent).toBe('Accepted at revision 2'),
    )
    // ...and the warning is gone, because the drift it named was consented to.
    await waitFor(() => expect(screen.queryByTestId('plan-changed-since')).toBeNull())
    // Still nothing to press. Re-signing is the tray's act, not the strip's.
    expect(stripButtons()).toHaveLength(0)
  })
})

describe('AC-2.20 — the strip does not ride the batch, and does not write outside it either', () => {
  it('renders beside a pending tray without touching it — it has no write of its own', async () => {
    server.accepted = true
    server.acceptedRevision = 1
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor()
    // A real, pending batch sitting underneath.
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.draft).toHaveLength(1))
    const before = JSON.stringify(server.draft)

    // NOTHING TO CLICK, which is the assertion. The strip used to carry a write
    // that posted on the click, and the property this block defended was that it
    // neither joined nor discarded the batch below it. That property is now
    // structural: no control, no route, no outcome slots of its own.
    expect(stripButtons()).toHaveLength(0)
    expect(screen.queryByRole('status')).toBeNull()

    expect(server.rounds).toBe(0)
    expect(server.messages).toEqual([])
    expect(JSON.stringify(server.draft)).toBe(before)
    expect(screen.getByTestId('plan-tray')).toBeTruthy()
    expect(server.notes[0].status).toBe('open')
  })

  it('sits OUTSIDE the tray and outside the note action bar whose help line it would falsify', async () => {
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor()
    const strip = await screen.findByTestId('plan-acceptance')
    expect(strip.closest('[data-testid="plan-tray"]')).toBeNull()
    expect(strip.closest('.plan-note-acts')).toBeNull()
    // ...and that bar's promise is still literally true of everything in it.
    const acts = await screen.findByTestId('plan-note-acts-n1')
    expect(acts.contains(strip)).toBe(false)
    expect(acts.textContent).toContain('nothing reaches the plan or its addressees until you submit')
  })

  it('a failed submit is reported by the EDITOR, and the strip says nothing at all', async () => {
    // There used to be two writes on two routes here, each with its own outcome
    // slot, and the property was that one failing did not clear the other's
    // notice. One of the two is gone, so the property collapses into a simpler
    // one worth keeping: the strip has no outcome slot to be confused with the
    // editor's, and a failed batch leaves the acceptance readout untouched.
    const { ApiError } = await import('../../../api/client')
    server.accepted = true
    server.acceptedRevision = 1
    server.notes = [note({ id: 'n1', by: 'backend', to: 'user' })]
    await editor()

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    server.failNextSubmit = new ApiError(500, 'the batch could not be sent')
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('the batch could not be sent')
    // The failure belongs to the editor, not to the strip.
    expect(within(screen.getByTestId('plan-acceptance')).queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('plan-accepted').textContent).toBe('Accepted at revision 1')
  })
})

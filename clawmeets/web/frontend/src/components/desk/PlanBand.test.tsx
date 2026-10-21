import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanNote, PlanSection, PlanSummary } from '../../api/endpoints/projectPlans'
import { FakePlanServer, routeTo } from '../project/plan/planTestServer'

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

vi.mock('../project/plan/PlanDiff', () => ({
  PlanDiff: ({ text }: { text: string }) =>
    createElement('pre', { 'data-testid': 'plan-diff' }, text),
}))

const { PlanBand } = await import('./PlanBand')
const { ProjectPlanTab } = await import('../project/ProjectPlanTab')
const { useAuthStore } = await import('../../stores/authStore')

const PID = 'p-1'

const BODY = ['# Project Plan: demo', '', '## Goal', 'Ship the thing.', ''].join('\n')
const SECTIONS: PlanSection[] = [
  { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
]

function note(over: Partial<PlanNote>): PlanNote {
  return {
    id: 'n',
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
  // The Approve control compares the logged-in user against the project's
  // owner, so the desk reader has to BE someone for AC-2.7 to mean anything.
  useAuthStore.setState({
    user: {
      id: server.createdBy,
      username: 'owner',
      created_at: '2026-01-01T00:00:00Z',
    },
  })
})

afterEach(() => {
  cleanup()
  qc.clear()
  useAuthStore.setState({ user: null })
})

function band(plan: PlanSummary | null) {
  return render(createElement(PlanBand, { plan, projectId: PID }), { wrapper })
}

describe('the band renders nothing where there is nothing to render', () => {
  it('no plan at all — absence is the signal, not a sentinel', () => {
    const { container } = band(null)
    expect(container.textContent).toBe('')
  })

  it('a FRONT-DESK shape gets no plan surface whatsoever', () => {
    // There is no user in the accepting role on that shape, which is exactly
    // why four of the seven members arrive null.
    server.surface = 'frontdesk'
    const { container } = band(server.summary())
    expect(container.textContent).toBe('')
  })
})

describe('F-1 — four members are null iff frontdesk, and 0 is never a revision', () => {
  it('a front-desk summary nulls phase, revision, accepted and accepted_revision', () => {
    server.surface = 'frontdesk'
    server.notes = [note({ id: 'a' })]
    const s = server.summary()
    expect(s.phase).toBeNull()
    expect(s.revision).toBeNull()
    expect(s.accepted).toBeNull()
    expect(s.accepted_revision).toBeNull()
    // The one member that is never null on any shape: a front-desk plan still
    // collects notes for the user, and the number that stops work may not
    // arrive as null.
    expect(s.open_notes_for_you).toBe(1)
  })

  it('`accepted_revision` is null BEFORE acceptance and never 0', () => {
    expect(server.summary().accepted_revision).toBeNull()
    server.accepted = true
    server.acceptedRevision = 1
    expect(server.summary().accepted_revision).toBe(1)
    // `0` is a sentinel the sidecar keeps internally; revisions start at 1.
    expect(server.summary().accepted_revision).not.toBe(0)
  })

  it('the band NULL-CHECKS phase rather than switching on it', () => {
    // A summary whose phase is absent must render the band without printing
    // `undefined` where a lifecycle word belongs.
    const s = { ...server.summary(), phase: null }
    band(s)
    expect(screen.getByTestId('plan-band')).toBeTruthy()
    expect(screen.queryByTestId('plan-band-phase')).toBeNull()
    expect(screen.getByTestId('plan-band').textContent).not.toContain('undefined')
  })
})

/* THE ALARM IS THE EDITOR'S NOW, AND THAT IS WHY THESE THREE AWAIT.
 *
 * They used to assert synchronously, because the callout rendered off the
 * `plan` PROP this file hands the band. `PlanEditor` renders it off
 * `GET …/plan` instead — one alarm for both mounts rather than a desk copy — so
 * it lands on the query's tick. Same coverage, one keyword: what is asserted
 * about the alarm below is unchanged, including that the summary member it used
 * to read carries no `status`, because `openDeviation` and the server's
 * `_open_deviation` are written to the same rule and this file drives BOTH
 * through one fake server. */
describe('the deviation callout — presence IS the predicate', () => {
  const dev = note({
    id: 'n-dev',
    kind: 'deviation',
    comment: 'shipped 4 slides, the plan says 6',
    section: 'goal',
    base_section: '## Goal\nShip six slides.\n',
  })

  it('renders against a payload that omits `status` entirely', async () => {
    server.notes = [dev]
    const summary = server.summary()
    // The wire shape carries FIVE members and no `status`. A client testing
    // `deviation.status === "open"` compares undefined and the callout
    // silently never renders.
    expect(Object.keys(summary.deviation!).sort()).toEqual([
      'base_section',
      'by',
      'comment',
      'id',
      'section',
    ])
    band(summary)
    expect(await screen.findByTestId('plan-comment-list')).toBeTruthy()
  })

  it('all five members are rendered or acted on — none is orphaned', async () => {
    server.notes = [dev]
    band(server.summary())
    const el = await screen.findByTestId('plan-comment-list')
    const row = within(el).getByTestId('plan-comment-row')
    expect(row.dataset.commentId).toBe('n-dev') // id: what a click routes to
    expect(row.textContent).toContain('@content_writer') // by: who noticed
    expect(row.textContent).toContain('shipped 4 slides') // comment: summarised
    expect(row.textContent).toContain('goal') // section: the locator
    // `base_section` MOVED RATHER THAN VANISHED. The alarm is one line per
    // deviation now — it summarises and routes — so the clause the deviation
    // is measured against renders on the NOTE, which is what owns it. Asserted
    // here so "the alarm got shorter" can never quietly mean "the fifth member
    // is orphaned again".
    expect((await screen.findByTestId('plan-note-base')).textContent).toContain(
      'Ship six slides.',
    )
  })

  it('THE CARD ADDS NOTHING TO THE COUNT — the deviation is already inside it', async () => {
    // The single most likely bug on this surface. `+ (deviation ? 1 : 0)`
    // double-counts the integer the execution gate reads, which is a defeated
    // guard rather than a miscount.
    server.notes = [note({ id: 'a' }), dev]
    band(server.summary())
    expect(screen.getByTestId('plan-band-count').textContent).toBe('2 for you')
    expect(await screen.findByTestId('plan-comment-list')).toBeTruthy()
    expect(screen.getByTestId('plan-band-count').textContent).not.toContain('3')
  })

  it('every plan-bearing shape satisfies `deviation present ⇒ count > 0`', () => {
    // Exhaustive rather than by intent: the disjunction the card used to carry
    // (`needsReview || deviation`) only ever earned its keep while a deviation
    // could be true with the count at zero. It cannot, so the second arm is
    // unreachable and is gone.
    const shapes: PlanNote[][] = [
      [],
      [note({ id: 'a' })],
      [note({ id: 'a' }), dev],
      [dev],
      [note({ id: 'a', to: 'content_writer' })],
      [note({ id: 'a', status: 'dismissed' })],
    ]
    for (const notes of shapes) {
      server.notes = notes
      const s = server.summary()
      if (s.deviation) expect(s.open_notes_for_you).toBeGreaterThan(0)
    }
  })
})

describe('the gated state is a conjunction of two members already present', () => {
  it('regular + executing + an open note for you', () => {
    server.notes = [note({ id: 'a' })]
    server.phase = 'executing'
    band(server.summary())
    expect(screen.getByTestId('plan-band-gated')).toBeTruthy()
  })

  it('not gated at zero notes, and not gated while still spec-ing', () => {
    server.phase = 'executing'
    band(server.summary())
    expect(screen.queryByTestId('plan-band-gated')).toBeNull()
    cleanup()

    server.notes = [note({ id: 'a' })]
    server.phase = 'spec-ing'
    band(server.summary())
    expect(screen.queryByTestId('plan-band-gated')).toBeNull()
  })

  it('there is no `halted` member on the wire, and the band must not invent one', () => {
    const s = server.summary()
    expect('halted' in s).toBe(false)
    expect(Object.keys(s).sort()).toEqual([
      'accepted',
      'accepted_revision',
      'deviation',
      'open_notes_for_you',
      'phase',
      'revision',
      'surface',
    ])
  })
})

/**
 * C1's STANDING ASSERTION.
 *
 * "Resolve a note through the route, assert `PlanIndex.open_notes_for_you` and
 * `PlanSummary.open_notes_for_you` both moved and are equal."
 *
 * The two surfaces are mounted TOGETHER against one server, and the resolve is
 * driven through the card's own control — the same route the tab uses, and the
 * only path by which a note's status ever changes. Nothing here decrements a
 * local integer; both numbers move because the server's one filter now counts
 * one fewer note.
 *
 * This is phase 6's exit criterion rather than merely phase 7's entry
 * criterion: ordering alone is not enough, because a defective phase 6
 * satisfies the arrow and still defeats the gate.
 */
describe('C1 — the card integer and the tab integer are ONE number', () => {
  function bothSurfaces() {
    return render(
      createElement(
        'div',
        null,
        createElement(PlanBand, { plan: server.summary(), projectId: PID }),
        createElement(ProjectPlanTab, { projectId: PID, active: true }),
      ),
      { wrapper },
    )
  }

  /**
   * REWRITTEN FOR M4, AND WHAT IT ASSERTS IS UNCHANGED: the two integers are
   * one number and they move together. Only the GESTURE moved. The card's
   * deviation callout used to resolve on the click and this test drove it
   * there; nothing about a note reaches a route on the click any more, so the
   * decision is staged on the note and the SUBMIT is what moves the status.
   *
   * That makes this a stronger version of the same claim rather than a weaker
   * one — it now proves the count survives the full stage-then-submit round
   * trip, which is the only path a note's status can take at all.
   */
  it('both move 3 -> 2 together when a staged decision is submitted', async () => {
    server.notes = [
      note({ id: 'a' }),
      note({ id: 'b' }),
      note({
        id: 'n-dev',
        kind: 'deviation',
        comment: 'off contract',
        base_section: '## Goal\nSix.\n',
      }),
    ]
    const view = bothSurfaces()

    const card = () => Number(screen.getByTestId('plan-band-count').textContent!.split(' ')[0])
    const tab = () => Number(screen.getByTestId('plan-open-for-you').textContent!.split(' ')[0])

    await screen.findByTestId('plan-open-for-you')
    await waitFor(() => expect(tab()).toBe(3))
    expect(card()).toBe(3)
    expect(card()).toBe(tab())
    // TWO ALARMS, ONE PER MOUNT, and that is the parity this block is about:
    // the tab used to render none at all, so a reader there saw the count and
    // no indication that one of those notes was the work going off-contract.
    // Scoped by density rather than counted loosely — the same scoping this
    // file already does for the note row, and for the same reason.
    // The alarm is a MODE of the comment list now, so both halves are asserted:
    // the list is on both mounts, and both are red.
    const alarms = view.container.querySelectorAll(
      '[data-density] [data-testid="plan-comment-list"]',
    )
    expect(alarms).toHaveLength(2)
    for (const a of alarms) expect(a.className).toContain('plan-cl--alarm')

    // Both surfaces mount an editor, so the gesture is scoped to the TAB's —
    // `density="full"`. The band's compact one is the same component and would
    // do the same thing; asserting on an ambiguous match would only be testing
    // testing-library's tie-breaking.
    const full = view.container.querySelector('[data-density="full"]') as HTMLElement
    const dev = await within(full).findByTestId('plan-note-acts-n-dev')
    fireEvent.click(within(dev).getByRole('button', { name: 'Dismiss' }))

    // STAGED, NOT SENT. The count has not moved and the server still has it open
    // — this is the half of change 9 that the callout used to break.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.notes.find((n) => n.id === 'n-dev')!.status).toBe('open')
    expect(tab()).toBe(3)

    fireEvent.click(within(full).getByRole('button', { name: /^Send review/ }))

    await waitFor(() => expect(tab()).toBe(2))
    // The card is a prop-driven component; re-render it from the SERVER's
    // summary, which is what the project-list refetch does in the app.
    view.rerender(
      createElement(
        'div',
        null,
        createElement(PlanBand, { plan: server.summary(), projectId: PID }),
        createElement(ProjectPlanTab, { projectId: PID, active: true }),
      ),
    )

    await waitFor(() => expect(card()).toBe(2))
    expect(card()).toBe(tab())
    // It holds because there is ONE note, not because two counters were kept
    // in step: the deviation is a single object both surfaces read, so there is
    // no second place for it to be counted or missed.
    expect(server.notes.find((n) => n.id === 'n-dev')!.status).toBe('dismissed')
    expect(server.openForYou()).toBe(2)
    // And BOTH alarms STAND DOWN off the one dismissal, for the same reason the
    // two integers move together: one note, read by one selector, on both
    // mounts. The LIST stays — two comments are still open and it is a
    // navigator for all of them — but nothing in it is off-contract any more,
    // so neither box is red. `--alarm` is the assertion because it is what
    // "alarm" now means: the list is unconditional, the urgency is not.
    const lists = screen.queryAllByTestId('plan-comment-list')
    expect(lists).toHaveLength(2)
    for (const l of lists) expect(l.className).not.toContain('plan-cl--alarm')
  })

  it('the two payloads agree on every shape, not only the one the test drove', () => {
    const shapes: PlanNote[][] = [
      [],
      [note({ id: 'a' })],
      [note({ id: 'a' }), note({ id: 'b', kind: 'deviation' })],
      [note({ id: 'a', to: 'content_writer' }), note({ id: 'b', to: '' })],
      [note({ id: 'a', status: 'applied' })],
    ]
    for (const notes of shapes) {
      server.notes = notes
      expect(server.summary().open_notes_for_you).toBe(server.index().open_notes_for_you)
    }
  })
})

/**
 * N9, IN ITS FINAL FORM. This used to assert that a FAILED resolve left the
 * note open rather than clearing it locally — a real guard against a real bug,
 * for a call this file no longer makes. The callout's two buttons were the last
 * place in the tree where something about a note reached a route on the click,
 * and M4 removed them rather than re-pointing them.
 *
 * So the guard is re-aimed at what can actually go wrong now: a control
 * creeping back on to the callout, and — the failure that would make this a
 * subtraction instead of a move — the deviation becoming undecidable because
 * the buttons went away and nothing replaced them.
 */
describe('N9 — nothing about a note reaches a route on the click', () => {
  it('the callout is an ALARM: it offers no control and posts nothing', async () => {
    server.notes = [note({ id: 'n-dev', kind: 'deviation', comment: 'off contract' })]
    const posted: string[] = []
    const realPost = routes.current!.post
    routes.current!.post = async (p: string, b?: unknown) => {
      posted.push(p)
      return realPost(p, b)
    }
    band(server.summary())

    const callout = await screen.findByTestId('plan-comment-list')
    // THE ONLY BUTTONS ARE ROUTES. A row is a `<button>` because clicking it
    // selects the note's section and scrolls to the note — it decides nothing
    // and posts nothing, which the `/resolve` assertion below is what actually
    // pins. Anything else appearing here is a control creeping back on.
    for (const b of within(callout).queryAllByRole('button')) {
      expect(b.getAttribute('data-testid')).toBe('plan-comment-row')
    }
    expect(screen.queryByRole('button', { name: 'Accept — move the contract' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject — hold the contract' })).toBeNull()
    // It says where the decision lives instead of silently dropping it.
    expect(within(callout).getByTestId('plan-comment-list-where').textContent).toContain(
      'nothing reaches the plan or its addressees until you submit',
    )
    expect(posted.filter((p) => /\/resolve$/.test(p))).toEqual([])
    expect(server.notes[0].status).toBe('open')
    expect(server.openForYou()).toBe(1)
  })

  it('and the deviation is still DECIDABLE, on its own note in the editor below', async () => {
    // The criterion the removal had to meet: a subtraction is not done until
    // the thing it removed has another way. Verified here rather than assumed —
    // the same standard AC-2.7 set for `Open the full Plan`.
    server.notes = [
      note({ id: 'n-dev', kind: 'deviation', comment: 'off contract', to: 'user' }),
    ]
    band(server.summary())

    const acts = await screen.findByTestId('plan-note-acts-n-dev')
    fireEvent.click(within(acts).getByRole('button', { name: 'Dismiss' }))

    // It STAGES. The status has not moved and no resolve was posted.
    await waitFor(() => expect(server.draft).toHaveLength(1))
    expect(server.draft[0].kind).toBe('dismiss')
    expect(server.notes[0].status).toBe('open')
  })
})

describe('the section picker survives every depth the server can send', () => {
  /* THE DESK-BLANKING BUG. `depth` is the plan grammar's, and it is
   * legitimately shallower than `##`: `parse_sections` emits the headless
   * opening prose at depth 0 (`_lede`) and a `#` heading that is not the
   * document title at depth 1. The compact picker indented with
   * `' '.repeat((depth - 2) * 2)`, so depth 0 asked for -4 characters,
   * `String.repeat` threw mid-render, and React unmounted the entire root —
   * My Desk went blank on a plan that is nothing but ordinary. */
  /* The fake locates each section by finding its heading line in the body, so
   * the body has to actually contain these shapes — which is the point: this is
   * a plan a coordinator writes, not a contrived payload. */
  const SHALLOW_BODY = [
    '# Project Plan: demo',
    '',
    'Prose before the first heading — the server sends this headless.',
    '',
    '# Notes',
    'A `#` heading that is not the title.',
    '',
    '## Goal',
    'Ship the thing.',
    '',
  ].join('\n')
  const SHALLOW: PlanSection[] = [
    { id: '_lede', heading: '', depth: 0, boxes: [0, 0], char_start: 0, char_end: 0 },
    { id: 'notes', heading: 'Notes', depth: 1, boxes: [0, 0], char_start: 0, char_end: 0 },
    { id: 'goal', heading: 'Goal', depth: 2, boxes: [0, 0], char_start: 0, char_end: 0 },
  ]

  beforeEach(() => {
    server = new FakePlanServer(SHALLOW_BODY, SHALLOW)
    routes.current = routeTo(server, PID)
  })

  it('renders a depth-0 and a depth-1 section instead of throwing', async () => {
    band(server.summary())

    const select = (await screen.findByLabelText('Plan sections')) as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toEqual(['all', '_lede', 'notes', 'goal'])
  })

  it('a headless section still has a word — an empty <option> is not a label', async () => {
    band(server.summary())

    const select = (await screen.findByLabelText('Plan sections')) as HTMLSelectElement
    const lede = Array.from(select.options).find((o) => o.value === '_lede')!
    expect(lede.textContent!.trim()).toBe('Overview')
    // Shallower than `##` indents by nothing; it never indents by less.
    expect(lede.textContent!.startsWith(' ')).toBe(false)
  })
})

/**
 * AC-2.7 / AC-2.17 — WHAT THE DESK CAN STILL DO AFTER `Open the full Plan` WENT.
 *
 * The button navigated to `…?tab=plan`, unmounting the card. Deleting it is only
 * safe if the surviving path is real, and "real" is not "the editor renders":
 * before change 10 a desk reader could edit the plan, comment on it and submit a
 * review batch but could not DECIDE on it, because the acceptance strip was
 * tab-only. So the claim is verified by RENDER, on both mounts, and it is a
 * COUNT rather than a layout — a duplicate mount renders perfectly and a source
 * grep cannot see it.
 *
 * WHAT "CAN STILL APPROVE" MEANS NOW. There is no Approve button anywhere:
 * accepting a plan is accepting the go-note, in the tray, with the same Accept
 * every other proposal has. So the desk's approval path is the note's, and that
 * is what is driven here — end to end, through the band's own compact mount.
 */
describe('AC-2.7 — the desk reaches the editor, and can still decide', () => {
  it('the band embeds a working editor with exactly ONE acceptance strip in it', async () => {
    band(server.summary())
    // The editor is INSIDE the band rather than reached by leaving it.
    const strip = await screen.findByTestId('plan-acceptance')
    expect(strip.closest('[data-testid="plan-band"]')).toBeTruthy()
    expect(strip.closest('[data-density="compact"]')).toBeTruthy()
    expect(screen.getAllByTestId('plan-acceptance')).toHaveLength(1)
    // NO APPROVE BUTTON AND NO REVOKE, on this surface or any other — both acts
    // are the tray's. The strip is a readout and carries no control at all.
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull()
    expect(within(strip).queryAllByRole('button')).toHaveLength(0)
  })

  it('...and it is not decorative: the desk reader can actually approve, by dismissing the confirm note', async () => {
    // `Dismiss` and not `Accept`: the confirm note carries no proposal, so
    // `has_proposal` withholds Accept and Reject and the verb every other row
    // already has is the one that means yes here.
    //
    // `Send review` is still THIS band's, because this fixture mounts the band
    // without an `onSendState` — the desk card passes one, and that is what
    // moves the Send into the card's own footer. Layout, not behaviour: the
    // submit is the same call either way.
    server.notes = [server.goNote()]
    band(server.summary())
    await screen.findByTestId('plan-acceptance')
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Send review/ }))
    await waitFor(() => expect(server.accepted).toBe(true))
    expect(server.notes[0].status).toBe('dismissed')
  })

  /**
   * ONE ACCEPTANCE READOUT PER SCREEN, AND THE HEADER IS THE ONE THAT KEEPS IT.
   *
   * The band header prints `✓ accepted` and `rev N` on the same row, and the
   * strip below it used to print "Accepted at revision N" — the same word and
   * the same integer, one line apart, because `planPill` returns 'accepted'
   * ONLY when `accepted_revision === revision`. This pins the fix as a COUNT
   * of readouts rather than a className: a chip that came back would render
   * perfectly and no grep would see it.
   *
   * The Plan tab is unaffected and stays pinned in `ProjectPlanTab.test.tsx` —
   * its header never says "accepted", so there the strip is the only place the
   * fact appears at all.
   */
  it('an ACCEPTED band states the acceptance once — the header keeps it, the strip stands down', async () => {
    server.accepted = true
    server.acceptedRevision = server.revision
    band(server.summary())

    // The editor is mounted and working — this is not "the band failed to render".
    await screen.findByLabelText('Plan sections')

    // The header still carries BOTH halves of the fact.
    expect(screen.getByText('accepted')).toBeTruthy()
    expect(screen.getByText(`rev ${server.revision}`)).toBeTruthy()

    // And it is not said a second time three lines down.
    expect(screen.queryByTestId('plan-accepted')).toBeNull()
    // The whole strip goes with it: `.plan-approve` owns padding and a bottom
    // rule, so an empty one is a stray line under the header rather than nothing.
    expect(screen.queryByTestId('plan-acceptance')).toBeNull()
  })

  /**
   * ...AND THE SUPPRESSION IS KEYED ON WHAT THE HEADER PRINTED, NOT ON THE DESK.
   *
   * Accepted-then-edited is the state `accepted_revision` exists to distinguish:
   * the pill falls through to 'up to date' and the accepted revision is nowhere
   * in the header. If the strip stood down on `density === 'compact'` instead,
   * the card would lose the number entirely here.
   */
  it('...but an accepted-THEN-EDITED band keeps the strip, because the header no longer carries it', async () => {
    server.accepted = true
    server.acceptedRevision = 1
    server.revision = 2
    band(server.summary())

    await screen.findByLabelText('Plan sections')
    expect(screen.queryByText('accepted')).toBeNull()
    expect(screen.getByText('up to date')).toBeTruthy()
    // The only place the accepted revision appears on this card.
    expect((await screen.findByTestId('plan-accepted')).textContent).toBe('Accepted at revision 1')
  })

  /**
   * ...AND THE WARNING IS NOT THE CHIP. `changed_since_acceptance` is the one
   * thing on this strip the band header does NOT say — no pill carries it — so
   * suppressing the readout must not take it down with it. This is the branch
   * that keeps the strip from being deleted outright on the desk.
   */
  it('...and an accepted band that DRIFTED keeps the strip, carrying the warning alone', async () => {
    server.accepted = true
    server.acceptedRevision = server.revision
    const idx = server.index.bind(server)
    // A DIGEST comparison the server makes; the summary the band reads carries
    // no such field, so the header pill is still 'accepted'.
    server.index = () => ({ ...idx(), changed_since_acceptance: true })
    band(server.summary())

    const strip = await screen.findByTestId('plan-acceptance')
    expect(within(strip).getByTestId('plan-changed-since').textContent).toContain(
      'The plan changed since approval',
    )
    // Still only one acceptance readout on the screen — the header's.
    expect(screen.queryByTestId('plan-accepted')).toBeNull()
    expect(screen.getByText('accepted')).toBeTruthy()
  })

  it('and the band offers no control that navigates away from it', async () => {
    server.phase = 'spec-ing'
    server.notes = [note({ id: 'a' })]
    band(server.summary())
    await screen.findByTestId('plan-acceptance')
    expect(screen.queryByTestId('plan-band-release')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open the full Plan/ })).toBeNull()
  })
})

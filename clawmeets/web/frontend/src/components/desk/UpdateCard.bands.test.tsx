import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DeskUpdate } from '../../hooks/useDeskUpdates'
import type { PlanSummary } from '../../api/endpoints/projectPlans'

/**
 * THE CARD-LEVEL INVARIANTS — the two that a pure-function test cannot reach,
 * because both are about what is RENDERED beside what:
 *
 *   1. the live meter is gated on the halted conjunction at its ONE display
 *      site, so no gated card ever draws "Your team is on it"; and
 *   2. the card offers NO NAVIGATION AWAY from the plan — the PLAN band embeds
 *      the editor, and that is the whole of how a desk reader reaches it.
 *
 * (2) USED TO BE THE OPPOSITE CLAIM. This file asserted that the release control
 * ("Open the full Plan") lived inside the Plan band rather than in `.md-actions`,
 * so a progress-lane card — whose action row is suppressed, and a halted card IS
 * a progress-lane card — could not hide it. That control is now DELETED: it
 * navigated to `…?tab=plan`, unmounting the card, on cards where the in-band
 * editor was already mounted directly below it. The one thing the tab still had
 * that the band did not was Approve / Revoke, which now renders inside
 * `PlanEditor` at both densities.
 *
 * So the three tests that drove the button are gone with their subject, and the
 * one that asserted its ABSENCE is REWRITTEN rather than kept: an absence
 * assertion against a control that no longer exists anywhere is a green test
 * that proves nothing. It now sweeps every fixture the deleted tests used, which
 * makes it a real claim again.
 */

vi.mock('../../api/endpoints/deskReadState', () => ({
  putDeskReadState: () => Promise.resolve({}),
  getDeskReadState: () => Promise.resolve([]),
}))
vi.mock('../../api/endpoints/messages', () => ({ sendUserMessage: () => Promise.resolve({}) }))
vi.mock('../../hooks/useProjectReport', () => ({ useProjectReport: () => ({ data: null }) }))
// The room's trust rule. These cards have no project list behind them, so the
// real hook fails closed; a test about a trusted thread turns it off.
let untrusted = true
vi.mock('../../hooks/useRoomTrust', () => ({
  useRoomTrust: () => ({
    untrustedBodies: untrusted, isOutsideAuthor: () => false, isUntrusted: () => untrusted, unknownAuthorUntrusted: untrusted,
  }),
}))

const UpdateCard = (await import('./UpdateCard')).default

afterEach(() => {
  cleanup()
  untrusted = true
})

function plan(over: Partial<PlanSummary> = {}): PlanSummary {
  return {
    surface: 'regular',
    phase: 'executing',
    revision: 2,
    accepted: false,
    accepted_revision: null,
    open_notes_for_you: 0,
    deviation: null,
    ...over,
  }
}

function item(over: Partial<DeskUpdate> = {}): DeskUpdate {
  return {
    projectId: 'p1',
    lane: 'progress',
    kind: 'project',
    agent: null,
    agentName: 'ana-analyst',
    sourceName: 'demo',
    roomLabel: '# user communication',
    title: 'Q3 numbers',
    quote: 'Working on it.',
    ts: '2035-01-01T00:00:00+00:00',
    latestMessageId: 'm1',
    files: [],
    navTo: '/projects/p1',
    plan: plan(),
    reportPublishedAt: null,
    ...over,
  }
}

function card(u: DeskUpdate, onOpen = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <UpdateCard item={u} onOpen={onOpen} onToast={vi.fn()} />
    </QueryClientProvider>,
  )
  return { ...view, onOpen }
}

describe('the live meter renders iff `isProgress && !gated`', () => {
  it('a progress card that is NOT gated draws the meter', () => {
    const { container } = card(item({ plan: plan({ open_notes_for_you: 0 }) }))
    expect(container.querySelector('.md-prog')).toBeTruthy()
    expect(container.textContent).toContain('Your team is on it')
  })

  it('a GATED progress card draws no meter — it is not "on it", it is waiting on you', () => {
    const { container } = card(item({ plan: plan({ open_notes_for_you: 1 }) }))
    expect(container.querySelector('.md-prog')).toBeNull()
    expect(container.textContent).not.toContain('Your team is on it')
    // ...and the static held line stands in its place, in the PLAN band.
    expect(screen.getByTestId('plan-band-gated')).toBeTruthy()
  })

  it('a non-progress lane draws no meter whether gated or not', () => {
    for (const lane of ['reply', 'report', 'read'] as const) {
      const { container } = card(item({ lane, plan: plan({ open_notes_for_you: 1 }) }))
      expect(container.querySelector('.md-prog')).toBeNull()
      cleanup()
    }
  })

  it('a DM card (no plan) is never gated, so its meter survives', () => {
    const { container } = card(item({ kind: 'dm', plan: null }))
    expect(container.querySelector('.md-prog')).toBeTruthy()
  })

  it('no `halted` flag is invented — the conjunction is written where it is shown', () => {
    const src = readSrc('src/components/desk/UpdateCard.tsx')
    expect(src).not.toMatch(/\bhalted\b/)
    // The gate is a single call to the one named predicate, not a re-spelling
    // of its three conjuncts at the display site.
    expect(src).toContain('isGated(item.plan)')
    expect(src).toContain('isProgress && !gated')
  })
})

describe('the PLAN band navigates nowhere — the editor is embedded in it', () => {
  it('a gated card is a PROGRESS card whose action row is suppressed…', () => {
    card(item({ plan: plan({ open_notes_for_you: 2 }) }))
    // Done / Send Back are gone — `actionable === false` on the progress lane.
    expect(screen.queryByRole('button', { name: /Done/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reply Back/ })).toBeNull()
  })

  /**
   * THE REWRITE OF THE VACUOUS ABSENCE (AC-2.8). One of the four tests here
   * asserted that the release control was absent when nothing was waiting on the
   * plan. With the control deleted outright that assertion is true of every
   * card, in every state, for a reason that has nothing to do with what it was
   * checking — a green test that proves nothing.
   *
   * It is rewritten to sweep the four fixtures the three DELETED tests used —
   * gated, spec-ing, executing-with-nothing-waiting, and a DM — so it asserts
   * something that could fail: that no card, in any of the states that used to
   * OFFER the button, offers it now, and none of them grew a substitute that
   * navigates away.
   */
  it('no card in any state offers a control that leaves the desk for the plan', () => {
    const fixtures: Partial<DeskUpdate>[] = [
      { plan: plan({ open_notes_for_you: 2 }) },
      { lane: 'reply', plan: plan({ phase: 'spec-ing', open_notes_for_you: 0 }) },
      { lane: 'reply', plan: plan({ phase: 'executing', open_notes_for_you: 0 }) },
      { kind: 'dm', plan: null },
    ]
    for (const over of fixtures) {
      const { onOpen } = card(item(over))
      expect(screen.queryByTestId('plan-band-release')).toBeNull()
      expect(screen.queryByRole('button', { name: /Open the full Plan/ })).toBeNull()
      expect(onOpen).not.toHaveBeenCalled()
      cleanup()
    }
  })

  /**
   * AC-2.7 IS NOT ASSERTED HERE, AND THAT IS DELIBERATE RATHER THAN A GAP. The
   * surviving path — the band EMBEDS `PlanEditor` while it is expanded — needs a
   * plan to render, and this file mounts cards against no plan server at all
   * (its subject is lanes and bands, not documents). An assertion here would
   * pass on an editor that had failed to load, which is the vacuity this very
   * describe block was rewritten to remove.
   *
   * It is asserted twice where it can actually fail: structurally in
   * `PlanEditor.mounts.test.tsx` ("the editor mounts ONLY while the PLAN band is
   * expanded"), and by RENDER in `PlanBand.test.tsx`, which drives both mounts
   * through the fake server and counts exactly one Approve control per screen —
   * the half of AC-2.7 that a reachable-but-read-only editor would not satisfy.
   */

  it('no lane derivation moved to make this work', () => {
    // The rejected alternative was to re-lane gated cards to `reply` so the
    // action row survived. That works and it moves cards between desk sections,
    // changing the header counts the user reads — a behaviour change to the
    // feed rather than a card redesign.
    const src = readSrc('src/hooks/useDeskUpdates.ts')
    expect(src).not.toContain('isGated')
    expect(src).not.toContain('deviation')
    // The one edit to this hook is the report-stamp pass-through.
    expect(src).toContain('reportPublishedAt: c.reportPublishedAt')
  })
})

describe('the three bands, in fixed order, on a real card', () => {
  it('renders report, plan, response — top to bottom, every time', () => {
    const { container } = card(
      item({ lane: 'report', plan: plan({ phase: 'complete' }), reportPublishedAt: '2035-06-01T00:00:00Z' }),
    )
    const ids = [...container.querySelectorAll('[data-testid^="band-"]')].map(
      (el) => (el as HTMLElement).dataset.testid,
    )
    const order = ids.map((t) => t!.replace(/^band-(fold-)?/, ''))
    expect(order).toEqual(['report', 'plan', 'response'])
  })

  it('omits the plan band entirely on a front-desk shape', () => {
    const { container } = card(
      item({ plan: plan({ surface: 'frontdesk', phase: null, revision: null, accepted: null }) }),
    )
    expect(container.querySelector('[data-testid$="-plan"]')).toBeNull()
    expect(screen.queryByTestId('plan-band')).toBeNull()
    // ...and the rail says why, in the ownership line rather than "no plan".
    expect(screen.getByTestId('phase-rail').textContent).toContain('not yours')
  })

  it('exactly one band is expanded on first render, and folding is reversible', () => {
    const { container } = card(
      item({ lane: 'reply', plan: plan({ phase: 'spec-ing', open_notes_for_you: 1 }) }),
    )
    expect(container.querySelectorAll('[data-testid^="band-"]:not([data-testid^="band-fold-"])'))
      .toHaveLength(1)
    // The expanded one is the PLAN band, per §4(c).
    expect(screen.getByTestId('band-plan')).toBeTruthy()
    // Fold it; nothing is destroyed and the row is still there to click back.
    fireEvent.click(screen.getByLabelText('Collapse Plan · the contract'))
    expect(screen.queryByTestId('band-plan')).toBeNull()
    expect(screen.getByTestId('band-fold-plan')).toBeTruthy()
    fireEvent.click(screen.getByTestId('band-fold-plan'))
    expect(screen.getByTestId('band-plan')).toBeTruthy()
  })

  it("an unaccepted plan with nothing for you opens the agent's response, and the fold says acceptance is pending", () => {
    card(item({ lane: 'reply', plan: plan({ phase: 'spec-ing', revision: 4, open_notes_for_you: 0 }) }))
    expect(screen.getByTestId('band-response')).toBeTruthy()
    expect(screen.queryByTestId('band-plan')).toBeNull()
    const fold = screen.getByTestId('band-fold-plan')
    expect(fold.textContent).toContain('rev 4 · awaiting your acceptance')
    expect(fold.textContent).toContain('Review & accept')
    expect(fold.textContent).not.toContain('held to it')
  })

  it('carrier 1 of 5 — an open deviation reddens the card in the FEED', () => {
    const dev = { id: 'd', by: 'ana', comment: 'four not six', section: 'goal', base_section: 'Six.' }
    const { container } = card(item({ plan: plan({ open_notes_for_you: 1, deviation: dev }) }))
    expect(container.querySelector('.md-card--urgent')).toBeTruthy()
    // A merely-waiting card is NOT red.
    cleanup()
    const calm = card(item({ plan: plan({ open_notes_for_you: 1 }) }))
    expect(calm.container.querySelector('.md-card--urgent')).toBeNull()
  })
})

function readSrc(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

describe('the quote band names whose words it holds', () => {
  it("labels the user's own unanswered message a Request, not a Response", () => {
    card(item({ plan: null, quote: 'how do I run the simulator?', quoteIsYours: true }))
    expect(screen.getByText('Request')).toBeTruthy()
    expect(screen.queryByText('Response')).toBeNull()
    expect(screen.getByText(/what you asked @ana-analyst/)).toBeTruthy()
  })

  it("keeps Response for the agent's words", () => {
    card(item({ plan: null }))
    expect(screen.getByText('Response')).toBeTruthy()
    expect(screen.queryByText('Request')).toBeNull()
  })
})

describe("an outside contact's words on the card", () => {
  it("labels a contact's unanswered message a Request and names the contact", () => {
    card(item({ plan: null, kind: 'dm', quote: 'Do you still have the Chablis?', quoteFromContact: 'Mara Quintero' }))
    expect(screen.getByText('Request')).toBeTruthy()
    expect(screen.queryByText('Response')).toBeNull()
    expect(screen.getByText(/what Mara Quintero asked @ana-analyst/)).toBeTruthy()
  })

  it("forwards a contact's message under the contact's name, not the agent's", () => {
    // A trusted channel thread (Telegram, email): a Hub thread has no Forward.
    untrusted = false
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const u = item({ plan: null, kind: 'dm', lane: 'reply', quote: 'Do you still have the Chablis?', quoteFromContact: 'Mara Quintero' })
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <UpdateCard item={u} onOpen={vi.fn()} onToast={vi.fn()} />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId('card-forward'))
    expect(screen.getByText('Forwarded from Mara Quintero')).toBeTruthy()
    expect(screen.queryByText('Forwarded from ana-analyst')).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { PlanIndex, PlanNudge } from '../../../api/endpoints/projectPlans'
import type { AgentCard } from '../../../types'
import { findThoughtPartner } from '../../../utils/thoughtPartner'

/**
 * The decision nudge against the STUB contract (engineering plan §5.4): a
 * fixture `PlanIndex` carrying `decision` + `nudge`, and a mocked
 * `postPlanNudgeEvent`. The real endpoints land with the backend; nothing here
 * depends on them.
 */

const postPlanNudgeEvent = vi.fn()
vi.mock('../../../api/endpoints/projectPlans', async () => {
  const actual = await vi.importActual<typeof import('../../../api/endpoints/projectPlans')>(
    '../../../api/endpoints/projectPlans',
  )
  return { ...actual, postPlanNudgeEvent: (...a: unknown[]) => postPlanNudgeEvent(...a) }
})

/* Every other write the browser could make. Grill me must reach none of them —
   the draft is typed into the composer, never sent. */
const clientPost = vi.fn()
vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return { ...actual, post: (...a: unknown[]) => clientPost(...a) }
})

const roster = { current: [] as AgentCard[], loading: false }
vi.mock('../../../hooks/useMyAgents', () => ({
  useMyAgents: () => ({ data: roster.current, isLoading: roster.loading, error: null }),
}))

/* The viewer, through the selector the component reads. Mocked rather than
   seeded with `useAuthStore.setState`, which `test/suiteHygiene.test.ts`
   reserves for the files it lists by name. */
const viewer = { current: null as { id: string; username: string } | null }
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (select: (s: { user: unknown }) => unknown) => select({ user: viewer.current }),
}))

const { PlanDecisionNudge } = await import('./PlanDecisionNudge')

const PID = 'p-1'
const REQUEST = "Should I take the Acme offer or stay where I am? I'm torn."
const USER = { id: 'u-1', username: 'alice' }

function agent(name: string, extra: Partial<AgentCard> = {}): AgentCard {
  return {
    id: `id-${name}`,
    name,
    description: '',
    capabilities: [],
    status: 'online',
    registered_at: '',
    last_heartbeat: null,
    discoverable_through_registry: false,
    registered_by: USER.id,
    is_verified: false,
    ...extra,
  } as AgentCard
}

const TP = agent('alice-thought_partner')

function stamps(over: Partial<PlanNudge> = {}): PlanNudge {
  return { shown_at: '', accepted_at: '', dismissed_at: '', held_back_at: '', ...over }
}

function plan(over: Partial<PlanIndex> = {}): PlanIndex {
  return {
    body: '# Plan\n',
    sections: [],
    notes: [],
    draft: null,
    can_decide: true,
    records_folds: true,
    sha: 'x',
    revision: 1,
    keeper: 'alice-assistant',
    open_notes_for_you: 0,
    spec_digest: '',
    accepted: false,
    accepted_revision: null,
    changed_since_acceptance: false,
    history: [],
    decision: true,
    nudge: stamps(),
    ...over,
  }
}

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

function mount(index: PlanIndex) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/${PID}/plan`]}>
        <Routes>
          <Route
            path="/projects/:id/plan"
            element={<PlanDecisionNudge projectId={PID} request={REQUEST} index={index} />}
          />
          <Route path="/dm/:agentName" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const line = () => screen.queryByTestId('plan-decision-nudge')
const events = () => postPlanNudgeEvent.mock.calls.map((c) => c[1])

beforeEach(() => {
  postPlanNudgeEvent.mockReset().mockResolvedValue(stamps())
  clientPost.mockReset()
  roster.current = [TP]
  roster.loading = false
  viewer.current = USER
})

afterEach(cleanup)

describe('PlanDecisionNudge', () => {
  it('shows the line when the flag is yes and the plan is unaccepted, and sends shown', async () => {
    mount(plan())
    expect(line()?.textContent).toContain(
      'This looks like a decision. Want the thought_partner to grill you first?',
    )
    expect(screen.getByRole('button', { name: 'Grill me' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' }).textContent).toBe('✕')
    await waitFor(() => expect(events()).toEqual(['shown']))
  })

  it('does not resend shown once the server has stamped it', async () => {
    mount(plan({ nudge: stamps({ shown_at: '2026-10-05T00:00:00Z' }) }))
    expect(line()).not.toBeNull()
    await Promise.resolve()
    expect(events()).toEqual([])
  })

  it.each([
    ['missing (null)', null],
    ['missing (absent, old server)', undefined],
    ['no', false],
  ])('shows nothing and sends nothing when the flag is %s', async (_label, decision) => {
    mount(plan({ decision }))
    expect(line()).toBeNull()
    await Promise.resolve()
    expect(events()).toEqual([])
  })

  it('shows nothing once the plan is accepted', async () => {
    mount(plan({ accepted: true, accepted_revision: 1 }))
    expect(line()).toBeNull()
    await Promise.resolve()
    expect(events()).toEqual([])
  })

  it('shows nothing on a project where it was already dismissed', () => {
    mount(plan({ nudge: stamps({ dismissed_at: '2026-10-05T00:00:00Z' }) }))
    expect(line()).toBeNull()
  })

  it('a differently named own agent with grill-me does not count: no line, sends held_back', async () => {
    roster.current = [agent('alice-coach', { capabilities: ['grill-me'] })]
    mount(plan())
    expect(line()).toBeNull()
    await waitFor(() => expect(events()).toEqual(['held_back']))
  })

  it('sends nothing while the roster is still loading', async () => {
    roster.current = []
    roster.loading = true
    mount(plan())
    expect(line()).toBeNull()
    await Promise.resolve()
    expect(events()).toEqual([])
  })

  it('dismiss hides the line immediately and sends dismissed', async () => {
    mount(plan({ nudge: stamps({ shown_at: 'x' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(line()).toBeNull()
    await waitFor(() => expect(events()).toEqual(['dismissed']))
  })

  it('Grill me opens the thought_partner DM with the request as a draft, without sending it', async () => {
    mount(plan({ nudge: stamps({ shown_at: 'x' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Grill me' }))
    expect(screen.getByTestId('where').textContent).toBe(
      `/dm/alice-thought_partner?draft=${encodeURIComponent(REQUEST)}`,
    )
    await waitFor(() => expect(events()).toEqual(['accepted']))
    // No message was posted anywhere: the draft sits in the composer.
    expect(clientPost).not.toHaveBeenCalled()
  })

  it('an event post failure is swallowed and the line stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    postPlanNudgeEvent.mockRejectedValue(new Error('boom'))
    mount(plan())
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(line()).not.toBeNull()
    warn.mockRestore()
  })
})

describe('findThoughtPartner', () => {
  it('matches only an own agent whose short name is exactly thought_partner', () => {
    expect(findThoughtPartner([TP], USER)).toBe(TP)
    expect(findThoughtPartner([agent('alice-thought_partner2')], USER)).toBeUndefined()
    expect(findThoughtPartner([agent('alice-Thought_Partner')], USER)).toBeUndefined()
    expect(
      findThoughtPartner([agent('bob-thought_partner', { registered_by: 'u-2' })], USER),
    ).toBeUndefined()
    expect(findThoughtPartner([TP], null)).toBeUndefined()
  })
})

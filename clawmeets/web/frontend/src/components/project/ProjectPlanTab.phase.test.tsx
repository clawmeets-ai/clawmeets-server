import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlanPhase } from '../../api/endpoints/projectPlans'

/**
 * N3 — `failed` IS A PHASE THE USER HAS TO BE ABLE TO SEE.
 *
 * `phaseLabel` answers null for `failed` on purpose: it is not a step on the
 * way anywhere, so it is not in `PHASE_RAIL`, and its doc comment says callers
 * "say so in their own words". The Plan tab's chip did not — it was a bare
 * `{phaseLabel(phase) && <chip/>}`, so the one lifecycle state a user most
 * needs to see on the Plan tab rendered as blank space. The only thing carrying
 * it was the project status badge in `ProjectView`, a different component with
 * a different vocabulary.
 *
 * These assertions distinguish the two reasons the chip can be empty, which is
 * the whole point: `failed` must say something, and a genuinely absent phase
 * (no plan, or a front-desk shape) must still say nothing.
 */

const project = { current: null as { plan: { phase: PlanPhase | null } | null } | null }

vi.mock('../../hooks/useProjects', () => ({ useProject: () => ({ data: project.current }) }))
vi.mock('../../hooks/useProjectPlan', () => ({
  useProjectPlan: () => ({
    data: {
      revision: 3,
      keeper: null,
      accepted: false,
      accepted_revision: null,
      changed_since_acceptance: false,
      notes: [],
      sections: [],
      body: '',
      sha: 'x',
      history: [],
      draft: null,
    },
    isLoading: false,
    error: null,
  }),
  useProjectPlanVersions: () => ({ data: [] }),
}))
// The editor below the header is a separate mount with its own suite; this file
// is about the header's chip.
vi.mock('./plan/PlanEditor', () => ({ PlanEditor: () => <div data-testid="plan-editor" /> }))

const { ProjectPlanTab } = await import('./ProjectPlanTab')

afterEach(cleanup)

function tab(phase: PlanPhase | null, hasPlan = true) {
  project.current = { plan: hasPlan ? { phase } : null }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ProjectPlanTab projectId="p-1" active />
    </QueryClientProvider>,
  )
}

describe('N3 — the Plan tab chip on a failed run', () => {
  it('says the run stopped short, rather than rendering nothing at all', async () => {
    tab('failed')
    await waitFor(() => expect(screen.getByTestId('project-plan-tab')).toBeTruthy())
    // The assertion that fails against wave 1: there was no element here.
    const chip = screen.getByTestId('plan-phase-failed')
    expect(chip.textContent).toContain('FAILED')
    expect(chip.textContent).toContain('stopped short of the Plan')
  })

  it('does NOT print a rail label for it — `failed` is not a step on the rail', async () => {
    tab('failed')
    await waitFor(() => expect(screen.getByTestId('project-plan-tab')).toBeTruthy())
    // The rename site stays the rename site: `PHASE_RAIL` has three entries and
    // this is not one of them, so the chip that prints a rail label stays away.
    expect(screen.queryByTestId('plan-phase')).toBeNull()
  })

  for (const [phase, label] of [
    ['spec-ing', 'PLAN'],
    ['executing', 'EXECUTE'],
    ['complete', 'REPORT'],
  ] as const) {
    it(`still prints ${label} for \`${phase}\`, and no failed chip`, async () => {
      tab(phase)
      await waitFor(() => expect(screen.getByTestId('project-plan-tab')).toBeTruthy())
      expect(screen.getByTestId('plan-phase').textContent).toBe(label)
      expect(screen.queryByTestId('plan-phase-failed')).toBeNull()
    })
  }

  it('an ABSENT phase still renders neither chip — the fix is not a catch-all', async () => {
    tab(null)
    await waitFor(() => expect(screen.getByTestId('project-plan-tab')).toBeTruthy())
    expect(screen.queryByTestId('plan-phase')).toBeNull()
    expect(screen.queryByTestId('plan-phase-failed')).toBeNull()
  })

  it('and neither does a project with no plan summary at all', async () => {
    tab(null, false)
    await waitFor(() => expect(screen.getByTestId('project-plan-tab')).toBeTruthy())
    expect(screen.queryByTestId('plan-phase')).toBeNull()
    expect(screen.queryByTestId('plan-phase-failed')).toBeNull()
  })
})

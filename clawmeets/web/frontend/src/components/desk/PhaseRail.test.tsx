import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PlanSummary } from '../../api/endpoints/projectPlans'
import { PHASE_RAIL, PhaseRail, phaseLabel } from './PhaseRail'

afterEach(cleanup)

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

function rail(p: PlanSummary | null, over: { hostName?: string; offContract?: boolean } = {}) {
  return render(
    <PhaseRail plan={p} hostName={over.hostName} offContract={over.offContract ?? false} />,
  )
}

describe('PHASE_RAIL is the rename, and the whole of it', () => {
  it('maps the STORED token to the displayed label', () => {
    expect(PHASE_RAIL.map((s) => [s.id, s.label])).toEqual([
      ['spec-ing', 'PLAN'],
      ['executing', 'EXECUTE'],
      ['complete', 'REPORT'],
    ])
  })

  it('never writes `spec-ing` back and never compares it to a client-side value', () => {
    // Structural, on CODE — comments stripped, because the header comment
    // necessarily names the token it is promising never to write.
    const src = readFileSync(resolve(process.cwd(), 'src/components/desk/PhaseRail.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    // Exactly ONE occurrence, and it is the `id:` in the mapping — the stored
    // token quoted as DATA, never compared as a branch and never assigned.
    expect(src.match(/spec-ing/g) ?? []).toHaveLength(1)
    expect(src).toMatch(/id:\s*'spec-ing'/)
    expect(src).not.toMatch(/===\s*'spec-ing'/)
    expect(src).not.toMatch(/'spec-ing'\s*[=)]/)
  })

  it('the raw token is never RENDERED, on any phase', () => {
    for (const phase of ['spec-ing', 'executing', 'complete'] as const) {
      const { container } = rail(plan({ phase }))
      expect(container.textContent).not.toContain('spec-ing')
      expect(container.textContent).not.toContain('undefined')
      cleanup()
    }
  })

  it('`phaseLabel` answers null for `failed` — it is not a step on the way anywhere', () => {
    expect(phaseLabel('spec-ing')).toBe('PLAN')
    expect(phaseLabel('failed')).toBeNull()
    expect(phaseLabel(null)).toBeNull()
    expect(phaseLabel(undefined)).toBeNull()
  })
})

describe('five branches, disjoint, and every one of them renders', () => {
  it('0a — no plan: the rail is GONE, not a line saying it is empty', () => {
    const { container } = rail(null)
    // A DM has no plan and never will, so there is no omission to report. The
    // old "none — no plan, no report" line described the card's shape rather
    // than anything actionable, on every DM card in the feed.
    expect(screen.queryByTestId('phase-rail')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('0b — front-desk: the line names OWNERSHIP, and shares no copy with 0a', () => {
    rail(plan({ surface: 'frontdesk', phase: null, revision: null }), { hostName: 'ana-analyst' })
    const el = screen.getByTestId('phase-rail')
    expect(el.dataset.rail).toBe('frontdesk')
    expect(el.textContent).toContain('not yours')
    expect(el.textContent).toContain("This project's plan is kept on @ana-analyst's side.")
    // Absence is only worth printing where the thing COULD have been there:
    // here there IS a plan, on a project the requester does not own.
    expect(el.textContent).not.toContain('no plan, no report')
    // Muted grey, never red: nothing missing is drawn in the deviation colour.
    expect(el.querySelector('.md-stage--direct')).toBeTruthy()
  })

  it('0b with an empty host name DROPS the possessive rather than faking it', () => {
    rail(plan({ surface: 'frontdesk', phase: null }), { hostName: '' })
    const el = screen.getByTestId('phase-rail')
    expect(el.textContent).toContain("This project's plan is kept on the host's side.")
    expect(el.textContent).not.toContain("@'s")
  })

  it('failed — the run stopped short of the Plan', () => {
    rail(plan({ phase: 'failed' }))
    const el = screen.getByTestId('phase-rail')
    expect(el.dataset.rail).toBe('failed')
    expect(el.textContent).toContain('failed — the run stopped short of the Plan')
    // `failed` is NOT one of the three steps, so no step is drawn `is-now`.
    expect(el.querySelectorAll('.md-stage-s.is-now')).toHaveLength(0)
  })

  it('the three phase steps mark exactly one `is-now`, and the ones before it done', () => {
    for (const [phase, done, next] of [
      ['spec-ing', 0, 2],
      ['executing', 1, 1],
      ['complete', 2, 0],
    ] as const) {
      const { container } = rail(plan({ phase }))
      expect(container.querySelectorAll('.md-stage-s.is-now')).toHaveLength(1)
      expect(container.querySelectorAll('.md-stage-s.is-done')).toHaveLength(done)
      expect(container.querySelectorAll('.md-stage-s.is-next')).toHaveLength(next)
      cleanup()
    }
  })

  it('an unknown or null phase degrades to all-next rather than throwing', () => {
    const { container } = rail(plan({ phase: null }))
    expect(container.querySelectorAll('.md-stage-s.is-next')).toHaveLength(3)
    expect(container.querySelectorAll('.md-stage-s.is-now')).toHaveLength(0)
    expect(container.textContent).not.toContain('undefined')
  })
})

describe('carrier 2 of 5 — the hint reddens off `offContract` and nothing else', () => {
  it('reads the phase hint when the work is on contract', () => {
    rail(plan(), { offContract: false })
    expect(screen.getByTestId('phase-rail').textContent).toContain('building to the Plan')
  })

  it('reads `off-contract — your call`, in the urgent token, when it is not', () => {
    const { container } = rail(plan(), { offContract: true })
    expect(container.textContent).toContain('off-contract — your call')
    expect(container.querySelector('.md-stage-warn')).toBeTruthy()
  })

  it('is PASSED, never re-derived — the rail reads no `deviation` member', () => {
    // The deviation predicate is written ONCE PER CARD, in `UpdateCard`. A
    // second reading here is how two carriers drift into disagreeing about
    // whether the same card is off-contract.
    const src = readFileSync(resolve(process.cwd(), 'src/components/desk/PhaseRail.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    expect(src).not.toContain('deviation')
    // ...and a card WITH a deviation still renders calm if it is not passed,
    // which is what makes the single-predicate claim checkable.
    const { container } = rail(
      plan({
        deviation: { id: 'd', by: 'x', comment: 'c', section: 's', base_section: 'b' },
      }),
      { offContract: false },
    )
    expect(container.textContent).not.toContain('off-contract')
  })
})

describe('the rail never grows a `host` member on PlanSummary', () => {
  it('takes the host from its own prop, not from the summary', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/desk/PhaseRail.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    expect(src).not.toMatch(/plan\.host/)
    expect(src).not.toMatch(/plan\?\.host/)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CardBand } from './CardBand'

/**
 * N4 — A FOLDED BAND IS A DISCLOSURE AND HAS TO ANNOUNCE ITSELF AS ONE.
 *
 * Every other assertion this suite makes about `CardBand` is about what a
 * sighted user sees: which band is open, what the fold row says, what tone it
 * carries. None of them can fail when the band is a plain `<button>` with no
 * `aria-expanded`, because visually it is identical — and that is exactly the
 * state wave 1 shipped. A screen-reader user was told "Plan · the contract, 2
 * changes waiting on you, Review, button" with nothing indicating there was a
 * collapsed region behind it and nothing changing when they opened it.
 *
 * The pattern is `LabelFilter.tsx:88`'s, followed rather than reinvented:
 * `aria-expanded` on the control, reflecting live state.
 *
 * M1 — AND THE PANEL IT NAMES HAS TO BE THIS CARD'S. Nothing below asserts a
 * literal id, because the id is generated per instance: what is load-bearing is
 * that the reference resolves, that it survives the fold, and that it is unique
 * on a desk holding more than one card.
 */

afterEach(cleanup)

function band(expanded: boolean, onToggle = vi.fn()) {
  return render(
    <CardBand
      id="plan"
      expanded={expanded}
      onToggle={onToggle}
      label="Plan · the contract"
      definition="what you and the agents agreed to build"
      foldMeta="2 changes waiting on you"
      foldCta="Review"
    >
      <div data-testid="band-body">the contract</div>
    </CardBand>,
  )
}

describe('N4 — CardBand announces itself as a disclosure', () => {
  it('the FOLDED row is a collapsed disclosure, not an unlabelled button', () => {
    band(false)
    const row = screen.getByTestId('band-fold-plan')
    // The assertion wave 1 could not fail: the row rendered, and that was all
    // anything checked.
    expect(row.getAttribute('aria-expanded')).toBe('false')
    const panelId = row.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    // Deliberately dangling while folded, and that is the design rather than an
    // oversight: the panel is UNMOUNTED, not hidden, because a mounted compact
    // `PlanEditor` costs a `GET …/plan` on every card that renders one.
    expect(document.getElementById(panelId!)).toBeNull()
  })

  it('the EXPANDED control reports the state it is now in', () => {
    band(true)
    const more = screen.getByLabelText('Collapse Plan · the contract')
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const panelId = more.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    // Once open the reference is live: it names an element that is really there.
    expect(document.getElementById(panelId!)).toBeTruthy()
  })

  it('the id it names is the DISCLOSED region, and excludes its own control', () => {
    band(true)
    const more = screen.getByLabelText('Collapse Plan · the contract')
    const panel = document.getElementById(more.getAttribute('aria-controls')!)
    expect(panel).toBeTruthy()
    // The body is inside it...
    expect(panel!.querySelector('[data-testid="band-body"]')).toBeTruthy()
    // ...and the toggle that controls it is NOT: a control nested inside the
    // region it claims to control is a broken relationship, not a stricter one.
    expect(panel!.querySelector('.md-cs-more')).toBeNull()
  })

  it('the two states agree on one id, so the relationship survives the toggle', () => {
    // Re-rendered rather than re-mounted, which is the case that matters and the
    // case the old spelling could not see: `CardBand` itself never unmounts on a
    // fold — only its children do — so the generated id has to be stable across
    // the toggle for `aria-controls` to keep pointing anywhere.
    const onToggle = vi.fn()
    const { rerender } = band(false, onToggle)
    const folded = screen.getByTestId('band-fold-plan').getAttribute('aria-controls')
    expect(folded).toBeTruthy()
    fireEvent.click(screen.getByTestId('band-fold-plan'))
    expect(onToggle).toHaveBeenCalled()
    rerender(
      <CardBand
        id="plan"
        expanded
        onToggle={onToggle}
        label="Plan · the contract"
        definition="what you and the agents agreed to build"
        foldMeta="2 changes waiting on you"
        foldCta="Review"
      >
        <div data-testid="band-body">the contract</div>
      </CardBand>,
    )
    expect(screen.getByLabelText('Collapse Plan · the contract').getAttribute('aria-controls')).toBe(
      folded,
    )
  })

  it('two cards open at once do not collide on one panel id', () => {
    // THE REAL SHAPE OF THE BUG, and why the previous spelling of this test
    // could not see it: it `cleanup()`ed between the two renders and compared
    // one BAND id against another, which says nothing about two CARDS.
    //
    // `DeskPage` renders one `UpdateCard` per feed item and the band ids are
    // compile-time constants ('report' | 'plan' | 'response'), so an id derived
    // from the band id repeats on every card. Two projects in `spec-ing` both
    // get `defaultOpenBands` = `[plan]`, both PLAN bands are expanded at load,
    // and the DOM holds two `id="band-panel-plan"`. A screen-reader user on the
    // SECOND card follows `aria-controls`, `getElementById` returns the FIRST
    // match, and they are read the wrong project's contract with no signal that
    // they moved. Duplicate `id` is invalid HTML regardless of any AT.
    //
    // No `cleanup()` between the renders: the collision only exists while both
    // cards are in the DOM together, which is the only state a desk is ever in.
    band(true)
    band(true)
    const controls = screen
      .getAllByLabelText('Collapse Plan · the contract')
      .map((b) => b.getAttribute('aria-controls')!)
    expect(controls).toHaveLength(2)
    expect(new Set(controls).size).toBe(2)
    // Attribute selector rather than `#id`: a generated id is not necessarily a
    // valid CSS identifier, and `querySelector('#:r0:')` throws on one.
    for (const id of controls) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1)
    }
  })
})

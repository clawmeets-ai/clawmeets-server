import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import DelegationRow from './DelegationRow'
import type { RecipientStatus } from './recipientStatus'

/**
 * Two states share this component and must never be confused, because after
 * this change they mean different things and someone debugging a fleet has to
 * tell them apart:
 *
 *  - `offline` — TYPED, terminal-ish, from a agent_offline row: the
 *    runner was not connected when the message was dispatched. Nothing to
 *    cancel, because nothing started.
 *  - `advisoryOffline` — a HINT, never a status: the batch is open and the
 *    roster (up to 60s stale) says the agent has since dropped. It may only
 *    de-emphasize the processing chip. The cancel button must survive it, or
 *    a user watching a truly stuck batch loses the one control they have.
 */

afterEach(cleanup)

function renderRow(status: RecipientStatus, advisoryOffline = false) {
  const onCancel = vi.fn()
  render(
    <DelegationRow
      displayName="backend"
      status={status}
      isCancelling={false}
      canCancel
      onCancel={onCancel}
      advisoryOffline={advisoryOffline}
    />,
  )
  return { onCancel }
}

describe('DelegationRow — the offline chip', () => {
  it('renders the offline state as its own word', () => {
    renderRow('offline')
    expect(screen.getByText(/offline/i)).toBeTruthy()
  })

  it('offers no cancel affordance — nothing was dispatched, so nothing can be stopped', () => {
    renderRow('offline')
    expect(screen.queryByLabelText('Cancel')).toBeNull()
  })

  // jsdom normalizes the hex to rgb(), so the assertions are on the computed
  // value: #b45309 amber vs the #b91c1c red the other terminal chips use.
  const AMBER = 'rgb(180, 83, 9)'
  const RED = 'rgb(185, 28, 28)'

  it('is amber, not the red used by canceled and timed out', () => {
    renderRow('offline')
    const chip = screen.getByText(/offline/i)
    expect(chip.getAttribute('style')).toContain(AMBER)
    expect(chip.getAttribute('style')).not.toContain(RED)
  })

  it('keeps timed out red, so the two terminal-looking states stay distinguishable', () => {
    renderRow('timed_out')
    expect(screen.getByText(/timed out/i).getAttribute('style')).toContain(RED)
  })
})

describe('DelegationRow — AC-3.6 advisory waiting', () => {
  it('says "waiting" instead of "processing" when the roster reports the agent offline', () => {
    renderRow('processing', true)
    expect(screen.getByText(/waiting/i)).toBeTruthy()
    expect(screen.queryByText(/processing/i)).toBeNull()
  })

  it('KEEPS the cancel button — the batch really is open and really is cancellable', () => {
    renderRow('processing', true)
    expect(screen.queryByLabelText('Cancel')).not.toBeNull()
  })

  it('renders no ● bullet, the visual grammar reserved for terminal chips', () => {
    renderRow('processing', true)
    expect(screen.getByText(/waiting/i).textContent).not.toContain('●')
  })

  it('does not animate the dots, so a stale roster reads as quiet, not confident', () => {
    const { container } = render(
      <DelegationRow
        displayName="backend"
        status="processing"
        isCancelling={false}
        canCancel
        onCancel={vi.fn()}
        advisoryOffline
      />,
    )
    expect(container.querySelectorAll('.animate-bounce').length).toBe(0)
  })

  it('leaves the ordinary processing chip untouched without the flag', () => {
    const { container } = render(
      <DelegationRow
        displayName="backend"
        status="processing"
        isCancelling={false}
        canCancel
        onCancel={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('processing')
    expect(container.querySelectorAll('.animate-bounce').length).toBe(3)
  })
})

/**
 * AC-3.7 — the chip for an agent that timed out with its runner already gone.
 * It must not read as a bare TIMED OUT (which implies the agent was there and
 * ignored you), and it must not read as the dispatch-time OFFLINE (which
 * implies the message never arrived). It is its own wording on the same
 * terminal status.
 */
describe('DelegationRow — offline at timeout', () => {
  const base = {
    displayName: 'backend',
    isCancelling: false,
    canCancel: true,
    onCancel: () => {},
  }

  it('qualifies the timeout instead of showing a bare TIMED OUT', () => {
    const { container } = render(
      <DelegationRow {...base} status="timed_out" offlineAtTimeout />,
    )
    const text = (container.textContent ?? '').toLowerCase()
    expect(text).toContain('offline')
    expect(text).toContain('timed out')
  })

  it('leaves a plain timeout exactly as it was', () => {
    const { container } = render(<DelegationRow {...base} status="timed_out" />)
    const text = (container.textContent ?? '').toLowerCase()
    expect(text).toContain('timed out')
    expect(text).not.toContain('offline')
  })

  it('explains on hover that the message DID arrive', () => {
    const { container } = render(
      <DelegationRow {...base} status="timed_out" offlineAtTimeout />,
    )
    const titled = container.querySelector('[title]')
    expect(titled?.getAttribute('title')).toContain('received the message')
  })

  it('offers no cancel button — the batch has already expired', () => {
    const { container } = render(
      <DelegationRow {...base} status="timed_out" offlineAtTimeout />,
    )
    expect(container.querySelector('[aria-label="Cancel"]')).toBeNull()
  })

  it('cannot turn a processing row terminal', () => {
    // offlineAtTimeout is only consulted inside the timed_out branch, so a
    // stray true on a live row must change nothing — including the cancel
    // affordance, because that batch really is open.
    const { container } = render(
      <DelegationRow {...base} status="processing" offlineAtTimeout />,
    )
    const text = (container.textContent ?? '').toLowerCase()
    expect(text).toContain('processing')
    expect(text).not.toContain('timed out')
    expect(container.querySelector('[aria-label="Cancel"]')).not.toBeNull()
  })
})

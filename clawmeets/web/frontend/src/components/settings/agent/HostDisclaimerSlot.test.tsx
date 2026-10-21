import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DOCTOR_FIX_COPY, HOST_DISCLAIMER_COPY } from '../../../utils/agentAccessCopy'
import HostDisclaimerSlot from './HostDisclaimerSlot'

afterEach(cleanup)

describe('the host disclaimer slot', () => {
  it('sandboxed: renders nothing', () => {
    const { container } = render(<HostDisclaimerSlot isolation="sandboxed" heldConversations={3} />)
    expect(container.textContent).toBe('')
  })

  it.each(['unavailable', 'something_newer', undefined])('%s: title, then the fix, in that order', (isolation) => {
    render(<HostDisclaimerSlot isolation={isolation} heldConversations={0} />)
    const slot = screen.getByTestId('host-disclaimer')
    const parts = [...slot.querySelectorAll('p')].map((p) => p.dataset.testid)
    expect(parts).toEqual(['host-disclaimer-title', 'host-disclaimer-fix'])
    expect(screen.getByTestId('host-disclaimer-title').textContent).toBe(HOST_DISCLAIMER_COPY.title)
    expect(screen.getByTestId('host-disclaimer-fix').textContent).toBe(DOCTOR_FIX_COPY.fix)
  })

  it('held 0 hides the count; N shows it between the title and the fix', () => {
    render(<HostDisclaimerSlot isolation="unavailable" heldConversations={1} />)
    expect(screen.getByTestId('host-disclaimer-held').textContent).toBe('1 conversation is waiting')
    cleanup()
    render(<HostDisclaimerSlot isolation="unavailable" heldConversations={4} />)
    const parts = [...screen.getByTestId('host-disclaimer').querySelectorAll('p')].map((p) => p.dataset.testid)
    expect(parts).toEqual(['host-disclaimer-title', 'host-disclaimer-held', 'host-disclaimer-fix'])
    expect(screen.getByTestId('host-disclaimer-held').textContent).toBe('4 conversations are waiting')
  })
})

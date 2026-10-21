import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { standIn } from '../../test/hubFixtures'
import { STAND_IN_COPY } from '../../utils/agentAccessCopy'
import StandInChip from './StandInChip'

afterEach(cleanup)

describe('the stand-in chip', () => {
  it('active: name from server · fp, and a "remote" badge', () => {
    render(<StandInChip info={standIn('scout')} />)
    expect(screen.getByTestId('hub-contact-user').textContent).toBe('scout')
    expect(screen.getByTestId('hub-contact-server').textContent).toBe('acme.dev')
    expect(screen.getByTestId('stand-in-remote').textContent).toBe('remote')
    expect(screen.getByTestId('stand-in-chip').getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByTestId('stand-in-inactive')).toBeNull()
  })

  it.each([
    ['unretained', 'no longer retained'],
    ['unlisted', 'no longer listed on the hub'],
    ['identity_changed', "its server's identity changed"],
    ['something_new', 'can no longer take part'],
    [null, 'can no longer take part'],
  ])('inactive (%s): greyed with the reason', (reason, text) => {
    const info = standIn('scout')
    render(<StandInChip info={{ ...info, hub: { ...info.hub!, bridge_state: 'inactive', inactive_reason: reason } }} />)
    expect(screen.getByTestId('stand-in-chip').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('stand-in-inactive').textContent).toBe(text)
    expect(STAND_IN_COPY.inactive(reason)).toBe(text)
  })

  it('no hub details: falls back to the id, as text', () => {
    render(<StandInChip info={{ ...standIn(), hub: null }} />)
    expect(screen.getByTestId('contact-fallback').textContent).toBe(standIn().id)
  })
})

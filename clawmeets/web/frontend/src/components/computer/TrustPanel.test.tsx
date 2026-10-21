import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComputerConsent } from '../../api/endpoints/computers'
import TrustPanel from './TrustPanel'

/**
 * The terminal line is the one part of this panel that depends on the machine,
 * and it must never claim "on" for a computer that turned it off (or "off" for
 * one that cannot say). The command inside it renders as code, so it can be
 * read — and typed — exactly.
 */

const CONSENT: ComputerConsent = {
  allowed: [
    { action: 'start', label: 'Start one of your agents' },
    { action: 'stop', label: 'Stop one of your agents' },
  ],
  never: [],
  agents_note: 'The agents it runs act as you and can run commands on this computer.',
  terminal_on:
    'Terminal: on. You can open a full shell on this computer, as you, from your Computer page. ' +
    'Turn it off on this machine with `clawmeets computer terminal disable`.',
  terminal_off: 'Terminal: off. Turn it on on this machine with `clawmeets computer terminal enable`.',
}

afterEach(cleanup)

describe('TrustPanel', () => {
  it('says the terminal is on, with the command that turns it off as code', () => {
    render(<TrustPanel consent={CONSENT} terminalEnabled />)
    expect(screen.getByText('What this connection can do')).toBeTruthy()
    expect(screen.getByText('The server can ask this computer to do only a fixed set of things:')).toBeTruthy()
    expect(screen.getByText(CONSENT.agents_note)).toBeTruthy()
    expect(screen.getByText(/Terminal: on\./)).toBeTruthy()
    const code = screen.getByText('clawmeets computer terminal disable')
    expect(code.tagName).toBe('CODE')
    expect(screen.queryByText(/Terminal: off\./)).toBeNull()
  })

  it('says the terminal is off when the machine turned it off', () => {
    render(<TrustPanel consent={CONSENT} terminalEnabled={false} />)
    expect(screen.getByText(/Terminal: off\./)).toBeTruthy()
    expect(screen.getByText('clawmeets computer terminal enable').tagName).toBe('CODE')
    expect(screen.queryByText(/Terminal: on\./)).toBeNull()
  })

  it('claims neither when the machine is too old to say', () => {
    render(<TrustPanel consent={CONSENT} terminalEnabled={null} />)
    expect(screen.queryByText(/Terminal: on\./)).toBeNull()
    expect(screen.queryByText(/Terminal: off\./)).toBeNull()
    expect(screen.getByText(/update this computer's software/)).toBeTruthy()
  })

  it('renders nothing until the server has answered', () => {
    const { container } = render(<TrustPanel consent={undefined} terminalEnabled />)
    expect(container.innerHTML).toBe('')
  })
})

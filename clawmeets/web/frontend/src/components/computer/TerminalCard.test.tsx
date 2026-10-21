import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Computer } from '../../api/endpoints/computers'
import { ApiError } from '../../api/client'
import TerminalCard from './TerminalCard'

/**
 * The card's four states, and what "Open terminal" does with the server's
 * answer. The panel itself (xterm + socket) is stubbed: jsdom cannot draw a
 * terminal, and the wire rules are tested in `terminalProtocol.test.ts`.
 */

const createTerminalTicket = vi.fn()

vi.mock('../../api/endpoints/computers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/computers')>()
  return {
    ...actual,
    createTerminalTicket: (...args: unknown[]) => createTerminalTicket(...args),
  }
})

vi.mock('./TerminalPanel', () => ({
  default: ({ ticket, computerName }: { ticket: string; computerName: string }) => (
    <div>
      Terminal session active on {computerName} with {ticket}
    </div>
  ),
}))

const LAPTOP: Computer = {
  id: 'abcdef0123456789',
  owner_user_id: 'u1',
  name: 'MacBook Pro',
  hostname: 'mbp.local',
  platform: 'macOS',
  os_version: '15.6',
  created_at: '2026-09-01T09:00:00Z',
  last_seen_at: new Date().toISOString(),
  revoked_at: null,
  daemon_version: '0.2.0',
  agents: [],
  agents_reported_at: new Date().toISOString(),
  last_command: null,
  connected: true,
  status: 'online',
  running_count: 0,
  agent_count: 0,
  model_clis: null,
  model_clis_checked_at: '',
  model_cli_ready: null,
  terminal_enabled: true,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TerminalCard', () => {
  it('a computer that is off: says so, and the button is disabled', () => {
    render(<TerminalCard computer={{ ...LAPTOP, status: 'off', connected: false }} />)
    expect(screen.getByText('Turn this computer on to open a terminal.')).toBeTruthy()
    const open = screen.getByRole('button', { name: /Open terminal/ }) as HTMLButtonElement
    expect(open.disabled).toBe(true)
  })

  it('software too old to say: asks for the update, offers no button', () => {
    render(<TerminalCard computer={{ ...LAPTOP, terminal_enabled: null }} />)
    expect(screen.getByText("Update this computer's software to use the terminal.")).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open terminal/ })).toBeNull()
  })

  it('treats a missing field (an older server) as too old to say', () => {
    const { terminal_enabled: _omit, ...older } = LAPTOP
    render(<TerminalCard computer={older} />)
    expect(screen.getByText("Update this computer's software to use the terminal.")).toBeTruthy()
  })

  it('turned off on the machine: says so and gives the command, not a toggle', () => {
    render(<TerminalCard computer={{ ...LAPTOP, terminal_enabled: false }} />)
    expect(screen.getByText('Off. It was turned off on this computer.')).toBeTruthy()
    expect(screen.getByText('clawmeets computer terminal enable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open terminal/ })).toBeNull()
  })

  it('on: says what it is, how to turn it off, and opens a session with a ticket', async () => {
    createTerminalTicket.mockResolvedValue({ ticket: 'tkt-1', expires_in: 60 })
    render(<TerminalCard computer={LAPTOP} />)
    expect(screen.getByText('On. Runs commands as you on this computer.')).toBeTruthy()
    expect(screen.getByText('clawmeets computer terminal disable')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Open terminal/ }))
    })
    expect(createTerminalTicket).toHaveBeenCalledWith(LAPTOP.id, expect.objectContaining({
      cols: expect.any(Number), rows: expect.any(Number),
    }))
    await screen.findByText('Terminal session active on MacBook Pro with tkt-1')
    expect(screen.queryByRole('button', { name: /Open terminal/ })).toBeNull()
  })

  it("shows the server's refusal verbatim and draws no terminal", async () => {
    createTerminalTicket.mockRejectedValue(
      new ApiError(409, 'This computer already has 3 terminal sessions open.'),
    )
    render(<TerminalCard computer={LAPTOP} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Open terminal/ }))
    })
    await screen.findByText('This computer already has 3 terminal sessions open.')
    expect(screen.queryByText(/Terminal session active/)).toBeNull()
    expect((screen.getByRole('button', { name: /Open terminal/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../stores/authStore'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { Computer, ComputerConsent } from '../../api/endpoints/computers'
import ComputerPage from './ComputerPage'

/**
 * The computer page, rendered the way an owner sees it.
 *
 * The mock boundary is the ENDPOINT MODULE, not the hooks: `useComputers` and
 * `useComputerCommand` run for real against a real QueryClient. What is most
 * likely to be wrong here is not the markup but whether a button's command
 * actually reaches the route with the right agent, and whether a machine that
 * cannot hear us has its buttons turned off — a mocked hook would assert both
 * of those away.
 *
 * The two behaviours worth a test at this level:
 *
 * 1. **An unreachable computer offers nothing it cannot deliver.** Every remote
 *    control is disabled and the typeable commands change to ones that fit the
 *    state. Buttons that look live on an unreachable machine are how a user ends
 *    up believing they started something they did not.
 * 2. **The trust panel renders before any action, from the SERVER's list.** The
 *    page claims that list is complete; rendering a hardcoded one would let the
 *    claim drift from what is enforced.
 */

const getComputers = vi.fn()
const getComputerConsent = vi.fn()
const runComputerCommand = vi.fn()

vi.mock('../../api/endpoints/computers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/computers')>()
  return {
    ...actual,
    getComputers: () => getComputers(),
    getComputerConsent: () => getComputerConsent(),
    runComputerCommand: (...args: unknown[]) => runComputerCommand(...args),
  }
})

const CONSENT: ComputerConsent = {
  allowed: [
    { action: 'start', label: 'Start one of your agents' },
    { action: 'stop', label: 'Stop one of your agents' },
    { action: 'restart', label: 'Restart one of your agents' },
    { action: 'status', label: 'Report which of them are running' },
    { action: 'update', label: 'Update the ClawMeets software on it (clawmeets and its connection software)' },
  ],
  never: [
    'Delete an agent — only you can, here in the browser',
    'Reach any other computer or account',
  ],
  agents_note: 'The agents it runs act as you and can run commands on this computer.',
  terminal_on:
    'Terminal: on. You can open a full shell on this computer, as you, from your Computer page. ' +
    'Turn it off on this machine with `clawmeets computer terminal disable`.',
  terminal_off: 'Terminal: off. Turn it on on this machine with `clawmeets computer terminal enable`.',
}

const LAPTOP: Computer = {
  id: 'abcdef0123456789',
  owner_user_id: 'u1',
  name: 'MacBook Pro',
  hostname: 'Chengtaos-MacBook-Pro.local',
  platform: 'macOS',
  os_version: '15.6',
  created_at: '2026-09-01T09:00:00Z',
  last_seen_at: new Date().toISOString(),
  revoked_at: null,
  daemon_version: '0.1.0',
  agents: [
    { short_name: 'wine', name: 'chengtao-wine', state: 'running', pid: 42 },
    { short_name: 'ops', name: 'chengtao-ops', state: 'crashed', pid: null },
  ],
  agents_reported_at: new Date().toISOString(),
  last_command: null,
  connected: true,
  status: 'online',
  running_count: 1,
  agent_count: 2,
}

function renderPage(computer: Computer, entry = `/computers/${computer.id}`) {
  getComputers.mockResolvedValue([computer])
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/computers/:computerId" element={<ComputerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

/** What a HOST_SYNC does in the app: the machine re-reported, so refetch. */
async function machineReports(queryClient: QueryClient, computer: Computer) {
  getComputers.mockResolvedValue([computer])
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['computers'] })
  })
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  getComputerConsent.mockResolvedValue(CONSENT)
  runComputerCommand.mockResolvedValue({
    command_id: 'c1', action: 'start', agent: 'ops', dispatched: true,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAuthStore.getState().logout()
})

describe('a healthy computer', () => {
  it('folds the allowlist and the nevers from the server under the ⓘ beside the name', async () => {
    renderPage({ ...LAPTOP, terminal_enabled: true })
    const info = await screen.findByRole('button', { name: 'What this connection can do' })
    expect(screen.queryByText(CONSENT.allowed[0].label)).toBeNull()
    fireEvent.click(info)
    expect(info.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('The server can ask this computer to do only a fixed set of things:')).toBeTruthy()
    for (const item of CONSENT.allowed) {
      expect(screen.getByText(item.label)).toBeTruthy()
    }
    expect(screen.getByText(CONSENT.agents_note)).toBeTruthy()
    expect(screen.getByText('Delete an agent — only you can, here in the browser')).toBeTruthy()
    // The old promises are gone: agents run commands, and the terminal is a shell.
    expect(screen.queryByText(/Run any other command/)).toBeNull()
    expect(screen.queryByText(/complete list/)).toBeNull()
  })

  it('keeps Disconnect visible without unfolding anything', async () => {
    renderPage(LAPTOP)
    expect(await screen.findByRole('button', { name: /Disconnect/ })).toBeTruthy()
  })

  it('offers a terminal on a computer that has it on', async () => {
    renderPage({ ...LAPTOP, terminal_enabled: true }, `/computers/${LAPTOP.id}?section=terminal`)
    const open = await screen.findByRole('button', { name: /Open terminal/ })
    expect((open as HTMLButtonElement).disabled).toBe(false)
  })

  it('says an agent stopped on its own rather than merely "Stopped"', async () => {
    renderPage(LAPTOP)
    // The difference between "I turned it off" and "something went wrong".
    await screen.findByText('Stopped on its own')
  })

  it('starting an agent sends that agent, and does not pretend it worked', async () => {
    renderPage(LAPTOP)
    const start = await screen.findByRole('button', { name: /^Start$/ })
    await act(async () => {
      fireEvent.click(start)
    })
    await waitFor(() => expect(runComputerCommand).toHaveBeenCalledWith(
      LAPTOP.id, 'start', 'ops',
    ))
    // The row still reads as stopped: only the machine knows whether the start
    // took, and it says so on its next check-in. Flipping the row optimistically
    // would be the same lie this surface exists to stop telling.
    expect(screen.getByText('Stopped on its own')).toBeTruthy()
  })
})

describe('a computer that is on with nothing running', () => {
  const idle: Computer = {
    ...LAPTOP,
    running_count: 0,
    agents: LAPTOP.agents.map((a) => ({ ...a, state: 'stopped' as const, pid: null })),
  }

  it('says so in its own words, and offers one button for all of them', async () => {
    renderPage(idle)
    await screen.findByText('Your computer is on, but none of your agents are running.')
    const startAll = screen.getByRole('button', { name: /Start all/ })
    await act(async () => {
      fireEvent.click(startAll)
    })
    // N separate commands, because the allowlist has no "start everything".
    await waitFor(() => expect(runComputerCommand).toHaveBeenCalledTimes(2))
    expect(runComputerCommand).toHaveBeenCalledWith(idle.id, 'start', 'wine')
    expect(runComputerCommand).toHaveBeenCalledWith(idle.id, 'start', 'ops')
  })
})

describe('a computer that cannot be reached', () => {
  const off: Computer = {
    ...LAPTOP,
    connected: false,
    status: 'off',
    last_seen_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
    running_count: 0,
    agents: LAPTOP.agents.map((a) => ({ ...a, state: 'stopped' as const, pid: null })),
  }

  it('turns every remote control off rather than offering a dead button', async () => {
    renderPage(off)
    await screen.findByText(/is off, asleep, or not on the internet/)
    for (const button of screen.getAllByRole('button', { name: /Start/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Start/ })[0])
    })
    expect(runComputerCommand).not.toHaveBeenCalled()
  })

  it('promises the queue and disclaims an outage, so nobody resends or waits on us', async () => {
    renderPage(off)
    await screen.findByText(/you don't need to send them again/)
    expect(screen.getByText(/not a ClawMeets outage/)).toBeTruthy()
  })

  it('reports the roster as last known rather than as current', async () => {
    renderPage(off)
    await screen.findByText('Last known: 0 of 2 running')
  })
})

describe('a computer that is awake but not answering', () => {
  const stale: Computer = {
    ...LAPTOP,
    connected: false,
    status: 'not_answering',
    last_seen_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  }

  it('sends the user to the keyboard, with the reconnect command first', async () => {
    renderPage(stale)
    await screen.findByText('Reconnect from the computer')
    // Shown whole and copyable: this is the state the page itself cannot fix.
    expect(screen.getByText('clawmeets computer start')).toBeTruthy()
  })
})

describe('the section list', () => {
  it('shows one section at a time and switches from the left-hand list', async () => {
    renderPage({ ...LAPTOP, terminal_enabled: true })
    await screen.findByText('Agents on this computer')
    expect(screen.queryByRole('button', { name: /Open terminal/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }))
    expect(await screen.findByRole('button', { name: /Open terminal/ })).toBeTruthy()
    expect(screen.queryByText('Agents on this computer')).toBeNull()
  })
})

describe('a failed command explains itself', () => {
  const failed: Computer = {
    ...LAPTOP,
    last_command: {
      command_id: 'c0',
      action: 'start',
      agent: 'ops',
      ok: false,
      detail: 'Could not find the clawmeets command on this computer',
      finished_at: new Date().toISOString(),
    },
  }

  it('surfaces why, so the button does not merely appear to do nothing', async () => {
    renderPage(failed)
    await screen.findByText(/Could not find the clawmeets command/)
  })

  it('stays quiet when the last command succeeded', async () => {
    renderPage({
      ...failed,
      last_command: { ...failed.last_command!, ok: true, detail: 'Started ops' },
    })
    await screen.findByText('Agents on this computer')
    expect(screen.queryByText('Started ops')).toBeNull()
  })
})

describe('a button waits for the machine, not for the request', () => {
  it('says "Stopping…" until the machine reports that stop finished', async () => {
    runComputerCommand.mockResolvedValue({
      command_id: 'stop-1', action: 'stop', agent: 'wine', dispatched: true,
    })
    const { queryClient } = renderPage(LAPTOP)
    const stop = await screen.findByRole('button', { name: /Stop$/ })
    await act(async () => {
      fireEvent.click(stop)
    })
    await waitFor(() => expect(runComputerCommand).toHaveBeenCalledWith(LAPTOP.id, 'stop', 'wine'))

    // The route has answered, but the machine has not: still waiting.
    const busy = screen.getByRole('button', { name: /Stopping…/ }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull()

    // An unrelated check-in (same roster, no result for this command) does
    // not release it.
    await machineReports(queryClient, { ...LAPTOP })
    expect(screen.getByRole('button', { name: /Stopping…/ })).toBeTruthy()

    // The machine answers THIS command: the row now offers Start.
    await machineReports(queryClient, {
      ...LAPTOP,
      running_count: 0,
      agents: LAPTOP.agents.map((a) => ({ ...a, state: 'stopped' as const, pid: null })),
      last_command: {
        command_id: 'stop-1', action: 'stop', agent: 'wine', ok: true,
        detail: 'Stopped wine', finished_at: new Date().toISOString(),
      },
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stopping…/ })).toBeNull())
  })

  it('keeps "Restarting…" until the agent is back under a new pid', async () => {
    runComputerCommand.mockResolvedValue({
      command_id: 'r-1', action: 'restart', agent: 'wine', dispatched: true,
    })
    const { queryClient } = renderPage(LAPTOP)
    const target = await screen.findByRole('button', { name: /Restart/ })
    await act(async () => {
      fireEvent.click(target)
    })
    await screen.findByRole('button', { name: /Restarting…/ })

    // Mid-restart scan: stopped, not yet back.
    await machineReports(queryClient, {
      ...LAPTOP,
      agents: [{ ...LAPTOP.agents[0], state: 'stopped', pid: null }, LAPTOP.agents[1]],
    })
    expect(screen.getByRole('button', { name: /Restarting…/ })).toBeTruthy()

    await machineReports(queryClient, {
      ...LAPTOP,
      agents: [{ ...LAPTOP.agents[0], pid: 43 }, LAPTOP.agents[1]],
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Restarting…/ })).toBeNull())
    expect(screen.getByRole('button', { name: /Restart/ })).toBeTruthy()
  })

  it('leaves the other rows usable while one is waiting', async () => {
    runComputerCommand.mockResolvedValue({
      command_id: 'stop-1', action: 'stop', agent: 'wine', dispatched: true,
    })
    renderPage(LAPTOP)
    const target = await screen.findByRole('button', { name: /Stop$/ })
    await act(async () => {
      fireEvent.click(target)
    })
    await screen.findByRole('button', { name: /Stopping…/ })
    const start = screen.getByRole('button', { name: /^Start$/ }) as HTMLButtonElement
    expect(start.disabled).toBe(false)
  })

  it('says why when nothing could be sent, and gives the button back', async () => {
    runComputerCommand.mockRejectedValue(
      new Error('MacBook Pro is not reachable right now, so nothing was sent.'),
    )
    renderPage(LAPTOP)
    const target = await screen.findByRole('button', { name: /Stop$/ })
    await act(async () => {
      fireEvent.click(target)
    })
    await screen.findByText(/Couldn't stop wine\. MacBook Pro is not reachable/)
    expect(screen.queryByRole('button', { name: /Stopping…/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Stop$/ })).toBeTruthy()
  })

  it('"Start all" counts down as each agent comes up, without resending', async () => {
    const idle: Computer = {
      ...LAPTOP,
      running_count: 0,
      agents: LAPTOP.agents.map((a) => ({ ...a, state: 'stopped' as const, pid: null })),
    }
    const { queryClient } = renderPage(idle)
    const target = await screen.findByRole('button', { name: /Start all/ })
    await act(async () => {
      fireEvent.click(target)
    })
    await screen.findByRole('button', { name: /Starting 2…/ })
    expect(screen.getAllByRole('button', { name: /Starting…/ })).toHaveLength(2)

    await machineReports(queryClient, {
      ...idle,
      running_count: 1,
      agents: [{ ...idle.agents[0], state: 'running', pid: 50 }, idle.agents[1]],
    })
    await screen.findByRole('button', { name: /Starting 1…/ })

    await machineReports(queryClient, {
      ...idle,
      running_count: 2,
      agents: [
        { ...idle.agents[0], state: 'running', pid: 50 },
        { ...idle.agents[1], state: 'running', pid: 51 },
      ],
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Starting/ })).toBeNull())
    expect(runComputerCommand).toHaveBeenCalledTimes(2)
  })
})

describe('an account with no computers', () => {
  it('lands on the empty state instead of a blank page', async () => {
    getComputers.mockResolvedValue([])
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/computers']}>
          <Routes>
            <Route path="/computers" element={<ComputerPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText('No computers connected yet')
    expect(screen.getByRole('button', { name: 'Connect a computer' })).toBeTruthy()
  })
})

describe('software updates', () => {
  it('updates ClawMeets on the computer with one click', async () => {
    renderPage({ ...LAPTOP, runner_version: '0.9.1', daemon_version: '0.4.0' }, `/computers/${LAPTOP.id}?section=software`)
    await screen.findByText('0.9.1')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update ClawMeets on this computer' }))
    })
    expect(runComputerCommand).toHaveBeenCalledWith(LAPTOP.id, 'update', undefined)
    expect(screen.getByText('Updating…')).toBeTruthy()
  })

  it("shows an update's failure on the software card, not the agents card", async () => {
    renderPage({
      ...LAPTOP,
      last_command: {
        command_id: 'u1', action: 'update', agent: null,
        ok: false, detail: 'clawmeets: could not update (pip: no network)', finished_at: new Date().toISOString(),
      },
    }, `/computers/${LAPTOP.id}?section=software`)
    await screen.findByText("Couldn't update. clawmeets: could not update (pip: no network)")
    expect(screen.queryByText("Couldn't update.")).toBeNull()
  })
})

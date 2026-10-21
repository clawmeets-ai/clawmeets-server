import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RetainedAgent } from '../../api/endpoints/hub'
import { hubAgent, retainedAgent } from '../../test/hubFixtures'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import RetainButton, { UnretainAction } from './RetainButton'

const api = vi.hoisted(() => ({
  retainHubAgent: vi.fn(),
  unretainHubAgent: vi.fn(),
  listRetained: vi.fn(),
}))
vi.mock('../../api/endpoints/hub', async (orig) => ({
  ...(await orig<typeof import('../../api/endpoints/hub')>()),
  retainHubAgent: (...a: unknown[]) => api.retainHubAgent(...a),
  unretainHubAgent: (...a: unknown[]) => api.unretainHubAgent(...a),
  listRetained: () => api.listRetained(),
}))

let retained: RetainedAgent[]
let ownAgents: Array<{ name: string; registered_by: string }> = []
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: ownAgents }) }))
vi.mock('../../stores/authStore', async (orig) => ({
  ...(await orig<typeof import('../../stores/authStore')>()),
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: 'me' } }),
}))
const agent = hubAgent()

function renderWith(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
  return qc
}

beforeEach(() => {
  retained = []
  api.listRetained.mockImplementation(() => Promise.resolve(retained))
  api.retainHubAgent.mockImplementation((id: string) => {
    const row = retainedAgent({ hub_agent_id: id })
    retained = [row]
    return Promise.resolve(row)
  })
  api.unretainHubAgent.mockImplementation(() => { retained = []; return Promise.resolve() })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Retain on a remote agent', () => {
  it('Retain → dialog → POST → the "Retained" badge', async () => {
    renderWith(<RetainButton agent={agent} />)
    fireEvent.click(await screen.findByTestId('retain-button'))
    expect(screen.getByTestId('retain-dialog')).toBeTruthy()
    await act(async () => { fireEvent.click(within(screen.getByTestId('retain-dialog')).getByRole('button', { name: 'Retain' })) })
    expect(api.retainHubAgent).toHaveBeenCalledWith(agent.hub_agent_id)
    expect((await screen.findByTestId('retained-badge')).textContent).toBe(RETAIN_COPY.retained)
    expect(screen.queryByTestId('retain-dialog')).toBeNull()
  })

  it('a refused retain shows its sentence inside the dialog', async () => {
    const { ApiError } = await import('../../api/client')
    api.retainHubAgent.mockRejectedValueOnce(new ApiError(403, 'x', { detail: { code: 'own_agent', message: '' } }))
    renderWith(<RetainButton agent={agent} />)
    fireEvent.click(await screen.findByTestId('retain-button'))
    fireEvent.click(within(screen.getByTestId('retain-dialog')).getByRole('button', { name: 'Retain' }))
    expect((await screen.findByTestId('retain-error')).textContent).toMatch(/is yours/)
  })

  it("another person's agent on this server (is_local) can be retained; your own gets no button", async () => {
    const local = hubAgent({ is_local: true, name: 'bo-helper' })
    ownAgents = [{ name: 'me-writer', registered_by: 'me' }]
    renderWith(<RetainButton agent={local} />)
    expect(await screen.findByTestId('retain-button')).toBeTruthy()
    cleanup()
    renderWith(<RetainButton agent={hubAgent({ is_local: true, name: 'me-writer' })} />)
    expect(screen.queryByTestId('retain-button')).toBeNull()
    expect(screen.queryByTestId('retained-badge')).toBeNull()
    ownAgents = []
  })

  it('Unretain asks first when the agent is in rooms ("It leaves N rooms")', async () => {
    retained = [retainedAgent({ hub_agent_id: agent.hub_agent_id, live_rooms: 2 })]
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderWith(<UnretainAction agent={{ ...agent, retained: true }} />)
    await waitFor(() => expect((screen.getByTestId('unretain') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('unretain'))
    expect(confirm.mock.calls[0][0]).toMatch(/It leaves 2 rooms/)
    expect(api.unretainHubAgent).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('unretain')).toBeTruthy())
    fireEvent.click(screen.getByTestId('unretain'))
    await waitFor(() => expect(api.unretainHubAgent).toHaveBeenCalledWith(agent.hub_agent_id))
  })

  it('Unretain with no live rooms does not ask', async () => {
    retained = [retainedAgent({ hub_agent_id: agent.hub_agent_id, live_rooms: 0 })]
    const confirm = vi.spyOn(window, 'confirm')
    renderWith(<UnretainAction agent={{ ...agent, retained: true }} />)
    await waitFor(() => expect((screen.getByTestId('unretain') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('unretain'))
    await waitFor(() => expect(api.unretainHubAgent).toHaveBeenCalled())
    expect(confirm).not.toHaveBeenCalled()
  })
})

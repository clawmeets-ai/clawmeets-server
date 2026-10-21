import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RetainedAgent } from '../../api/endpoints/hub'
import { hubConfig, retainedAgent } from '../../test/hubFixtures'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import RetainedList from './RetainedList'

const api = vi.hoisted(() => ({ listRetained: vi.fn(), retainHubAgent: vi.fn(), getHubConfig: vi.fn() }))
vi.mock('../../api/endpoints/hub', async (orig) => ({
  ...(await orig<typeof import('../../api/endpoints/hub')>()),
  listRetained: () => api.listRetained(),
  retainHubAgent: (...a: unknown[]) => api.retainHubAgent(...a),
  getHubConfig: () => api.getHubConfig(),
}))

const navigate = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))

let rows: RetainedAgent[]
function renderList(listedNow: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><RetainedList listedNow={new Set(listedNow)} /></QueryClientProvider>)
}

beforeEach(() => {
  rows = []
  api.listRetained.mockImplementation(() => Promise.resolve(rows))
  api.getHubConfig.mockResolvedValue(hubConfig())
  api.retainHubAgent.mockImplementation((id: string) => Promise.resolve(retainedAgent({ hub_agent_id: id })))
})
afterEach(cleanup)

const a = retainedAgent({ name: 'alpha', live_rooms: 3 })
const b = retainedAgent({ name: 'beta', state: 'unlisted' })
const c = retainedAgent({ name: 'gamma', state: 'identity_changed' })

describe('the retained list', () => {
  it('one row each, with the state chips and live_rooms', async () => {
    rows = [a, b, c, retainedAgent({ name: 'delta', state: 'surprise' }), retainedAgent({ name: 'eps', live_rooms: 0 })]
    renderList()
    expect(await screen.findAllByTestId('retained-row')).toHaveLength(5)
    expect(screen.getByTestId('retained-live').textContent).toBe(RETAIN_COPY.inRooms(3))
    expect(screen.getByTestId('retained-unlisted').textContent).toBe(RETAIN_COPY.unlisted)
    expect(screen.getByTestId('retained-identity').textContent).toBe(RETAIN_COPY.identityChangedChip)
    expect(screen.getByTestId('retained-unknown').textContent).toBe(RETAIN_COPY.unknownState)
    expect(screen.getAllByTestId('retained-live')).toHaveLength(1)
  })

  it('an unlisted row the directory shows listed reads "Listed again — retain?" and opens the dialog', async () => {
    rows = [b]
    renderList([b.hub_agent_id])
    fireEvent.click(await screen.findByTestId('retained-listed-again'))
    expect(screen.getByTestId('retain-dialog')).toBeTruthy()
    expect(screen.queryByTestId('retain-identity')).toBeNull()
  })

  it('"Retain again" opens the dialog with the identity line, and posts', async () => {
    rows = [c]
    renderList()
    fireEvent.click(await screen.findByTestId('retained-retain-again'))
    expect(screen.getByTestId('retain-identity')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retain' }))
    await waitFor(() => expect(api.retainHubAgent).toHaveBeenCalledWith(c.hub_agent_id))
  })

  it('empty, and the hub off', async () => {
    renderList()
    expect((await screen.findByTestId('retained-empty')).textContent).toBe(RETAIN_COPY.noneRetained)
    cleanup()
    api.getHubConfig.mockResolvedValue(hubConfig({ mode: 'off' }))
    renderList()
    expect((await screen.findByTestId('retained-hub-off')).textContent).toBe(RETAIN_COPY.hubOff)
  })

  it('remote text renders as text', async () => {
    rows = [retainedAgent({ name: 'x', description: '<img src=x onerror=alert(1)>' })]
    renderList()
    await screen.findByTestId('retained-row')
    expect(document.querySelector('img')).toBeNull()
  })

  it('an agent of this server reads "On this server" and Message opens its DM', async () => {
    rows = [retainedAgent({ name: 'bo-helper', is_local: true, agent_id: 'b1', hub_agent_id: 'fp~bo-helper' }),
      retainedAgent({ name: 'cy-gone', is_local: true, agent_id: 'c1', hub_agent_id: 'fp~cy-gone', state: 'unlisted' })]
    renderList(['fp~cy-gone'])
    expect(await screen.findAllByTestId('retained-local')).toHaveLength(2)
    expect(screen.getByTestId('retained-unlisted').textContent).toBe(RETAIN_COPY.noLongerShared)
    expect(screen.queryByTestId('retained-listed-again')).toBeNull()
    const [message] = screen.getAllByTestId('retained-message')                // active rows only
    fireEvent.click(message)
    expect(navigate).toHaveBeenCalledWith('/dm/bo-helper')
  })
})

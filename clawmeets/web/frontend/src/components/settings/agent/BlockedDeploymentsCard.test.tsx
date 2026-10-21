import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BlockedDeployment } from '../../../api/endpoints/hub'
import { FP_ACME, FP_OTHER, NOW_S } from '../../../test/hubFixtures'
import BlockedDeploymentsCard from './BlockedDeploymentsCard'

/** Blocked servers: one row per genesis fingerprint, the current key only when
 *  it differs, Unblock by the genesis fingerprint, names as text. */

const api = vi.hoisted(() => ({
  listBlockedDeployments: vi.fn(),
  unblockDeployment: vi.fn(),
}))
vi.mock('../../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../../api/endpoints/hub')>()
  return {
    ...real,
    listBlockedDeployments: (...a: unknown[]) => api.listBlockedDeployments(...a),
    unblockDeployment: (...a: unknown[]) => api.unblockDeployment(...a),
  }
})

const AGENT = 'alice-researcher'
const row = (o: Partial<BlockedDeployment> = {}): BlockedDeployment => ({
  deployment_fingerprint: FP_ACME, deployment_name: 'spam.example', created_at: NOW_S - 86400, ...o,
})

function renderCard(rows: BlockedDeployment[]) {
  api.listBlockedDeployments.mockResolvedValue(rows)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <BlockedDeploymentsCard agentFullName={AGENT} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BlockedDeploymentsCard', () => {
  it('says when nothing is blocked', async () => {
    renderCard([])
    expect(await screen.findByText('No servers blocked.')).toBeTruthy()
    expect(api.listBlockedDeployments).toHaveBeenCalledWith(AGENT)
  })

  it('shows the name, the genesis fp, and "current key" only when the key rotated', async () => {
    renderCard([
      row(),
      row({ deployment_fingerprint: FP_OTHER, deployment_name: 'rotated.example', current_fingerprint: '5ac2e019ffff' }),
      row({ deployment_fingerprint: '77b0e1d4aaaa', deployment_name: 'same.example', current_fingerprint: '77b0e1d4aaaa' }),
    ])
    const rows = await screen.findAllByTestId('blocked-deployment')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('spam.example')
    expect(rows[0].textContent).toContain(`fp ${FP_ACME.slice(0, 8)}`)
    expect(rows[0].textContent).not.toContain('current key')
    expect(rows[0].textContent).toContain('· since ')
    expect(rows[1].textContent).toContain('current key 5ac2e019')
    expect(rows[2].textContent).not.toContain('current key')
  })

  it('Unblock sends the genesis fingerprint and shows the list it gets back', async () => {
    renderCard([row({ current_fingerprint: '5ac2e019ffff' })])
    api.unblockDeployment.mockResolvedValue([])
    fireEvent.click(await screen.findByRole('button', { name: 'Unblock spam.example' }))
    await waitFor(() => expect(api.unblockDeployment).toHaveBeenCalledWith(AGENT, FP_ACME))
    expect(await screen.findByText('No servers blocked.')).toBeTruthy()
  })

  it('renders a hostile server name as text, without invisible characters', async () => {
    renderCard([row({ deployment_name: '<b>evil</b>‮example' })])
    const [r] = await screen.findAllByTestId('blocked-deployment')
    expect(r.textContent).toContain('<b>evil</b>example')
    expect(r.querySelector('b')).toBeNull()
  })
})

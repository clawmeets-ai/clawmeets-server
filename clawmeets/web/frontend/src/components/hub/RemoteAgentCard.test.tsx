import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { hubAgent } from '../../test/hubFixtures'
import { withQueryClient } from '../../test/queryWrapper'

vi.mock('../../hooks/useHub', async (orig) => ({
  ...(await orig<typeof import('../../hooks/useHub')>()),
  useHubAvatar: () => null,
}))

import RemoteAgentCard from './RemoteAgentCard'

afterEach(cleanup)

describe('RemoteAgentCard capability chips', () => {
  it('repeated capabilities, or ones made identical by safeRemoteText, all render with no duplicate-key warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<RemoteAgentCard agent={hubAgent({ capabilities: ['research', 'research', 'a​b', 'ab'] })} onMessage={() => {}} />, { wrapper: withQueryClient })
    expect(screen.getAllByText('research')).toHaveLength(2)
    expect(screen.getAllByText('ab')).toHaveLength(2)
    expect(err.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false)
    err.mockRestore()
  })
})

describe('RemoteAgentCard "Reported"', () => {
  it('a report filed from one card turns every card for that agent to "Reported", with no remount', async () => {
    const { act } = await import('@testing-library/react')
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
    const { createElement } = await import('react')
    const endpoints = await import('../../api/endpoints/hub')
    vi.spyOn(endpoints, 'reportHubAgent').mockResolvedValue(undefined)
    const { useReportHubAgent } = await import('../../hooks/useHub')
    const id = 'cccccccccccccccc~scout'
    let report: ReturnType<typeof useReportHubAgent> | null = null
    function Reporter() {
      report = useReportHubAgent()
      return null
    }
    const qc = new QueryClient()
    render(createElement(QueryClientProvider, { client: qc },
      createElement(RemoteAgentCard, { agent: hubAgent({ hub_agent_id: id }), onMessage: () => {} }),
      createElement(RemoteAgentCard, { agent: hubAgent({ hub_agent_id: id }), onMessage: () => {} }),
      createElement(Reporter)))
    await act(async () => { await report!.mutateAsync({ hubAgentId: id, reason: 'spam' }) })
    for (const more of screen.getAllByRole('button', { name: /More/ })) more.click()
    await act(async () => {})
    expect(screen.getAllByRole('menuitem', { name: 'Reported' })).toHaveLength(2)
  })
})

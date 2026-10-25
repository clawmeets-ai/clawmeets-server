import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { HubChannel } from '../../../api/endpoints/hub'
import { hubChannel } from '../../../test/hubFixtures'
import { hubChannelKey } from '../../../hooks/useHub'
import { HUB_CARD_COPY } from '../../../utils/hubChannelView'
import HubDispatchSetting from './HubDispatchSetting'

/** The Hub tab's dispatch switch: PUT …/dispatch with the switch and the cap,
 *  the answer replacing the cached channel, and the cap's bounds. */

const api = vi.hoisted(() => ({ setHubDispatch: vi.fn() }))
vi.mock('../../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../../api/endpoints/hub')>()
  return { ...real, setHubDispatch: (...a: unknown[]) => api.setHubDispatch(...a) }
})

const AGENT = 'alice-researcher'

function renderSetting(ch: Partial<HubChannel>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const channel = hubChannel({ enabled: true, status: 'connected', ...ch })
  queryClient.setQueryData(hubChannelKey(AGENT), channel)
  render(
    <QueryClientProvider client={queryClient}>
      <HubDispatchSetting channel={channel} agentFullName={AGENT} />
    </QueryClientProvider>,
  )
  return queryClient
}

const sw = () => screen.getByRole('switch', { name: HUB_CARD_COPY.dispatchLabel })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HubDispatchSetting', () => {
  it('is off by default and turning it on sends the cap', async () => {
    const updated = hubChannel({ enabled: true, accept_dispatch: true, dispatch_daily_cap: 20, dispatched_today: 0 })
    api.setHubDispatch.mockResolvedValue(updated)
    const qc = renderSetting({})
    expect(sw().getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw())
    await waitFor(() => expect(api.setHubDispatch).toHaveBeenCalledWith(AGENT, true, 20))
    await waitFor(() => expect(qc.getQueryData(hubChannelKey(AGENT))).toEqual(updated))
  })

  it('shows today\'s count while on and saves a new cap on blur', async () => {
    api.setHubDispatch.mockResolvedValue(hubChannel({ enabled: true, accept_dispatch: true, dispatch_daily_cap: 7 }))
    renderSetting({ accept_dispatch: true, dispatch_daily_cap: 20, dispatched_today: 3 })
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('hub-dispatch-today').textContent).toBe('3 of 20 routed requests today')
    const input = screen.getByLabelText(HUB_CARD_COPY.dispatchCapLabel)
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.setHubDispatch).toHaveBeenCalledWith(AGENT, true, 7))
  })

  it('refuses a cap outside 1-200', () => {
    renderSetting({})
    const input = screen.getByLabelText(HUB_CARD_COPY.dispatchCapLabel)
    fireEvent.change(input, { target: { value: '500' } })
    fireEvent.blur(input)
    fireEvent.click(sw())
    expect(sw().getAttribute('aria-disabled')).toBe('true')
    expect(api.setHubDispatch).not.toHaveBeenCalled()
  })
})

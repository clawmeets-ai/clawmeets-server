import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import { HUB_CONFIG_KEY } from '../../hooks/useHub'
import { hubConfig } from '../../test/hubFixtures'
import HubAvatar from './HubAvatar'

/**
 * Avatars are fetched with the bearer token through getFile() (an <img src>
 * pointing at the route would 401), shown from an object URL, keyed on the
 * listing's refresh time, and fall back to initials on any failure.
 */

const getFile = vi.hoisted(() => vi.fn())
vi.mock('../../api/client', async (orig) => {
  const real = await orig<typeof import('../../api/client')>()
  return { ...real, getFile: (...a: unknown[]) => getFile(...a) }
})

const URL_PATH = '/api/hub/agents/3f9a1c2e5b7d9f00~scout/avatar'
let qc: QueryClient

function renderAvatar(props: Partial<Parameters<typeof HubAvatar>[0]> = {}) {
  return render(
    <QueryClientProvider client={qc}>
      <HubAvatar avatarUrl={URL_PATH} refreshedAt={100} name="scout" {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:avatar-1'), revokeObjectURL: vi.fn() }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  getFile.mockReset()
})

describe('HubAvatar', () => {
  it('fetches the PNG through getFile() with the bearer token and shows a blob URL, never the route', async () => {
    getFile.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const { container } = renderAvatar()
    const img = await screen.findByTestId('hub-avatar-img')
    expect(getFile).toHaveBeenCalledWith(URL_PATH)
    expect(img.getAttribute('src')).toBe('blob:avatar-1')
    expect(container.innerHTML).not.toContain('/api/hub/agents/')
  })

  it('the cache is keyed on listing_refreshed_at: a newer refresh fetches again, the same one does not', async () => {
    getFile.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const { rerender } = renderAvatar({ refreshedAt: 100 })
    await screen.findByTestId('hub-avatar-img')
    const again = (at: number) => (
      <QueryClientProvider client={qc}><HubAvatar avatarUrl={URL_PATH} refreshedAt={at} name="scout" /></QueryClientProvider>
    )
    rerender(again(100))
    expect(getFile).toHaveBeenCalledTimes(1)
    rerender(again(200))
    await waitFor(() => expect(getFile).toHaveBeenCalledTimes(2))
  })

  it.each([
    ['a 404 avatar_not_set', () => Promise.reject(new ApiError(404, 'avatar_not_set'))],
    ['a 503 with nothing cached', () => Promise.reject(new ApiError(503, 'hub_unreachable'))],
    ['a non-PNG body', () => Promise.resolve(new Blob(['<svg/>'], { type: 'image/svg+xml' }))],
  ])('%s shows the initials', async (_label, answer) => {
    getFile.mockImplementation(answer)
    renderAvatar()
    await waitFor(() => expect(getFile).toHaveBeenCalled())
    expect((await screen.findByTestId('hub-avatar-initials')).textContent).toBe('S')
    expect(screen.queryByTestId('hub-avatar-img')).toBeNull()
  })

  it('a URL that is not the same-origin proxy path is never fetched', async () => {
    renderAvatar({ avatarUrl: 'https://evil.dev/track.png' })
    expect(screen.getByTestId('hub-avatar-initials')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 10))
    expect(getFile).not.toHaveBeenCalled()
  })

  it('loads with the hub off (read-only, never gated) and a null avatar_url shows initials', async () => {
    qc.setQueryData(HUB_CONFIG_KEY, hubConfig({ mode: 'off', registration: 'none' }))
    getFile.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    renderAvatar()
    await screen.findByTestId('hub-avatar-img')
    cleanup()
    renderAvatar({ avatarUrl: null, name: '​zed' })
    expect(screen.getByTestId('hub-avatar-initials').textContent).toBe('Z')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { DeskUpdate } from './useDeskUpdates'

/**
 * A sign-off has to land in "Recently done" on the SIGNING device without
 * depending on the WebSocket.
 *
 * The server does echo DESK_READ_STATE_SYNC back to the originating session, so
 * the socket would normally do it — but the card is dropped from the live lane
 * optimistically, the instant the PUT is issued. With the socket down or
 * mid-reconnect the card is then in neither the live lane nor the sign-off
 * section until a remount or a focus refetch past the 30s staleTime, which
 * reads as data loss. Hence the local invalidation, and hence this test: it is
 * the only thing standing between the fix and a silent regression the WS would
 * mask in every environment where the socket happens to be up.
 */

const putDeskReadState = vi.fn(() =>
  Promise.resolve({
    project_id: 'p1',
    chatroom_name: 'user-communication',
    last_seen_message_id: 'm1',
    updated_at: '2035-01-01T00:00:00+00:00',
  }),
)

vi.mock('../api/endpoints/deskReadState', () => ({
  putDeskReadState: (...args: unknown[]) => putDeskReadState(...(args as [])),
  getDeskReadState: () => Promise.resolve([]),
}))

const { useMarkDeskRead } = await import('./useDeskReadState')

const ITEM = {
  projectId: 'p1',
  latestMessageId: 'm1',
} as DeskUpdate

afterEach(cleanup)

describe('useMarkDeskRead', () => {
  it('invalidates the sign-off feed itself, without the WS echo', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useMarkDeskRead(), { wrapper })
    result.current.markRead(ITEM)

    await waitFor(() => expect(putDeskReadState).toHaveBeenCalledTimes(1))
    // Prefix, not the full key — the hook has no idea how many cards the
    // section asks for, and ['desk-sign-offs'] prefix-matches every variant.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['desk-sign-offs'] }),
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['desk-read-state'] })
  })

  it('does not touch either cache when the PUT fails', async () => {
    putDeskReadState.mockRejectedValueOnce(new Error('offline'))
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const onError = vi.fn()

    const { result } = renderHook(() => useMarkDeskRead(), { wrapper })
    result.current.markRead(ITEM, onError)

    // The store rolls back and the card reappears on the live lane; refetching
    // the sign-off feed here would only re-confirm the row isn't there.
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(invalidate).not.toHaveBeenCalled()
  })
})

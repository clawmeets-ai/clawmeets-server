import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/** Each id is fetched once per room: a new message asks for its own id only. */

const asked: string[][] = []
let answer: (ids: string[]) => Promise<unknown[]> = () => Promise.resolve([])
vi.mock('../api/endpoints/hub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/endpoints/hub')>()),
  listBridgeDeliveries: (_p: string, _r: string, ids: string[]) => {
    asked.push(ids)
    return answer(ids)
  },
}))
const row = (id: string) => ({ room_message_id: id, hub_agent_id: 'h1', state: 'relayed' })
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}
const { useBridgeDeliveries, BRIDGE_IDS_PER_REQUEST } = await import('./useAgentAccess')

afterEach(() => cleanup())

describe('bridge deliveries', () => {
  it('fetches only the ids not fetched before in the room', async () => {
    asked.length = 0
    const { rerender } = renderHook(({ ids }) => useBridgeDeliveries('p1', 'work', ids, true), {
      wrapper: wrapper(), initialProps: { ids: ['m1', 'm2'] },
    })
    await waitFor(() => expect(asked).toEqual([['m1', 'm2']]))
    rerender({ ids: ['m1', 'm2', 'm3'] })
    await waitFor(() => expect(asked).toEqual([['m1', 'm2'], ['m3']]))
    rerender({ ids: ['m1', 'm2', 'm3'] })
    await new Promise((r) => setTimeout(r, 20))
    expect(asked).toHaveLength(2)
  })

  it('a request still in flight when a new id arrives is neither repeated nor lost', async () => {
    asked.length = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    answer = async (ids) => { if (ids.includes('m1')) await gate; return ids.map(row) }
    const { result, rerender } = renderHook(({ ids }) => useBridgeDeliveries('p2', 'work', ids, true), {
      wrapper: wrapper(), initialProps: { ids: ['m1'] },
    })
    await waitFor(() => expect(asked).toEqual([['m1']]))
    rerender({ ids: ['m1', 'm2'] })
    await waitFor(() => expect(asked).toEqual([['m1'], ['m2']]))
    release()
    await waitFor(() => expect(Object.keys(result.current).sort()).toEqual(['m1', 'm2']))
  })

  it('a failed chunk keeps the rows earlier chunks fetched, and asks again only from it on', async () => {
    asked.length = 0
    const ids = Array.from({ length: BRIDGE_IDS_PER_REQUEST + 1 }, (_, i) => `m${i}`)
    const last = ids[ids.length - 1]
    let failLast = true
    answer = async (chunk) => {
      if (failLast && chunk.includes(last)) throw new Error('down')
      return chunk.map(row)
    }
    const { result, rerender } = renderHook(({ ids }) => useBridgeDeliveries('p3', 'work', ids, true), {
      wrapper: wrapper(), initialProps: { ids },
    })
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(BRIDGE_IDS_PER_REQUEST))
    // The kept rows change the missing list, so the failed chunk is asked once
    // more at once, and then not again until the id list changes.
    await waitFor(() => expect(asked).toHaveLength(3))
    await new Promise((r) => setTimeout(r, 20))
    expect(asked.slice(1)).toEqual([[last], [last]])
    failLast = false
    rerender({ ids: [...ids, 'new'] })
    await waitFor(() => expect(asked).toHaveLength(4))
    expect(asked[3]).toEqual([last, 'new'])
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(ids.length + 1))
  })
})

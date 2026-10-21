import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { DeskUpdate } from '../../hooks/useDeskUpdates'
import type { ParticipantInfo } from '../../api/endpoints/hub'
import { participantInfo } from '../../test/hubFixtures'

/**
 * A My Desk card quotes the newest message of a project's user-communication
 * room, and for a host-side Hub Request that is a stranger's message. The card
 * asks the same trust rule as the room (hooks/useRoomTrust: the whole room,
 * and the quote's author), and passes the answer on to its quote, its files
 * and the Forward preview it opens.
 */

let untrusted = false
const trustAsked: [string, string][] = []
vi.mock('../../hooks/useUntrustedBodies', () => ({
  useUntrustedBodies: (projectId: string, room: string) => {
    trustAsked.push([projectId, room])
    return untrusted
  },
}))
// The room's participants, as the server lists them; the owner is u-owner.
let roomInfo: ParticipantInfo[] | undefined = [participantInfo('a-support')]
vi.mock('../../hooks/useProjects', () => ({
  useChatroom: () => ({ data: roomInfo === undefined ? undefined : { participant_info: roomInfo } }),
  useUserProjects: () => ({ data: [{ id: 'p-req', created_by: 'u-owner' }] }),
  useProject: () => ({ data: undefined }),
}))
const viewerProps: { untrusted?: boolean }[] = []
vi.mock('../files/FileViewerModal', () => ({
  default: (p: { untrusted?: boolean }) => { viewerProps.push(p); return null },
}))
vi.mock('../../api/endpoints/deskReadState', () => ({
  putDeskReadState: () => Promise.resolve({}),
  getDeskReadState: () => Promise.resolve([]),
}))
vi.mock('../../api/endpoints/messages', () => ({ sendUserMessage: () => Promise.resolve({}) }))
vi.mock('../../hooks/useProjectReport', () => ({ useProjectReport: () => ({ data: null }) }))

const UpdateCard = (await import('./UpdateCard')).default
type Handle = import('./UpdateCard').UpdateCardHandle

const HOSTILE = 'Hi ![pixel](https://x.example/p.png?u=owner) and [click](javascript:alert(1))'

afterEach(() => {
  cleanup()
  untrusted = false
  trustAsked.length = 0
  roomInfo = [participantInfo('a-support')]
  viewerProps.length = 0
})

function card(ref = createRef<Handle>(), o: Partial<DeskUpdate> = {}) {
  const u: DeskUpdate = {
    projectId: 'p-req', lane: 'reply', kind: 'dm', agent: null, agentName: 'support',
    sourceName: 'Request', roomLabel: 'direct message', title: 'Request', quote: HOSTILE,
    quoteAuthorId: 'a-support', quoteOutsideIsolated: false, ts: '2035-01-01T00:00:00+00:00', latestMessageId: 'm1',
    files: [], navTo: '/dm/support/p-req', plan: null, reportPublishedAt: null, ...o,
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UpdateCard ref={ref} item={u} onOpen={vi.fn()} onToast={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return ref
}

const imgs = () => document.querySelectorAll('img[src*="x.example"]')
const jsLinks = () =>
  [...document.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'))

describe('a My Desk card quoting a Hub requester', () => {
  it('asks the room\'s trust rule, and its quote draws no <img> and no javascript: anchor', () => {
    untrusted = true
    card()
    expect(trustAsked).toContainEqual(['p-req', 'user-communication'])
    expect(screen.getAllByText(/Hi/).length).toBeGreaterThan(0)
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
  })

  it('has no Forward button, and its forward shortcut does nothing', () => {
    untrusted = true
    const ref = card(undefined, { quoteAuthorId: 'contact:k1', quoteFromContact: 'scout@acme.dev' })
    expect(screen.queryByTestId('card-forward')).toBeNull()
    act(() => ref.current!.forward())
    expect(screen.queryByText(/Forwarded from/)).toBeNull()
  })

  it('a trusted room\'s card keeps its Forward button, and the shortcut opens the dialog', async () => {
    const ref = card()
    expect(screen.getByTestId('card-forward')).toBeTruthy()
    act(() => ref.current!.forward())
    expect(await screen.findByText(/Forwarded from/)).toBeTruthy()
  })

  it('a trusted room\'s card still draws the image', () => {
    card()
    expect(imgs().length).toBe(1)
  })
})

describe('a My Desk card in a room the whole-room rule trusts: per author', () => {
  it('a Telegram contact\'s message is outside: untrusted quote, no Forward, files open untrusted', () => {
    // The row's channel is Telegram, so the whole room is trusted; the
    // contact still is not (it is missing from participant_info).
    const ref = card(undefined, {
      quoteAuthorId: 'contact:k1', quoteFromContact: 'Mara',
      files: [{ filename: 'menu.md', entryType: 'file_created' }],
    })
    expect(imgs().length).toBe(0)
    expect(jsLinks().length).toBe(0)
    expect(screen.queryByTestId('card-forward')).toBeNull()
    act(() => ref.current!.forward())
    expect(screen.queryByText(/Forwarded from/)).toBeNull()
    fireEvent.click(screen.getByText('menu.md'))
    expect(viewerProps.at(-1)?.untrusted).toBe(true)
  })

  it('another account\'s agent listed outside:true is untrusted too', () => {
    roomInfo = [participantInfo('a-theirs', { outside: true })]
    card(undefined, { quoteAuthorId: 'a-theirs' })
    expect(imgs().length).toBe(0)
    expect(screen.queryByTestId('card-forward')).toBeNull()
  })

  it('a quote stamped outside_isolated is untrusted even from an agent listed inside', () => {
    card(undefined, { quoteOutsideIsolated: true })
    expect(imgs().length).toBe(0)
    expect(screen.queryByTestId('card-forward')).toBeNull()
  })

  it('fails closed while the room has no participant list', () => {
    roomInfo = undefined
    card()
    expect(imgs().length).toBe(0)
    expect(screen.queryByTestId('card-forward')).toBeNull()
  })

  it('a signed-off card (no author on the wire) is untrusted when the room has an outside participant', () => {
    roomInfo = [participantInfo('a-support'), participantInfo('contact:k1', { kind: 'user', outside: true })]
    card(undefined, { quoteAuthorId: null })
    expect(imgs().length).toBe(0)
    expect(screen.queryByTestId('card-forward')).toBeNull()
  })

  it('an own agent listed outside:false stays trusted, and its files open trusted', () => {
    card(undefined, { files: [{ filename: 'menu.md', entryType: 'file_created' }] })
    expect(imgs().length).toBe(1)
    expect(screen.getByTestId('card-forward')).toBeTruthy()
    fireEvent.click(screen.getByText('menu.md'))
    expect(viewerProps.at(-1)?.untrusted).toBe(false)
  })
})

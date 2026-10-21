import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import type { ChannelThread, HeldReply } from '../../api/endpoints/channels'
import ChannelThreadNotice, { THREAD_NOTICE_COPY } from './ChannelThreadNotice'

/**
 * The "window closed" notice above a channel thread. The thread endpoint is
 * mocked; everything else is real.
 */

const api = vi.hoisted(() => ({ getChannelThread: vi.fn() }))
vi.mock('../../api/endpoints/channels', () => ({
  getChannelThread: (...a: unknown[]) => api.getChannelThread(...a),
}))

const CLOSED_AT = 1_760_000_000
const XSS = '<img src=x onerror=alert(1)>'

function held(over: Partial<HeldReply> = {}): HeldReply {
  return { message_id: 'm1', part_index: 0, text: 'Your table is booked.', reason: 'window_closed', held_at: CLOSED_AT, ...over }
}

function thread(over: Partial<ChannelThread> = {}): ChannelThread {
  return {
    project_id: 'p1', channel: 'whatsapp', paused: false, contact_name: 'Mara Quintero',
    window_closed_at: null, held: [],
    ...over,
  }
}

function renderNotice(messageCount = 3) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (count: number) => (
    <QueryClientProvider client={queryClient}>
      <ChannelThreadNotice projectId="p1" messageCount={count} />
    </QueryClientProvider>
  )
  const view = render(ui(messageCount))
  return { ...view, rerenderWith: (count: number) => view.rerender(ui(count)) }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChannelThreadNotice', () => {
  it('renders nothing, silently, when the project is not a channel thread (404)', async () => {
    api.getChannelThread.mockRejectedValue(new ApiError(404, 'Not a channel thread'))
    const { container } = renderNotice()
    await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledWith('p1'))
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders nothing on any other error', async () => {
    api.getChannelThread.mockRejectedValue(new ApiError(500, 'boom'))
    const { container } = renderNotice()
    await waitFor(() => expect(api.getChannelThread).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing while the window is open', async () => {
    api.getChannelThread.mockResolvedValue(thread({ window_closed_at: null }))
    const { container } = renderNotice()
    await waitFor(() => expect(api.getChannelThread).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('window closed with 2 held: says "2 replies", names the contact, lists both texts in order as Not sent', async () => {
    api.getChannelThread.mockResolvedValue(thread({
      window_closed_at: CLOSED_AT,
      held: [held({ message_id: 'm1', text: 'Your table is booked.' }), held({ message_id: 'm2', text: 'See you at 8.' })],
    }))
    renderNotice()
    const text = await screen.findByTestId('channel-thread-notice-text')
    expect(text.textContent).toBe(
      "WhatsApp's 24-hour window has closed. 2 replies were held and won't be sent. Mara Quintero has to write again before the agent can answer.",
    )
    const items = screen.getAllByTestId('channel-thread-held')
    expect(items).toHaveLength(2)
    expect(screen.getAllByTestId('channel-thread-held-text').map((n) => n.textContent)).toEqual([
      'Your table is booked.', 'See you at 8.',
    ])
    for (const item of items) expect(item.textContent).toContain(THREAD_NOTICE_COPY.notSent)
  })

  it('reads singular for 1 held reply', async () => {
    api.getChannelThread.mockResolvedValue(thread({ window_closed_at: CLOSED_AT, held: [held()] }))
    renderNotice()
    expect((await screen.findByTestId('channel-thread-notice-text')).textContent).toContain(
      "1 reply was held and won't be sent.",
    )
  })

  it('counts a reply held as two parts once, and shows both parts', async () => {
    api.getChannelThread.mockResolvedValue(thread({
      window_closed_at: CLOSED_AT,
      held: [held({ part_index: 0, text: 'Part one.' }), held({ part_index: 1, text: 'Part two.' })],
    }))
    renderNotice()
    expect((await screen.findByTestId('channel-thread-notice-text')).textContent).toContain(
      "1 reply was held and won't be sent.",
    )
    expect(screen.getAllByTestId('channel-thread-held-text').map((n) => n.textContent)).toEqual([
      'Part one.', 'Part two.',
    ])
  })

  it('the contact name and held text never become markup', async () => {
    api.getChannelThread.mockResolvedValue(thread({
      window_closed_at: CLOSED_AT, contact_name: XSS, held: [held({ text: XSS })],
    }))
    const { container } = renderNotice()
    const text = await screen.findByTestId('channel-thread-notice-text')
    expect(text.textContent).toContain(`${XSS} has to write again`)
    expect(screen.getByTestId('channel-thread-held-text').textContent).toBe(XSS)
    expect(container.querySelector('img')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('asks again when a new message arrives, and goes away once the window is open again', async () => {
    api.getChannelThread.mockResolvedValueOnce(thread({ window_closed_at: CLOSED_AT, held: [held()] }))
    const { rerenderWith } = renderNotice(3)
    await screen.findByTestId('channel-thread-notice')
    api.getChannelThread.mockResolvedValue(thread({ window_closed_at: null }))
    rerenderWith(4)
    await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('channel-thread-notice')).toBeNull())
  })

  it('a reply that may already have reached the contact is not called "Not sent"', async () => {
    api.getChannelThread.mockResolvedValue(thread({
      window_closed_at: CLOSED_AT,
      held: [
        held({ message_id: 'm1', text: 'Timed out once.', reason: 'window_closed_maybe_sent' }),
        held({ message_id: 'm2', text: 'Never tried.' }),
      ],
    }))
    renderNotice()
    const items = await screen.findAllByTestId('channel-thread-held')
    expect(items[0].textContent).toContain(THREAD_NOTICE_COPY.maybeSent)
    expect(items[0].textContent).not.toContain(THREAD_NOTICE_COPY.notSent)
    expect(items[1].textContent).toContain(THREAD_NOTICE_COPY.notSent)
  })

  it('asks again every minute with no new message, so a later hold shows up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      api.getChannelThread.mockResolvedValueOnce(thread({ window_closed_at: null }))
      renderNotice(3)
      await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledTimes(1))
      expect(screen.queryByTestId('channel-thread-notice')).toBeNull()
      api.getChannelThread.mockResolvedValue(thread({ window_closed_at: CLOSED_AT, held: [held()] }))
      await vi.advanceTimersByTimeAsync(60_000)
      await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledTimes(2))
      await screen.findByTestId('channel-thread-notice')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a 404 (not a channel thread) asks exactly once, not every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      api.getChannelThread.mockRejectedValue(new ApiError(404, 'Not a channel thread'))
      renderNotice(3)
      await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(api.getChannelThread).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a 200 keeps asking: a second call after 61 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      api.getChannelThread.mockResolvedValue(thread({ window_closed_at: null }))
      renderNotice(3)
      await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(61_000)
      await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('a 200 then a 404 (connection removed): polling stops and the notice goes away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      api.getChannelThread.mockResolvedValueOnce(thread({ window_closed_at: CLOSED_AT, held: [held()] }))
      renderNotice(3)
      await screen.findByTestId('channel-thread-notice')
      api.getChannelThread.mockRejectedValue(new ApiError(404, 'Not a channel thread'))
      await vi.advanceTimersByTimeAsync(60_000)
      await waitFor(() => expect(api.getChannelThread).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.queryByTestId('channel-thread-notice')).toBeNull())
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(api.getChannelThread).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

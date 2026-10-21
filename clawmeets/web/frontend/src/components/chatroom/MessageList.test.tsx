import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatMessage } from '../../types'
import { buildRecipientStatusIndex } from './recipientStatus'

/**
 * `?msg=` deep-link landing, the second half of ⌘K message search.
 *
 * The failure this file exists for: MessageList already pins to the bottom on
 * every messages change, and that layout effect and scroll-to-target write the
 * same scrollTop. Untreated the pin wins, so click-through *looks* like it
 * works and silently drops the user at the end of the room. That is invisible
 * to a manual smoke test on a short room, which is exactly why it is pinned
 * here.
 */

// MessageItem pulls in the auth store, react-query and react-markdown; none of
// that is under test. The stub keeps the one thing MessageList depends on —
// the `data-message-id` anchor — honest.
vi.mock('./MessageItem', () => ({
  default: ({
    messages,
    highlightMessageId,
  }: {
    messages: ChatMessage[]
    highlightMessageId?: string | null
  }) => (
    <>
      {messages.map((m) => (
        <div
          key={m.id}
          data-message-id={m.id}
          data-flashing={m.id === highlightMessageId ? 'yes' : 'no'}
        >
          {m.content}
        </div>
      ))}
    </>
  ),
}))

const { default: MessageList } = await import('./MessageList')

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    entry_type: 'message',
    id,
    ts: `2026-07-26T10:0${id.slice(-1)}:00.000000Z`,
    from_participant_id: `p-${id}`,
    from_participant_name: `sender-${id}`,
    content: `body of ${id}`,
    expects_response_from: [],
    ...over,
  }
}

const MESSAGES = [msg('m1'), msg('m2'), msg('m3')]

/** scrollTop writes made by the pin-to-bottom layout effect. */
let scrollTopWrites: number[] = []
let scrollIntoView: ReturnType<typeof vi.fn>

function list(props: Partial<Parameters<typeof MessageList>[0]> = {}) {
  return render(
    <MessageList
      isOutsideAuthor={() => false}
      messages={MESSAGES}
      agents={[]}
      chatroomName="shared-context"
      statusIndex={buildRecipientStatusIndex(MESSAGES, [], [])}
      {...props}
    />,
  )
}

describe('MessageList — ?msg= deep-link target', () => {
  beforeEach(() => {
    scrollTopWrites = []
    scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    // jsdom does no layout: scrollHeight is always 0 and scrollTop is a no-op.
    // Stub both so the pin-to-bottom write is observable.
    Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    })
    Object.defineProperty(HTMLDivElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (v: number) => scrollTopWrites.push(v),
    })
  })

  afterEach(() => {
    cleanup()
    // @ts-expect-error — removing the stubs restores jsdom's own accessors.
    delete HTMLDivElement.prototype.scrollHeight
    // @ts-expect-error — ditto.
    delete HTMLDivElement.prototype.scrollTop
    vi.useRealTimers()
  })

  it('pins to the bottom when there is no target (the existing behaviour)', () => {
    list()
    expect(scrollTopWrites).toEqual([1000])
  })

  it('scrolls to the target and suppresses the pin-to-bottom', async () => {
    const onTargetResolved = vi.fn()
    list({ targetMessageId: 'm2', onTargetResolved })

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    // The pin never ran: the user lands on m2, not at the end of the room.
    expect(scrollTopWrites).toEqual([])
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(scrollIntoView.mock.instances[0]).toBe(
      document.querySelector('[data-message-id="m2"]'),
    )
    expect(onTargetResolved).toHaveBeenCalledWith(true)
  })

  it('flashes the target, then drops the tint', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    list({ targetMessageId: 'm2' })

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="m2"]')?.getAttribute('data-flashing')).toBe(
        'yes',
      ),
    )
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(
      document.querySelector('[data-message-id="m2"]')?.getAttribute('data-flashing'),
    ).toBe('no')
  })

  it('resolves once, so a background refetch cannot re-scroll the user', async () => {
    const onTargetResolved = vi.fn()
    const { rerender } = list({ targetMessageId: 'm2', onTargetResolved })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))

    // Same target, new message array — what a WebSocket-driven refetch looks like.
    rerender(
      <MessageList
        isOutsideAuthor={() => false}
        messages={[...MESSAGES, msg('m4')]}
        agents={[]}
        chatroomName="shared-context"
        statusIndex={buildRecipientStatusIndex(MESSAGES, [], [])}
        targetMessageId="m2"
        onTargetResolved={onTargetResolved}
      />,
    )
    await waitFor(() => expect(screen.getByText('body of m4')).toBeTruthy())
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(onTargetResolved).toHaveBeenCalledTimes(1)
  })

  /**
   * Review finding 5. The one-shot latch is per *cycle*, not for the lifetime
   * of the component: a same-room deep link only changes the query string, so
   * nothing remounts MessageList and a latch that never comes off makes the
   * second click on a hit a no-op — no scroll, no flash, and `?msg=` left in
   * the address bar because `onTargetResolved` never fires.
   *
   * The sequence below IS the repro: land on m2, let the view strip `?msg=`
   * (the null rerender), then arrive at the same target again.
   */
  it('lands on the SAME target twice — the latch is per cycle, not for ever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onTargetResolved = vi.fn()
    const { rerender } = list({ targetMessageId: 'm2', onTargetResolved })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(onTargetResolved).toHaveBeenNthCalledWith(1, true)
    expect(
      document.querySelector('[data-message-id="m2"]')?.getAttribute('data-flashing'),
    ).toBe('yes')

    // Let the first flash expire, so a tint seen after the second click is a
    // NEW flash rather than the first one still running.
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(
      document.querySelector('[data-message-id="m2"]')?.getAttribute('data-flashing'),
    ).toBe('no')

    // What clearTarget() does to this component: `?msg=` is gone, so the prop
    // arrives as null. (Proved end-to-end in useMessageDeepLink.test.tsx.)
    rerender(
      <MessageList
        isOutsideAuthor={() => false}
        messages={MESSAGES}
        agents={[]}
        chatroomName="shared-context"
        statusIndex={buildRecipientStatusIndex(MESSAGES, [], [])}
        targetMessageId={null}
        onTargetResolved={onTargetResolved}
      />,
    )

    // ⌘K again, same phrase, same hit.
    rerender(
      <MessageList
        isOutsideAuthor={() => false}
        messages={MESSAGES}
        agents={[]}
        chatroomName="shared-context"
        statusIndex={buildRecipientStatusIndex(MESSAGES, [], [])}
        targetMessageId="m2"
        onTargetResolved={onTargetResolved}
      />,
    )

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center' })
    expect(scrollIntoView.mock.instances[1]).toBe(
      document.querySelector('[data-message-id="m2"]'),
    )
    // Flashes again...
    expect(
      document.querySelector('[data-message-id="m2"]')?.getAttribute('data-flashing'),
    ).toBe('yes')
    // ...and resolves again, which is what strips `?msg=` the second time.
    expect(onTargetResolved).toHaveBeenNthCalledWith(2, true)
    // Still never pins to the bottom instead.
    expect(scrollTopWrites).toEqual([])
  })

  it('gives up on a deleted message inside the bounded window and says so', async () => {
    const onTargetResolved = vi.fn()
    list({ targetMessageId: 'gone', onTargetResolved })

    // The window is ~2 s of real time; rAF keeps retrying until it expires.
    await waitFor(() => expect(onTargetResolved).toHaveBeenCalledWith(false), { timeout: 5000 })
    expect(scrollIntoView).not.toHaveBeenCalled()
    const note = await screen.findByText('That message is no longer in this room.')
    expect(note).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText('That message is no longer in this room.')).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect as reactUseEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskUpdate } from '../../hooks/useDeskUpdates'

/**
 * The single invariant "Recently done" rests on: **Mark Done writes the
 * read-state watermark and Reply Back does not.**
 *
 * Every row in the desk read-state store is what the section counts, so if Reply
 * Back ever writes one again the label silently over-claims — a card you
 * *replied to* would be badged "Done". There is no other guard: the store
 * records no intent, so this test is the boundary.
 *
 * Asserted at `putDeskReadState`, the network edge, rather than at the hook —
 * the point is that nothing reaches the store, by any path.
 *
 * DONE NOW HAS A SECOND WRITE — it completes the project — and the pins for
 * that live here too, because they are pins on the same button: the two writes
 * fire in a fixed order, both card kinds fire them, and a failed completion
 * fires neither.
 */

const putDeskReadState = vi.fn(() =>
  Promise.resolve({
    project_id: 'p1',
    chatroom_name: 'user-communication',
    last_seen_message_id: 'm1',
    updated_at: '2035-01-01T00:00:00+00:00',
  }),
)
const sendUserMessage = vi.fn(() => Promise.resolve({}))
// Recorded in `calls` alongside the watermark write so ORDER is observable —
// two independent spies would only prove both happened.
const calls: string[] = []
const completeProject = vi.fn(() => {
  calls.push('complete')
  return Promise.resolve({ status: 'completed', changed: true })
})

vi.mock('../../api/endpoints/deskReadState', () => ({
  putDeskReadState: (...args: unknown[]) => {
    calls.push('markRead')
    return putDeskReadState(...(args as []))
  },
  getDeskReadState: () => Promise.resolve([]),
}))
vi.mock('../../api/endpoints/messages', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...(args as [])),
}))
vi.mock('../../api/endpoints/projects', () => ({
  completeProject: (...args: unknown[]) => completeProject(...(args as [])),
}))
const sendHubDraft = vi.fn(() => Promise.resolve({}))
vi.mock('../../hooks/useHub', () => ({
  sendHubDraft: (...args: unknown[]) => sendHubDraft(...(args as [])),
}))
vi.mock('../../hooks/useProjectReport', () => ({ useProjectReport: () => ({ data: null }) }))

/**
 * THE STAGED BATCH, FAKED AT THE BAND'S EDGE. `planSend` reaches the card by one
 * route only — `PlanBand`'s `onSendState` — so standing in for the band is
 * standing in for the whole editor, and the card under test is untouched.
 *
 * `staged` is null by default, which is the honest default: a card with a plan
 * whose reader has decided nothing holds no batch. The band is also the reason
 * this is a MOUNTED stub rather than a prop — `CardBand` renders no children
 * while folded, so an unmounted band reports `null` on the way out, which is the
 * behaviour the "folding clears the count" rule depends on.
 */
const staged = { current: null as { count: number; submit: () => void } | null }
const submitSpy = vi.fn()
vi.mock('./PlanBand', () => ({
  PlanBand: ({ onSendState }: { onSendState?: (s: unknown) => void }) => {
    // Read at RENDER and reported from an effect keyed on what was read, so a
    // test that empties the batch and re-renders is heard — which is the whole
    // point of the disarm case below.
    const batch = staged.current
    reactUseEffect(() => {
      onSendState?.(batch && { ...batch, submitting: false, discard: () => {} })
      return () => onSendState?.(null)
    }, [onSendState, batch])
    return createElement('div', { 'data-testid': 'plan-band' })
  },
}))

const UpdateCard = (await import('./UpdateCard')).default

const ITEM: DeskUpdate = {
  projectId: 'p1',
  lane: 'reply',
  kind: 'dm',
  agent: null,
  agentName: 'ana-analyst',
  sourceName: 'ana-analyst',
  roomLabel: 'direct message',
  title: 'Q3 numbers are in',
  quote: 'Here are the numbers.',
  ts: '2035-01-01T00:00:00+00:00',
  latestMessageId: 'm1',
  files: [],
  navTo: '/dm/ana-analyst/p1',
}

const toast = vi.fn()

function renderCard(item: DeskUpdate = ITEM) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    ...render(
      <QueryClientProvider client={client}>
        <UpdateCard item={item} onOpen={vi.fn()} onToast={toast} />
      </QueryClientProvider>,
    ),
    client,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  calls.length = 0
  completeProject.mockClear()
  completeProject.mockImplementation(() => {
    calls.push('complete')
    return Promise.resolve({ status: 'completed', changed: true })
  })
  putDeskReadState.mockClear()
  sendUserMessage.mockClear()
  sendHubDraft.mockClear()
  toast.mockClear()
  submitSpy.mockClear()
  staged.current = null
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

/**
 * THE ADAPTIVE ACTION ROW — every action is always there, and what moves is
 * which one is PRIMARY.
 *
 *   rows staged    -> Send review · N   | Reply Back · Mark Done
 *   comments open  -> Start review      | Reply Back · Mark Done
 *   nothing open   -> Mark Done         | Reply Back
 *
 * The complaint it answers: a user who has just replied to four agent comments
 * reads `Done` as the next step. That is a reasonable reading, because `Done`
 * is where the eye ends up — it was the primary, it never moved, and the
 * review's own `Send review` was inside a box that scrolls with the card. Both
 * halves are answered by the review's own button being the primary here, which
 * is why this file asserts the PRIMARY CLASS and not mere presence.
 *
 * `Mark Done` ITSELF IS NEVER WITHHELD. Taking it off the card answered the
 * same complaint twice and charged for it: a reader who wants a thread off the
 * desk while the coordinator has questions open had no button at all — on the
 * one card type that always has a question open, since an unconfirmed plan
 * carries the confirm note. Completing over the top of open notes is a decision
 * the user is entitled to, and it is reversible: replying reopens the project
 * with every note still open.
 *
 * THE ONE PRESS IT DOES NOT HONOUR IMMEDIATELY is with a batch staged, because
 * that is the only thing on this card that cannot come back — the rows live in
 * the editor and nothing has posted them. The button asks on itself and the
 * second press does what the new label says.
 */
function planSummary(openForYou: number) {
  return {
    surface: 'regular' as const,
    phase: 'spec-ing',
    revision: 1,
    accepted_revision: null,
    accepted_at: null,
    open_notes_for_you: openForYou,
    deviation: null,
  }
}

const PROJECT_ITEM = { ...ITEM, kind: 'project' } as DeskUpdate

describe('UpdateCard — the adaptive action row', () => {
  it('keeps Mark Done on the card while plan notes wait, but not as the primary', () => {
    renderCard({ ...PROJECT_ITEM, plan: planSummary(3) } as DeskUpdate)
    const done = screen.getByTestId('card-mark-done')
    expect(done.className).not.toContain('md-btn--primary')
    expect(screen.getByTestId('card-start-review').className).toContain('md-btn--primary')
    // Reply Back survives every state — it is never the primary and never
    // competes with the review. Mark Done sits AFTER it, the far end of the row
    // from the primary, so the two are never adjacent under a thumb.
    const row = done.parentElement!
    const order = [...row.children].map((c) => c.getAttribute('data-testid'))
    expect(order.slice(0, 3)).toEqual([
      'card-start-review',
      'card-reply-back',
      'card-mark-done',
    ])
  })

  it('...and one press completes the project, open notes and all', async () => {
    renderCard({ ...PROJECT_ITEM, plan: planSummary(3) } as DeskUpdate)
    fireEvent.click(screen.getByTestId('card-mark-done'))
    await waitFor(() => expect(completeProject).toHaveBeenCalledTimes(1))
  })

  /**
   * THE PLATE REFRESHES OFF THE ROUND TRIP THE CARD ALREADY MADE.
   *
   * Completing a project is exactly the input a linked to-do's ticket chip is
   * derived from, and the 200 here is proof the transition happened. Before
   * this, the chip was refreshed by ONE path only — the `desk_todo_sync` frame
   * the server pushes moments later — so a socket that was down, reconnecting,
   * or merely slow left the chip reading "Working" on a project the user had
   * just marked done, with nothing scheduled to correct it.
   *
   * Asserted on `invalidateQueries` rather than on a rendered chip because the
   * chip lives in the To-do rail, on the other side of the desk: what this card
   * owes the rail is the invalidation, not the pixels.
   *
   * ONLY ON SUCCESS. A completion that failed proves nothing about the
   * project's status, and refetching on it would be a pointless request that
   * re-renders the same stale value.
   */
  it('invalidates the to-do plate on a successful completion — and only then', async () => {
    const { client } = renderCard(PROJECT_ITEM)
    const spy = vi.spyOn(client, 'invalidateQueries')

    fireEvent.click(screen.getByTestId('card-mark-done'))
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ['desk-todos'] }),
    )

    spy.mockClear()
    completeProject.mockImplementation(() => Promise.reject(new Error('nope')))
    cleanup()
    const failed = renderCard(PROJECT_ITEM)
    const failSpy = vi.spyOn(failed.client, 'invalidateQueries')
    fireEvent.click(screen.getByTestId('card-mark-done'))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(failSpy).not.toHaveBeenCalledWith({ queryKey: ['desk-todos'] })
  })

  it('makes Mark Done the primary, and the first button, once nothing is open', () => {
    renderCard({ ...PROJECT_ITEM, plan: planSummary(0) } as DeskUpdate)
    const done = screen.getByTestId('card-mark-done')
    expect(done.className).toContain('md-btn--primary')
    expect(screen.queryByTestId('card-start-review')).toBeNull()
    expect(done.parentElement!.children[0]).toBe(done)
    cleanup()
    // A DM has no plan at all, which answers 0 — there is nothing to review, so
    // the row goes straight to Mark Done.
    renderCard()
    expect(screen.getByTestId('card-mark-done').className).toContain('md-btn--primary')
  })

  it('asks once before discarding a staged review, then completes on the second press', async () => {
    staged.current = { count: 4, submit: submitSpy }
    renderCard({ ...PROJECT_ITEM, plan: planSummary(4) } as DeskUpdate)

    // Send review is the primary; Mark Done is present and quiet.
    expect(screen.getByTestId('card-send-review').className).toContain('md-btn--primary')
    const done = screen.getByTestId('card-mark-done')
    expect(done.className).not.toContain('md-btn--primary')

    fireEvent.click(done)
    // Nothing happened yet, and the button now says what the next press costs.
    expect(completeProject).not.toHaveBeenCalled()
    expect(screen.getByTestId('card-mark-done').textContent).toContain('Discard 4')
    // The toast is for the keyboard door, which never sees the label.
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('4 replies are staged'))

    fireEvent.click(screen.getByTestId('card-mark-done'))
    await waitFor(() => expect(completeProject).toHaveBeenCalledTimes(1))
    // The staged rows are dropped, not sent: Mark Done never submits a review.
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('the keyboard shortcut obeys the same rule the row draws', async () => {
    // `DeskPage`'s shortcut calls the imperative handle directly, so a question
    // asked only by a button's label would be skipped entirely by the keyboard.
    staged.current = { count: 2, submit: submitSpy }
    const ref = { current: null as null | { dismiss: () => void } }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <UpdateCard
          ref={ref as never}
          item={{ ...PROJECT_ITEM, plan: planSummary(2) } as DeskUpdate}
          onOpen={vi.fn()}
          onToast={toast}
        />
      </QueryClientProvider>,
    )
    await act(async () => {
      ref.current?.dismiss()
    })
    expect(completeProject).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('2 replies are staged'))
    await act(async () => {
      ref.current?.dismiss()
    })
    await waitFor(() => expect(completeProject).toHaveBeenCalledTimes(1))
  })

  it('a batch that empties disarms the question', async () => {
    staged.current = { count: 1, submit: submitSpy }
    const { rerender } = renderCard({ ...PROJECT_ITEM, plan: planSummary(1) } as DeskUpdate)
    fireEvent.click(screen.getByTestId('card-mark-done'))
    expect(screen.getByTestId('card-mark-done').textContent).toContain('Discard 1')

    // The review is sent from the card footer: the band reports `null` and the
    // armed button is left asking about a batch nobody is holding.
    staged.current = null
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <UpdateCard
          item={{ ...PROJECT_ITEM, plan: planSummary(0) } as DeskUpdate}
          onOpen={vi.fn()}
          onToast={toast}
        />
      </QueryClientProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('card-mark-done').textContent).not.toContain('Discard'),
    )
    expect(completeProject).not.toHaveBeenCalled()
  })
})


describe('UpdateCard — Reply Back vs Mark Done', () => {
  it('Reply Back posts the message but never writes a sign-off', async () => {
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: /Reply Back/ }))
    // PromptEditor is a contentEditable, not an <input> — it reads the DOM on
    // `input`, so writing textContent and firing that is how it takes a draft.
    const editor = screen.getByRole('textbox')
    editor.textContent = 'try again'
    fireEvent.input(editor)
    fireEvent.click(screen.getByRole('button', { name: /command/ }))

    await waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1))
    expect(sendUserMessage).toHaveBeenCalledWith(
      'p1',
      'user-communication',
      expect.objectContaining({ content: 'try again' }),
    )

    // Past the 340ms window the sign-off path would have used. The card stays
    // on the desk and re-lanes to Working on the active-work broadcast; the
    // store must not have heard about it.
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(putDeskReadState).not.toHaveBeenCalled()
    expect(completeProject).not.toHaveBeenCalled()
  })

  it('Reply Back on a hub thread goes through the hub send route', async () => {
    // The user-message route refuses a hub thread (use_hub_send).
    renderCard({ ...ITEM, agentName: 'far-scout@acme.dev', navTo: '/hub/fp~far-scout/p1', hubThread: true })

    fireEvent.click(screen.getByRole('button', { name: /Reply Back/ }))
    const editor = screen.getByRole('textbox')
    editor.textContent = 'one more thing'
    fireEvent.input(editor)
    fireEvent.click(screen.getByRole('button', { name: /command/ }))

    await waitFor(() => expect(sendHubDraft).toHaveBeenCalledTimes(1))
    expect(sendHubDraft).toHaveBeenCalledWith(expect.anything(), 'p1', 'one more thing', [])
    expect(sendUserMessage).not.toHaveBeenCalled()
  })

  it('Done completes the project, THEN writes exactly one watermark', async () => {
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: /Done/ }))

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await waitFor(() => expect(putDeskReadState).toHaveBeenCalledTimes(1))
    expect(completeProject).toHaveBeenCalledTimes(1)
    expect(completeProject).toHaveBeenCalledWith('p1')
    expect(putDeskReadState).toHaveBeenCalledWith({
      project_id: 'p1',
      chatroom_name: 'user-communication',
      last_seen_message_id: 'm1',
    })
    // THE ORDER IS THE POINT. `markRead` is what removes the card and it rolls
    // itself back on failure; a completion running second could fail silently
    // with the card already gone and the ticket chip still reading Working.
    expect(calls).toEqual(['complete', 'markRead'])
    expect(sendUserMessage).not.toHaveBeenCalled()
  })

  it('a PROJECT card completes too — there is no kind gate', async () => {
    renderCard({ ...ITEM, kind: 'project' })

    fireEvent.click(screen.getByRole('button', { name: /Done/ }))

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await waitFor(() => expect(putDeskReadState).toHaveBeenCalledTimes(1))
    expect(completeProject).toHaveBeenCalledWith('p1')
    expect(calls).toEqual(['complete', 'markRead'])
  })

  it('a FAILED completion leaves the card alone — no watermark, no removal', async () => {
    completeProject.mockImplementation(() => {
      calls.push('complete')
      return Promise.reject(new Error('You do not have permission'))
    })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: /Done/ }))

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await waitFor(() => expect(completeProject).toHaveBeenCalledTimes(1))
    // Nothing reached the store, so the card is still on the desk with its
    // actions intact — the user can read the error and press Done again.
    expect(putDeskReadState).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Done/ })).toBeTruthy()
  })

  it('offers neither action on a done (read-lane) card', () => {
    renderCard({ ...ITEM, lane: 'read' })

    expect(screen.queryByRole('button', { name: /Done/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reply Back/ })).toBeNull()
    // The card itself still renders — it is Open-only, not hidden. (The lane
    // is conveyed by the "Recently done" section heading, not by a pill.)
    expect(screen.getByText('Q3 numbers are in')).toBeTruthy()
  })
})

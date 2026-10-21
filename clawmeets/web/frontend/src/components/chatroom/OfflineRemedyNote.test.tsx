import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import OfflineRemedyNote from './OfflineRemedyNote'

/**
 * The copy IS the deliverable here — a chip that says "offline" without a
 * remedy still ends in a support ticket. Clauses pinned by test rather than by
 * review:
 *
 *  - For an agent that NEVER RECEIVED the message: "still queued … delivered
 *    when the runner reconnects" must survive, and every "send it again"
 *    phrasing must stay absent. The message is durable and catch-up replays it
 *    on reconnect, so telling this user to resend duplicates work on a message
 *    already going to be answered — with 2.5 days of backlog it double-delivers
 *    all of it. Asserted absent, not merely unasserted.
 *  - For an agent that DID receive it and lost its runner mid-work (AC-3.7):
 *    the opposite. Its cursor is already past the message so nothing replays
 *    it; the resend advice must be present, and the "still queued" promise must
 *    NOT be, because it would be a lie about lost work.
 *  - AC-3.3: the note must say this is the user's own machine and not a
 *    clawmeets outage. A user who believes the service is down does not run a
 *    command on their laptop.
 *  - `clawmeets start` must appear literally and be copyable. A remedy the
 *    user has to retype from a screenshot is a remedy they will not run.
 */

afterEach(cleanup)

const ONE = [{ agentId: 'a1', displayName: 'backend' }]
const TWO = [
  { agentId: 'a1', displayName: 'backend' },
  { agentId: 'a2', displayName: 'designer' },
]
const ELEVEN = Array.from({ length: 11 }, (_, i) => ({
  agentId: `a${i}`,
  displayName: `agent-${i}`,
}))

/** Default props: nothing wrong, nothing rendered. */
const none = { neverReceived: [], offlineAtTimeout: [], hasWorkingRecipients: false }

describe('OfflineRemedyNote — never received (dispatch-time offline)', () => {
  it('renders nothing when no recipient is offline', () => {
    const { container } = render(<OfflineRemedyNote {...none} />)
    expect(container.firstChild).toBeNull()
  })

  it('names the offline agent', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={ONE} />,
    )
    expect(container.textContent).toContain('@backend')
    expect(container.textContent).toContain("didn't receive this message")
  })

  it('names every offline agent when there are several', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={TWO} />,
    )
    expect(container.textContent).toContain('@backend and @designer')
  })

  it('says nothing is working on the message — the point is to end the wait', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={ONE} />,
    )
    expect(container.textContent).toContain('nothing is working on it')
  })

  it('promises delivery on reconnect and never tells the user to send again', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={ONE} />,
    )
    const text = (container.textContent ?? '').toLowerCase()
    expect(text).toContain('still queued')
    expect(text).toContain('reconnect')
    expect(text).toContain("you don't need to send it again")
    expect(text).not.toContain('send again')
    expect(text).not.toContain('re-send')
    expect(text).not.toContain('resend')
  })

  it('keeps the plural variant queued too', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={TWO} />,
    )
    const text = (container.textContent ?? '').toLowerCase()
    expect(text).toContain('still queued for them')
    expect(text).not.toContain('send again')
  })
})

/**
 * AC-3.7. The batch_timeout flavour: the agent DID get the message. Every
 * assertion here is the mirror image of the block above, which is the point —
 * merging the two states would make one of these two paragraphs a lie.
 */
describe('OfflineRemedyNote — offline at timeout (received, runner died mid-work)', () => {
  it('says the agent did get the message, and that the work was lost', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} offlineAtTimeout={ONE} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('@backend did get this message')
    expect(text).toContain('was lost')
  })

  it('tells the user to send again here — and does NOT promise it is queued', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} offlineAtTimeout={ONE} />,
    )
    const text = (container.textContent ?? '').toLowerCase()
    expect(text).toContain('send this again if you still need it')
    expect(text).not.toContain('still queued')
  })

  it('never claims this agent did not receive the message', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} offlineAtTimeout={ONE} />,
    )
    expect(container.textContent).not.toContain("didn't receive this message")
  })

  it('keeps both groups distinguishable when one message has both', () => {
    const { container } = render(
      <OfflineRemedyNote
        {...none}
        neverReceived={ONE}
        offlineAtTimeout={[{ agentId: 'a9', displayName: 'designer' }]}
      />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain("@backend isn't connected")
    expect(text).toContain('@designer did get this message')
    // Both remedies present, each attached to its own agent.
    expect(text).toContain("you don't need to send it again")
    expect(text).toContain('send this again if you still need it')
  })
})

describe('OfflineRemedyNote — shared explainer', () => {
  it('says this is the user\'s own machine and not an outage (AC-3.3)', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={ONE} />,
    )
    expect(container.textContent).toContain('not a clawmeets outage')
    expect(container.textContent).toContain('your own machine')
  })

  it('says it for the timeout flavour too, not just the dispatch one', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} offlineAtTimeout={ONE} />,
    )
    expect(container.textContent).toContain('not a clawmeets outage')
  })

  it('gives the remedy exactly once for an eleven-agent fleet (AC-3.5)', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={ELEVEN} />,
    )
    const text = container.textContent ?? ''
    expect(occurrences(text, 'clawmeets start')).toBe(1)
    expect(occurrences(text, 'not a clawmeets outage')).toBe(1)
    // And it still names them all.
    expect(text).toContain('@agent-0')
    expect(text).toContain('@agent-10')
    expect(text).toContain("11 agents aren't connected.")
  })

  it('reassures about the working recipients only in the mixed case', () => {
    const mixed = render(
      <OfflineRemedyNote {...none} neverReceived={ONE} hasWorkingRecipients />,
    )
    expect(mixed.container.textContent).toContain(
      'The other recipients on this message are unaffected.',
    )
    cleanup()
    const alone = render(<OfflineRemedyNote {...none} neverReceived={ONE} />)
    expect(alone.container.textContent).not.toContain('are unaffected')
  })

  it('gives the remedy verbatim, and says where to run it', () => {
    const { container } = render(
      <OfflineRemedyNote {...none} neverReceived={ONE} />,
    )
    expect(container.textContent).toContain('clawmeets start')
    expect(container.textContent).toContain('where you set that agent up')
  })

  it('copies the command to the clipboard on click', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    render(<OfflineRemedyNote {...none} neverReceived={ONE} />)
    fireEvent.click(screen.getByLabelText('Copy clawmeets start'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('clawmeets start'))
  })

  it('survives a blocked clipboard without throwing', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    Object.assign(navigator, { clipboard: { writeText } })
    render(<OfflineRemedyNote {...none} neverReceived={ONE} />)
    fireEvent.click(screen.getByLabelText('Copy clawmeets start'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    // Still selectable text, button back to idle.
    expect(screen.getByLabelText('Copy clawmeets start')).toBeTruthy()
  })
})

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

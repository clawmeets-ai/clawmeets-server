import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentCard, ChatMessage } from '../../types'
import { buildRecipientStatusIndex } from './recipientStatus'

/**
 * A chat message whose sender is an outside contact (`contact:<id>`): a person
 * writing in to a Front Desk thread over Telegram, email, … They are on no
 * agent roster and have no user account; all the web app has is the id and the
 * name stored on the message.
 */

const CONTACT_ID = 'contact:7d1c0e52-5b8e-4e0a-9d43-2f1f6c1b9a10'
const AGENT: AgentCard = {
  id: 'agent-1',
  name: 'chu-customer_support',
  registered_by: 'owner-1',
} as AgentCard

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    entry_type: 'message',
    id,
    ts: '2026-10-06T10:00:00.000000Z',
    from_participant_id: CONTACT_ID,
    from_participant_name: 'Mara Quintero',
    content: `body of ${id}`,
    expects_response_from: [],
    ...over,
  }
}

afterEach(cleanup)

// ---------------------------------------------------------------------------
// MessageList: bubbles group by sender id, never by display name
// ---------------------------------------------------------------------------

describe('MessageList groups by sender id', () => {
  afterEach(() => vi.doUnmock('./MessageItem'))

  it('two senders sharing a display name never merge into one bubble', async () => {
    vi.resetModules()
    vi.doMock('./MessageItem', () => ({
      default: ({ messages }: { messages: ChatMessage[] }) => (
        <div data-testid="group">{messages.map((m) => m.from_participant_id).join(',')}</div>
      ),
    }))
    const { default: MessageList } = await import('./MessageList')
    // The owner tests their own bot and names the test contact after
    // themselves: same name, different senders, 10 seconds apart.
    const messages = [
      msg('m1', { from_participant_id: 'owner-1', from_participant_name: 'chu' }),
      msg('m2', { from_participant_name: 'chu', ts: '2026-10-06T10:00:10.000000Z' }),
    ]
    render(
      <MessageList
        isOutsideAuthor={() => false}
        messages={messages}
        agents={[]}
        chatroomName="user-communication"
        statusIndex={buildRecipientStatusIndex(messages, [], [])}
      />,
    )
    const groups = screen.getAllByTestId('group').map((g) => g.textContent)
    expect(groups).toEqual(['owner-1', CONTACT_ID])
  })
})

// ---------------------------------------------------------------------------
// MessageItem: the header shows the contact's name, never the raw id
// ---------------------------------------------------------------------------

async function renderItem(m: ChatMessage) {
  vi.resetModules()
  const { default: MessageItem } = await import('./MessageItem')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MessageItem
        messages={[m]}
        agents={[AGENT]}
        projectId="p1"
        chatroomName="user-communication"
        statusIndex={buildRecipientStatusIndex([m], [AGENT], [])}
        expandedIds={new Set()}
        onToggleExpand={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe("MessageItem names a contact sender", () => {
  it("shows the contact's stored display name", async () => {
    await renderItem(msg('m1'))
    expect(screen.getAllByText('Mara Quintero').length).toBeGreaterThan(0)
    expect(screen.queryByText(new RegExp(CONTACT_ID))).toBeNull()
  })

  it('shows a readable label, not the id, when the stored name is missing', async () => {
    await renderItem(msg('m1', { from_participant_name: '' }))
    expect(screen.getAllByText('Outside contact').length).toBeGreaterThan(0)
    expect(screen.queryByText(new RegExp(CONTACT_ID))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Recipient status: a contact's message is not the agent's reply
// ---------------------------------------------------------------------------

describe('recipient status with a contact in the room', () => {
  it("a contact's follow-up never completes the agent's pending turn", () => {
    const ask = msg('m1', { expects_response_from: [AGENT.id] })
    const followUp = msg('m2', { ts: '2026-10-06T10:00:30.000000Z' })
    const index = buildRecipientStatusIndex([ask, followUp], [AGENT], [])
    expect(index.resolve(ask, AGENT.id)).toBe('pending')
  })

  it('the agent replying does complete it', () => {
    const ask = msg('m1', { expects_response_from: [AGENT.id] })
    const reply = msg('m2', {
      from_participant_id: AGENT.id,
      from_participant_name: AGENT.name,
      ts: '2026-10-06T10:00:30.000000Z',
    })
    const index = buildRecipientStatusIndex([ask, reply], [AGENT], [])
    expect(index.resolve(ask, AGENT.id)).toBe('completed')
  })
})

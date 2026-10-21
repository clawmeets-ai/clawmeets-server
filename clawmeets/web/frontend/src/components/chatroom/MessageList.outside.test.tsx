import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { participantInfo, standIn } from '../../test/hubFixtures'
import type { ChatMessage } from '../../types'
import { outsideAuthorRule } from '../../utils/roomTrust'
import { buildRecipientStatusIndex } from './recipientStatus'
import MessageList from './MessageList'

/**
 * Per-message trust in a workroom: an outside author's body renders through
 * MarkdownBody untrusted (no images, safe links, no Forward / Save) with an
 * "outside" badge; an inside author's body is unchanged; the server's notes
 * are one plain-text line.
 */

const OWNER = 'u1'
const STAND_IN = standIn('scout')
const HOSTILE = 'Hi ![x](https://evil.example/x.png) [click](javascript:alert(1))'
const room = { participant_info: [participantInfo('a-own'), participantInfo('a-theirs', { kind: 'user', outside: true }), STAND_IN] }

const msg = (id: string, from: string, content: string): ChatMessage => ({
  entry_type: 'message', id, ts: `2026-10-0${id.slice(-1)}T10:00:00Z`, from_participant_id: from,
  from_participant_name: from, content, expects_response_from: [],
})

function renderList(messages: ChatMessage[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MessageList
          messages={messages}
          agents={[]}
          projectId="p1"
          chatroomName="work"
          statusIndex={buildRecipientStatusIndex(messages, [], [])}
          isOutsideAuthor={outsideAuthorRule(room, OWNER)}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const group = (id: string) => screen.getByText((_, el) => el?.getAttribute('data-message-id') === id).closest('.group') as HTMLElement

beforeEach(() => seedSessions([makeSession({ id: OWNER, username: 'owner' })], OWNER))
afterEach(cleanup)

describe('outside bodies in a workroom', () => {
  it('a stand-in\'s message: badge, no image loads, no javascript: link, no Forward or Save', () => {
    renderList([msg('m1', STAND_IN.id, HOSTILE)])
    const g = group('m1')
    expect(within(g).getByTestId('outside-badge').textContent).toBe('outside')
    expect(g.querySelector('img')).toBeNull()
    expect(g.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(within(g).queryByRole('button', { name: /Forward/ })).toBeNull()
    expect(within(g).queryByRole('button', { name: /Save to knowledge pack/ })).toBeNull()
  })

  it('a person of another account (kind user, outside) is fenced the same way', () => {
    renderList([msg('m1', 'a-theirs', HOSTILE)])
    const g = group('m1')
    expect(within(g).getByTestId('outside-badge')).toBeTruthy()
    expect(g.querySelector('img')).toBeNull()
  })

  it('a sender missing from participant_info is outside (fail closed)', () => {
    renderList([msg('m1', 'someone-new', 'hello')])
    expect(within(group('m1')).getByTestId('outside-badge')).toBeTruthy()
  })

  it('a row stamped outside_isolated is fenced even when its author is now listed inside', () => {
    renderList([{ ...msg('m1', 'a-own', HOSTILE), outside_isolated: true }])
    const g = group('m1')
    expect(within(g).getByTestId('outside-badge')).toBeTruthy()
    expect(g.querySelector('img')).toBeNull()
    expect(within(g).queryByRole('button', { name: /Forward/ })).toBeNull()
  })

  it('an inside author is unchanged: no badge, images allowed, Forward offered', () => {
    renderList([msg('m1', 'a-own', 'Hi ![x](https://ok.example/x.png)')])
    const g = group('m1')
    expect(within(g).queryByTestId('outside-badge')).toBeNull()
    expect(g.querySelector('img')).not.toBeNull()
    expect(within(g).getByRole('button', { name: /Forward/ })).toBeTruthy()
  })

  it('a server note is one plain-text line, never Markdown', () => {
    renderList([msg('m1', 'system', 'scout@acme.dev can no longer take part in this room (unretained) **bold**')])
    const note = screen.getByTestId('system-note')
    expect(note.textContent).toContain('can no longer take part in this room (unretained) **bold**')
    expect(note.querySelector('strong')).toBeNull()
    expect(screen.queryByTestId('outside-badge')).toBeNull()
  })
})

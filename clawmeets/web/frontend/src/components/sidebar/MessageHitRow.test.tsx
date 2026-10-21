import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SearchHit } from '../../types'
import MessageHitRow from './MessageHitRow'

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    message_id: 'm1',
    project_id: 'p1',
    project_name: 'chat-search-typeahead',
    room_id: 'shared-context',
    room_type: 'project',
    room_label: 'shared-context',
    ts: '2026-07-26T14:03:11.482000Z',
    author_id: 'agent_1',
    author_name: 'clawmeets-backend',
    snippet: 'a recency weight, so a message from today can outrank',
    snippet_truncated_start: false,
    snippet_truncated_end: false,
    match_offsets: [[2, 9]],
    score: 6.204,
    deep_link: {
      path: '/projects/p1/chatrooms/shared-context?msg=m1',
      kind: 'project_room',
      project_id: 'p1',
      chatroom_name: 'shared-context',
      agent_name: null,
      message_id: 'm1',
    },
    ...over,
  }
}

describe('MessageHitRow', () => {
  afterEach(cleanup)

  it('shows the author and highlights the matched span', () => {
    render(<MessageHitRow hit={hit()} />)
    expect(screen.getByText('clawmeets-backend')).toBeTruthy()
    const marks = document.querySelectorAll('mark')
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['recency'])
  })

  it('renders the ellipsis from the truncated flags, outside every highlight', () => {
    // The server never embeds '…' — if it did, or if we injected it into the
    // string before splitting, the offsets would shift under the highlight.
    render(
      <MessageHitRow
        hit={hit({ snippet_truncated_start: true, snippet_truncated_end: true })}
      />,
    )
    const row = document.body.textContent ?? ''
    expect(row).toContain('…a recency')
    expect(row).toContain('outrank…')
    expect(document.querySelector('mark')?.textContent).toBe('recency')
  })

  it('renders a snippet containing markup as literal text', () => {
    // `snippet` is plain text that may contain '<' and '&' (§3.5). It must go
    // through a JSX text node — never MarkdownBody, never dangerouslySetInnerHTML.
    render(
      <MessageHitRow
        hit={hit({
          snippet: 'try <script>alert(1)</script> & **bold**',
          match_offsets: [],
        })}
      />,
    )
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('strong')).toBeNull()
    expect(screen.getByText(/try <script>alert\(1\)<\/script> & \*\*bold\*\*/)).toBeTruthy()
  })

  it('renders an unhighlighted snippet when match_offsets is empty', () => {
    render(<MessageHitRow hit={hit({ match_offsets: [] })} />)
    expect(document.querySelector('mark')).toBeNull()
    expect(screen.getByText(/a recency weight/)).toBeTruthy()
  })

  it('shows the DM thread title when one was resolved', () => {
    render(<MessageHitRow hit={hit({ room_type: 'dm' })} threadTitle="Q3 planning" />)
    expect(screen.getByText('Q3 planning')).toBeTruthy()
  })
})

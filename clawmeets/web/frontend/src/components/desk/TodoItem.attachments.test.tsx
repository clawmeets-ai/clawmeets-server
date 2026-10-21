import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { DeskTodo, DeskTodoAttachment } from '../../api/endpoints/deskTodos'
import TodoItem from './TodoItem'

/**
 * AC-3.3 — the plate says an item carries real bytes.
 */

const A = (over: Partial<DeskTodoAttachment> = {}): DeskTodoAttachment => ({
  id: 'a-4f9c2b1e',
  name: 'notes.pdf',
  size: 20481,
  content_type: 'application/pdf',
  sha256: '9f86d0',
  created_at: '2026-09-01T10:14:02+00:00',
  ...over,
})

const T = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't1',
  owner_user_id: 'u1',
  text: 'Chase the Northwind renewal',
  // `status` is gone from the wire; these four replace it and are all
  // typed REQUIRED, which is why every to-do fixture in the suite
  // moved at once rather than one at a time.
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  attachments: [],
  ...over,
})

function row(t: DeskTodo) {
  return render(
    <TodoItem t={t} onToggle={vi.fn()} onRemove={vi.fn()} onUse={vi.fn()} />,
  )
}

describe('TodoItem attachment badge', () => {
  afterEach(cleanup)

  it('shows an attachment count on a row with attachments and nothing on a row without', () => {
    const { unmount } = row(T({ attachments: [A(), A({ id: 'a-2', name: 'deck.key' })] }))
    expect(screen.getByTitle('2 attachments').textContent).toContain('2')
    unmount()

    row(T({ attachments: [] }))
    expect(screen.queryByTitle(/attachment/)).toBeNull()
  })

  it('singularises the accessible title for one attachment', () => {
    row(T({ attachments: [A()] }))
    expect(screen.getByTitle('1 attachment')).toBeTruthy()
  })

  it('rides the draft-recipient line when there is one, and the meta row otherwise', () => {
    // ONE BADGE, TWO HOMES — the width fix, pinned. A drafted row addressed to
    // someone already spends a whole wrap line on the recipient and that line
    // ends short of the row's right edge, so the count parks in the dead space
    // instead of claiming a slot of its own in the `.todo-meta` wrap. Every
    // other shape has no such line and the badge must stay put; pushing it
    // flush-right against a due date reads as arbitrary.
    const { unmount } = row(
      T({ drafted: true, draft_prompt: 'Renewal terms?', draft_recipient_name: 'u-ana', attachments: [A()] }),
    )
    const onDraftLine = screen.getByTitle('1 attachment')
    expect(onDraftLine.closest('.todo-draft-to')).not.toBeNull()
    expect(onDraftLine.className).toContain('todo-attach--inline')
    unmount()

    // Drafted but addressed to nobody: no recipient line exists to sit on.
    const { unmount: u2 } = row(T({ drafted: true, draft_prompt: 'Renewal terms?', attachments: [A()] }))
    const noRecipient = screen.getByTitle('1 attachment')
    expect(noRecipient.closest('.todo-draft-to')).toBeNull()
    expect(noRecipient.parentElement?.className).toContain('todo-meta')
    u2()

    // …and the plain undrafted row keeps it in the meta line as before.
    row(T({ attachments: [A()] }))
    const plain = screen.getByTitle('1 attachment')
    expect(plain.parentElement?.className).toContain('todo-meta')
    expect(plain.className).not.toContain('todo-attach--inline')
  })

  it('badges a self-captured row too — bytes are not an agent-only concept', () => {
    row(T({ attachments: [A()] }))

    expect(screen.getByTitle('1 attachment')).toBeTruthy()
    // The agent hint is origin-gated and must stay absent here.
    expect(screen.queryByText(/\+ prompt/)).toBeNull()
  })
})

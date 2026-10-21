import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentCard } from '../../types'
import type { DeskTodo, DeskTodoAttachment } from '../../api/endpoints/deskTodos'

/**
 * THE CHIP ✕ IS A BOX RESET, NOT A DETACH.
 *
 * It used to call one callback that did one thing — drop the binding — leaving
 * an unlabelled box still holding the item's draft, its
 * stored files and the agent it was addressed to. The point of these tests is
 * the SCOPE of the reset and the one place it deliberately stops:
 *
 *  - ✕ clears draft + tray and fires both the binding and the recipient
 *    callbacks;
 *  - a declined confirm changes NOTHING, so a mis-click cannot cost attachments
 *    that were staged but never saved onto the item;
 *  - a SEND still detaches but does NOT reset the recipient — that is what lets
 *    a second message go to the same agent without re-picking, and it is the
 *    behaviour most at risk from a future "simplification" that merges the two
 *    callbacks back together.
 */

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] as AgentCard[] }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))
vi.mock('../common/ModelSelector', () => ({ default: () => null }))

// Stored bytes resolve straight away; these tests care about what survives the
// ✕, not about the fetch itself.
const cache = new Map<string, File>()
vi.mock('../../api/endpoints/deskTodoAttachments', () => ({
  fetchTodoAttachment: async (todoId: string, a: DeskTodoAttachment) => {
    const f = new File(['stored bytes'], a.name, { type: a.content_type })
    cache.set(`${todoId}:${a.id}`, f)
    return f
  },
  cachedTodoAttachment: (todoId: string, id: string) => cache.get(`${todoId}:${id}`),
  forgetTodoAttachment: (todoId: string, id: string) => {
    cache.delete(`${todoId}:${id}`)
  },
}))

const { default: DeskComposer } = await import('./DeskComposer')
type Handle = import('./DeskComposer').DeskComposerHandle

const RECIPIENT = { id: 'a1', name: 'ana-analyst', status: 'online' } as AgentCard
const BOUND = { id: 't-9a3f21', text: 'Chase the Northwind renewal' }
const SOP = { id: 's-77c1', title: 'Daily partner COD check' }

const A = (over: Partial<DeskTodoAttachment> = {}): DeskTodoAttachment => ({
  id: 'a-4f9c2b1e',
  name: 'notes.pdf',
  size: 20481,
  content_type: 'application/pdf',
  sha256: '9f86d0',
  created_at: '2026-09-01T10:14:02+00:00',
  ...over,
})

const todo = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't-9a3f21',
  owner_user_id: 'u1',
  text: 'Chase the Northwind renewal',
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  draft_prompt: 'Chase the renewal',
  attachments: [],
  ...over,
})

function renderBox() {
  const ref = createRef<Handle>()
  const onClearTodo = vi.fn()
  const onResetRecipient = vi.fn()
  const onClearSop = vi.fn()
  const onDispatch = vi.fn(async () => ({ linked: true }))
  const { container } = render(
    <DeskComposer
      ref={ref}
      recipient={RECIPIENT}
      onRecipientChange={vi.fn()}
      onDispatch={onDispatch}
      todoSource={BOUND}
      onClearTodo={onClearTodo}
      onResetRecipient={onResetRecipient}
      onClearSop={onClearSop}
    />,
  )
  const load = async (t: DeskTodo) => {
    act(() => {
      ref.current?.loadTodoDraft(t.draft_prompt || t.text, t)
    })
    await act(async () => {})
  }
  const detach = () =>
    screen.getByRole('button', { name: 'Detach this to-do' }) as HTMLButtonElement
  const draft = () => container.querySelector('[contenteditable="true"]')!.textContent ?? ''
  // The tray is absent, not empty, when nothing is staged — so count chips
  // rather than asserting on a list role that may not be in the document.
  const stagedCount = () => container.querySelectorAll('button[title^="Remove "]').length
  const addFile = async (name: string) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['mine'], name)] } })
    })
  }
  const type = async (s: string) => {
    const box = container.querySelector('[contenteditable="true"]')!
    await act(async () => {
      fireEvent.input(box, { target: { textContent: s } })
    })
  }
  const press = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /command/i }))
    })
  }
  return {
    container,
    load,
    detach,
    draft,
    stagedCount,
    addFile,
    type,
    press,
    onClearTodo,
    onResetRecipient,
    onClearSop,
  }
}

describe('the chip ✕ resets the whole box', () => {
  beforeEach(() => {
    cache.clear()
  })
  afterEach(cleanup)

  it('clears draft and tray, and drops both the binding and the recipient', async () => {
    const { load, detach, draft, stagedCount, onClearTodo, onResetRecipient, onClearSop } =
      renderBox()

    await load(
      todo({ attachments: [A()] }),
    )
    // Precondition: the item really did fill the box — otherwise an
    // always-empty box would pass every assertion below.
    expect(draft()).toContain('Chase the renewal')
    expect(stagedCount()).toBeGreaterThan(0)

    await act(async () => {
      fireEvent.click(detach())
    })

    expect(draft()).toBe('')
    expect(stagedCount()).toBe(0)
    expect(onClearTodo).toHaveBeenCalledTimes(1)
    expect(onResetRecipient).toHaveBeenCalledTimes(1)
    expect(onClearSop).toHaveBeenCalledTimes(1)
  })

  it('the SOP chip ✕ resets the box the same way', async () => {
    const ref = createRef<Handle>()
    const onClearSop = vi.fn()
    const onResetRecipient = vi.fn()
    const { container } = render(
      <DeskComposer
        ref={ref}
        recipient={RECIPIENT}
        onRecipientChange={vi.fn()}
        onDispatch={vi.fn(async () => ({ linked: false }))}
        sopSource={SOP}
        onClearSop={onClearSop}
        onResetRecipient={onResetRecipient}
      />,
    )
    const draft = () => container.querySelector('[contenteditable="true"]')!.textContent ?? ''
    act(() => {
      ref.current?.loadTemplate('Run the COD check for {{inventory}}')
    })
    expect(draft()).toContain('Run the COD check')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Detach this SOP' }))
    })

    expect(draft()).toBe('')
    expect(onClearSop).toHaveBeenCalledTimes(1)
    expect(onResetRecipient).toHaveBeenCalledTimes(1)
  })

  it('a declined confirm over unsaved attachments leaves the box untouched', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { load, detach, draft, stagedCount, addFile, onClearTodo, onResetRecipient } =
      renderBox()

    await load(todo({ attachments: [A()] }))
    await addFile('my-own-notes.txt')
    const before = stagedCount()

    await act(async () => {
      fireEvent.click(detach())
    })

    expect(confirm).toHaveBeenCalledTimes(1)
    // The whole point: the file the user cannot retype is still there, and so
    // is the binding the head is naming.
    expect(stagedCount()).toBe(before)
    expect(draft()).toContain('Chase the renewal')
    expect(onClearTodo).not.toHaveBeenCalled()
    expect(onResetRecipient).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('a successful send detaches but does NOT reset the recipient', async () => {
    const { type, press, onClearTodo, onResetRecipient } = renderBox()

    await type('have a look at this')
    await press()

    // Sending clears the box and unbinds the item, but the pill stays put so
    // the next message can go to the same agent without re-picking.
    expect(onClearTodo).toHaveBeenCalledTimes(1)
    expect(onResetRecipient).not.toHaveBeenCalled()
  })
})

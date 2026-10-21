import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { AgentCard } from '../../types'
import type { DeskTodo } from '../../api/endpoints/deskTodos'

/**
 * Loading a to-do into the desk message box. The draft text was always swapped;
 * the attachment tray was NOT — a file the user staged while working one item
 * stayed staged and would ride the next item's command out to a different
 * recipient, with the "Replace your current draft?" confirm saying nothing
 * about it. A to-do owns its whole box, attachments included.
 *
 * Dropping is right — carrying would let the next Save persist someone else's
 * file onto the wrong item, and the server cannot detect that mis-attribution
 * because the request names a to-do id and carries a full desired-state array.
 * Auto-saving on switch is worse still: a row click would become a write.
 *
 * So the drop stands and the SILENCE goes. The guard used to fire on dirty
 * TEXT alone, which is the bug these tests are mostly about: with a file
 * staged and the text empty or matching, there was no confirm at all. That used
 * to cost a re-attach. Now the user believes the file is on the item.
 */

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] as AgentCard[] }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))
vi.mock('../common/ModelSelector', () => ({ default: () => null }))

const { default: DeskComposer } = await import('./DeskComposer')
type Handle = import('./DeskComposer').DeskComposerHandle

/** A to-do carrying only what these tests care about. `attachments` is always a
 *  list — the wire shape has no null arm — so it is spelled out here rather
 *  than left to a coalesce that production code does not do either. */
const todo = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't1',
  owner_user_id: 'u1',
  text: 'Chase the Q3 numbers',
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

function renderBox(todoSource: { id: string; text: string } | null = null) {
  const ref = createRef<Handle>()
  const { container } = render(
    <DeskComposer
      ref={ref}
      recipient={null}
      onRecipientChange={vi.fn()}
      onDispatch={vi.fn(async () => ({ linked: true }))}
      todoSource={todoSource}
    />,
  )
  const attach = (...files: File[]) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { files } })
    })
  }
  const load = (body: string, over: Partial<DeskTodo> = {}): boolean | undefined => {
    let ok: boolean | undefined
    act(() => {
      ok = ref.current?.loadTodoDraft(body, todo(over))
    })
    return ok
  }
  // The tray chips carry the file name as their title (StagedAttachments).
  const stagedNames = () =>
    Array.from(container.querySelectorAll('button[title^="Remove "]')).map((b) =>
      (b.getAttribute('title') ?? '').replace(/^Remove /, ''),
    )
  const remove = (name: string) => {
    fireEvent.click(container.querySelector(`button[title="Remove ${name}"]`) as HTMLElement)
  }
  return { attach, load, stagedNames, remove }
}

const file = (name: string) => new File(['x'], name, { type: 'text/plain' })

const A = (id: string, name: string) => ({
  id,
  name,
  size: 1,
  content_type: 'text/plain',
  sha256: '9f86d0',
  created_at: '2026-09-01T10:14:02+00:00',
})

const BOUND = { id: 't1', text: 'Chase the Q3 numbers' }

describe('DeskComposer loadTodoDraft', () => {
  afterEach(cleanup)

  it('drops files the user staged on the previous to-do', () => {
    const { attach, load, stagedNames } = renderBox()
    load('Chase the Q3 numbers')

    attach(file('contract.pdf'))
    expect(stagedNames()).toEqual(['contract.pdf'])

    // Switch to a different item — the user confirms replacing the draft.
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(load('Draft the vendor reply')).toBe(true)

    expect(stagedNames()).toEqual([])
  })

  it('leaves the tray alone when the user declines the replace confirm', () => {
    const { attach, load, stagedNames } = renderBox()
    load('Chase the Q3 numbers')
    attach(file('contract.pdf'))

    vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(load('Draft the vendor reply')).toBe(false)

    // Nothing was written, so nothing is dropped — the box still holds to-do A.
    expect(stagedNames()).toEqual(['contract.pdf'])
  })

  it('warns before discarding unsaved attachments on a bound to-do', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { attach, load, stagedNames } = renderBox(BOUND)

    load('Chase the Q3 numbers')
    attach(file('contract.pdf'))
    load('Draft the vendor reply')

    // The message names WHAT is lost and WHERE from — a generic "replace your
    // draft?" would be answering a different question.
    expect(confirm).toHaveBeenCalledWith(
      'You have 1 unsaved attachment on “Chase the Q3 numbers”. Switching will discard them.',
    )
    expect(stagedNames()).toEqual([])
  })

  it('warns with empty or matching text when a file is staged', () => {
    // The case the old guard missed entirely, in both of its shapes.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { attach, load } = renderBox(BOUND)

    // (a) matching text — `current !== body.trim()` was false, so no confirm.
    load('Chase the Q3 numbers')
    attach(file('contract.pdf'))
    load('Chase the Q3 numbers')
    expect(confirm).toHaveBeenCalledTimes(1)

    // (b) empty box — `current` was falsy, so no confirm.
    confirm.mockClear()
    attach(file('second.pdf'))
    load('')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('pluralises the count of unsaved attachments', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { attach, load } = renderBox(BOUND)

    load('Chase the Q3 numbers')
    attach(file('a.pdf'), file('b.pdf'))
    load('Draft the vendor reply')

    expect(confirm).toHaveBeenCalledWith(
      'You have 2 unsaved attachments on “Chase the Q3 numbers”. Switching will discard them.',
    )
  })

  it('the attachment wording wins when the text is also dirty', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { attach, load } = renderBox(BOUND)

    load('Chase the Q3 numbers')
    attach(file('contract.pdf'))
    load('Something else entirely')

    // Both conditions hold; the one that costs the user something they cannot
    // retype is the one that gets said.
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved attachment'))
    expect(confirm).not.toHaveBeenCalledWith('Replace your current draft?')
  })

  it('does not count a stored attachment that carries a server id', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { load } = renderBox(BOUND)

    // Loaded and untouched: nothing to lose, so nothing to warn about, and the
    // text is unchanged too.
    load('Chase the Q3 numbers', { attachments: [A('a-1', 'stored.pdf')] })
    load('Chase the Q3 numbers')

    expect(confirm).not.toHaveBeenCalled()
  })

  it('warns about a ✕’d-not-saved attachment, whose removal would be silently undone', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { load, remove } = renderBox(BOUND)

    load('Chase the Q3 numbers', { attachments: [A('a-1', 'stored.pdf')] })
    remove('stored.pdf')
    load('Chase the Q3 numbers')

    // The server still holds it. Switching away without saving puts the file
    // back — which is a change to what the user sees, so it is worth a word.
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved attachment'))
  })

  it('declining leaves both the tray and the draft alone', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { attach, load, stagedNames } = renderBox(BOUND)

    load('Chase the Q3 numbers')
    attach(file('contract.pdf'))

    expect(load('Draft the vendor reply')).toBe(false)
    expect(stagedNames()).toEqual(['contract.pdf'])
  })

  it('keeps today’s silent drop on an UNBOUND box — the warning names an item there is none of', () => {
    // Known and deliberately out of scope: the message names the bound to-do's
    // text, which does not exist when nothing is bound. Asserted so the gap is
    // a decision on record rather than a surprise.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { attach, load, stagedNames } = renderBox(null)

    load('Chase the Q3 numbers')
    attach(file('contract.pdf'))
    load('Chase the Q3 numbers')

    expect(confirm).not.toHaveBeenCalled()
    expect(stagedNames()).toEqual([])
  })
})

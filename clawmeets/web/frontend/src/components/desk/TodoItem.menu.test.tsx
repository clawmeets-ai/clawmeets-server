import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import TodoItem from './TodoItem'

/**
 * The row's two action icons — Labels and Delete — collapsed into one `⋮`.
 *
 * The width is the point: on the touch branch `.todo-actions` is a real flex
 * child, so two icons at rest cost ~34px of a ~250px rail before the task's
 * first character. But the thing that can silently break is BEHAVIOUR, and
 * these are the four claims that matter:
 *
 *   1. neither action is reachable until the menu is opened (it is the only
 *      way in now — losing an item means losing the capability outright),
 *   2. Labels hands back the ⋮ BUTTON, because the rail positions the label
 *      popover off `anchor.getBoundingClientRect()` and the menu item that was
 *      clicked has unmounted by the time it reads that,
 *   3. Escape closes without firing either, and
 *   4. nothing in here loads the row into the message box — the cluster sits
 *      outside the body button, but a click that propagated would still be
 *      read as a press of the row.
 */

const T = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't1',
  owner_user_id: 'u1',
  text: 'Chase the Northwind renewal',
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  attachments: [],
  ...over,
})

function row(over: Partial<Parameters<typeof TodoItem>[0]> = {}) {
  const props = {
    t: T(),
    onArchive: vi.fn(),
    onRemove: vi.fn(),
    onUse: vi.fn(),
    onEditLabels: vi.fn(),
    ...over,
  }
  render(<TodoItem {...props} />)
  return props
}

const openMenu = () => fireEvent.click(screen.getByLabelText('More actions'))

describe('TodoItem overflow menu', () => {
  afterEach(cleanup)

  it('shows one trigger and no Labels or Delete until it is pressed', () => {
    row()
    expect(screen.getByLabelText('More actions')).toBeTruthy()
    expect(screen.queryByText('Labels')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()

    openMenu()
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByText('Labels')).toBeTruthy()
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  it('deletes by id, and closes the menu behind it', () => {
    const { onRemove } = row()
    openMenu()
    fireEvent.click(screen.getByText('Delete'))

    expect(onRemove).toHaveBeenCalledWith('t1')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens labels against the ⋮ TRIGGER, not the menu item that vanished', () => {
    // The rail reads `anchor.getBoundingClientRect().bottom` to place the
    // popover. Handing it the clicked item would anchor against an element
    // already removed from the document.
    const { onEditLabels } = row()
    const trigger = screen.getByLabelText('More actions')
    openMenu()
    fireEvent.click(screen.getByText('Labels'))

    expect(onEditLabels).toHaveBeenCalledTimes(1)
    const [todo, anchor] = (onEditLabels as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(todo.id).toBe('t1')
    expect(anchor).toBe(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on Escape without firing either action', () => {
    const { onRemove, onEditLabels } = row()
    openMenu()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
    expect(onEditLabels).not.toHaveBeenCalled()
  })

  it('closes on a pointerdown outside the row', () => {
    row()
    openMenu()
    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('never loads the row into the message box', () => {
    // Opening the menu, and each of its items, must not read as a press of the
    // row — `onUse` is the one handler here that writes nothing but moves the
    // whole composer.
    const { onUse } = row()
    openMenu()
    expect(onUse).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete'))
    expect(onUse).not.toHaveBeenCalled()
  })

  it('gives an archived row a Delete-only menu — the drawer has no labels', () => {
    // The Archived drawer passes no `onEditLabels` at all, which is what makes
    // the label strip absent there. The menu inherits that for free.
    const onRemove = vi.fn()
    render(
      <TodoItem
        t={T({ archived: true })}
        onArchive={vi.fn()}
        onRemove={onRemove}
        onUse={vi.fn()}
      />,
    )
    openMenu()

    expect(screen.queryByText('Labels')).toBeNull()
    fireEvent.click(screen.getByText('Delete'))
    expect(onRemove).toHaveBeenCalledWith('t1')
  })
})

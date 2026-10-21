import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import InlineEditableTitle from './InlineEditableTitle'

/**
 * House style: vitest + @testing-library/react with `fireEvent` and
 * `afterEach(cleanup)`, matching MessageHitRow.test.tsx. `user-event` is
 * deliberately NOT introduced -- this milestone adds zero dependencies.
 *
 * `String.fromCodePoint` rather than a literal emoji, for the same reason the
 * rules module spells its character classes out: an astral literal is exactly
 * the thing a careless edit silently mangles.
 */
const EMOJI = String.fromCodePoint(0x1f642)

/**
 * Stands in for the two page headers. The important part it reproduces is that
 * `value` is OWNED BY THE CALLER (in the app, by the React Query cache) and
 * only moves when a save succeeds. That is what makes "Esc restores" and
 * "a rejection restores" real assertions rather than assertions about internal
 * component state.
 */
function Harness({
  onSave,
  initial = 'Trip plan',
  editable = true,
}: {
  onSave: (next: string) => Promise<unknown>
  initial?: string
  editable?: boolean
}) {
  const [value, setValue] = useState(initial)
  return (
    <h2>
      <InlineEditableTitle
        value={value}
        label="Project name"
        editable={editable}
        onSave={async (next) => {
          const result = await onSave(next)
          setValue(next) // the optimistic cache patch, in miniature
          return result
        }}
      />
    </h2>
  )
}

const trigger = () => screen.getByRole('button')
const input = () => screen.getByRole('textbox') as HTMLInputElement
const noInput = () => screen.queryByRole('textbox')

/** Let the awaited onSave settle and React flush the resulting state. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

/** Open the editor the way a user does. */
function openEditor() {
  fireEvent.click(trigger())
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } })
}

describe('InlineEditableTitle', () => {
  afterEach(cleanup)

  it('enters edit mode on click, with the input focused and fully selected', () => {
    render(<Harness onSave={vi.fn()} />)
    openEditor()

    const el = input()
    expect(el.value).toBe('Trip plan')
    expect(document.activeElement).toBe(el)
    // Select-all, so replacing a whole auto-generated title is one keystroke.
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe('Trip plan'.length)
  })

  it('Enter saves exactly once, with the normalized value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<Harness onSave={onSave} />)

    openEditor()
    type('  Berlin   offsite  ')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()

    // Normalized before it leaves the client: collapsed and trimmed, exactly
    // as the server would rewrite it.
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('Berlin offsite')
    expect(noInput()).toBeNull()
    expect(trigger().textContent).toContain('Berlin offsite')
  })

  it('Esc restores the original name and makes no save', () => {
    const onSave = vi.fn()
    render(<Harness onSave={onSave} />)

    openEditor()
    type('something else entirely')
    fireEvent.keyDown(input(), { key: 'Escape' })

    expect(onSave).not.toHaveBeenCalled()
    expect(noInput()).toBeNull()
    expect(trigger().textContent).toContain('Trip plan')
    // Focus comes back to the trigger, so a keyboard user is not stranded.
    expect(document.activeElement).toBe(trigger())
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '    '],
  ])('refuses to save a %s name and says why, in an alert', (_label, text) => {
    const onSave = vi.fn()
    render(<Harness onSave={onSave} />)

    openEditor()
    type(text)
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Thread name cannot be empty.')
    // Still editing, still focused -- the user fixes it without reopening.
    expect(noInput()).not.toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it.each([
    ['ASCII', 'a'],
    ['emoji', EMOJI],
  ])('saves at exactly 60 %s and refuses 61', async (_label, ch) => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<Harness onSave={onSave} />)

    openEditor()
    type(ch.repeat(61))
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      'Thread name must be 60 characters or fewer.',
    )

    // 60 emoji is 120 UTF-16 units. A `.length` check would reject this, and
    // the server would have accepted it -- which is the regression this row
    // exists to catch.
    type(ch.repeat(60))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(ch.repeat(60))
  })

  it('shows the too-long message live on keystroke, not only on commit', () => {
    render(<Harness onSave={vi.fn()} />)
    openEditor()

    type('a'.repeat(60))
    expect(screen.queryByRole('alert')).toBeNull()
    type('a'.repeat(61))
    expect(screen.getByRole('alert').textContent).toContain('60 characters or fewer')
    type('a'.repeat(59))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the counter from 20 remaining, and never a maxLength attribute', () => {
    render(<Harness onSave={vi.fn()} />)
    openEditor()

    // maxLength would silently truncate a pasted title and never say why.
    expect(input().getAttribute('maxlength')).toBeNull()

    type('a'.repeat(39))
    expect(screen.queryByText(/characters left/)).toBeNull()
    type('a'.repeat(40))
    expect(screen.getByText('20 characters left')).toBeTruthy()
    type('a'.repeat(60))
    expect(screen.getByText('0 characters left')).toBeTruthy()
    type('a'.repeat(62))
    expect(screen.getByText('2 over the limit')).toBeTruthy()
  })

  it('restores the old name on a rejection, and hands back the text and the cursor', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(new Error('You do not have permission to rename this thread'))
    render(<Harness onSave={onSave} />)

    openEditor()
    type('Renamed by someone without rights')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()

    // The server's `detail`, verbatim, in an alert.
    expect(screen.getByRole('alert').textContent).toBe(
      'You do not have permission to rename this thread',
    )
    // Back in edit mode with what the user typed, focused, NOT select-alled --
    // one keystroke must not wipe it.
    const el = input()
    expect(el.value).toBe('Renamed by someone without rights')
    expect(document.activeElement).toBe(el)
    expect(el.selectionStart).toBe(el.selectionEnd)
  })

  it('blur saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<Harness onSave={onSave} />)

    openEditor()
    type('Saved by clicking away')
    fireEvent.blur(input())
    await settle()

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('Saved by clicking away')
  })

  it('blur with an INVALID value cancels and restores instead of saving', () => {
    const onSave = vi.fn()
    render(<Harness onSave={onSave} />)

    openEditor()
    type('   ')
    fireEvent.blur(input())

    expect(onSave).not.toHaveBeenCalled()
    expect(trigger().textContent).toContain('Trip plan')
    // No error banner left pinned to a field the user has walked away from.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['Enter', () => fireEvent.keyDown(input(), { key: 'Enter' })],
    ['blur', () => fireEvent.blur(input())],
  ])('sends no request when the value is unchanged (%s)', async (_label, commit) => {
    const onSave = vi.fn()
    render(<Harness onSave={onSave} />)

    openEditor()
    // Whitespace the server would normalize away is still "unchanged".
    type('  Trip   plan  ')
    commit()
    await settle()

    expect(onSave).not.toHaveBeenCalled()
    expect(trigger().textContent).toContain('Trip plan')
  })

  /**
   * Leaving edit mode unmounts the input, and a browser fires a blur at the
   * focused element on the way out. Both tests below reproduce that exit-blur.
   *
   * Both events go inside ONE `act()`, which is what makes them bite: a bare
   * `fireEvent.keyDown` flushes the re-render before it returns, so the input
   * is already detached and a following `fireEvent.blur` would hit a dead node
   * and silently prove nothing. Batching defers the unmount to the end of the
   * block, so the blur reaches the live handler.
   */
  it('commits once on Enter -- the exit-blur cannot double-fire', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<Harness onSave={onSave} />)

    openEditor()
    type('Committed once')
    const el = input()
    act(() => {
      fireEvent.keyDown(el, { key: 'Enter' })
      fireEvent.blur(el)
    })
    await settle()

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('Committed once')
  })

  it('keeps focus on the trigger when the exit-blur follows an Esc', () => {
    // Esc returns focus to the trigger. Without the latch the exit-blur runs
    // the cancel path a second time and overwrites that decision, dropping a
    // keyboard user onto <body> -- so this is the assertion that keeps the
    // latch honest, and it fails the moment the latch is removed.
    render(<Harness onSave={vi.fn()} />)

    openEditor()
    type('   ') // invalid, so the blur path would take the cancel branch
    const el = input()
    act(() => {
      fireEvent.keyDown(el, { key: 'Escape' })
      fireEvent.blur(el)
    })

    expect(document.activeElement).toBe(trigger())
    expect(trigger().textContent).toContain('Trip plan')
  })

  it('renders plain text with no control at all when not editable', () => {
    render(<Harness onSave={vi.fn()} editable={false} />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(noInput()).toBeNull()
    expect(document.body.textContent).toContain('Trip plan')
    // No tab stop anywhere in the subtree.
    expect(document.querySelectorAll('[tabindex], button, input, a').length).toBe(0)
  })

  it('completes a keyboard-only round trip and lands focus back on the trigger', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<Harness onSave={onSave} />)

    // Tab-to-focus, then Enter. jsdom does not implement tab traversal or the
    // implicit Enter->click on a button, so this is the observable equivalent:
    // the trigger is focusable, and activating it opens the editor.
    const button = trigger()
    button.focus()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-label')).toBe(
      'Project name: Trip plan. Click to rename.',
    )
    fireEvent.click(button)

    expect(document.activeElement).toBe(input())
    type('Keyboard only')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()

    expect(onSave).toHaveBeenCalledWith('Keyboard only')
    expect(document.activeElement).toBe(trigger())
    // Success is announced politely, not rendered as visible chrome.
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Renamed to "Keyboard only".')
    expect(status.className).toContain('sr-only')
  })

  it('truncates a long name and keeps the full string in a tooltip', () => {
    const long = 'A very long thread title that will not fit in the header at all'
    render(<Harness onSave={vi.fn()} initial={long} />)

    const label = trigger().querySelector('span')
    expect(label?.className).toContain('truncate')
    expect(label?.getAttribute('title')).toBe(long)
  })

  it('starts a fresh edit session after a cancel, so the commit latch resets', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<Harness onSave={onSave} />)

    openEditor()
    fireEvent.keyDown(input(), { key: 'Escape' })
    // Reopening must clear the latch Esc set, or the next Enter would be
    // swallowed and the rename would silently do nothing.
    openEditor()
    type('Second attempt')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await settle()

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('Second attempt')
  })
})

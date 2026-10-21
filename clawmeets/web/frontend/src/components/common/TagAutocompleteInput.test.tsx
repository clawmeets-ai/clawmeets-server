import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TagAutocompleteInput from './TagAutocompleteInput'

/**
 * `autoFocus` has to open the dropdown, and for a long time it didn't.
 *
 * React applies the `autoFocus` attribute during `commitMount`, which runs
 * BEFORE the ref callback attaches. `handleFocus` used to start with
 * `const el = inputRef.current; if (!el) return`, so on an autofocused mount
 * it bailed on a null ref and `isOpen` never flipped. The field focused, the
 * caret blinked, and no suggestions appeared until the user clicked it --
 * silently, with no error anywhere. Reading `e.currentTarget` instead makes
 * the first focus behave like every later one.
 *
 * `TagPillInput` never had the bug (its `onFocus` touches no ref), which is
 * why only this component is pinned here.
 */
afterEach(cleanup)

const SUGGESTIONS = ['engineering', 'finance', 'nyc', 'wine']

describe('TagAutocompleteInput', () => {
  it('opens its suggestions on an autofocused mount', () => {
    render(
      <TagAutocompleteInput
        value=""
        onChange={() => {}}
        suggestions={SUGGESTIONS}
        autoFocus
      />,
    )

    // The dropdown is rendered only while `isOpen` -- its presence IS the
    // assertion that focus handling ran.
    for (const tag of SUGGESTIONS) {
      expect(screen.getByText(tag)).toBeTruthy()
    }
  })

  it('still opens on a user focus, with no autoFocus involved', () => {
    render(
      <TagAutocompleteInput
        value=""
        onChange={() => {}}
        suggestions={SUGGESTIONS}
      />,
    )

    expect(screen.queryByText('finance')).toBeNull()
    fireEvent.focus(screen.getByRole('textbox'))
    expect(screen.getByText('finance')).toBeTruthy()
  })

  it('filters to the in-progress token when autofocused with existing text', () => {
    // The caret sits at the end on mount, so the token under it is `fin` --
    // this pins that the autofocus path computes a real cursor position
    // rather than defaulting to "show everything".
    render(
      <TagAutocompleteInput
        value="nyc, fin"
        onChange={() => {}}
        suggestions={SUGGESTIONS}
        autoFocus
      />,
    )

    expect(screen.getByText('finance')).toBeTruthy()
    expect(screen.queryByText('engineering')).toBeNull()
  })

  it('selects a suggestion on mousedown and replaces only the open token', () => {
    const onChange = vi.fn()
    render(
      <TagAutocompleteInput
        value="nyc, fin"
        onChange={onChange}
        suggestions={SUGGESTIONS}
        autoFocus
      />,
    )

    // mousedown, not click: the row commits on `onMouseDown` with
    // `preventDefault()` so the selection lands before the input blurs and
    // closes the dropdown out from under it.
    fireEvent.mouseDown(screen.getByText('finance'))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toContain('nyc')
    expect(onChange.mock.calls[0][0]).toContain('finance')
  })
})

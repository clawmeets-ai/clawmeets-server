import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import PromptEditor, { type PromptEditorHandle, type PromptStats } from './PromptEditor'
import { AgentStatus, type AgentCard, type User } from '../../types'

/**
 * The editor's job is to make a stored prompt's blanks fillable and to stop a
 * half-filled one from reaching an agent. These cover the contract the four
 * composers rely on — the imperative handle, the send guard, and the two
 * serializations — plus the caret rule that everything else rests on.
 *
 * jsdom has no execCommand, so paths that use it (paste, line break,
 * replaceRange) are stubbed where exercised.
 */

afterEach(cleanup)

function setup(props: Partial<React.ComponentProps<typeof PromptEditor>> = {}) {
  const ref = createRef<PromptEditorHandle>()
  const onChange = vi.fn<(t: string, s: PromptStats) => void>()
  const onSubmit = vi.fn()
  const utils = render(
    <PromptEditor
      ref={ref}
      placeholder="Message @agent…"
      onChange={onChange}
      onSubmit={onSubmit}
      {...props}
    />,
  )
  const el = utils.container.querySelector('.pe-input') as HTMLDivElement
  // The handle's structural verbs go through React state (the `ver` counter
  // gates the one imperative innerHTML write), so they need an act() flush.
  const load = (src: string) => act(() => ref.current!.loadTemplate(src, false))
  const plain = (src: string) => act(() => ref.current!.setPlain(src, false))
  return { ref, onChange, onSubmit, el, load, plain, ...utils }
}

const BODY = 'Cut {{Count|number:6}} reels for {{Client}} by {{Deadline|date}}.'

describe('loadTemplate', () => {
  it('renders one atomic chip per blank', () => {
    const { ref, el, load } = setup()
    load(BODY)
    const chips = el.querySelectorAll('[data-ph]')
    expect(chips).toHaveLength(3)
    // Atomic: the caret steps over a chip rather than into it.
    chips.forEach((c) => expect(c.getAttribute('contenteditable')).toBe('false'))
    expect(chips[0].textContent).toContain('Count')
  })

  it('shows the type tag on an unfilled chip and drops it once filled', () => {
    const { ref, el, load } = setup()
    load('{{Voice|select:warm,punchy}}')
    expect(el.querySelector('.ph-k')?.textContent).toBe('sel')
    fireEvent.click(el.querySelector('[data-ph]')!)
    fireEvent.click(screen.getByText('warm'))
    const chip = el.querySelector('[data-ph]')!
    expect(chip.className).toContain('filled')
    expect(chip.querySelector('.ph-k')).toBeNull()
    expect(chip.textContent).toBe('warm')
  })

  it('reports stats through onChange', () => {
    const { ref, onChange, load } = setup()
    load(BODY)
    const [, stats] = onChange.mock.calls.at(-1)!
    expect(stats).toMatchObject({ total: 3, filled: 0, empty: 3 })
  })

  it('setPlain leaves braces literal — chips come only from a stored SOP', () => {
    const { ref, el, plain } = setup()
    plain('literal {{Braces}} here')
    expect(el.querySelectorAll('[data-ph]')).toHaveLength(0)
    expect(ref.current!.getText()).toBe('literal {{Braces}} here')
  })

  it('clear empties the box', () => {
    const { ref, load } = setup()
    load(BODY)
    act(() => ref.current!.clear())
    expect(ref.current!.getText()).toBe('')
  })
})

describe('getText vs getSource', () => {
  it('getText degrades unfilled blanks to [Label] — the send shape', () => {
    const { ref, load } = setup()
    load('Ship {{Thing}} now')
    expect(ref.current!.getText()).toBe('Ship [Thing] now')
  })

  it('getSource preserves unfilled blanks — the draft-save shape', () => {
    const { ref, el, load } = setup()
    load('Ship {{Thing}} by {{Deadline|date}}')
    // Fill only the first.
    fireEvent.click(el.querySelectorAll('[data-ph]')[0])
    fireEvent.change(screen.getByPlaceholderText('Type a value…'), {
      target: { value: 'the reels' },
    })
    fireEvent.click(screen.getByText('set'))
    // A saved draft must round-trip, not flatten to [Deadline].
    expect(ref.current!.getSource()).toBe('Ship the reels by {{Deadline|date}}')
    expect(ref.current!.getText()).toBe('Ship the reels by [Deadline]')
  })
})

describe('the send guard', () => {
  it('nudgeEmpty reports true, pulses the empties, and opens the first', () => {
    const { ref, el, load } = setup()
    load(BODY)
    let blocked = false
    // Opening the popover + showing the warning are React state, so flush.
    act(() => {
      blocked = ref.current!.nudgeEmpty()
    })
    expect(blocked).toBe(true)
    expect(el.querySelectorAll('.ph-chip.nudge')).toHaveLength(3)
    // The first empty blank's popover is open, addressed to it.
    expect(screen.getByRole('dialog', { name: /Fill Count/ })).toBeTruthy()
    expect(screen.getByText(/3 placeholders still need a value/)).toBeTruthy()
  })

  it('nudgeEmpty reports false once every blank is filled', () => {
    const { ref, el, load } = setup()
    load('{{A|select:x}} {{B|select:y}}')
    ;['x', 'y'].forEach((v, i) => {
      fireEvent.click(el.querySelectorAll('[data-ph]')[i])
      fireEvent.click(screen.getByText(v))
    })
    expect(ref.current!.nudgeEmpty()).toBe(false)
  })

  it('reports false when there are no blanks at all', () => {
    const { ref, plain } = setup()
    plain('a plain message')
    expect(ref.current!.nudgeEmpty()).toBe(false)
  })
})

describe('a repeated blank is one question', () => {
  // `{{A}} {{B}} {{A}}` is two questions — the rule `parse_blanks` applies on
  // the Python side, so `sop trigger --set A=…` already fills both A's from one
  // answer. The composer has to ask the same number of times.
  const TWICE = 'Reconcile {{Day|select:Mon,Tue}} for {{Loc|select:W8th}} and post {{Day}}.'

  it('counts distinct blanks, not occurrences', () => {
    const { el, onChange, load } = setup()
    load(TWICE)
    expect(el.querySelectorAll('[data-ph]')).toHaveLength(3)
    const [, stats] = onChange.mock.calls.at(-1)!
    expect(stats).toMatchObject({ total: 2, filled: 0, empty: 2 })
    expect(screen.getByText('0/2 filled')).toBeTruthy()
  })

  it('fills every occurrence from one answer and advances to the next blank', async () => {
    const { ref, el, load } = setup()
    load(TWICE)
    fireEvent.keyDown(el, { key: 'Tab' })
    fireEvent.click(screen.getByText('Mon'))

    const chips = el.querySelectorAll('[data-ph]')
    expect(chips[0].textContent).toBe('Mon')
    expect(chips[2].textContent).toBe('Mon')
    expect(screen.getByText('1/2 filled')).toBeTruthy()
    expect(ref.current!.getText()).toBe('Reconcile Mon for [Loc] and post Mon.')

    // Auto-advance lands on Loc, not on the twin that just got its answer.
    expect(await screen.findByRole('dialog', { name: /Fill Loc/ })).toBeTruthy()
  })

  it('warns about the blanks still owed, not the empty chips on screen', () => {
    const { ref, el, load } = setup()
    load(TWICE)
    act(() => {
      ref.current!.nudgeEmpty()
    })
    // All three pulse — every one of them reads as blank — but only two
    // answers are actually missing.
    expect(el.querySelectorAll('.ph-chip.nudge')).toHaveLength(3)
    expect(screen.getByText(/2 placeholders still need a value/)).toBeTruthy()
  })

  it('unblocks send once each distinct blank has an answer', () => {
    const { ref, el, load } = setup()
    load(TWICE)
    fireEvent.click(el.querySelectorAll('[data-ph]')[0])
    fireEvent.click(screen.getByText('Mon'))
    fireEvent.click(el.querySelectorAll('[data-ph]')[1])
    fireEvent.click(screen.getByText('W8th'))
    expect(ref.current!.nudgeEmpty()).toBe(false)
  })

  it('a half-filled draft still round-trips both {{…}} sources', () => {
    const { ref, el, load } = setup()
    load('Ship {{Thing}} by {{Day|date}} — {{ thing }} again')
    fireEvent.click(el.querySelectorAll('[data-ph]')[0])
    fireEvent.change(screen.getByPlaceholderText('Type a value…'), {
      target: { value: 'the reels' },
    })
    fireEvent.click(screen.getByText('set'))
    // The second occurrence took the value but keeps its own source text, so
    // saving and reloading gives back exactly what the author wrote.
    expect(ref.current!.getSource()).toBe('Ship the reels by {{Day|date}} — the reels again')
    expect(ref.current!.getText()).toBe('Ship the reels by [Day] — the reels again')
  })
})

describe('the status row', () => {
  it('is absent without blanks and counts progress with them', () => {
    const { ref, container, el, load, plain } = setup()
    plain('plain')
    expect(container.querySelector('.ph-bar')).toBeNull()

    load('{{A|select:x}} {{B|select:y}}')
    expect(screen.getByText('0/2 filled')).toBeTruthy()

    fireEvent.click(el.querySelectorAll('[data-ph]')[0])
    fireEvent.click(screen.getByText('x'))
    expect(screen.getByText('1/2 filled')).toBeTruthy()

    fireEvent.click(el.querySelectorAll('[data-ph]')[1])
    fireEvent.click(screen.getByText('y'))
    expect(screen.getByText('every placeholder filled')).toBeTruthy()
    expect(container.querySelector('.ph-bar.done')).toBeTruthy()
  })
})

describe('the fill popover', () => {
  it('offers a typed value even when the blank has a set', () => {
    const { ref, el, load } = setup()
    load('{{Voice|select:warm,punchy}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    // A set is a shortcut, never a cage.
    fireEvent.change(screen.getByPlaceholderText('or type your own…'), {
      target: { value: 'deadpan' },
    })
    fireEvent.click(screen.getByText('set'))
    expect(ref.current!.getText()).toBe('deadpan')
  })

  it('offers the standard quick picks for a bare date blank', () => {
    const { ref, el, load } = setup()
    load('{{Deadline|date}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    ;['Today', 'Tomorrow', 'End of week', 'Next Monday'].forEach((o) =>
      expect(screen.getByText(o)).toBeTruthy(),
    )
  })

  it('surfaces a default and clears back to empty', () => {
    const { ref, el, load } = setup()
    load('{{Threshold|text:$50}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    expect(screen.getByText(/default · \$50/)).toBeTruthy()
    // Empty input + `set` commits the default.
    fireEvent.click(screen.getByText('set'))
    expect(ref.current!.getText()).toBe('$50')

    fireEvent.click(el.querySelector('[data-ph]')!)
    fireEvent.click(screen.getByText('clear'))
    expect(ref.current!.getText()).toBe('[Threshold]')
  })

  it('swallows Escape so a surrounding overlay does not close', () => {
    const { ref, el, load } = setup()
    load('{{A}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    const input = screen.getByPlaceholderText('Type a value…')
    const evt = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    const seenAtWindow = vi.fn()
    window.addEventListener('keydown', seenAtWindow)
    input.dispatchEvent(evt)
    window.removeEventListener('keydown', seenAtWindow)
    // Dialogs around the composer bind a window-level Escape; filling a blank
    // must not close one out from under a half-written draft.
    expect(seenAtWindow).not.toHaveBeenCalled()
  })
})

/** A roster the `agent` / `agents` kinds can resolve against: the viewer's own
 *  assistant plus two peers, all online, all owned by the viewer (so they render
 *  under their short names). */
const VIEWER: User = {
  id: 'u1',
  username: 'ann',
  created_at: '2026-01-01T00:00:00Z',
}

const ROSTER: AgentCard[] = ['ann-backend', 'ann-assistant', 'ann-brand'].map((name, i) => ({
  id: `a${i}`,
  name,
  description: '',
  capabilities: [],
  status: AgentStatus.ONLINE,
  registered_at: '2026-01-01T00:00:00Z',
  last_heartbeat: null,
  discoverable_through_registry: false,
  registered_by: VIEWER.id,
  is_verified: true,
}))

describe('a multi-pick roster blank', () => {
  const multi = () => setup({ agents: ROSTER, viewer: VIEWER })

  it('leads the roster with the viewer own assistant, whatever the registry order', () => {
    const { el, load } = multi()
    load('{{Mentors|agents}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    const offered = Array.from(document.querySelectorAll('.ph-opt-tx')).map(
      (n) => n.textContent,
    )
    // Registry order is backend, assistant, brand — the default comes first.
    expect(offered).toEqual(['assistant', 'backend', 'brand'])
  })

  it('accumulates picks and stays open between them', () => {
    const { ref, el, load } = multi()
    load('Brief {{Mentors|agents}} first.')
    fireEvent.click(el.querySelector('[data-ph]')!)
    fireEvent.click(screen.getByText('assistant'))
    // Still open — a second mentor is one more click, not another round-trip.
    fireEvent.click(screen.getByText('backend'))
    expect(screen.getByText('2 picked')).toBeTruthy()
    fireEvent.click(screen.getByText('Done'))
    expect(ref.current!.getText()).toBe('Brief assistant, backend first.')
  })

  it('unticks a name that is clicked twice', () => {
    const { ref, el, load } = multi()
    load('{{Mentors|agents}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    fireEvent.click(screen.getByText('assistant'))
    fireEvent.click(screen.getByText('backend'))
    fireEvent.click(screen.getByText('assistant'))
    fireEvent.click(screen.getByText('Done'))
    expect(ref.current!.getText()).toBe('backend')
  })

  it('adds a typed name that is not on the roster', () => {
    const { ref, el, load } = multi()
    load('{{Mentors|agents}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    fireEvent.click(screen.getByText('assistant'))
    fireEvent.change(screen.getByPlaceholderText('or type a name…'), {
      target: { value: 'a human' },
    })
    fireEvent.click(screen.getByText('add'))
    fireEvent.click(screen.getByText('Done'))
    expect(ref.current!.getText()).toBe('assistant, a human')
  })

  it('answers with the assistant when Done is pressed on an untouched list', () => {
    const { ref, el, load } = multi()
    load('{{Mentors|agents}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    // The default is named on the button, so it is a promise before it is a click.
    fireEvent.click(screen.getByText('Done · assistant'))
    expect(ref.current!.getText()).toBe('assistant')
  })

  it('blocks send while untouched — the default is offered, never auto-applied', () => {
    const { ref, load } = multi()
    load('{{Mentors|agents}}')
    expect(ref.current!.getText()).toBe('[Mentors]')
    expect(ref.current!.nudgeEmpty()).toBe(true)
  })

  it('clears every pick without closing the menu', () => {
    const { ref, el, load } = multi()
    load('{{Mentors|agents}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    fireEvent.click(screen.getByText('assistant'))
    fireEvent.click(screen.getByText('clear'))
    expect(screen.queryByText('1 picked')).toBeNull()
    fireEvent.click(screen.getByText('brand'))
    fireEvent.click(screen.getByText('Done'))
    expect(ref.current!.getText()).toBe('brand')
  })

  it('a single-pick agent blank still commits on the first click', () => {
    const { ref, el, load } = multi()
    load('{{Approver|agent}}')
    fireEvent.click(el.querySelector('[data-ph]')!)
    fireEvent.click(screen.getByText('backend'))
    expect(ref.current!.getText()).toBe('backend')
    // No Done button, and no assistant default: a single roster blank commits
    // exactly what was picked, as it always has.
    expect(screen.queryByText('Done')).toBeNull()
  })
})

describe('keyboard', () => {
  it('Cmd/Ctrl+Enter submits; plain Enter does not', () => {
    const { onSubmit, el } = setup()
    fireEvent.keyDown(el, { key: 'Enter', metaKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(el, { key: 'Enter', ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(2)

    document.execCommand = vi.fn(() => true)
    fireEvent.keyDown(el, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('Escape blurs so global nav hotkeys take over', () => {
    const { el } = setup()
    el.focus()
    const blur = vi.spyOn(el, 'blur')
    fireEvent.keyDown(el, { key: 'Escape' })
    expect(blur).toHaveBeenCalled()
  })

  it('a consumer that preventDefaults takes the key from the editor', () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault())
    const { onSubmit, el } = setup({ onKeyDown })
    // This is how MessageInput keeps Enter for its @mention dropdown.
    fireEvent.keyDown(el, { key: 'Enter', metaKey: true })
    expect(onKeyDown).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Tab jumps to the next empty blank', () => {
    const { ref, el, load } = setup()
    load('{{First}} {{Second}}')
    fireEvent.keyDown(el, { key: 'Tab' })
    expect(screen.getByRole('dialog', { name: /Fill First/ })).toBeTruthy()
  })
})

describe('paste', () => {
  it('is forced to plain text', () => {
    const exec = vi.fn(() => true)
    document.execCommand = exec
    const { el } = setup()
    fireEvent.paste(el, {
      clipboardData: { getData: () => 'pasted <b>markup</b>' },
    })
    expect(exec).toHaveBeenCalledWith('insertText', false, 'pasted <b>markup</b>')
  })
})

describe('the caret contract', () => {
  it('filling a chip does not rewrite the editable root', () => {
    const { ref, el, load } = setup()
    load('{{A|select:x}} tail')
    const chipNode = el.querySelector('[data-ph]')!
    const tailNode = el.lastChild

    fireEvent.click(chipNode)
    fireEvent.click(screen.getByText('x'))

    // Same node objects — only the chip's own innerHTML changed. If the
    // structural effect had re-run, these identities would be gone and the
    // user's caret with them.
    expect(el.querySelector('[data-ph]')).toBe(chipNode)
    expect(el.lastChild).toBe(tailNode)
  })

  it('typing does not rewrite the editable root', () => {
    const { ref, el, load } = setup()
    load('{{A}} tail')
    const chipNode = el.querySelector('[data-ph]')!
    fireEvent.input(el)
    expect(el.querySelector('[data-ph]')).toBe(chipNode)
  })
})

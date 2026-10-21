import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DeskLabel } from '../../api/endpoints/deskLabels'
import { toRegistry, type RegistryState } from '../../utils/labelView'
import { CaptureLabels } from './LabelInput'
import LabelInput, {
  applyPick,
  captureMenu,
  captureToken,
  menuLength,
  pickExceedsCap,
  stripToken,
} from './LabelInput'

/**
 * The confirm rule and the cap.
 *
 * The cap is the one behaviour in the whole feature with NO mock check behind
 * it — no fixture row comes near eight labels, the worst carries three — so
 * everything here is new rather than ported, and it is the only coverage it
 * will ever have.
 */

/** One kind. `next` and `wait-for` kept their rows through the retirement —
 *  nothing on disk is deleted — and arrive as ordinary contexts. */
const L = (slug: string, name = slug): DeskLabel => ({
  slug,
  name,
  kind: 'context',
  color: 'blue',
  created_at: '1970-01-01T00:00:00+00:00',
  updated_at: '1970-01-01T00:00:00+00:00',
})

const LABELS = [
  L('office'),
  L('home'),
  L('computer'),
  L('errands'),
  L('phone'),
  L('garage'),
  L('deep-work'),
  L('studio'),
  L('shed'),
  L('next', 'Next'),
  L('wait-for', 'Wait For'),
]

const reg = (state: RegistryState = 'ready', labels = LABELS) => toRegistry(labels, state)

afterEach(cleanup)

describe('captureToken — the confirm rule', () => {
  it('sees a live @ token at the caret — and ONLY @', () => {
    // The `!` arm is gone with the axis it reached. A typed `!` is ordinary
    // text now and stays in the to-do, which is the right outcome rather than a
    // regression: there is no second axis for it to name, so stripping it would
    // silently eat a character the owner meant to keep.
    expect(captureToken('call the bank @off')).toEqual({ query: 'off' })
    expect(captureToken('@')).toEqual({ query: '' })
    expect(captureToken('!wait')).toBeNull()
  })

  it('sees nothing once the token is no longer at the caret', () => {
    expect(captureToken('ask @assistant about the Provi PO')).toBeNull()
    expect(captureToken('plain text')).toBeNull()
  })

  it('stripToken removes ONLY the trailing token, and never a bare !', () => {
    expect(stripToken('call the bank @off')).toBe('call the bank ')
    expect(stripToken('no token here')).toBe('no token here')
    // WAS stripped as a state token. Now it is text the owner wrote.
    expect(stripToken('ship it !urgent')).toBe('ship it !urgent')
  })
})

describe('captureMenu', () => {
  it('offers matching labels — there is one pool now, not one per sigil', () => {
    // WAS "offers matching labels of the token's kind, and only that kind",
    // where `!w` opened a STATE menu. `CaptureMenu.kind` is gone with the
    // second pool; every token draws from the one list of contexts.
    const m = captureMenu('@off', [], reg())!
    expect(m.hits.map((l) => l.slug)).toEqual(['office'])
    // `wait-for` is still offered — it just takes the `@` key like everything
    // else, because it is a context now.
    expect(captureMenu('@w', [], reg())!.hits.map((l) => l.slug)).toEqual(['wait-for'])
    // and `!` opens nothing at all
    expect(captureMenu('!w', [], reg())).toBeNull()
  })

  it('offers to CREATE past two characters, and not before', () => {
    expect(captureMenu('@ne', [], reg())!.canCreate).toBe(true)
    expect(captureMenu('@z', [], reg())?.canCreate ?? false).toBe(false)
  })

  it('an existing name offers no CREATE — it is simply that label', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "names the
    // OTHER axis and the key to press, both directions", and the answering was
    // the point: one flat slug namespace shared by two kinds meant either could
    // have got there first, so `@next` had to say "that is a state, press !".
    //
    // `CaptureMenu.clash` is deleted with the second kind. WHAT REPLACED IT is
    // the plain match underneath: `@next` hits the existing `next` row, so the
    // menu offers to ATTACH it and does not offer to create a duplicate.
    const m = captureMenu('@next', [], reg())!
    expect(m.hits.map((l) => l.slug)).toEqual(['next'])
    expect(m.canCreate).toBe(false)
  })

  it('offers NOTHING while the registry is unreadable', () => {
    // Inline-creating `garage` over a `garage` the owner made last week would
    // earn a labels.duplicate; we cannot know what exists, so we offer nothing.
    expect(captureMenu('@off', [], reg('unavailable', []))).toBeNull()
  })

  it('refuses a slug over 32 chars AND says why, rather than vanishing', () => {
    // A menu that just disappears at the 33rd character leaves the owner to
    // discover the refusal from a 400 on submit — the exact outcome that
    // refusing at input time exists to avoid.
    const m = captureMenu('@' + 'a'.repeat(40), [], reg())!
    expect(m.canCreate).toBe(false)
    expect(m.fault).toBe('slug_too_long')
  })

  it('menuLength counts the create row', () => {
    const m = captureMenu('@ne', [], reg())!
    expect(menuLength(m)).toBe(m.hits.length + 1)
  })
})

describe('the 8-label cap', () => {
  const eight = LABELS.slice(0, 8).map((l) => l.slug)

  it('a 9th label is refused, and the reason is stated', () => {
    expect(pickExceedsCap(eight, 'shed')).toBe(true)
  })

  it('EVERY pick at the cap is refused now — there is no replacing pick left', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "a state
    // pick AT the cap is allowed — it replaces, so the set does not grow", and
    // it was a real entitlement: at-most-one-state meant picking `wait-for`
    // swapped out `next` rather than adding, so the set stayed at eight.
    //
    // `applyPick`'s state branch was the ONLY enforcement of one-state-per-todo
    // anywhere in the product, and it is deleted with the axis. WHAT REPLACED
    // IT: nothing, because a context has never been exclusive — `wait-for` is
    // an ordinary ninth label now and the cap correctly refuses it.
    //
    // Counting the RESULT rather than the input is still the right shape; it
    // just no longer earns a case, since result and input now agree.
    const withNext = [...LABELS.slice(0, 7).map((l) => l.slug), 'next']
    expect(withNext).toHaveLength(8)
    expect(pickExceedsCap(withNext, 'wait-for')).toBe(true)
    expect(applyPick(withNext, 'wait-for')).toHaveLength(9)
    expect(applyPick(withNext, 'wait-for')).toContain('next')
  })

  it('REMOVING at the cap is always allowed', () => {
    expect(applyPick(eight, eight[0])).toHaveLength(7)
  })

  it('the autocomplete stops offering at the cap', () => {
    const m = captureMenu('@she', eight, reg())!
    expect(m.atCap).toBe(true)
    expect(m.canCreate).toBe(false)
  })

  it('the typed token stays LITERAL at the cap — never silently dropped', () => {
    // The owner keeps what they wrote and can delete a chip and retry without
    // retyping. Nothing here strips the text.
    const text = 'buy bolts @she'
    expect(captureMenu(text, eight, reg())!.atCap).toBe(true)
    expect(text).toBe('buy bolts @she')
  })

  it('the picker disables every ADD affordance at the cap, with the reason', () => {
    render(
      <LabelInput
        value={eight}
        registry={reg()}
        onChange={vi.fn()}
        onCreate={vi.fn()}
      />,
    )
    expect(screen.getByText(/8 labels is the maximum/)).toBeTruthy()
    // A label already on the row stays clickable — that is how you get UNDER
    // the cap.
    const on = screen.getByRole('button', { name: '@office' }) as HTMLButtonElement
    expect(on.getAttribute('aria-disabled')).not.toBe('true')
    // `aria-disabled`, not `disabled`: the blocked row keeps its place in the
    // tab order so the refusal has something to attach to.
    const off = screen.getByRole('button', { name: '@shed' }) as HTMLButtonElement
    expect(off.disabled).toBe(false)
    expect(off.getAttribute('aria-disabled')).toBe('true')
    expect((screen.getByLabelText('Create a label') as HTMLInputElement).disabled).toBe(true)
  })

  it('the picker blocks EVERY off row at the cap, including the old state rows', () => {
    // Was "the picker leaves the STATE rows enabled at the cap" — the surface
    // half of the deleted entitlement above. `@Wait For` is an ordinary label
    // now, so it blocks like any other; `aria-disabled` rather than `disabled`
    // is unchanged, because the refusal still needs somewhere to attach.
    const withNext = [...LABELS.slice(0, 7).map((l) => l.slug), 'next']
    render(<LabelInput value={withNext} registry={reg()} onChange={vi.fn()} onCreate={vi.fn()} />)
    const other = screen.getByRole('button', { name: '@Wait For' }) as HTMLButtonElement
    expect(other.disabled).toBe(false)
    expect(other.getAttribute('aria-disabled')).toBe('true')
  })

  it('renders a cap 400 that beat the input-time guard', () => {
    // Reachable by race: another tab adds labels between this tab's last
    // refetch and its PATCH.
    render(
      <LabelInput
        value={['office']}
        registry={reg()}
        onChange={vi.fn()}
        onCreate={vi.fn()}
        error="That would put too many labels on one to-do — at most 8 labels per to-do (got 10). Take one off first."
      />,
    )
    expect(screen.getByText(/got 10/)).toBeTruthy()
  })
})

describe('the picker', () => {
  let onChange: ReturnType<typeof vi.fn>
  beforeEach(() => {
    onChange = vi.fn()
  })

  it('every pick ACCUMULATES — nothing replaces anything any more', () => {
    // Was "picking a state REPLACES the one already there". The section it was
    // clicked in ("State — pick one") is gone from the picker along with the
    // rule it enforced.
    render(
      <LabelInput value={['office', 'next']} registry={reg()} onChange={onChange} onCreate={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '@Wait For' }))
    expect(onChange).toHaveBeenCalledWith(['office', 'next', 'wait-for'])
    expect(screen.queryByText(/State — pick one/)).toBeNull()
  })

  it('picking a context ACCUMULATES', () => {
    render(<LabelInput value={['office']} registry={reg()} onChange={onChange} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '@home' }))
    expect(onChange).toHaveBeenCalledWith(['office', 'home'])
  })

  it('lists an unregistered slug the row carries, so it can be removed', () => {
    // Otherwise the only way to SEE it is the chip and the only way to remove
    // it is to guess.
    render(<LabelInput value={['offce']} registry={reg()} onChange={onChange} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Remove @offce from this to-do'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('inline create always sends kind:context — the ! fork is gone', () => {
    // Was "sends kind:state for a ! prefix and kind:context otherwise". There
    // is one kind, so the prefix decides nothing; `displayNameFrom` still
    // strips a leading sigil, so `!blocked` creates `blocked` rather than
    // carrying the character into the name.
    const onCreate = vi.fn().mockResolvedValue(L('brand-new'))
    render(<LabelInput value={[]} registry={reg()} onChange={onChange} onCreate={onCreate} />)
    const input = screen.getByLabelText('Create a label')
    fireEvent.change(input, { target: { value: '!blocked' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith('blocked', 'context')

    fireEvent.change(input, { target: { value: 'garden' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenLastCalledWith('garden', 'context')
  })

  it('inline create refuses a >32-char slug at input time', () => {
    const onCreate = vi.fn()
    render(<LabelInput value={[]} registry={reg()} onChange={onChange} onCreate={onCreate} />)
    const input = screen.getByLabelText('Create a label')
    fireEvent.change(input, { target: { value: 'a'.repeat(40) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText(/too long/)).toBeTruthy()
  })

  it('a ! prefix on an existing name now ATTACHES it — there is no clash to report', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "a ! prefix
    // on an existing CONTEXT reports the clash — it does not attach it", and it
    // guarded a genuine trap: `!office` normalized to a slug the registry had,
    // so an existing-first branch would silently hand the owner the CONTEXT
    // @office when they pressed `!` and meant a state.
    //
    // Both halves of the trap are gone — there is no other kind to mean, and
    // `clashWith` is deleted. WHAT REPLACED IT is the existing-first branch
    // itself, which is now simply correct: the registry has the slug, so the
    // right answer is to attach that label.
    const onCreate = vi.fn()
    render(<LabelInput value={[]} registry={reg()} onChange={onChange} onCreate={onCreate} />)
    const input = screen.getByLabelText('Create a label')
    fireEvent.change(input, { target: { value: '!office' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(['office'])
  })

  it('an existing name attaches the existing label rather than creating a duplicate', () => {
    const onCreate = vi.fn()
    render(<LabelInput value={[]} registry={reg()} onChange={onChange} onCreate={onCreate} />)
    const input = screen.getByLabelText('Create a label')
    fireEvent.change(input, { target: { value: '@office' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(['office'])
  })

  it('off-ready it offers no list but still removes what the row carries', () => {
    render(
      <LabelInput
        value={['office', 'next']}
        registry={reg('unavailable', [])}
        onChange={onChange}
        onCreate={vi.fn()}
      />,
    )
    expect(screen.queryByLabelText('Create a label')).toBeNull()
    expect(screen.getByText(/didn't load/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove next from this to-do'))
    expect(onChange).toHaveBeenCalledWith(['office'])
  })
})

describe('an UNWRITABLE registry — no create path may stay reachable', () => {
  // `orphaned` is a 200 with zero rows over a labelled plate: the file could not
  // be parsed. A create there appends to an empty list and SAVES, overwriting
  // bytes that may still have been recoverable. Every create surface refuses,
  // and every one of them SAYS SO — a refusal the owner cannot see is the same
  // failure as no refusal, discovered later as a 400.

  it('the picker disables the create field and gives the reason', () => {
    render(
      <LabelInput
        value={[]}
        registry={reg('ready', [])}
        onChange={vi.fn()}
        onCreate={vi.fn()}
        writable={false}
      />,
    )
    expect((screen.getByLabelText('Create a label') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/could overwrite the list we cannot read/)).toBeTruthy()
  })

  it('the picker refuses a submitted create rather than firing it', () => {
    const onCreate = vi.fn()
    render(
      <LabelInput
        value={[]}
        registry={reg('ready', [])}
        onChange={vi.fn()}
        onCreate={onCreate}
        writable={false}
      />,
    )
    const input = screen.getByLabelText('Create a label')
    fireEvent.change(input, { target: { value: '@office' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    // And the typed token is still there — refused, not swallowed.
    expect((input as HTMLInputElement).value).toBe('@office')
  })

  it('the capture menu still OPENS, carrying the refusal', () => {
    // The dangerous shape is the silent one: with no labels to match, a bare
    // `canCreate: false` makes the whole menu vanish and the owner meets the
    // refusal as a 400 on submit — the exact outcome refusing at input time
    // exists to avoid.
    const m = captureMenu('@office', [], reg('ready', []), false)
    expect(m).not.toBeNull()
    expect(m!.canCreate).toBe(false)
    expect(m!.refusal).toMatch(/could overwrite the list we cannot read/)
    expect(menuLength(m!)).toBe(0)
  })

  it('the capture menu renders that refusal', () => {
    const m = captureMenu('@office', [], reg('ready', []), false)!
    render(
      <CaptureLabels
        menu={m}
        index={0}
        registry={reg('ready', [])}
        onAccept={vi.fn()}
        onCreate={vi.fn()}
      />,
    )
    expect(screen.getByText(/could overwrite the list we cannot read/)).toBeTruthy()
    expect(screen.queryByText(/Create context/)).toBeNull()
  })

  it('leaves the writable case alone', () => {
    expect(captureMenu('@newthing', [], reg())!.canCreate).toBe(true)
    expect(captureMenu('@newthing', [], reg())!.refusal).toBeNull()
  })
})

describe('the cap explains itself to a keyboard', () => {
  const eight = LABELS.slice(0, 8).map((l) => l.slug)

  it('puts the reason ABOVE the rows it explains', () => {
    // In a max-height scroller with a large registry, a note at the foot is
    // below the fold while the owner is pressing dead rows at the head.
    const { container } = render(
      <LabelInput value={eight} registry={reg()} onChange={vi.fn()} onCreate={vi.fn()} />,
    )
    const cap = container.querySelector('.pop-cap')!
    const firstSection = container.querySelector('.pop-sec')!
    expect(cap.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('points each blocked row at that reason', () => {
    render(<LabelInput value={eight} registry={reg()} onChange={vi.fn()} onCreate={vi.fn()} />)
    const blocked = screen.getByRole('button', { name: '@shed' })
    const capId = blocked.getAttribute('aria-describedby')
    expect(capId).toBeTruthy()
    expect(document.getElementById(capId!)!.textContent).toMatch(/8 labels is the maximum/)
  })

  it('still refuses a blocked row that is clicked anyway', () => {
    // `aria-disabled` keeps the row in the tab order, so the click now ARRIVES;
    // `pick` is what refuses it. And the reason stays stated exactly once — it
    // is already above the row and linked to it.
    const onChange = vi.fn()
    const { container } = render(
      <LabelInput value={eight} registry={reg()} onChange={onChange} onCreate={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '@shed' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.pop-cap')).toHaveLength(1)
    expect(container.querySelector('.pop-err')).toBeNull()
  })
})

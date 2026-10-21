import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DeskLabel } from '../../api/endpoints/deskLabels'
import { toRegistry, type RegistryContent, type RegistryState } from '../../utils/labelView'

/**
 * The manage sheet: the only surface that can reorder the registry — which is
 * the only way to control group order.
 *
 * It USED to be the sole repair path for a label filed under the wrong kind.
 * There is one kind, so there is nothing to file wrongly and nothing to repair.
 */

const refetch = vi.fn()
const create = vi.fn()
const rename = vi.fn()
const recolour = vi.fn()
const reorder = vi.fn()
const remove = vi.fn()
const merge = vi.fn()

vi.mock('../../hooks/useLabels', () => ({
  useLabels: () => ({
    registry: toRegistry([], 'ready'),
    isLoading: false,
    isError: false,
    refetch,
    create,
    rename,
    recolour,
    reorder,
    remove,
    merge,
  }),
}))

const { default: LabelManageSheet } = await import('./LabelManageSheet')

/** One kind. The last three rows were the owner's states before the
 *  retirement and arrive as contexts — their rows, names, colours and
 *  positions all intact, because nothing on disk was deleted. */
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
  L('phone'),
  L('next', 'Next'),
  L('wait-for', 'Wait For'),
  L('someday', 'Some Day'),
]

const flash = vi.fn()

function renderSheet(
  labels = LABELS,
  state: RegistryState = 'ready',
  unregistered: string[] = [],
  content: RegistryContent = labels.length ? 'populated' : 'empty',
) {
  const onClose = vi.fn()
  render(
    <LabelManageSheet
      registry={toRegistry(labels, state)}
      content={content}
      refCounts={new Map(labels.map((l, i) => [l.slug, i + 1]))}
      unregistered={unregistered}
      onClose={onClose}
      flash={flash}
    />,
  )
  return { onClose }
}

beforeEach(() => {
  for (const m of [create, rename, recolour, reorder, remove, merge, flash, refetch]) m.mockReset()
  create.mockResolvedValue(L('new'))
  // Every verb on the hook returns a promise; a bare vi.fn() would return
  // undefined and the component's `.catch` would throw inside an event
  // handler, which vitest reports as an unhandled error rather than a failure.
  rename.mockResolvedValue(L('office'))
  recolour.mockResolvedValue(L('office'))
  remove.mockResolvedValue({ detached_from: 3 })
  merge.mockResolvedValue({ moved: 3, into: 'home' })
  reorder.mockResolvedValue([])
})
afterEach(cleanup)

describe('the merge dropdown offers every OTHER label, and never itself', () => {
  // WAS "offers SAME-KIND targets only", walked over every label rather than
  // spot-checked because merging a context INTO a state would have handed that
  // state to every to-do carrying the context — including to-dos that already
  // had one, which `kind` existed to prevent.
  //
  // The guard is not weakened, it is SATISFIED BY CONSTRUCTION: one kind means
  // every other row is same-kind. The server still refuses a cross-kind merge
  // with `labels.kind_mismatch`, and that code is still mapped client-side for
  // a registry written before the retirement. The walk is kept because
  // "never itself" is the half that can still regress.
  it.each(LABELS.map((l) => [l.slug, '@' + l.name] as const))(
    '%s can merge into any other label but itself',
    (slug, display) => {
      renderSheet()
      fireEvent.click(screen.getByLabelText(`Delete or merge ${display}`))
      const select = screen.getByLabelText('Merge target') as HTMLSelectElement
      const targets = [...select.options].map((o) => o.value).filter(Boolean)
      expect(targets).not.toContain(slug)
      expect(targets.length).toBe(LABELS.length - 1)
    },
  )
})

describe('delete and merge', () => {
  it('the confirm names the detach count and says the to-dos survive', () => {
    renderSheet()
    fireEvent.click(screen.getByLabelText('Delete or merge @office'))
    const warn = screen.getByRole('alertdialog')
    // refCounts gives @office 1
    expect(warn.textContent).toContain('1 to-do')
    expect(warn.textContent).toContain('stay on your plate')
  })

  it('deleting the last of anything warns about NOTHING extra now', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "warns that
    // grouping switches off when deleting the LAST state", and the warning was
    // honest at the time: delete your only state row and grouping by state had
    // nothing left to project onto, so it switched off.
    //
    // WHAT REPLACED IT: nothing, and nothing may. Grouping by ticket state
    // reads no registry row at all, so no label deletion can take it away —
    // and a warning saying otherwise would be false. The delete confirm keeps
    // its one true sentence: the to-dos themselves stay on the plate.
    renderSheet([L('office'), L('next', 'Next')])
    fireEvent.click(screen.getByLabelText('Delete or merge @Next'))
    const dialog = screen.getByRole('alertdialog').textContent!
    expect(dialog).not.toContain('last state')
    expect(dialog).not.toContain('Unprocessed')
    expect(dialog).toContain('stay on your plate')
  })

  it('confirm with no target DELETES and reads the detach count back', async () => {
    renderSheet()
    fireEvent.click(screen.getByLabelText('Delete or merge @office'))
    fireEvent.click(screen.getByText('Confirm'))
    expect(remove).toHaveBeenCalledWith('office')
    expect(merge).not.toHaveBeenCalled()
    await waitFor(() => expect(flash).toHaveBeenCalledWith(expect.stringContaining('3 to-dos')))
    expect(flash.mock.calls[0][0]).toContain('None were removed')
  })

  it('confirm with a target MERGES instead', async () => {
    renderSheet()
    fireEvent.click(screen.getByLabelText('Delete or merge @office'))
    fireEvent.change(screen.getByLabelText('Merge target'), { target: { value: 'home' } })
    fireEvent.click(screen.getByText('Confirm'))
    expect(merge).toHaveBeenCalledWith('office', 'home')
    expect(remove).not.toHaveBeenCalled()
    await waitFor(() => expect(flash).toHaveBeenCalledWith(expect.stringContaining('merged into home')))
  })
})

describe('rename and recolour', () => {
  it('PATCH sends only the name — never kind', () => {
    renderSheet()
    const input = screen.getByLabelText('Rename @office')
    fireEvent.change(input, { target: { value: 'The Office' } })
    fireEvent.blur(input)
    // `rename` is the hook verb that PATCHes {name}; there is no kind path at
    // all, which is the point — an equal echo would mean the sheet is PATCHing
    // the whole row back.
    expect(rename).toHaveBeenCalledWith('office', 'The Office')
  })

  it('an unchanged name writes nothing', () => {
    renderSheet()
    const input = screen.getByLabelText('Rename @office')
    fireEvent.blur(input)
    expect(rename).not.toHaveBeenCalled()
  })

  it('the swatch cycles the palette', () => {
    renderSheet()
    fireEvent.click(screen.getByLabelText('Change colour of @office'))
    expect(recolour).toHaveBeenCalledWith('office', 'green')
  })
})

describe('reorder', () => {
  it('writes the whole registry order', () => {
    renderSheet()
    // Keyboard route: a pointer drag is unreachable by keyboard, and
    // reordering the registry is the ONLY way to control group order.
    fireEvent.keyDown(screen.getByLabelText('Reorder @home'), { key: 'ArrowUp' })
    expect(reorder).toHaveBeenCalledWith([
      'home',
      'office',
      'phone',
      'next',
      'wait-for',
      'someday',
    ])
  })

  it('arrow keys stop at the ENDS of the one list', () => {
    // WAS "move within the KIND, never across the axis boundary" — @phone was
    // the last context and ArrowDown must not have walked it into the states.
    // There is one list now, so the only boundary left is its last row.
    renderSheet()
    fireEvent.keyDown(screen.getByLabelText('Reorder @Some Day'), { key: 'ArrowDown' })
    expect(reorder).not.toHaveBeenCalled()
    // …and @phone, which used to be a boundary, now moves freely.
    fireEvent.keyDown(screen.getByLabelText('Reorder @phone'), { key: 'ArrowDown' })
    expect(reorder).toHaveBeenCalled()
  })

  it('announces the new position for a screen reader', () => {
    renderSheet()
    fireEvent.keyDown(screen.getByLabelText('Reorder @home'), { key: 'ArrowUp' })
    // "of 6", not "of 3": one list, not two.
    expect(screen.getByText(/moved to position 1 of 6/)).toBeTruthy()
  })
})

describe('create', () => {
  it('there is ONE section and ONE add control — kind cannot be mis-set', () => {
    // WAS "kind is POSITIONAL — the States section adds a state". The split was
    // positional precisely because kind was immutable and consequential; with
    // one kind there is no field on this form that can be mis-set, so the
    // second section and its add control are deleted rather than disabled.
    renderSheet()
    expect(screen.queryByText('Add a state')).toBeNull()
    expect(screen.queryByText(/States —/)).toBeNull()
    fireEvent.click(screen.getByText('Add a context'))
    fireEvent.change(screen.getByLabelText('New context name'), { target: { value: 'Blocked' } })
    fireEvent.click(screen.getByText('Add context'))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'blocked', kind: 'context' }),
    )
  })

  it('always sends colour explicitly, so no create flashes one then repaints', () => {
    renderSheet()
    fireEvent.click(screen.getByText('Add a context'))
    fireEvent.change(screen.getByLabelText('New context name'), { target: { value: 'garage' } })
    fireEvent.click(screen.getByText('Add context'))
    // Six seed rows all on `blue` here, so the least-used token is `green`.
    expect(create.mock.calls[0][0].color).toBeTruthy()
  })

  it('refuses a DUPLICATE name before the round trip', () => {
    // WAS "refuses a cross-kind name collision" — `office` typed under States,
    // which the sheet answered by naming the section to use instead. One
    // namespace and one kind makes that simply a duplicate, and the branch
    // underneath it already refused one. The refusal survives; the reason it
    // gives is the true one now.
    renderSheet()
    fireEvent.click(screen.getByText('Add a context'))
    fireEvent.change(screen.getByLabelText('New context name'), { target: { value: 'office' } })
    fireEvent.click(screen.getByText('Add context'))
    expect(create).not.toHaveBeenCalled()
    expect(screen.getByText(/already have/)).toBeTruthy()
  })

  it('refuses a >32-char slug rather than truncating it', () => {
    renderSheet()
    fireEvent.click(screen.getByText('Add a context'))
    fireEvent.change(screen.getByLabelText('New context name'), {
      target: { value: 'a'.repeat(40) },
    })
    fireEvent.click(screen.getByText('Add context'))
    expect(create).not.toHaveBeenCalled()
    expect(screen.getByText(/too long/)).toBeTruthy()
  })
})

describe('the unregistered section', () => {
  it('offers ONE verb — the fork it used to ask about is gone', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "offers @
    // and ! — and ! ONLY here, never one-tap from a chip", and the fork was
    // real: an agent that wrote `waiting-on-bank` had no way to say which axis
    // it meant, so the owner had to, and `!` was confined to this surface
    // because it could hand a second state to a to-do that already had one.
    //
    // WHAT REPLACED IT: one tap. There is nothing to ask, and the `!` button is
    // deleted rather than left to send a kind the server would refuse.
    renderSheet(LABELS, 'ready', ['waiting-on-bank'])
    expect(screen.queryByLabelText('Add waiting-on-bank as a state')).toBeNull()
    fireEvent.click(screen.getByLabelText('Add waiting-on-bank to your label list'))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'context' }))
  })
})

describe('the degraded surfaces', () => {
  it('an empty registry invites the first label rather than reading as broken', () => {
    renderSheet([], 'ready')
    expect(screen.getByText(/No labels yet/)).toBeTruthy()
    expect(screen.getByText('Add a context')).toBeTruthy()
  })

  it('a LOST registry offers nothing to manage, and says nothing was lost', () => {
    // Every control would be a lie: the sections would read empty, the add
    // forms would collide with labels that do exist, and the unregistered
    // section would offer to add back the owner's whole vocabulary.
    renderSheet([], 'unavailable')
    expect(screen.getByText(/didn't load/)).toBeTruthy()
    expect(screen.queryByText('Add a context')).toBeNull()
  })

  describe('an ORPHANED registry — the corrupt-looks-missing trap', () => {
    // The server answers an unparseable registry with a 200 and ZERO ROWS, so
    // `state` is `ready` and the list is empty. Before `content` reached the
    // sheet that read as "no labels yet", and the owner's whole real vocabulary
    // was listed under "written by an agent" with one-tap re-add — a tap that
    // appends one row to an empty list and SAVES, overwriting the file.
    const ORPHANED = (): void => renderSheet([], 'ready', ['office', 'home', 'phone'], 'orphaned')

    it('does not claim the owner has no labels', () => {
      ORPHANED()
      expect(screen.queryByText(/No labels yet/)).toBeNull()
      expect(screen.getByText(/still carry labels/)).toBeTruthy()
    })

    it('leaves NO write path reachable', () => {
      ORPHANED()
      // The two add forms, the unregistered section and its one-tap @ / ! are
      // all gone — checked as absences, since the destructive tap was a button
      // that merely LOOKED like the repair.
      expect(screen.queryByText('Add a context')).toBeNull()
      expect(screen.queryByText('Add a state')).toBeNull()
      expect(screen.queryByText(/written by an agent/)).toBeNull()
      expect(screen.queryByLabelText('Add office as a context')).toBeNull()
      expect(screen.queryByLabelText('Add office as a state')).toBeNull()
      // Nothing that reorders, renames, recolours, deletes or merges either.
      expect(screen.queryAllByRole('textbox')).toHaveLength(0)
      for (const verb of [create, rename, recolour, reorder, remove, merge]) {
        expect(verb).not.toHaveBeenCalled()
      }
    })

    it('offers Try again, and tells the owner to wait before rebuilding', () => {
      ORPHANED()
      fireEvent.click(screen.getByText('Try again'))
      expect(refetch).toHaveBeenCalled()
      expect(screen.getByText(/before adding anything back/)).toBeTruthy()
    })

    it('does not borrow the failure copy — nothing failed', () => {
      ORPHANED()
      expect(screen.queryByText(/didn't load/)).toBeNull()
    })
  })

  it('a PENDING registry says it is loading, not that it failed', () => {
    // `axisKnown` is false for `cold` and `unavailable` alike, so without
    // `unknownAxisReason` the very first query of the session reports a failure.
    renderSheet([], 'cold')
    expect(screen.getByText(/Still loading your labels/)).toBeTruthy()
    expect(screen.queryByText(/didn't load/)).toBeNull()
  })

  it('closes on Escape', () => {
    const { onClose } = renderSheet()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('the ONE section header still carries its cardinality', () => {
    // The "one per to-do" half went with the States section. The surviving half
    // is not decoration either: with two sections the pair was the whole
    // difference between the axes in six words, and with one it is still the
    // only thing on screen saying a to-do may carry several.
    renderSheet()
    expect(screen.getByText('any number per to-do')).toBeTruthy()
    expect(screen.queryByText('one per to-do')).toBeNull()
    expect(within(document.body).getByText(/Deleting/)).toBeTruthy()
  })
})

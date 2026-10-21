import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentCard } from '../../types'
import type { DeskSop } from '../../api/endpoints/deskSops'

/**
 * The SOP rail's job is to get a stored prompt into the composer addressed to
 * the right agent. These cover that, plus the card's keyboard semantics (it's
 * a div[role=button], because the hover actions are real buttons and can't
 * nest inside one). The syntax lesson lives in the authoring dialog, not here.
 */

const save = vi.fn()
const remove = vi.fn()
const touch = vi.fn()
let sops: DeskSop[] = []
let recentIds: string[] = []
let agents: AgentCard[] | undefined
let sopSchedules = new Map<string, never>()

const AGENT = {
  id: 'a1',
  name: 'ana-editor',
  registered_by: 'u1',
  status: 'online',
} as AgentCard

function sop(over: Partial<DeskSop> = {}): DeskSop {
  return {
    id: 's1',
    owner_user_id: 'u1',
    title: 'Weekly reel batch',
    agent_id: 'a1',
    agent_name: 'ana-editor',
    body: 'Cut {{Count|number:6}} reels by {{Deadline|date}}.',
    created_at: '',
    updated_at: '',
    ...over,
  }
}

vi.mock('../../hooks/useSops', () => ({
  useSops: () => ({ sops, isLoading: false, save, remove }),
}))
vi.mock('../../hooks/useSopRecents', () => ({
  useSopRecents: () => ({ recentIds, touch }),
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
// Cadence chips ride on a react-query fetch; the rail's own behaviour doesn't
// depend on it, so stub the lookup rather than standing up a QueryClient.
vi.mock('../../hooks/useSopSchedules', () => ({ useSopSchedules: () => sopSchedules }))
vi.mock('../../hooks/useMyAgents', () => ({ useMyAgents: () => ({ data: agents ?? [] }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))

// Imported after the mock declarations so the component picks them up.
const { default: SopRail } = await import('./SopRail')

/** The editor re-selects the inserted label inside a rAF; let it run. */
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())))

/** The rail's one box: search field AND the name of the SOP `+` creates. */
const SOP_BOX = 'Search SOPs, or name a new one…'

/** THE CREATE BUTTON, and `getByLabelText('Add SOP')` is the query that must
 *  be used for it — not `getByText('New SOP')`. The button is icon-only, and
 *  the editor dialog it opens carries `aria-label="New SOP"` plus a heading of
 *  the same words, so a text query would silently start asserting against the
 *  dialog and pass while the button was broken or absent. */
const addSop = () => screen.getByLabelText('Add SOP') as HTMLButtonElement

/** Library sections start folded. Most tests are about the rows inside them,
 *  so they open every heading first; the fold tests pass `unfold: false`. */
function renderRail({ unfold = true }: { unfold?: boolean } = {}) {
  const onUseSop = vi.fn()
  const onScheduleSop = vi.fn()
  render(<SopRail onUseSop={onUseSop} onScheduleSop={onScheduleSop} />)
  if (unfold) document.querySelectorAll('.sop-sec-h').forEach((h) => fireEvent.click(h))
  return { onUseSop, onScheduleSop }
}

/** Type into the rail's box. */
const typeBox = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(SOP_BOX), { target: { value } })

describe('SopRail', () => {
  beforeEach(() => {
    sops = [sop()]
    recentIds = []
    agents = [AGENT]
    sopSchedules = new Map()
    save.mockReset()
    remove.mockReset()
    touch.mockReset()
  })
  // `globals: false` means RTL registers no auto-cleanup.
  afterEach(cleanup)

  it('hands the SOP up with its resolved recipient on click', () => {
    const { onUseSop } = renderRail()
    fireEvent.click(screen.getByText('Weekly reel batch'))
    expect(onUseSop).toHaveBeenCalledTimes(1)
    expect(onUseSop).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      expect.objectContaining({ id: 'a1' }),
    )
    // Recorded for the "Recently used" group.
    expect(touch).toHaveBeenCalledWith('s1')
  })

  it('falls back to the assistant when the stored agent is gone', () => {
    agents = [{ id: 'a9', name: 'ana-assistant', registered_by: 'u1' } as AgentCard]
    const { onUseSop } = renderRail()
    fireEvent.click(screen.getByText('Weekly reel batch'))
    // Degrades rather than dangling — never hands up a dead recipient.
    expect(onUseSop).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      expect.objectContaining({ name: 'ana-assistant' }),
    )
  })

  it('routes the schedule button up without also firing the card', () => {
    const { onUseSop, onScheduleSop } = renderRail()
    fireEvent.click(screen.getByLabelText('Schedule Weekly reel batch'))
    expect(onScheduleSop).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    // The card's own click would load the SOP body instead of the schedule
    // request, so the hover action must stop propagation.
    expect(onUseSop).not.toHaveBeenCalled()
  })

  it('shows a cadence chip only once the SOP is actually scheduled', () => {
    renderRail()
    expect(document.querySelector('.sop-cron')).toBeNull()
    cleanup()
    sopSchedules = new Map([
      ['s1', { next_fire_at: '2030-03-04T14:00:00Z' }],
    ]) as unknown as typeof sopSchedules
    renderRail()
    expect(document.querySelector('.sop-cron')).toBeTruthy()
  })

  it('activates on Enter and Space, since the card is not a <button>', () => {
    const { onUseSop } = renderRail()
    const card = document.querySelector('.sop-item') as HTMLElement
    expect(card.getAttribute('role')).toBe('button')
    expect(card.tabIndex).toBe(0)
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: ' ' })
    expect(onUseSop).toHaveBeenCalledTimes(2)
  })

  it('previews the body blanks', () => {
    renderRail()
    expect(screen.getByText('Count')).toBeTruthy()
    expect(screen.getByText('Deadline')).toBeTruthy()
  })

  it('opens the editor from Edit without also loading the SOP', () => {
    const { onUseSop } = renderRail()
    fireEvent.click(screen.getByLabelText('Edit Weekly reel batch'))
    // stopPropagation kept the click off the card.
    expect(onUseSop).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Edit SOP' })).toBeTruthy()
  })

  it('deletes from the hover action without loading the SOP', () => {
    const { onUseSop } = renderRail()
    fireEvent.click(screen.getByLabelText('Delete Weekly reel batch'))
    expect(remove).toHaveBeenCalledWith('s1')
    expect(onUseSop).not.toHaveBeenCalled()
  })

  it('searches the body text, not just the title', () => {
    sops = [sop(), sop({ id: 's2', title: 'Cold email', body: 'Send batch to {{Segment}}.' })]
    renderRail()
    fireEvent.change(screen.getByPlaceholderText(SOP_BOX), {
      target: { value: 'segment' },
    })
    expect(screen.queryByText('Weekly reel batch')).toBeNull()
    expect(screen.getByText('Cold email')).toBeTruthy()
  })

  it('reports a miss rather than looking empty', () => {
    renderRail()
    fireEvent.change(screen.getByPlaceholderText(SOP_BOX), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText(/No SOP matches/)).toBeTruthy()
  })

  it('heads unprefixed SOPs "Yours", against the prefixed sections', () => {
    // "All" was right while the rail had one list; with SYSTEM: and the
    // owner's own prefixes alongside it, the heading has to say WHICH slice.
    renderRail()
    expect(screen.getByText('Yours')).toBeTruthy()
    expect(screen.queryByText('All')).toBeNull()
  })

  it('shows nothing but the search box and a disabled + when the library is empty', () => {
    // No first-run panel: the rail's own hint says what an SOP is, and the
    // authoring dialog carries the blank-syntax lesson.
    sops = []
    renderRail()
    expect(screen.queryByText('Yours')).toBeNull()
    expect(addSop()).toBeTruthy()
    // Greyed rather than absent — on an EMPTY library this is the only
    // affordance there is, so it has to be visible and say what unlocks it.
    expect(addSop().disabled).toBe(true)
    expect(addSop().title).toBe('Type a name to create an SOP')
  })

  it('matches every typed word, in any order, as a substring', () => {
    sops = [
      sop({ id: 's1', title: 'Marketing:product IG content' }),
      sop({ id: 's2', title: 'Ops:restock' }),
    ]
    renderRail()
    typeBox('marketing ig')
    expect(screen.getByText('product IG content')).toBeTruthy()
    expect(screen.queryByText('restock')).toBeNull()

    // Order-free, and partial words still land.
    typeBox('ig mark')
    expect(screen.getByText('product IG content')).toBeTruthy()

    // AND, not OR: a word that matches nothing takes the row with it,
    // otherwise every extra keystroke would WIDEN the result set.
    typeBox('marketing zzz')
    expect(screen.queryByText('product IG content')).toBeNull()
  })

  it('arms the + only once the box holds a name', () => {
    renderRail()
    expect(addSop().disabled).toBe(true)
    typeBox('  ')
    expect(addSop().disabled).toBe(true) // whitespace is not a name
    typeBox('Quarterly recap')
    expect(addSop().disabled).toBe(false)
    expect(addSop().title).toBe('Create SOP “Quarterly recap”')
  })

  it('opens the editor from the + with the name copied out of the box', () => {
    renderRail()
    typeBox('  Quarterly recap  ')
    fireEvent.click(addSop())
    const name = screen.getByPlaceholderText(
      'e.g. Marketing:weekly reel batch',
    ) as HTMLInputElement
    expect(name.value).toBe('Quarterly recap') // trimmed
    // The box is emptied, because its contents were CONSUMED — the same title
    // living in two places with nothing syncing them is the bug this avoids.
    expect((screen.getByPlaceholderText(SOP_BOX) as HTMLInputElement).value).toBe('')
  })

  it('opens the same editor on Enter as on the +', () => {
    renderRail()
    typeBox('Quarterly recap')
    fireEvent.keyDown(screen.getByPlaceholderText(SOP_BOX), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeTruthy()
    expect(
      (screen.getByPlaceholderText('e.g. Marketing:weekly reel batch') as HTMLInputElement).value,
    ).toBe('Quarterly recap')
  })

  it('ignores Enter on an empty box rather than opening a nameless editor', () => {
    renderRail()
    fireEvent.keyDown(screen.getByPlaceholderText(SOP_BOX), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('files a prefixed SOP under its prefix and drops the prefix from the card', () => {
    sops = [sop({ id: 's2', title: 'Marketing:product IG content' })]
    renderRail()
    expect(screen.getByText('Marketing')).toBeTruthy()
    expect(screen.getByText('product IG content')).toBeTruthy()
    // The heading already says Marketing; repeating it on the row buys nothing.
    expect(screen.queryByText('Marketing:product IG content')).toBeNull()
    // Nothing unprefixed left, so no "Yours" heading stands empty.
    expect(screen.queryByText('Yours')).toBeNull()
  })

  it('orders the owner ahead of other sections and SYSTEM last', () => {
    sops = [
      sop({ id: 's1', title: 'SYSTEM:Create new project' }),
      sop({ id: 's2', title: 'Marketing:product IG content' }),
      sop({ id: 's3', title: 'Weekly reel batch' }),
      sop({ id: 's4', title: 'Ops:restock' }),
    ]
    renderRail()
    const heads = [...document.querySelectorAll('.todo-plate-h')].map(
      (h) => h.textContent?.replace(/\d+$/, ''),
    )
    // Owner's own work first, seeded boilerplate last, the rest alphabetical.
    expect(heads).toEqual(['Yours', 'Marketing', 'Ops', 'SYSTEM'])
  })

  it('folds prefixes that differ only in case into one section', () => {
    sops = [
      sop({ id: 's1', title: 'Marketing:one' }),
      sop({ id: 's2', title: 'marketing:two' }),
    ]
    renderRail()
    // One heading, spelled the way the first row spelled it, counting both.
    const heads = [...document.querySelectorAll('.todo-plate-h')]
    expect(heads.length).toBe(1)
    expect(heads[0].textContent).toBe('Marketing2')
  })

  it('keeps a prose colon out of the sections', () => {
    // A sentence that happens to contain a colon is not filing — the prefix
    // cap is what tells the two apart.
    const prose = 'Reminder to chase the Q3 invoice before Friday: it slips otherwise'
    sops = [sop({ id: 's1', title: prose })]
    renderRail()
    expect(screen.getByText('Yours')).toBeTruthy()
    expect(screen.getByText(prose)).toBeTruthy()
  })

  it('narrows the headings with the search, leaving no empty section', () => {
    sops = [
      sop({ id: 's1', title: 'Marketing:product IG content' }),
      sop({ id: 's2', title: 'Ops:restock' }),
    ]
    renderRail()
    fireEvent.change(screen.getByPlaceholderText(SOP_BOX), {
      target: { value: 'restock' },
    })
    expect(screen.queryByText('Marketing')).toBeNull()
    expect(screen.getByText('Ops')).toBeTruthy()
  })

  it('names the section on a recently-used row, which sits outside it', () => {
    sops = [sop({ id: 's1', title: 'Marketing:product IG content' })]
    recentIds = ['s1']
    renderRail()
    // Once under "Recently used" carrying its own section tag, once under the
    // Marketing heading without one.
    expect(screen.getAllByText('product IG content').length).toBe(2)
    expect(document.querySelectorAll('.sop-sec').length).toBe(1)
    expect(document.querySelector('.sop-sec')?.textContent).toBe('Marketing')
  })

  it('lists recently used separately, and hides it while searching', () => {
    recentIds = ['s1']
    renderRail()
    expect(screen.getByText('Recently used')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(SOP_BOX), {
      target: { value: 'reel' },
    })
    expect(screen.queryByText('Recently used')).toBeNull()
  })

  it('folds every library section by default, but never Recently used', () => {
    sops = [
      sop({ id: 's1', title: 'Weekly reel batch' }),
      sop({ id: 's2', title: 'SYSTEM:Create new project' }),
    ]
    recentIds = ['s2']
    renderRail({ unfold: false })
    const heads = [...document.querySelectorAll('.sop-sec-h')]
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    // Folded rows are not rendered; the recent one still is, once.
    expect(screen.queryByText('Weekly reel batch')).toBeNull()
    expect(screen.getAllByText('Create new project').length).toBe(1)
  })

  it('opens and closes a section from its heading', () => {
    renderRail({ unfold: false })
    const head = screen.getByRole('button', { name: /Yours/ })
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Weekly reel batch')).toBeTruthy()
    fireEvent.click(head)
    expect(screen.queryByText('Weekly reel batch')).toBeNull()
  })

  it('shows every hit while searching, folded or not', () => {
    renderRail({ unfold: false })
    typeBox('reel')
    expect(screen.getByText('Weekly reel batch')).toBeTruthy()
    // Clearing the search puts the fold back the way the owner left it.
    typeBox('')
    expect(screen.queryByText('Weekly reel batch')).toBeNull()
  })

  it('drops a recent id whose SOP no longer exists', () => {
    // Deleted here or in another session — it just stops appearing.
    recentIds = ['gone']
    renderRail()
    expect(screen.queryByText('Recently used')).toBeNull()
  })
})

describe('SopEditor', () => {
  beforeEach(() => {
    sops = []
    agents = [AGENT]
    save.mockReset()
  })
  afterEach(cleanup)

  /** The ONLY route to a new-SOP editor: name it in the rail's box, then `+`.
   *  There is deliberately no nameless path any more — the `+` is disabled
   *  until the box has something in it. */
  const reopen = (title = 'Draft') => {
    typeBox(title)
    fireEvent.click(addSop())
  }
  const openNew = (title = 'Draft') => {
    render(<SopRail onUseSop={vi.fn()} />)
    reopen(title)
  }

  it('blocks Save until both name and prompt are filled', () => {
    openNew('My SOP')
    const saveBtn = screen.getByText('Save SOP').closest('button') as HTMLButtonElement
    const ta = document.querySelector('.sop-ta') as HTMLTextAreaElement
    const name = screen.getByPlaceholderText(
      'e.g. Marketing:weekly reel batch',
    ) as HTMLInputElement

    // The name arrived from the rail's box, so the prompt is what's missing.
    expect(name.value).toBe('My SOP')
    expect(saveBtn.disabled).toBe(true) // a name alone isn't enough

    fireEvent.change(ta, { target: { value: 'Do the thing' } })
    expect(saveBtn.disabled).toBe(false)

    // Whitespace doesn't count as filled.
    fireEvent.change(name, { target: { value: '   ' } })
    expect(saveBtn.disabled).toBe(true)
  })

  it('focuses the prompt, not the name, when the name arrived pre-filled', () => {
    // The author already said what it is called; the field they came here to
    // fill is the prompt.
    openNew('Quarterly recap')
    expect(document.activeElement).toBe(document.querySelector('.sop-ta'))
  })

  it('inserts a blank at the caret and selects its label for renaming', async () => {
    openNew()
    const ta = document.querySelector('.sop-ta') as HTMLTextAreaElement
    fireEvent.click(screen.getByTitle(/Numeric field/))
    expect(ta.value).toBe('{{Count|number:6}}')
    await nextFrame()
    // The label — not the whole snippet — is selected, so typing renames it.
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('Count')
  })

  it('selects the label of a bare blank too (no pipe to stop at)', async () => {
    openNew()
    const ta = document.querySelector('.sop-ta') as HTMLTextAreaElement
    fireEvent.click(screen.getByTitle(/plainest blank/))
    expect(ta.value).toBe('{{Company}}')
    await nextFrame()
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('Company')
  })

  it('counts the blanks it detects', () => {
    openNew()
    const ta = document.querySelector('.sop-ta') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'a {{X}} b {{Y|date}}' } })
    expect(screen.getByText('2 blanks detected')).toBeTruthy()
  })

  it('saves both agent id and name so the card survives a rename', () => {
    openNew()
    fireEvent.change(screen.getByPlaceholderText('e.g. Marketing:weekly reel batch'), {
      target: { value: '  Padded  ' },
    })
    fireEvent.change(document.querySelector('.sop-ta') as HTMLTextAreaElement, {
      target: { value: 'Do {{Thing}}' },
    })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a1' } })
    fireEvent.click(screen.getByText('Save SOP'))

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Padded', // trimmed
        body: 'Do {{Thing}}',
        agent_id: 'a1',
        agent_name: 'ana-editor',
      }),
    )
  })

  it('sends an explicit null recipient when none is picked', () => {
    openNew()
    fireEvent.change(screen.getByPlaceholderText('e.g. Marketing:weekly reel batch'), {
      target: { value: 'T' },
    })
    fireEvent.change(document.querySelector('.sop-ta') as HTMLTextAreaElement, {
      target: { value: 'B' },
    })
    fireEvent.click(screen.getByText('Save SOP'))
    // Explicit null, not an omitted key — otherwise a cleared recipient would
    // silently keep the old one server-side.
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: null, agent_name: null }),
    )
  })

  it('closes on Escape and on a scrim click, but not on a click inside', () => {
    openNew()
    fireEvent.mouseDown(document.querySelector('.sop-dlg') as HTMLElement)
    expect(screen.queryByRole('dialog')).toBeTruthy()

    fireEvent.mouseDown(document.querySelector('.sop-scrim') as HTMLElement)
    expect(screen.queryByRole('dialog')).toBeNull()

    reopen()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

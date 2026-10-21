import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskLabel } from '../../api/endpoints/deskLabels'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import type { AgentCard } from '../../types'
import { toRegistry, type RegistryState } from '../../utils/labelView'
import { useDeskLabelViewStore } from '../../stores/deskLabelViewStore'

/**
 * The row-click contract, and the labelled rail's DOM-level behaviours — the
 * ones the pure layer cannot prove because they are about what renders: a click
 * that loads the item and writes nothing, grips present ungrouped and ABSENT
 * grouped, group -> ungroup leaving plate order byte-identical, the filtered
 * header, and the hidden-by-filter strip.
 */

const reorder = vi.fn()
const add = vi.fn()
const archive = vi.fn()
const remove = vi.fn()
const rename = vi.fn()
let agents: AgentCard[] | undefined
let todos: DeskTodo[]
let adding = false
let addingText: string | undefined
let registryLabels: DeskLabel[]
let registryState: RegistryState

const AGENT = { id: 'a1', name: 'ana-analyst', registered_by: 'u1' } as AgentCard

const TASK: DeskTodo = {
  id: 't1',
  owner_user_id: 'u1',
  text: 'Chase the Q3 numbers',
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  draft_prompt: 'Pull the Q3 close numbers.',
  draft_recipient_id: 'a1',
  draft_recipient_name: 'ana-analyst',
  drafted: true,
  attachments: [],
}

// EVERY verb the rail destructures must be stubbed here. `setLabels` is why the
// four pre-existing tests in this file went red on the commit that added it —
// the rail called an undefined function. One line each, but a missing one reads
// as a regression in unrelated tests rather than as the mock drifting behind
// the hook. `rename` was added the same way, for the inline title edit.
vi.mock('../../hooks/useTodos', () => ({
  useTodos: () => ({
    todos,
    add,
    adding,
    addingText,
    captureWithDraft: vi.fn(),
    archive,
    remove,
    rename,
    reorder,
    saveDraft: vi.fn(),
    setLabels: vi.fn(),
  }),
}))
const refetch = vi.fn()
vi.mock('../../hooks/useLabels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useLabels')>(
    '../../hooks/useLabels',
  )
  return {
    ...actual,
    useLabels: () => ({
      registry: toRegistry(registryLabels, registryState),
      isLoading: false,
      isError: registryState === 'unavailable',
      refetch,
      create: vi.fn(),
      rename: vi.fn(),
      recolour: vi.fn(),
      reorder: vi.fn(),
      remove: vi.fn(),
      merge: vi.fn(),
    }),
    useLabelViewReconcile: () => ({ notice: null, dismissNotice: vi.fn() }),
  }
})
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))

// Imported after the mock declarations so the component picks them up.
const { default: TodoRail } = await import('./TodoRail')

// The cross-highlight pair, inert. Every case in this file is about the rail's
// OWN behaviour, and the rail neither resolves the links nor decides what they
// mean — `DeskPage` does both, and proves it in `DeskPage.crossHighlight.test`.
// Spread as one object so a future prop on that pair lands in one place here
// rather than in the ~70 render sites below.
const NO_HOVER = { linkedTodoIds: new Set<string>(), onHoverTodo: () => {} }

/** One kind. A stored `state` row arrives as a context after the retirement. */
const L = (slug: string): DeskLabel => ({
  slug,
  name: slug,
  kind: 'context',
  color: 'blue',
  created_at: '1970-01-01T00:00:00+00:00',
  updated_at: '1970-01-01T00:00:00+00:00',
})

const ROW = (id: string, labels: string[], over: Partial<DeskTodo> = {}): DeskTodo => ({
  id,
  owner_user_id: 'u1',
  text: `task ${id}`,
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  labels,
  attachments: [],
  ...over,
})

let queryClient: QueryClient
const wrap = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

/** Render the rail with stub wiring; returns the spy and the row's body button. */
function renderRail() {
  const onUseTodo = vi.fn()
  render(<TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={onUseTodo} flash={vi.fn()} />, { wrapper: wrap })
  return { onUseTodo, row: screen.getByTitle('Load into the message box') }
}

function renderPlate() {
  const flash = vi.fn()
  render(<TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={flash} />, { wrapper: wrap })
  return { flash }
}

/** The DOM order of the rows currently on screen, by their to-do id. */
const plateOrder = (): string[] =>
  [...document.querySelectorAll('[data-todo-id],[data-todo-instance]')].map(
    (el) =>
      el.getAttribute('data-todo-id') ?? el.getAttribute('data-todo-instance') ?? '',
  )

beforeEach(() => {
  localStorage.clear()
  useDeskLabelViewStore.getState().reset()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  todos = [TASK]
  adding = false
  addingText = undefined
  registryLabels = []
  registryState = 'ready'
  reorder.mockReset()
  add.mockReset()
  archive.mockReset()
  remove.mockReset()
  rename.mockReset()
})

describe('TodoRail row click', () => {
  beforeEach(() => {
    agents = [AGENT]
  })
  // `globals: false` in vitest.config means RTL never registers its own
  // auto-cleanup, so renders would otherwise stack across tests.
  afterEach(cleanup)

  it('hands the to-do up to be loaded into the message box', () => {
    const { onUseTodo, row } = renderRail()

    fireEvent.click(row)

    expect(onUseTodo).toHaveBeenCalledTimes(1)
    expect(onUseTodo).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
  })

  it('neither completes nor deletes the item', () => {
    const { row } = renderRail()

    fireEvent.click(row)

    expect(archive).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('leaves the row on the plate, under "To do"', () => {
    const { row } = renderRail()

    fireEvent.click(row)

    expect(screen.getByText('Chase the Q3 numbers')).toBeTruthy()
    expect(screen.queryByText('Done')).toBeNull()
  })

  it('renders no send button on a drafted row', () => {
    renderRail()

    expect(screen.queryByLabelText('Send draft')).toBeNull()
    expect(screen.queryByTitle('Send draft')).toBeNull()
  })

  it('does not resolve recipients — a cold roster changes nothing', () => {
    agents = undefined
    const { onUseTodo, row } = renderRail()

    fireEvent.click(row)

    expect(onUseTodo).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
  })
})

/**
 * Inline rename. The title claims a plain click, so the two things worth
 * pinning are the ones a reader cannot see from the markup: that opening the
 * editor does NOT also load the row into the message box (they are nested
 * elements — without `stopPropagation` one click does both), and that Esc
 * writes nothing even though blur is wired to save.
 */
describe('TodoRail inline rename', () => {
  beforeEach(() => {
    agents = [AGENT]
  })
  afterEach(cleanup)

  /** The title in read mode — the click target that opens the editor. */
  const title = () => screen.getByTitle('Click to rename')
  const field = () => screen.getByLabelText('Task title') as HTMLInputElement

  it('swaps the title for a pre-filled field, and does NOT load the row', () => {
    const { onUseTodo } = renderRail()

    fireEvent.click(title())

    expect(field().value).toBe('Chase the Q3 numbers')
    // The editor and the loader share a row; opening one must not fire the other.
    expect(onUseTodo).not.toHaveBeenCalled()
  })

  it('drops the body out of <button> while editing, so the field can take a caret', () => {
    renderRail()

    fireEvent.click(title())

    // An <input> inside a <button> is invalid HTML and the button eats the
    // caret — the read-mode button must be gone for the duration.
    expect(screen.queryByTitle('Load into the message box')).toBeNull()
    expect(field().closest('button')).toBeNull()
  })

  it('Enter renames once and closes the editor', () => {
    renderRail()
    fireEvent.click(title())

    fireEvent.change(field(), { target: { value: 'Chase the Q4 numbers' } })
    fireEvent.keyDown(field(), { key: 'Enter' })

    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith('t1', 'Chase the Q4 numbers')
    expect(screen.queryByLabelText('Task title')).toBeNull()
  })

  it('Esc writes nothing and restores the original title', () => {
    renderRail()
    fireEvent.click(title())
    const input = field()

    fireEvent.change(input, { target: { value: 'throw this away' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(rename).not.toHaveBeenCalled()
    expect(screen.getByText('Chase the Q3 numbers')).toBeTruthy()
  })

  it('Esc still writes nothing when the engine blurs the field on unmount', () => {
    renderRail()
    fireEvent.click(title())
    const input = field()

    fireEvent.change(input, { target: { value: 'throw this away' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    // Whether removing a focused node fires `focusout` is engine-dependent;
    // blur commits, so a late one must find the edit already settled or Esc
    // would save on exactly the browsers that do fire it.
    fireEvent.blur(input)

    expect(rename).not.toHaveBeenCalled()
  })

  it('clicking away saves what was typed', () => {
    renderRail()
    fireEvent.click(title())

    fireEvent.change(field(), { target: { value: 'Chase the Q4 numbers' } })
    fireEvent.blur(field())

    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith('t1', 'Chase the Q4 numbers')
  })

  it('Enter does not commit twice through the blur that follows it', () => {
    renderRail()
    fireEvent.click(title())
    const input = field()

    fireEvent.change(input, { target: { value: 'Chase the Q4 numbers' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('offers no rename affordance in the Archived drawer', () => {
    // Not `renderRail()` — its handle is the open row's body button, and a
    // plate whose only item is archived has none.
    todos = [{ ...TASK, archived: true }]
    renderPlate()
    // The heading is 'Archived' now, and the rename is still absent: a
    // filed-away task is a record, not a draft.
    fireEvent.click(screen.getByText('Archived'))
    expect(screen.queryByText('Done')).toBeNull()
    expect(screen.queryByTitle('Click to rename')).toBeNull()
  })
})

/**
 * The UNDRAFTED row — a plain self-captured to-do with no draft, no due and no
 * source. Nothing renders under its title, and the title owns a plain click for
 * rename, so this shape is the one where the split hit area can leave the row
 * with no loadable pixels at all: it stopped reaching the message box entirely
 * while every test above stayed green, because all of them use a DRAFTED row.
 *
 * jsdom has no layout, so these cannot assert pixels. They pin the two things
 * that produce them: the row still hands itself up to be loaded, and the blank
 * meta line carries the hit strip that a drafted row has no need of.
 */
describe('TodoRail undrafted row', () => {
  const PLAIN: DeskTodo = {
    ...TASK,
    text: 'Book the offsite venue',
    draft_prompt: null,
    draft_recipient_id: null,
    draft_recipient_name: null,
    drafted: false,
  }
  const HINT = 'No draft yet — click to start one'

  beforeEach(() => {
    agents = [AGENT]
    todos = [PLAIN]
  })
  afterEach(cleanup)

  it('hands an item with no draft up to be loaded, seeded with its title', () => {
    const { onUseTodo, row } = renderRail()

    fireEvent.click(row)

    expect(onUseTodo).toHaveBeenCalledTimes(1)
    expect(onUseTodo).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', drafted: false }))
  })

  it('gives the blank meta line a hit strip, so the row has something to click', () => {
    renderRail()

    // Inside the body button — the strip loads the row like the rest of it.
    const strip = screen.getByText(HINT)
    expect(strip.closest('button')?.getAttribute('title')).toBe('Load into the message box')
  })

  it('drops the strip once the row has meta of its own', () => {
    todos = [TASK] // drafted: the preview line already fills that space
    renderRail()

    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('still renames from the title — the click that loads is the one elsewhere', () => {
    const { onUseTodo } = renderRail()

    fireEvent.click(screen.getByTitle('Click to rename'))

    expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe(
      'Book the offsite venue',
    )
    expect(onUseTodo).not.toHaveBeenCalled()
  })
})

describe('the labelled rail', () => {
  afterEach(cleanup)

  beforeEach(() => {
    agents = [AGENT]
    // The rail hydrates the view store from the signed-in user on mount, so a
    // test that sets view state has to point the store at that user FIRST —
    // otherwise the mount-time hydrate reads an empty blob over it.
    useDeskLabelViewStore.getState().hydrate('u1')
    registryLabels = [L('office'), L('home'), L('next')]
    todos = [
      ROW('a', ['office', 'next']),
      ROW('b', ['home']),
      ROW('c', ['office', 'home']),
      ROW('d', []),
    ]
  })

  it('renders a grip on every row while UNGROUPED', () => {
    renderPlate()
    expect(screen.getAllByLabelText('Drag to reorder')).toHaveLength(4)
    expect(document.querySelectorAll('[data-todo-id]')).toHaveLength(4)
    expect(document.querySelectorAll('[data-todo-instance]')).toHaveLength(0)
  })

  it('renders NO grip at all while grouped — absent, not disabled', () => {
    useDeskLabelViewStore.getState().setGroup('context')
    renderPlate()
    // `wire` is simply not passed, so TodoItem's existing `{wire && …}` guard
    // renders nothing. The affordance is absent rather than present-and-broken.
    expect(screen.queryAllByLabelText('Drag to reorder')).toHaveLength(0)
    // …and the rows carry the INSTANCE attribute, so elementFromPoint could
    // not resolve an ambiguous id even if drag were re-enabled by accident.
    expect(document.querySelectorAll('[data-todo-id]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-todo-instance]').length).toBeGreaterThan(0)
  })

  it('group → ungroup leaves the plate order byte-identical and issues no reorder', () => {
    const { unmount } = render(
      <TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={vi.fn()} />,
      { wrapper: wrap },
    )
    const before = plateOrder()
    expect(before).toEqual(['a', 'b', 'c', 'd'])
    unmount()

    useDeskLabelViewStore.getState().setGroup('context')
    const grouped = render(
      <TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={vi.fn()} />,
      { wrapper: wrap },
    )
    grouped.unmount()

    useDeskLabelViewStore.getState().setGroup(null)
    render(<TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={vi.fn()} />, { wrapper: wrap })
    expect(plateOrder()).toEqual(before)
    // Grouping is a pure projection: it never writes, so the endpoint is never
    // touched and there is nothing to restore.
    expect(reorder).not.toHaveBeenCalled()
  })

  it('duplicates a row under every group it belongs to, once per label', () => {
    useDeskLabelViewStore.getState().setGroup('context')
    renderPlate()
    // 'c' carries @office and @home, so it renders twice.
    expect(plateOrder().filter((id) => id === 'c')).toHaveLength(2)
    expect(plateOrder().filter((id) => id === 'd')).toHaveLength(1)
  })

  it('ARCHIVING a DUPLICATED row clears every rendering of it', () => {
    // Duplication is free because all copies are ONE react-query record: the
    // write is keyed on the to-do id, not on the rendering, so every copy
    // re-renders in the same frame. The check that proves it is that each
    // copy's checkbox addresses the SAME id.
    //
    // The checkbox's accessible name is 'Archive', not 'Mark done' — which is
    // the whole point of criterion 3: this control is the only place the action
    // is named at all, and what it does is file the row away.
    useDeskLabelViewStore.getState().setGroup('context')
    renderPlate()
    const copies = [...document.querySelectorAll('[data-todo-instance="c"]')]
    expect(copies).toHaveLength(2)

    for (const copy of copies) {
      const box = within(copy as HTMLElement).getByLabelText('Archive')
      expect(box.getAttribute('title')).toContain('file it away')
      fireEvent.click(box)
    }
    expect(archive.mock.calls).toEqual([['c'], ['c']])
  })

  it('reads "To do N" unfiltered and "M of N" under a filter, with a clear', () => {
    const { unmount } = render(
      <TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={vi.fn()} />,
      { wrapper: wrap },
    )
    const header = () => document.querySelector('.todo-plate-h') as HTMLElement
    expect(header().textContent).toContain('To do')
    expect(within(header()).getByText('4')).toBeTruthy()
    unmount()

    useDeskLabelViewStore.getState().toggleFilter('office')
    renderPlate()
    expect(header().textContent).toContain('2')
    expect(header().textContent).toContain('of 4')
    expect(within(header()).getByLabelText('Clear filter')).toBeTruthy()
  })

  it('caps chips at three and offers +N', () => {
    todos = [ROW('a', ['office', 'home', 'next', 'infra', 'other'])]
    renderPlate()
    expect(screen.getByLabelText('Show 3 more labels')).toBeTruthy()
    // CAP-1 chips plus the +N control.
    expect(document.querySelectorAll('.todo-labels .lb')).toHaveLength(2)
  })

  it('the TICKET chip does not consume a chip slot or change the +N count', () => {
    // Criterion 1, asserted at the arithmetic it could break. The same five
    // labels on a Working row: still CAP-1 label chips, still "+3", and the
    // ticket chip rendered ALONGSIDE them rather than as one of them — it is
    // `.tk`, never `.lb`, so `chipsFor` cannot see it.
    todos = [ROW('a', ['office', 'home', 'next', 'infra', 'other'], { state: 'working' })]
    renderPlate()
    expect(screen.getByLabelText('Show 3 more labels')).toBeTruthy()
    expect(document.querySelectorAll('.todo-labels .lb')).toHaveLength(2)
    expect(document.querySelectorAll('.todo-labels .tk')).toHaveLength(1)
  })

  it('a NEW row renders NO ticket chip — a blank row is a New row', () => {
    todos = [ROW('a', [], { state: 'new', association_count: 2 })]
    renderPlate()
    expect(document.querySelectorAll('.tk')).toHaveLength(0)
    // …and with no labels either, the strip itself does not render.
    expect(document.querySelectorAll('.todo-labels')).toHaveLength(0)
  })

  it('exactly ONE ticket chip per row, and it leads the strip', () => {
    todos = [ROW('a', ['office'], { state: 'working', association_count: 3 })]
    renderPlate()
    const strip = document.querySelector('.todo-labels')!
    expect(strip.querySelectorAll('.tk')).toHaveLength(1)
    expect(strip.firstElementChild!.className).toContain('tk')
    // "linked", never "running": `association_count` is the STORED count, so a
    // dangling id is inside it and this sentence stays true with one there.
    expect(strip.querySelector('.tk')!.getAttribute('title')).toBe('Working · 3 linked')
  })

  it('an ARCHIVED row whose project is still running is visibly Working', () => {
    // AC-1.7, and an INVERSION of an earlier round's design: a row in the
    // drawer does NOT show nothing. The drawer stopped saying anything about
    // state, so the chip is the only thing left that can — and it renders
    // there without dragging the label strip back in, because the chip is
    // derived inside TodoItem rather than passed through `chips`.
    todos = [ROW('a', ['office'], { archived: true, state: 'working', association_count: 1 })]
    renderPlate()
    fireEvent.click(screen.getByText('Archived'))
    const row = document.querySelector('.todo-item.archived')!
    expect(row.querySelectorAll('.tk')).toHaveLength(1)
    expect(row.querySelector('.tk')!.textContent).toContain('Working')
    // no label chips came with it
    expect(row.querySelectorAll('.lb')).toHaveLength(0)
    // and the checkbox names the reverse action
    expect(within(row as HTMLElement).getByLabelText('Unarchive')).toBeTruthy()
  })

  it('+N expands the row, and the chips stop being capped', () => {
    todos = [ROW('a', ['office', 'home', 'next', 'infra', 'other'])]
    renderPlate()
    // Not a <button> — the row already is one, and a button inside a button is
    // invalid HTML the parser may un-nest. Same role, same tab stop, same keys.
    const more = screen.getByLabelText('Show 3 more labels')
    expect(more.tagName).toBe('SPAN')
    expect(more.getAttribute('role')).toBe('button')
    expect(more.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(more, { key: 'Enter' })
    expect(document.querySelectorAll('.todo-labels .lb')).toHaveLength(5)
    expect(screen.queryByLabelText(/Show \d+ more labels/)).toBeNull()
  })

  it('pins the filtered chip to the front of the row', () => {
    todos = [ROW('a', ['office', 'home', 'next'])]
    useDeskLabelViewStore.getState().toggleFilter('home')
    renderPlate()
    const chips = [...document.querySelectorAll('.todo-labels .lb')]
    expect(chips[0].getAttribute('data-lb')).toBe('home')
    expect(chips[0].className).toContain('pin')
  })

  it('shows the failure banner ONLY when the query has errored', () => {
    registryState = 'cold'
    registryLabels = []
    const { unmount } = render(
      <TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={vi.fn()} />,
      { wrapper: wrap },
    )
    // Nothing has failed yet — a banner here would flash on every cold start.
    expect(document.querySelector('.deg-note')).toBeNull()
    unmount()

    registryState = 'unavailable'
    renderPlate()
    expect(document.querySelector('.deg-note')?.textContent).toContain("didn't load")
  })

  it('shows NO banner at provisional — cache-only is correct, not degraded', () => {
    registryState = 'provisional'
    renderPlate()
    expect(document.querySelector('.deg-note')).toBeNull()
  })

  it('an EMPTY registry is an answer, not a failure', () => {
    registryLabels = []
    registryState = 'ready'
    todos = [ROW('a', []), ROW('b', [])]
    renderPlate()
    expect(document.querySelector('.deg-note')).toBeNull()
  })

  it('a LABELLED plate with an empty registry gets its own notice', () => {
    // The corrupt-looks-missing trap: an unparseable registry answers with
    // zero rows rather than the seed, so it is indistinguishable from an
    // emptied one EXCEPT by the labels still on the plate.
    registryLabels = []
    registryState = 'ready'
    todos = [ROW('a', ['office'])]
    renderPlate()
    expect(document.querySelector('.deg-note')?.textContent).toContain('came back empty')
  })

  describe('that orphaned notice offers the repair, not the destruction', () => {
    const orphan = () => {
      registryLabels = []
      registryState = 'ready'
      todos = [ROW('a', ['office'])]
      renderPlate()
      return document.querySelector('.deg-note')!
    }

    it('leads with what survived and does not ask for a rebuild', () => {
      // "Nothing has been lost" and "add them back" cannot both be true in one
      // breath — and the owner resolves the contradiction by pressing the only
      // button there.
      const note = orphan()
      expect(note.textContent).toContain('still carry their labels')
      expect(note.textContent).toContain('Nothing has been lost')
      expect(note.textContent).not.toMatch(/Add them back/)
    })

    it('offers Try again and no route into the manage sheet', () => {
      const note = orphan()
      const buttons = [...note.querySelectorAll('button')]
      expect(buttons.map((b) => b.textContent)).toEqual(['Try again'])
      fireEvent.click(buttons[0])
      expect(refetch).toHaveBeenCalled()
    })
  })

  it('the TICKET axis replaces the state axis and is NEVER disabled', () => {
    // THIS ASSERTION TESTED AN AXIS THAT NO LONGER EXISTS. It read "the state
    // axis is DISABLED WITH ITS REASON at zero states, not hidden", and the
    // disabling was load-bearing: left selectable, "group by state" at zero
    // states rendered ONE red "Unprocessed" group holding the entire plate —
    // pixel-identical to the failure screen, reached by a legitimate click.
    //
    // WHAT REPLACED IT is a row that cannot reach that state at all. Ticket
    // grouping partitions on a required field and always yields four groups,
    // so there is no zero-groups case to disable for and no reason to give.
    registryLabels = [L('office')]
    renderPlate()
    fireEvent.click(screen.getByText('Group'))
    expect(document.querySelector('[data-axis="state"]')).toBeNull()
    const row = document.querySelector('[data-axis="ticket"]') as HTMLButtonElement
    expect(row).toBeTruthy()
    expect(row.disabled).toBe(false)
    expect(row.textContent).toContain('4 groups')
    // The axis is named "State", never "Ticket". Nothing else in this UI ever
    // explains what a ticket is, so the word only ever cost the reader.
    expect(row.textContent).toContain('State')
    expect(row.textContent).not.toContain('Ticket')
  })

  it('the LABEL axis is disabled with its reason while the registry is lost — the ticket axis is not', () => {
    // Was "both axes are disabled". Disabling the ticket axis here is exactly
    // the failure `effectiveGroup`'s exemption exists to prevent: the one axis
    // that still works would vanish at the moment it is the only one left.
    registryState = 'unavailable'
    registryLabels = []
    renderPlate()
    fireEvent.click(screen.getByText('Group'))
    const context = document.querySelector('[data-axis="context"]') as HTMLButtonElement
    const ticket = document.querySelector('[data-axis="ticket"]') as HTMLButtonElement
    expect(context.disabled).toBe(true)
    expect(context.parentElement?.textContent).toContain("didn't load")
    expect(ticket.disabled).toBe(false)
  })

  it('a filter survives a lost registry and still filters, as a flat OR', () => {
    registryState = 'unavailable'
    registryLabels = []
    useDeskLabelViewStore.getState().toggleFilter('office')
    renderPlate()
    // 'a' and 'c' carry @office; the filter must not silently stop filtering.
    expect(plateOrder()).toEqual(['a', 'c'])
    expect(useDeskLabelViewStore.getState().filter).toEqual(['office'])
  })

  it('suppresses the stored group axis off-ready WITHOUT overwriting it', () => {
    useDeskLabelViewStore.getState().setGroup('context')
    registryState = 'unavailable'
    registryLabels = []
    renderPlate()
    expect(document.querySelector('.grp-h')).toBeNull()
    // …so the owner's axis comes back by itself when the registry does.
    expect(useDeskLabelViewStore.getState().group).toBe('context')
  })

  it('collapses empty groups to one line rather than N headers', () => {
    registryLabels = [
      L('office'),
      L('home'),
      L('garage'),
      L('shed'),
    ]
    useDeskLabelViewStore.getState().setGroup('context')
    renderPlate()
    expect(screen.getByText(/2 empty groups · Show/)).toBeTruthy()
    fireEvent.click(screen.getByText(/2 empty groups · Show/))
    expect(screen.getByText('Hide empty groups')).toBeTruthy()
  })
})

/**
 * THE TICKET AXIS ON THE RAIL — grouping, filtering, the drawer, and the
 * checkbox that no longer mirrors anything.
 *
 * Separated from `the labelled rail` because the point of most of these is what
 * happens when the LABEL registry is dead: the ticket axis reads a field that
 * arrives with the to-do, so it must keep working exactly there.
 */
describe('the ticket axis', () => {
  afterEach(cleanup)

  beforeEach(() => {
    agents = [AGENT]
    useDeskLabelViewStore.getState().hydrate('u1')
    registryLabels = [L('office'), L('home')]
    todos = [
      ROW('a', ['office'], { state: 'new' }),
      ROW('b', ['home'], { state: 'working', association_count: 1 }),
      ROW('c', ['office'], { state: 'completed', association_count: 2 }),
      ROW('d', [], { state: 'working', archived: true, association_count: 1 }),
      ROW('e', [], { state: 'failed', association_count: 1 }),
    ]
  })

  /* ── criterion 5: grouping is a REPLACEMENT ───────────────────────────── */

  it('renders EXACTLY four groups, WORKING FIRST then FAILED, with every row in one', () => {
    useDeskLabelViewStore.getState().setGroup('ticket')
    renderPlate()
    const headers = [...document.querySelectorAll('.grp-n')].map((el) => el.textContent)
    expect(headers).toEqual(['Working', 'Failed', 'New', 'Done'])
    // Rows follow their group: 'b' is Working, 'e' is Failed, 'a' is New, 'c'
    // is Completed. 'd' is archived, so it is in the drawer, not in a group.
    expect(plateOrder()).toEqual(['b', 'e', 'a', 'c'])
  })

  it('there is NO "Unprocessed · no state" pile — New IS the inbox', () => {
    useDeskLabelViewStore.getState().setGroup('ticket')
    renderPlate()
    expect(screen.queryByText(/Unprocessed/)).toBeNull()
    expect(document.querySelector('.grp.inbox')).toBeNull()
    // A bare row with no labels at all lands in New, not in a residual.
    expect(document.querySelectorAll('.grp')).toHaveLength(4)
  })

  it('G1/G2 — it still groups with the registry DEAD, where context cannot', () => {
    // The whole reason the branch sits before `groupTodos`'s axisKnown early
    // return and the axis is exempt from the off-ready suppression: this is
    // the moment ticket grouping is the only one left.
    registryState = 'unavailable'
    registryLabels = []
    useDeskLabelViewStore.getState().setGroup('ticket')
    renderPlate()
    expect([...document.querySelectorAll('.grp-n')].map((el) => el.textContent)).toEqual([
      'Working',
      'Failed',
      'New',
      'Done',
    ])
  })

  it('never folds an empty ticket group away, and never counts one as empty', () => {
    todos = [ROW('a', [], { state: 'new' })]
    useDeskLabelViewStore.getState().setGroup('ticket')
    renderPlate()
    expect(document.querySelectorAll('.grp')).toHaveLength(4)
    // No "N empty groups · Show" line — the four ARE the map. This is also
    // where the fourth state's cost is paid: a one-row plate now carries four
    // headers, not three.
    expect(screen.queryByText(/empty group/)).toBeNull()
  })

  it('marks no row as duplicated — one to-do, one state, one group', () => {
    useDeskLabelViewStore.getState().setGroup('ticket')
    renderPlate()
    expect(document.querySelectorAll('.todo-dup')).toHaveLength(0)
  })

  it("an owner's stored group:'state' arrives as ticket grouping, not as off", () => {
    localStorage.setItem(
      'clawmeets-desk-label-view-v1:u1',
      JSON.stringify({ group: 'state', filter: [], matchAll: false, collapsed: {} }),
    )
    useDeskLabelViewStore.setState({ userId: null })
    renderPlate()
    expect([...document.querySelectorAll('.grp-n')].map((el) => el.textContent)).toEqual([
      'Working',
      'Failed',
      'New',
      'Done',
    ])
  })

  /* ── criterion 6: filtering ───────────────────────────────────────────── */

  it('filters by state, and the states are NOT slugs in the label filter', () => {
    useDeskLabelViewStore.getState().toggleState('working')
    renderPlate()
    expect(plateOrder()).toEqual(['b'])
    // The separation is the criterion: a state slug in `filter` would be
    // resolved against the registry by the pin set, the liveness check and the
    // counts, and would fail as a dashed unknown chip in all three.
    expect(useDeskLabelViewStore.getState().filter).toEqual([])
    expect(useDeskLabelViewStore.getState().states).toEqual(['working'])
  })

  it('offers all four rows with COUNTS, and survives a dead registry', () => {
    registryState = 'unavailable'
    registryLabels = []
    renderPlate()
    fireEvent.click(screen.getByText('Filter'))
    const rows = [...document.querySelectorAll('.pop-row')].map((el) => el.textContent)
    // Rendered OUTSIDE the `!known` branch, so the section is here even though
    // there is no label list to show.
    expect(rows.some((t) => t?.startsWith('New'))).toBe(true)
    expect(rows.some((t) => t?.startsWith('Working'))).toBe(true)
    expect(rows.some((t) => t?.startsWith('Failed'))).toBe(true)
    expect(rows.some((t) => t?.startsWith('Done'))).toBe(true)
    // Counts come from the UNARCHIVED plate: New 1, Working 1 (not 2 — 'd' is
    // archived), Done 1.
    const working = rows.find((t) => t?.startsWith('Working'))!
    expect(working).toContain('1')
  })

  it('offers NO ALL/AND toggle on the state rows', () => {
    // One state per to-do makes an AND unsatisfiable, so the control could only
    // ever produce an empty plate.
    renderPlate()
    fireEvent.click(screen.getByText('Filter'))
    expect(screen.queryByText(/Match ALL states/)).toBeNull()
    expect(screen.queryByText(/Match ALL ticket/)).toBeNull()
  })

  it('the four "is a filter on" sites all see a state-only filter', () => {
    useDeskLabelViewStore.getState().toggleState('working')
    renderPlate()
    // (3) the plate header reads "N of M" and offers a clear. M is the four
    // UNARCHIVED rows (a/b/c/e); 'd' is in the drawer.
    expect(document.querySelector('.todo-plate-c')!.textContent).toBe('1 of 4')
    expect(screen.getAllByLabelText('Clear filter').length).toBeGreaterThan(0)
    // (4) the Filter badge counts it and the button reads as on
    expect(document.querySelector('.ctl-n')!.textContent).toBe('1')
    expect(document.querySelector('.todo-ctl')!.className).toContain('filtered')
    // and the active-filter bar names it, removably
    expect(screen.getByLabelText('Remove Working from the filter')).toBeTruthy()
  })

  it('clearing wipes BOTH axes from one button', () => {
    useDeskLabelViewStore.getState().toggleFilter('office')
    useDeskLabelViewStore.getState().toggleState('working')
    renderPlate()
    fireEvent.click(screen.getAllByLabelText('Clear filter')[0])
    expect(useDeskLabelViewStore.getState().filter).toEqual([])
    expect(useDeskLabelViewStore.getState().states).toEqual([])
  })

  /* ── criterion 4: the Archived drawer honours the filter ──────────────── */

  it('the drawer honours the filter and says how many of its rows are showing', () => {
    todos = [
      ROW('a', ['office'], { state: 'new' }),
      ROW('d', [], { state: 'working', archived: true }),
      ROW('e', [], { state: 'completed', archived: true }),
    ]
    useDeskLabelViewStore.getState().toggleState('completed')
    renderPlate()
    // The count beside the heading is the drawer's TOTAL; the sub says how much
    // of it the filter is letting through, rather than quietly contradicting
    // the control directly above it.
    expect(document.querySelector('.todo-arch-c')!.textContent).toBe('2')
    expect(document.querySelector('.todo-arch-sub')!.textContent).toBe('showing 1 of 2')
    fireEvent.click(screen.getByText('Archived'))
    expect(document.querySelectorAll('.todo-item.archived')).toHaveLength(1)
  })

  it('says nothing about "showing" when no filter is on', () => {
    renderPlate()
    expect(document.querySelector('.todo-arch-sub')).toBeNull()
  })

  /* ── criterion 3: what the drawer rename costs ───────────────────────── */

  it('the drawer drops the word Done and the green check', () => {
    renderPlate()
    const tog = document.querySelector('.todo-arch-tog')!
    expect(tog.textContent).toContain('Archived')
    expect(tog.textContent).not.toContain('Done')
    // The old `.todo-done-*` classes are gone with the claim they carried.
    expect(document.querySelector('.todo-done-drawer')).toBeNull()
    expect(document.querySelector('.todo-done-tog')).toBeNull()
  })

  it('an archived row carries .archived, never .done', () => {
    renderPlate()
    fireEvent.click(screen.getByText('Archived'))
    expect(document.querySelectorAll('.todo-item.archived')).toHaveLength(1)
    expect(document.querySelectorAll('.todo-item.done')).toHaveLength(0)
  })

  it('both checkboxes name the ARCHIVE action, with a tooltip each', () => {
    // They are the only place the action is named at all, and neither button
    // had a tooltip before this.
    renderPlate()
    const open = screen.getAllByLabelText('Archive')
    expect(open.length).toBeGreaterThan(0)
    expect(open[0].getAttribute('title')).toContain('file it away')
    fireEvent.click(screen.getByText('Archived'))
    const back = screen.getByLabelText('Unarchive')
    expect(back.getAttribute('title')).toContain('put it back')
    expect(screen.queryByLabelText('Mark done')).toBeNull()
    expect(screen.queryByLabelText('Mark not done')).toBeNull()
  })

  /* ── criterion 7: no mirroring, therefore no flicker ─────────────────── */

  it('archiving a WORKING row writes archived alone and does not touch state', () => {
    // The mirroring is dropped: with no manual override there is no derived
    // field for the checkbox to contradict, and mirroring would now FABRICATE a
    // Done chip on a row whose projects are still running.
    renderPlate()
    const row = document.querySelector('[data-todo-id="b"]')!
    fireEvent.click(within(row as HTMLElement).getByLabelText('Archive'))
    expect(archive.mock.calls).toEqual([['b']])
  })

  it('the chip is IDENTICAL before, during and after an archive round trip', () => {
    // What replaces the mirroring as a criterion. The rail re-renders from the
    // same record with `archived` flipped and `state` untouched, so the chip
    // does not flicker through Done and back.
    const { rerender } = render(
      <TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={vi.fn()} />,
      { wrapper: wrap },
    )
    const chipOf = (sel: string) => document.querySelector(`${sel} .tk`)?.textContent
    expect(chipOf('[data-todo-id="b"]')).toContain('Working')

    // …the optimistic patch lands: same record, `archived: true`, same state.
    todos = todos.map((t) => (t.id === 'b' ? { ...t, archived: true } : t))
    rerender(<TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={vi.fn()} flash={vi.fn()} />)
    fireEvent.click(screen.getByText('Archived'))
    const archivedRows = [...document.querySelectorAll('.todo-item.archived')]
    const moved = archivedRows.find((el) => el.textContent?.includes('task b'))!
    expect(moved.querySelector('.tk')!.textContent).toContain('Working')
    expect(moved.querySelector('.tk')!.textContent).not.toContain('Done')
  })

  /* ── criterion 9: the badge ───────────────────────────────────────────── */

  it('the plate header counts a COMPLETED row that is still unarchived', () => {
    // The accepted consequence: a plate whose projects have all finished keeps
    // its count until the owner files the rows. A header that disagreed with
    // the length of the list beneath it would be worse.
    todos = [
      ROW('a', [], { state: 'completed' }),
      ROW('b', [], { state: 'completed' }),
      ROW('c', [], { state: 'completed', archived: true }),
    ]
    renderPlate()
    expect(document.querySelector('.todo-plate-c')!.textContent).toBe('2')
    expect(plateOrder()).toEqual(['a', 'b'])
  })
})

/**
 * ONE BOX, TWO JOBS. The rail's box searches the plate as you type AND is the
 * task the `+` captures — so these cases pin both halves and, more importantly,
 * the seam between them: that a search narrows through exactly the same
 * machinery as a label filter (the "N of M" header, the clear `×`, the
 * archived drawer), because a row that leaves the plate without a visible
 * cause is the failure mode this whole design is built around.
 */
describe('the To-do rail search box', () => {
  beforeEach(() => {
    agents = [AGENT]
  })
  afterEach(cleanup)

  const box = () => screen.getByPlaceholderText('Search or add a task…') as HTMLInputElement
  const addBtn = () => screen.getByLabelText('Add task') as HTMLButtonElement
  const type = (value: string) => fireEvent.change(box(), { target: { value } })

  it('matches every typed word, in any order, as a substring', () => {
    todos = [
      ROW('a', [], { text: 'Chase the Provi PO' }),
      ROW('b', [], { text: 'Reconcile the Provi invoice' }),
    ]
    renderPlate()
    type('provi po')
    expect(plateOrder()).toEqual(['a'])

    // Order-free, and a partial word still lands.
    type('po prov')
    expect(plateOrder()).toEqual(['a'])

    // AND, not OR — the second word narrows rather than widens.
    type('provi')
    expect(plateOrder()).toEqual(['a', 'b'])
  })

  it('reaches the draft recipient of a row and its label slugs', () => {
    registryLabels = [L('office')]
    todos = [
      ROW('a', ['office'], { text: 'Nothing in common' }),
      ROW('b', [], { text: 'Also nothing', draft_recipient_name: 'ana-analyst' }),
      ROW('c', [], { text: 'Third' }),
    ]
    renderPlate()
    type('office')
    expect(plateOrder()).toEqual(['a'])
    type('analyst')
    expect(plateOrder()).toEqual(['b'])
  })

  it('strips the @ so a half-typed label token still searches', () => {
    // The box is also the label autocomplete's input, so `@office` is a normal
    // thing to find in it. It has to narrow to the slug, not to nothing.
    registryLabels = [L('office')]
    todos = [ROW('a', ['office'], { text: 'One' }), ROW('b', [], { text: 'Two' })]
    renderPlate()
    type('@office')
    expect(plateOrder()).toEqual(['a'])
  })

  it('counts itself in the "N of M" header and the clear ×', () => {
    // A search is the third narrowing term and has to be visible as one —
    // otherwise rows vanish with no stated cause.
    todos = [ROW('a', [], { text: 'alpha' }), ROW('b', [], { text: 'beta' })]
    renderPlate()
    expect(document.querySelector('.todo-plate-c')!.textContent).toBe('2')
    type('alpha')
    expect(document.querySelector('.todo-plate-c')!.textContent).toBe('1 of 2')

    fireEvent.click(screen.getByLabelText('Clear filter'))
    expect(box().value).toBe('')
    expect(plateOrder()).toEqual(['a', 'b'])
  })

  it('narrows the archived drawer by the same query as the open plate', () => {
    todos = [
      ROW('a', [], { text: 'alpha' }),
      ROW('x', [], { text: 'alpha filed', archived: true }),
      ROW('y', [], { text: 'beta filed', archived: true }),
    ]
    renderPlate()
    type('alpha')
    expect(screen.getByText('showing 1 of 2')).toBeTruthy()
  })

  it('offers the capture as the answer when nothing matches', () => {
    todos = [ROW('a', [], { text: 'alpha' })]
    renderPlate()
    type('buy milk')
    expect(screen.getByText('No task matches “buy milk”')).toBeTruthy()
    expect(screen.getByText('Press Enter to capture it as a new task.')).toBeTruthy()
  })

  it('arms the + only once the box holds text', () => {
    renderPlate()
    expect(addBtn().disabled).toBe(true)
    expect(addBtn().title).toBe('Type a task to add it')
    type('   ')
    expect(addBtn().disabled).toBe(true) // whitespace is not a task
    type('Chase the PO')
    expect(addBtn().disabled).toBe(false)
  })

  it('captures on the + and on Enter alike, then empties the box', () => {
    renderPlate()
    type('Chase the PO')
    fireEvent.click(addBtn())
    expect(add).toHaveBeenCalledWith('Chase the PO', expect.objectContaining({ labels: [] }))
    expect(box().value).toBe('')
    // Emptying the box also lifts the search it was applying.
    expect(plateOrder()).toEqual(['t1'])

    add.mockReset()
    type('Second one')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(add).toHaveBeenCalledWith('Second one', expect.objectContaining({ labels: [] }))
    expect(box().value).toBe('')
  })

  it('says a capture is in flight until the row lands', () => {
    adding = true
    addingText = 'Chase the PO'
    renderPlate()
    expect(screen.getByRole('status').textContent).toBe('Adding “Chase the PO”…')
  })

  it('gives the words back and says why when a capture is refused', () => {
    const { flash } = renderPlate()
    type('Chase the PO')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('')
    const { onError } = add.mock.calls[0][1]
    act(() => onError(new Error('Server unavailable')))
    expect(flash).toHaveBeenCalledWith('Server unavailable')
    expect(box().value).toBe('Chase the PO')
  })

  it('never overwrites a newer draft with a refused one', () => {
    renderPlate()
    type('Chase the PO')
    fireEvent.keyDown(box(), { key: 'Enter' })
    type('Next thing')
    const { onError } = add.mock.calls[0][1]
    act(() => onError(new Error('nope')))
    expect(box().value).toBe('Next thing')
  })

  it('writes nothing on Enter in an empty box', () => {
    renderPlate()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(add).not.toHaveBeenCalled()
  })

  it('clears the box from the × without capturing anything', () => {
    renderPlate()
    type('half a thought')
    fireEvent.click(screen.getByTitle('Clear'))
    expect(box().value).toBe('')
    expect(add).not.toHaveBeenCalled()
  })
})

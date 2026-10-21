import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeskLabel } from '../../api/endpoints/deskLabels'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import { toRegistry } from '../../utils/labelView'
import { useDeskLabelViewStore } from '../../stores/deskLabelViewStore'

/**
 * PRESS AND HOLD ANYWHERE ON A ROW TO REORDER IT.
 *
 * The grip is a 16px transparent strip in the panel's gutter — `cursor: grab`
 * is its only cue, so a finger can never find it and the plate was effectively
 * unorderable on a phone. The hold is the second way into the SAME drag
 * machine, and these cases are all about the four things that decide whether it
 * is usable rather than infuriating:
 *
 *   · a short press is still a click (the row loads into the message box),
 *   · a press that MOVES is still a scroll or a text drag-select,
 *   · a press on a control of its own never arms at all, and
 *   · the click that trails a completed drag is swallowed, or dropping a row
 *     would also load it into the composer as a parting gift.
 *
 * `TodoRail.test.tsx` and `desk.css.test.ts` are expected to pass UNTOUCHED
 * alongside this file — that is the check that the hold is additive and the
 * grip path is byte-identical to what it was.
 */

const reorder = vi.fn()
const archive = vi.fn()
const remove = vi.fn()
let todos: DeskTodo[]
let registryLabels: DeskLabel[]

const L = (slug: string): DeskLabel => ({
  slug,
  name: slug,
  kind: 'context',
  color: 'blue',
  created_at: '1970-01-01T00:00:00+00:00',
  updated_at: '1970-01-01T00:00:00+00:00',
})

const ROW = (id: string, labels: string[] = []): DeskTodo => ({
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
})

vi.mock('../../hooks/useTodos', () => ({
  useTodos: () => ({
    todos,
    add: vi.fn(),
    captureWithDraft: vi.fn(),
    archive,
    remove,
    rename: vi.fn(),
    reorder,
    saveDraft: vi.fn(),
    setLabels: vi.fn(),
  }),
}))
vi.mock('../../hooks/useLabels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useLabels')>(
    '../../hooks/useLabels',
  )
  return {
    ...actual,
    useLabels: () => ({
      registry: toRegistry(registryLabels, 'ready'),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
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
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))

const { default: TodoRail } = await import('./TodoRail')

const NO_HOVER = { linkedTodoIds: new Set<string>(), onHoverTodo: () => {} }

/** The hold, in ms — HOLD_MS in the hook. Named once so a re-tune moves one
 *  number here and the cases still say "just under" / "just over". */
const HOLD = 420

let queryClient: QueryClient
const wrap = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

/** Rows in DOM order. */
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-todo-id]')]

/**
 * jsdom has no layout and no `elementFromPoint`, so the hit-test has to be fed
 * a fixture: y=0 is the first row, y=100 the second, and so on. That is the
 * ONLY thing stubbed — the hook's own `closest('[data-todo-id]')` still does
 * the resolving, so an id-attribute regression would still be caught here.
 */
function stubHitTest() {
  document.elementFromPoint = ((_x: number, y: number) =>
    rows()[Math.floor(y / 100)] ?? null) as typeof document.elementFromPoint
}

/** The whole row element (not the body button) for a given to-do id. */
const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-todo-id="${id}"]`)!

/** The body <button> inside a row — what a press on "the row" usually hits. */
const bodyOf = (id: string) => rowEl(id).querySelector<HTMLElement>('.todo-body')!

/**
 * jsdom ships no `PointerEvent` constructor, so `fireEvent.pointerDown` builds
 * a bare `Event` and SILENTLY DROPS `button` / `clientX` / `clientY` — every
 * coordinate the hold logic reads would arrive `undefined`, and `button !== 0`
 * alone would make every case here pass for the wrong reason. A `MouseEvent`
 * named `pointerdown` carries the same fields React reads off the synthetic
 * event, so the hook sees exactly what a browser would send it.
 */
const pointer = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })

/** A pointerdown that should arm the hold: primary contact, at row `index`. */
const press = (el: HTMLElement, index: number) =>
  fireEvent(el, pointer('pointerdown', { clientX: 10, clientY: index * 100 }))

/** Pointer moved to a point; `index * 100` is the centre of row `index`. */
const moveTo = (clientX: number, clientY: number) =>
  fireEvent(window, pointer('pointermove', { clientX, clientY }))

const release = () => fireEvent(window, pointer('pointerup', {}))
const abort = () => fireEvent(window, pointer('pointercancel', {}))

/** Let the hold timer fire. `act` because it lands in component state. */
const hold = (ms = HOLD) => act(() => void vi.advanceTimersByTime(ms))

function renderPlate() {
  const onUseTodo = vi.fn()
  render(
    <TodoRail activeTodoId={null} {...NO_HOVER} onUseTodo={onUseTodo} flash={vi.fn()} />,
    { wrapper: wrap },
  )
  stubHitTest()
  return { onUseTodo }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  useDeskLabelViewStore.getState().reset()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  todos = [ROW('a', ['office']), ROW('b', ['home']), ROW('c', ['office'])]
  registryLabels = [L('office'), L('home')]
  reorder.mockReset()
  archive.mockReset()
  remove.mockReset()
})

afterEach(() => {
  cleanup()
  // Let the click-swallower's own removal timeout run before the fake clock is
  // thrown away. Without it a completed drag leaves a `once` capture listener
  // on `window` for the whole FILE, and the next case's first click vanishes
  // into it — which looks exactly like the feature being broken.
  act(() => void vi.advanceTimersByTime(1))
  vi.useRealTimers()
})

describe('TodoRail long-press reorder', () => {
  it('holds the row body, moves onto another row, and reorders on release', () => {
    renderPlate()

    press(bodyOf('a'), 0)
    hold()
    moveTo(10, 100)
    release()

    expect(reorder).toHaveBeenCalledTimes(1)
    expect(reorder).toHaveBeenCalledWith('a', 'b')
  })

  it('arms from the row itself, not just the body button', () => {
    // The whole point is "anywhere on the row" — the meta line, the chips
    // strip and the row's own padding all have to pick it up, which they only
    // do because the handler sits on the ROOT.
    renderPlate()

    press(rowEl('a'), 0)
    hold()
    moveTo(10, 200)
    release()

    expect(reorder).toHaveBeenCalledWith('a', 'c')
  })

  it('leaves a SHORT press as an ordinary click that loads the row', () => {
    const { onUseTodo } = renderPlate()

    press(bodyOf('a'), 0)
    hold(100)
    release()
    fireEvent.click(bodyOf('a'))

    expect(reorder).not.toHaveBeenCalled()
    expect(onUseTodo).toHaveBeenCalledTimes(1)
    expect(onUseTodo).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('cancels the hold once the pointer moves past the slop — the scroll wins', () => {
    const { onUseTodo } = renderPlate()

    press(bodyOf('a'), 0)
    moveTo(10, 30)
    hold(HOLD * 2)
    moveTo(10, 100)
    release()
    fireEvent.click(bodyOf('a'))

    expect(reorder).not.toHaveBeenCalled()
    // …and the row is still clickable afterwards: a cancelled hold must not
    // leave the click swallower armed.
    expect(onUseTodo).toHaveBeenCalledTimes(1)
  })

  it('survives a tremor inside the slop — a thumb is never perfectly still', () => {
    renderPlate()

    press(bodyOf('a'), 0)
    moveTo(13, 4)
    hold()
    moveTo(10, 100)
    release()

    expect(reorder).toHaveBeenCalledWith('a', 'b')
  })

  it('swallows the click that trails a completed drag', () => {
    // The row body is a <button>. Without the one-shot capture-phase
    // swallower, the pointerup that DROPS a row also fires its click and the
    // row lands in the composer as a parting gift.
    const { onUseTodo } = renderPlate()

    press(bodyOf('a'), 0)
    hold()
    moveTo(10, 100)
    release()
    fireEvent.click(bodyOf('a'))

    expect(reorder).toHaveBeenCalledTimes(1)
    expect(onUseTodo).not.toHaveBeenCalled()
  })

  it('re-arms the click for the NEXT press after a drag', () => {
    // The swallower is `once` AND removed on a 0ms timeout, so it can only ever
    // eat the one click that belongs to the drag it ended.
    const { onUseTodo } = renderPlate()

    press(bodyOf('a'), 0)
    hold()
    moveTo(10, 100)
    release()
    act(() => void vi.advanceTimersByTime(1))

    fireEvent.click(bodyOf('a'))

    expect(onUseTodo).toHaveBeenCalledTimes(1)
  })

  it('locks the body against panning for the duration of the drag, and only that', () => {
    renderPlate()

    press(bodyOf('a'), 0)
    hold()
    expect(document.body.classList.contains('todo-dragging')).toBe(true)

    release()
    expect(document.body.classList.contains('todo-dragging')).toBe(false)
  })

  it('writes nothing when the drag is cancelled mid-flight', () => {
    renderPlate()

    press(bodyOf('a'), 0)
    hold()
    moveTo(10, 100)
    abort()

    expect(reorder).not.toHaveBeenCalled()
    expect(document.body.classList.contains('todo-dragging')).toBe(false)
  })

  it('never arms from a control that owns its own press', () => {
    // Checkbox, ⋮ and the grip each have a press to spend. The grip matters
    // most: its pointerdown ALSO bubbles to the row, so without the exclusion
    // one press would start a drag and arm a competing timer on top of it.
    renderPlate()

    for (const sel of ['.todo-check', '.todo-actions button']) {
      fireEvent(
        rowEl('a').querySelector<HTMLElement>(sel)!,
        pointer('pointerdown', { clientX: 10, clientY: 0 }),
      )
      hold()
      moveTo(10, 100)
      release()
    }

    expect(reorder).not.toHaveBeenCalled()
    expect(archive).not.toHaveBeenCalled()
  })

  it('lets the grip drag EXACTLY once, not once per entry point', () => {
    // The grip sits inside the row, so its pointerdown bubbles to the row's own
    // handler. `startDrag` fires on the way down and `armLongPress` must refuse
    // — otherwise one press runs two machines over one row, and the second one
    // would still be armed after the first has dropped it.
    renderPlate()

    fireEvent(
      rowEl('a').querySelector<HTMLElement>('.todo-grip')!,
      pointer('pointerdown', { clientX: 10, clientY: 0 }),
    )
    moveTo(10, 100)
    release()
    // Well past the hold: nothing may be left armed to fire after the drop.
    hold(HOLD * 2)
    moveTo(10, 200)
    release()

    expect(reorder).toHaveBeenCalledTimes(1)
    expect(reorder).toHaveBeenCalledWith('a', 'b')
  })

  it('never arms from the inline rename field', () => {
    // The field needs caret placement and drag-select; a hold inside it must
    // not lift the row out from under the text being edited.
    renderPlate()
    fireEvent.click(screen.getAllByTitle('Click to rename')[0])
    const field = rowEl('a').querySelector<HTMLElement>('.todo-rename')!

    fireEvent(field, pointer('pointerdown', { clientX: 10, clientY: 0 }))
    hold()
    moveTo(10, 100)
    release()

    expect(reorder).not.toHaveBeenCalled()
  })

  it('stays absent in grouped mode, where order is locked', () => {
    // Grouped rows get no `wire` at all, so they carry neither the grip nor the
    // row-level onPointerDown. Absent, not present-and-broken.
    // Hydrate first: the store's mount-time hydrate would otherwise read an
    // empty blob straight back over the group we just set.
    useDeskLabelViewStore.getState().hydrate('u1')
    useDeskLabelViewStore.getState().setGroup('context')
    renderPlate()
    const instanced = document.querySelectorAll<HTMLElement>('[data-todo-instance]')
    expect(instanced.length).toBeGreaterThan(0)

    fireEvent(instanced[0], pointer('pointerdown', { clientX: 10, clientY: 0 }))
    hold()
    moveTo(10, 100)
    release()

    expect(reorder).not.toHaveBeenCalled()
  })

  it('ignores a non-primary button, so right-click still opens the menu', () => {
    renderPlate()

    fireEvent(bodyOf('a'), pointer('pointerdown', { button: 2, clientX: 10, clientY: 0 }))
    hold()
    moveTo(10, 100)
    release()

    expect(reorder).not.toHaveBeenCalled()
  })
})

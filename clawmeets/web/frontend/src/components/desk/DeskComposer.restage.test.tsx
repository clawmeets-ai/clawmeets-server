import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AgentCard } from '../../types'
import type { DeskTodo, DeskTodoAttachment } from '../../api/endpoints/deskTodos'

/**
 * Re-staging a saved to-do's attachments as REAL `File` objects, so a later
 * dispatch sends real bytes rather than a name.
 *
 * The fetch is eager — at load — and not lazy at dispatch, for a concrete
 * reason: `dispatch()` is try/finally with no catch, so a network failure
 * pushed in there would leave the box having sent nothing, said nothing and
 * explained nothing. At load the failure has somewhere to render, at the moment
 * the user is already looking at the item.
 *
 * The endpoint module is mocked, which is how every test in this repo isolates
 * a network boundary.
 */

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] as AgentCard[] }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))
vi.mock('../common/ModelSelector', () => ({ default: () => null }))

// The typed fake for the download route, driven by the published contract:
// 200 → raw bytes with the stored content type, 404 → the plate names bytes
// that are gone. A real per-attachment-id cache sits in the real module, so it
// is modelled here too — the test asserts a second load costs no second fetch.
const blobs = new Map<string, string>()
const cache = new Map<string, File>()
const fetchTodoAttachment = vi.fn(async (todoId: string, a: DeskTodoAttachment) => {
  const key = `${todoId}:${a.id}`
  const hit = cache.get(key)
  if (hit) return hit
  const body = blobs.get(key)
  if (body === undefined) throw new Error(`To-do '${todoId}' not found`)
  const file = new File([body], a.name, { type: a.content_type })
  cache.set(key, file)
  return file
})
vi.mock('../../api/endpoints/deskTodoAttachments', () => ({
  fetchTodoAttachment: (todoId: string, a: DeskTodoAttachment) =>
    fetchTodoAttachment(todoId, a),
  cachedTodoAttachment: (todoId: string, id: string) => cache.get(`${todoId}:${id}`),
  forgetTodoAttachment: (todoId: string, id: string) => {
    cache.delete(`${todoId}:${id}`)
  },
}))

const { default: DeskComposer } = await import('./DeskComposer')
type Handle = import('./DeskComposer').DeskComposerHandle

/** jsdom's File implements no `.text()`, so read it the way the app's own
 *  base64 helper does. */
const readText = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsText(f)
  })

const A = (over: Partial<DeskTodoAttachment> = {}): DeskTodoAttachment => ({
  id: 'a-4f9c2b1e',
  name: 'notes.pdf',
  size: 20481,
  content_type: 'application/pdf',
  sha256: '9f86d0',
  created_at: '2026-09-01T10:14:02+00:00',
  ...over,
})

const todo = (over: Partial<DeskTodo> = {}): DeskTodo => ({
  id: 't-9a3f21',
  owner_user_id: 'u1',
  text: 'Chase the Northwind renewal',
  // `status` is gone from the wire; these four replace it and are all
  // typed REQUIRED, which is why every to-do fixture in the suite
  // moved at once rather than one at a time.
  state: 'new',
  archived: false,
  association_count: 0,
  project_ids: [],
  created_at: '',
  updated_at: '',
  draft_prompt: 'Chase the renewal',
  attachments: [],
  ...over,
})

function renderBox() {
  const ref = createRef<Handle>()
  // `{ linked: true }` is the shape the prop contract now requires — the
  // composer destructures it to decide whether to keep the to-do bound.
  const onDispatch = vi.fn(async () => ({ linked: true }))
  const { container } = render(
    <DeskComposer
      ref={ref}
      recipient={{ id: 'a1', name: 'ana-analyst', status: 'online' } as AgentCard}
      onRecipientChange={vi.fn()}
      onDispatch={onDispatch}
      todoSource={{ id: 't-9a3f21', text: 'Chase the Northwind renewal' }}
    />,
  )
  // Loading is synchronous by contract; the background fetches settle on the
  // microtask queue, so `flush: false` is what lets a test look at the tray
  // mid-flight.
  const load = async (t: DeskTodo, flush = true) => {
    act(() => {
      ref.current?.loadTodoDraft(t.draft_prompt || t.text, t)
    })
    if (flush) await act(async () => {})
  }
  const tray = () => screen.getByRole('list', { name: 'Staged attachments' })
  const chip = (name: string) =>
    within(tray()).getByRole('listitem', {
      // `listitem` is matched by its accessible name, which the chip's own
      // title supplies (plain name, or name + why it is unusual).
      name: (_, el) => (el.getAttribute('title') ?? '').startsWith(name),
    })
  const stagedNames = () =>
    within(tray())
      .getAllByRole('listitem')
      .map((el) => (el.getAttribute('title') ?? '').split(' — ')[0])
  const command = () =>
    screen.getByRole('button', { name: /command/i }) as HTMLButtonElement
  return { ref, container, load, chip, stagedNames, command, onDispatch }
}

describe('DeskComposer re-stages stored attachments', () => {
  beforeEach(() => {
    blobs.clear()
    cache.clear()
    fetchTodoAttachment.mockClear()
  })
  afterEach(cleanup)

  it('re-stages stored attachments as File instances with non-zero size', async () => {
    // Read the tray the only way production does: through what a dispatch
    // actually hands out. A name-only chip would arrive here as a 0-byte
    // placeholder and the recipient would get an empty file.
    blobs.set('t-9a3f21:a-4f9c2b1e', 'the real bytes')
    const { load, onDispatch, command } = renderBox()

    await load(todo({ attachments: [A()] }))
    await act(async () => {
      fireEvent.click(command())
    })

    const files = onDispatch.mock.calls[0][2] as unknown as File[]
    expect(files).toHaveLength(1)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].size).toBeGreaterThan(0)
    expect(await readText(files[0])).toBe('the real bytes')
  })

  it('chips render immediately with the descriptor’s name and size while loading', async () => {
    blobs.set('t-9a3f21:a-4f9c2b1e', 'the real bytes')
    const { load, chip, stagedNames } = renderBox()

    // Do NOT flush: this is the first frame after the click.
    await load(todo({ attachments: [A({ size: 20481 })] }), false)

    expect(stagedNames()).toEqual(['notes.pdf'])
    // 20481 B from the descriptor — the placeholder File is empty and would
    // have read "0 B", which is the flash of wrongness this exists to avoid.
    expect(within(chip('notes.pdf')).getByText(/20 KB · loading…/)).toBeTruthy()

    await act(async () => {})
    expect(within(chip('notes.pdf')).queryByText(/loading/)).toBeNull()
  })

  it('disables Command while any entry is loading, and the title says why', async () => {
    blobs.set('t-9a3f21:a-4f9c2b1e', 'the real bytes')
    const { load, command } = renderBox()

    await load(todo({ attachments: [A()] }), false)

    expect(command().disabled).toBe(true)
    expect(command().title).toMatch(/Waiting for attachments to load/)

    await act(async () => {})

    expect(command().disabled).toBe(false)
    expect(command().title).toMatch(/Command/)
  })

  it('renders an error chip whose retry re-fetches', async () => {
    // No blob planted → the download 404s, which is the deliberately-surfaced
    // case where the plate names bytes that are gone.
    const { load, chip, command } = renderBox()

    await load(todo({ attachments: [A()] }))

    expect(within(chip('notes.pdf')).getByText(/unavailable/)).toBeTruthy()
    // A failed chip is not a loading chip: Command is usable again rather than
    // wedged forever.
    expect(command().disabled).toBe(false)

    // The bytes come back, and the user retries.
    blobs.set('t-9a3f21:a-4f9c2b1e', 'the real bytes')
    await act(async () => {
      fireEvent.click(screen.getByTitle('Retry notes.pdf'))
    })

    expect(within(chip('notes.pdf')).queryByText(/unavailable/)).toBeNull()
    expect(fetchTodoAttachment).toHaveBeenCalledTimes(2)
  })

  it('discards a fetch that resolves after a newer load', async () => {
    // Click row A, then row B before A's bytes arrive. A's File must not land
    // in B's tray.
    let releaseA!: (f: File) => void
    fetchTodoAttachment.mockImplementationOnce(
      () => new Promise<File>((res) => (releaseA = res)),
    )
    blobs.set('t-other:a-b', 'b bytes')

    const { load, stagedNames, chip } = renderBox()
    await load(todo({ attachments: [A({ id: 'a-a', name: 'a-file.pdf' })] }), false)

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await load(
      todo({
        id: 't-other',
        text: 'Other item',
        draft_prompt: 'Other item',
        attachments: [A({ id: 'a-b', name: 'b-file.pdf' })],
      }),
    )

    await act(async () => {
      releaseA(new File(['a bytes'], 'a-file.pdf'))
    })

    expect(stagedNames()).toEqual(['b-file.pdf'])
    expect(within(chip('b-file.pdf')).queryByText(/loading/)).toBeNull()
  })

  it('serves a second load of the same to-do from the cache', async () => {
    blobs.set('t-9a3f21:a-4f9c2b1e', 'the real bytes')
    const { load, chip } = renderBox()
    const t = todo({ attachments: [A()] })

    await load(t)
    expect(fetchTodoAttachment).toHaveBeenCalledTimes(1)

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    // Not flushed: a cached blob must stage as `ready` in the FIRST frame, with
    // no loading flash and no second request.
    await load(t, false)

    expect(fetchTodoAttachment).toHaveBeenCalledTimes(1)
    expect(within(chip('notes.pdf')).queryByText(/loading/)).toBeNull()
  })
})

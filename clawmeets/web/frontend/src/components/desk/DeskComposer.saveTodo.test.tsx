import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentCard } from '../../types'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import type { TrayEntry } from '../../hooks/useMessageAttachments'
import { ApiError } from '../../api/client'
import { buildAttachmentDesiredState } from '../../utils/todoAttachments'

/**
 * "Save to-do" on the desk message box. The two things that make it a to-do
 * button rather than a second send button: it needs text but NOT a recipient
 * (a to-do is a note to yourself), and it hands over the editor's SOURCE, so a
 * draft with unfilled blanks round-trips as a template instead of decaying into
 * "[Label]" the next time the item is loaded.
 *
 * It now also hands over the TRAY, because the bytes ride the same request as
 * the draft. Whether a tray entry re-uploads or is kept is decided by its
 * stored `attachmentId` — never by its name.
 */

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] as AgentCard[] }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))
// The toolbar's model quick-edit wants a router + a QueryClient of its own and
// has nothing to do with saving a to-do — stub it rather than standing both up.
vi.mock('../common/ModelSelector', () => ({ default: () => null }))

const { default: DeskComposer } = await import('./DeskComposer')
type Handle = import('./DeskComposer').DeskComposerHandle

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
  attachments: [],
  ...over,
})

function renderBox(
  over: {
    todoSource?: { id: string; text: string } | null
    onSaveTodo?: (source: string, tray: TrayEntry[]) => Promise<void>
  } = {},
) {
  const onSaveTodo = vi.fn(over.onSaveTodo ?? (async () => {}))
  const ref = createRef<Handle>()
  const { container } = render(
    <DeskComposer
      ref={ref}
      recipient={null}
      onRecipientChange={vi.fn()}
      onDispatch={vi.fn(async () => ({ linked: true }))}
      onSaveTodo={onSaveTodo}
      todoSource={over.todoSource ?? null}
    />,
  )
  const save = screen.getByRole('button', { name: /save to-do/i }) as HTMLButtonElement
  // The rich editor is a contenteditable, not an <input> — write it the way a
  // paste does and let PromptEditor's input handler pick the change up.
  const editor = container.querySelector('[contenteditable]') as HTMLElement
  const type = (text: string) => {
    editor.textContent = text
    fireEvent.input(editor)
  }
  const attach = (...files: File[]) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files } })
  }
  const load = (t: DeskTodo) => {
    act(() => {
      ref.current?.loadTodoDraft(t.draft_prompt || t.text, t)
    })
  }
  const stagedNames = () =>
    Array.from(container.querySelectorAll('button[title^="Remove "]')).map((b) =>
      (b.getAttribute('title') ?? '').replace(/^Remove /, ''),
    )
  const press = async () => {
    await act(async () => {
      fireEvent.click(save)
    })
  }
  return { onSaveTodo, save, type, attach, load, stagedNames, press }
}

const file = (name: string, body = 'x') => new File([body], name, { type: 'text/plain' })

describe('DeskComposer Save to-do', () => {
  afterEach(cleanup)

  it('is disabled while the box is empty and enabled once text exists — with no recipient picked', () => {
    const { save, type } = renderBox()

    expect(save.disabled).toBe(true)

    type('Chase the Q3 numbers')

    // No recipient was ever selected: saving a note to yourself must not
    // require one, unlike command.
    expect(save.disabled).toBe(false)
  })

  it('hands over the editor source, so unfilled blanks survive the round trip', async () => {
    const { onSaveTodo, type, press } = renderBox()

    type('Pull the numbers by {{Deadline|date}}')
    await press()

    expect(onSaveTodo).toHaveBeenCalledTimes(1)
    expect(onSaveTodo.mock.calls[0][0]).toContain('{{Deadline|date}}')
    expect(onSaveTodo.mock.calls[0][0]).not.toContain('[Deadline]')
  })

  it('names the bound to-do in the head and on the button', () => {
    const { save } = renderBox({ todoSource: { id: 't1', text: 'Chase the Q3 numbers' } })

    expect(screen.getByTitle(/Bound to the to-do/)).toBeTruthy()
    expect(save.title).toContain('Chase the Q3 numbers')
  })

  it('onSaveTodo receives the staged File objects', async () => {
    const { onSaveTodo, load, attach, press } = renderBox({
      todoSource: { id: 't-9a3f21', text: 'Chase the Northwind renewal' },
    })

    load(todo({ draft_prompt: 'Chase the renewal' }))
    attach(file('contract.pdf', 'real bytes'))
    await press()

    const tray = onSaveTodo.mock.calls[0][1]
    // The whole tray goes up — the composer does not pre-filter, because what
    // uploads is a property of the entry, decided in one place.
    expect(tray.map((e) => [e.origin, e.file.name])).toEqual([['user', 'contract.pdf']])
    expect(tray.every((e) => e.file instanceof File)).toBe(true)

    // And what that tray SAVES as is the user's file.
    await expect(buildAttachmentDesiredState(tray)).resolves.toEqual([
      { filename: 'contract.pdf', content_b64: btoa('real bytes') },
    ])
  })

  it('does not clear the tray on save', async () => {
    // A send clears because the message left. A save does not: the item stays
    // bound and its files stay in the box, now as its saved attachments.
    const { type, attach, stagedNames, press } = renderBox()

    type('Chase the renewal')
    attach(file('contract.pdf'))
    expect(stagedNames()).toEqual(['contract.pdf'])

    await press()

    expect(stagedNames()).toEqual(['contract.pdf'])
  })

  it('is held in a pending state until onSaveTodo settles', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { save, type } = renderBox({ onSaveTodo: () => gate })

    type('Chase the renewal')
    act(() => {
      fireEvent.click(save)
    })
    expect(save.disabled).toBe(true)

    await act(async () => {
      release()
      await gate
    })
    expect(save.disabled).toBe(false)
  })

  it('renders a 413 detail verbatim', async () => {
    // The server's sentence names the file, the actual size, the limit and the
    // env var to raise. Rewording it client-side would throw away every one of
    // those; it is written for this exact screen.
    const detail =
      "attachments total 23068672 bytes, exceeds the 20971520-byte per-to-do limit " +
      '(raise CLAWMEETS_MAX_MESSAGE_ATTACHMENTS_BYTES)'
    const { type, press } = renderBox({
      onSaveTodo: () => Promise.reject(new ApiError(413, detail)),
    })

    type('Chase the renewal')
    await press()

    expect(screen.getByText(detail)).toBeTruthy()
  })

  it('renders a 400 stale-keep detail verbatim too', async () => {
    // The second-tab case: this tab sent {keep: a-deadbeef} for an id the to-do
    // no longer has. The server wrote nothing and said why.
    const detail = "attachment 'a-deadbeef' is not on this to-do"
    const { type, press } = renderBox({
      onSaveTodo: () => Promise.reject(new ApiError(400, detail)),
    })

    type('Chase the renewal')
    await press()

    expect(screen.getByText(detail)).toBeTruthy()
  })

  it('a load that is at or over the size cap still saves every stored id back', async () => {
    // The destructive shape this guards: the tray is emitted as the COMPLETE
    // desired state, so a chip the client-side cap refused at LOAD time is a
    // stored file the very next Save deletes. Both triggers are here — the
    // a to-do the server considers legal, and a deployment that raised the
    // server env var past this client's hardcoded 20 MB mirror.
    const stored = (id: string, size: number) => ({
      id,
      name: `${id}.bin`,
      size,
      content_type: 'application/octet-stream',
      sha256: '9f86d0',
      created_at: '2026-09-01T10:14:02+00:00',
    })
    const MB = 1024 * 1024

    const { onSaveTodo, load, press } = renderBox({
      todoSource: { id: 't-9a3f21', text: 'Chase the Northwind renewal' },
    })

    load(
      todo({
        draft_prompt: 'Chase the renewal',
        attachments: [stored('a-111', 20 * MB), stored('a-222', 10 * MB)],
      }),
    )
    await press()

    const tray = onSaveTodo.mock.calls[0][1] as TrayEntry[]
    expect(await buildAttachmentDesiredState(tray)).toEqual([
      { keep: 'a-111' },
      { keep: 'a-222' },
    ])
  })

  it('falls back to a plain sentence when the failure carries no server detail', async () => {
    const { type, press } = renderBox({
      onSaveTodo: () => Promise.reject(new TypeError('NetworkError')),
    })

    type('Chase the renewal')
    await press()

    expect(screen.getByText(/Couldn’t save that to-do/)).toBeTruthy()
    // A transport failure must not leak its stack-level wording to the user.
    expect(screen.queryByText(/NetworkError/)).toBeNull()
  })
})

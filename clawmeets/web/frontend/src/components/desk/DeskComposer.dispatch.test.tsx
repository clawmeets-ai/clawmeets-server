import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentCard } from '../../types'

/**
 * THE COMPOSER'S HALF OF THE LINK: what it captures, when it hands it over, and
 * what it does with the answer.
 *
 * Every one of these guards a race or an ordering, which is to say none of them
 * can be established by reading the component:
 *
 *  - the bound to-do's id is read BEFORE the clear that a successful send
 *    fires, or the association is made against `null`;
 *  - a per-draft idempotency token is minted and held, so two presses mean one
 *    thread and therefore one association;
 *  - the token ROTATES on a send that linked and is HELD on one that did not,
 *    which is what makes the retry land in the same thread;
 *  - `linked: false` keeps the to-do bound, so the head still names the item
 *    the toast is talking about.
 */

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] as AgentCard[] }) }))
vi.mock('../../stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'ana' } }),
}))
vi.mock('../common/ModelSelector', () => ({ default: () => null }))
vi.mock('../../api/endpoints/deskTodoAttachments', () => ({
  fetchTodoAttachment: vi.fn(),
  cachedTodoAttachment: () => undefined,
  forgetTodoAttachment: () => {},
}))

const { default: DeskComposer } = await import('./DeskComposer')

const RECIPIENT = { id: 'a1', name: 'ana-analyst', status: 'online' } as AgentCard
const BOUND = { id: 't-9a3f21', text: 'Chase the Northwind renewal' }

type Opts = { todoId: string | null; clientThreadKey: string }

/** Renders the box already bound to a to-do, with `onDispatch` under the
 *  test's control — including how long it takes to resolve, which is the only
 *  way to look INSIDE the window where the box is disabled. */
function renderBox(
  impl: (r: AgentCard, t: string, f: File[], o: Opts) => Promise<{ linked: boolean }>,
  { bound = true }: { bound?: boolean } = {},
) {
  const onDispatch = vi.fn(impl)
  const onClearTodo = vi.fn()
  const view = render(
    <DeskComposer
      recipient={RECIPIENT}
      onRecipientChange={vi.fn()}
      onDispatch={onDispatch}
      todoSource={bound ? BOUND : null}
      onClearTodo={onClearTodo}
    />,
  )
  const command = () =>
    screen.getByRole('button', { name: /command/i }) as HTMLButtonElement
  const type = async (s: string) => {
    const box = view.container.querySelector('[contenteditable="true"]')!
    await act(async () => {
      fireEvent.input(box, { target: { textContent: s } })
    })
  }
  const press = async () => {
    await act(async () => {
      fireEvent.click(command())
    })
  }
  return { ...view, onDispatch, onClearTodo, command, type, press }
}

const opts = (m: ReturnType<typeof vi.fn>, i = 0) => m.mock.calls[i][3] as Opts

/** The send button is replaced by a "Sent" badge for 1900ms. A test that
 *  presses twice has to live through that, or the second press has no button
 *  to find — which is itself the behaviour that makes the token's ROTATION
 *  rule observable rather than theoretical. */
const settle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(2000)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('DeskComposer hands the link everything it needs', () => {
  it('passes the bound to-do id, read before the clear that would race it', async () => {
    const { onDispatch, type, press } = renderBox(async () => ({ linked: true }))
    await type('have a look at this')
    await press()
    expect(opts(onDispatch).todoId).toBe('t-9a3f21')
  })

  it('passes a null to-do id when the box is bound to nothing', async () => {
    // Not an edge case — it is the ordinary free-form send, and it has to be
    // distinguishable from "we forgot to read the binding".
    const { onDispatch, type, press } = renderBox(async () => ({ linked: true }), {
      bound: false,
    })
    await type('morning')
    await press()
    expect(opts(onDispatch).todoId).toBeNull()
  })

  it('the id survives a clear that fires while the dispatch is in flight', async () => {
    // The failure this pins: reading `todoSource` AFTER the await would see the
    // state the send itself cleared and link nothing, silently — "no to-do" is
    // a legitimate answer on this path, so nothing downstream would complain.
    let release: (v: { linked: boolean }) => void = () => {}
    const { onDispatch, type, press } = renderBox(
      () => new Promise<{ linked: boolean }>((r) => { release = r }),
    )
    await type('have a look at this')
    await press()
    expect(onDispatch).toHaveBeenCalledTimes(1)
    await act(async () => { release({ linked: true }) })
    expect(opts(onDispatch).todoId).toBe('t-9a3f21')
  })
})

describe('DeskComposer double-press produces ONE thread', () => {
  it('a second press inside the in-flight window makes no second request', async () => {
    // `pending` is read from the render closure, so two clicks in one tick both
    // see it false. The synchronous ref is what closes that window.
    let release: (v: { linked: boolean }) => void = () => {}
    const { onDispatch, type, command } = renderBox(
      () => new Promise<{ linked: boolean }>((r) => { release = r }),
    )
    await type('have a look at this')
    await act(async () => {
      fireEvent.click(command())
      fireEvent.click(command())
    })
    expect(onDispatch).toHaveBeenCalledTimes(1)
    await act(async () => { release({ linked: true }) })
  })

  it('carries a client thread key, so a retry maps to one thread server-side', async () => {
    const { onDispatch, type, press } = renderBox(async () => ({ linked: true }))
    await type('have a look at this')
    await press()
    expect(opts(onDispatch).clientThreadKey).toEqual(expect.any(String))
    expect(opts(onDispatch).clientThreadKey.length).toBeGreaterThan(0)
  })

  it('ROTATES the key after a send that linked — a new draft is a new thread', async () => {
    const { onDispatch, type, press } = renderBox(async () => ({ linked: true }))
    await type('first')
    await press()
    await settle()
    await type('second')
    await press()
    expect(opts(onDispatch, 0).clientThreadKey).not.toBe(opts(onDispatch, 1).clientThreadKey)
  })

  it('HOLDS the key when the message went out but the link did not', async () => {
    // This is the recovery path, and the reason rotation is gated on `linked`
    // rather than on success: the next press has to land in the SAME thread,
    // so re-sending re-attempts the association against the thread that was
    // actually created rather than spawning a second one beside it.
    const { onDispatch, type, press } = renderBox(async () => ({ linked: false }))
    await type('first')
    await press()
    await settle()
    await type('again')
    await press()
    expect(opts(onDispatch, 0).clientThreadKey).toBe(opts(onDispatch, 1).clientThreadKey)
  })
})

describe('DeskComposer honours what the dispatch reports back', () => {
  it('clears the bound to-do when the link landed', async () => {
    const { onClearTodo, type, press } = renderBox(async () => ({ linked: true }))
    await type('have a look at this')
    await press()
    expect(onClearTodo).toHaveBeenCalled()
  })

  it('KEEPS the to-do bound when the link did not', async () => {
    // The page cannot re-bind afterwards — its clear fires once the dispatch
    // resolves and wins that race — so honouring the answer here is the only
    // place this can be decided. The head keeps naming the item, which is what
    // makes the toast's sentence point at something on screen.
    const { onClearTodo, type, press } = renderBox(async () => ({ linked: false }))
    await type('have a look at this')
    await press()
    expect(onClearTodo).not.toHaveBeenCalled()
    expect(screen.getByTitle(/Bound to the to-do/)).toBeTruthy()
  })

  it('still clears the TEXT when the link failed — the message really went out', async () => {
    // Keeping the draft in the box would invite a resend, which would post the
    // same text a second time into the same thread. Only the BINDING is kept.
    const { container, type, press } = renderBox(async () => ({ linked: false }))
    await type('have a look at this')
    await press()
    const box = container.querySelector('[contenteditable="true"]')!
    expect(box.textContent).toBe('')
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import AccountChip from './AccountChip'
import { LandingRedirect } from '../../App'
import { useAuthStore } from '../../stores/authStore'
import { makeSession, seedSessions } from '../../test/authFixtures'

/**
 * M4's chip — AC-4.1 through AC-4.3, AC-4.6, and B21.
 *
 * A REAL ROUTER, not a `useNavigate` mock. Every claim here is about where the
 * user ENDS UP: a switch that lands on `/welcome` rather than a broken `/desk`
 * (AC-4.6), an expired row that reaches the add surface pre-filled, a click on
 * your own row that goes NOWHERE (B21). Mocking `useNavigate` would let all
 * four pass while asserting only that a function was called with a string —
 * and AC-4.6 in particular is a claim about `LandingRedirect`'s decision, which
 * a mock deletes.
 *
 * `LandingRedirect` is mounted for the same reason: it is the component that
 * turns `useSwitchAccount()`'s unconditional `/` into desk-vs-welcome, so the
 * assertion "switching to an assistant-less account lands on /welcome" is only
 * meaningful with it in the tree.
 */

const A = 'user-a'
const B = 'user-b'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>
}

/** The chip sits OUTSIDE `<Routes>`, exactly as it does in the real sidebar:
 *  it must survive the navigation it causes, or the assertions after a click
 *  would be running against an unmounted tree. */
function renderChip(at = '/desk') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <AccountChip />
      <LocationProbe />
      <Routes>
        <Route path="/" element={<LandingRedirect />} />
        <Route path="/desk" element={<div>desk-page</div>} />
        <Route path="/welcome" element={<div>welcome-page</div>} />
        <Route path="/settings" element={<div>settings-page</div>} />
        <Route path="/account/add" element={<div>add-page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: /signed in as/ }))
  return screen.getByRole('dialog', { name: 'Accounts' })
}

function locationNow(): string {
  return screen.getByTestId('loc').textContent ?? ''
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  seedSessions([])
})

afterEach(() => {
  // `globals: false` in vitest.config.ts means RTL registers no auto-cleanup,
  // and a chip left mounted stays subscribed to the store AND leaves its portal
  // in document.body for the next case's queries to find.
  cleanup()
  seedSessions([])
})

describe('AC-4.1 — the chip replaces the avatar', () => {
  it('renders the ACTIVE account and opens a portalled popover listing them all', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], a.userId)

    const { container } = renderChip()
    // Initials, from the active account, on the trigger itself.
    expect(screen.getByRole('button', { name: /signed in as ana/ })).toBeTruthy()

    const dialog = openPopover()
    // Every signed-in account, not just the active one.
    expect(screen.getByRole('button', { name: 'Switch to bo' })).toBeTruthy()
    expect(screen.getByLabelText('ana, active account')).toBeTruthy()

    // PORTALLED. The rail is a 68px column that clips its overflow; a popover
    // rendered inside the chip's own subtree would be cut off at 68px wide.
    expect(container.contains(dialog)).toBe(false)
    expect(document.body.contains(dialog)).toBe(true)
  })

  it('marks the active account rather than leaving the list ambiguous', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], b.userId)

    renderChip()
    openPopover()
    expect(screen.getByLabelText('bo, active account').getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Switch to ana' }).getAttribute('aria-current')).toBeNull()
  })
})

describe('AC-4.2 — three states, read from the session’s own refreshExpiresAt', () => {
  it('renders active, signed-in-background and expired distinctly', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    // A DEAD REFRESH CREDENTIAL, spelled in the token's own `exp` — nothing is
    // fetched and nothing may be. `mintToken` writes a past `exp`, `decodeExp`
    // reads it back at hydration, and the chip renders the consequence.
    const c = makeSession({ id: 'user-c', username: 'cai', refreshTtlSeconds: -60 })
    seedSessions([a, b, c], a.userId)

    renderChip()
    openPopover()

    expect(screen.getByLabelText('ana, active account')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Switch to bo' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'cai, session expired — sign in again' }),
    ).toBeTruthy()
    // The visible half agrees with the accessible half.
    expect(screen.getByText('Session expired — sign in again')).toBeTruthy()
  })

  it('an expired row re-authorises rather than switching to a dead session', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const c = makeSession({ id: 'user-c', username: 'cai', refreshTtlSeconds: -60 })
    seedSessions([a, c], a.userId)

    renderChip()
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'cai, session expired — sign in again' }))

    // AC-4.4's surface, pre-filled. Switching TO cai would have handed the user
    // an account whose very next request 401s them straight back out.
    expect(locationNow()).toBe('/account/add?username=cai')
    expect(useAuthStore.getState().activeUserId).toBe(A)
  })
})

describe('B21 — the active account is not offered as a switch target', () => {
  it('renders the active row as a non-interactive row, and clicking it goes nowhere', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], a.userId)

    renderChip('/desk')
    openPopover()
    expect(screen.getByText('desk-page')).toBeTruthy()

    // Not a button at all — the element type IS the affordance.
    expect(screen.queryByRole('button', { name: 'ana, active account' })).toBeNull()

    // And the click is inert. `useSwitchAccount()` still redirects
    // unconditionally per AC-3.6 — this row simply never calls it, which is
    // the fix B21 asked for and the one the hook's own comment names.
    fireEvent.click(screen.getByLabelText('ana, active account'))
    expect(locationNow()).toBe('/desk')
    expect(screen.getByText('desk-page')).toBeTruthy()
  })

  it('a background row still switches, and still redirects', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], a.userId)

    renderChip('/desk')
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to bo' }))

    expect(useAuthStore.getState().activeUserId).toBe(B)
    // AC-3.6's redirect, then LandingRedirect's decision for bo (who has an
    // assistant) — the URL never stays on the outgoing account's page.
    expect(screen.getByText('desk-page')).toBeTruthy()
    expect(useAuthStore.getState().sessions).toHaveLength(2)
  })
})

describe('AC-4.6 — an account with no assistant lands on /welcome', () => {
  it('switching to a freshly-created account does NOT land on a broken /desk', () => {
    const a = makeSession({ id: A, username: 'ana' })
    // What a brand-new account looks like: verified, signed in, no assistant
    // linked yet. Easy to miss precisely because every hand-made test account
    // has one.
    const fresh = makeSession({ id: 'user-n', username: 'nia', assistantAgentId: null })
    seedSessions([a, fresh], a.userId)
    expect(useAuthStore.getState().sessions[1].user.assistant_agent_id).toBeUndefined()

    renderChip('/desk')
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to nia' }))

    expect(screen.getByText('welcome-page')).toBeTruthy()
    expect(screen.queryByText('desk-page')).toBeNull()
  })

  it('and the control: an account WITH an assistant still lands on /desk', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], a.userId)

    renderChip('/welcome')
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to bo' }))

    expect(screen.getByText('desk-page')).toBeTruthy()
  })
})

describe('AC-4.3 — keyboard and screen reader', () => {
  it('traps Tab inside the popover and wraps at both ends', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], a.userId)

    renderChip()
    const dialog = openPopover()
    const stops = Array.from(dialog.querySelectorAll('button'))
    expect(stops.length).toBeGreaterThan(1)

    // Opening moves focus INTO the popover — a popover you have to hunt for
    // with the keyboard is not keyboard accessible.
    expect(document.activeElement).toBe(stops[0])

    // Forward off the end wraps to the front rather than escaping to the page
    // behind an overlay that is still painted over it.
    stops[stops.length - 1].focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(stops[0])

    // And backwards off the front wraps to the end.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(stops[stops.length - 1])
  })

  it('Escape closes and RESTORES focus to the chip', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)

    renderChip()
    const trigger = screen.getByRole('button', { name: /signed in as ana/ })
    openPopover()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Accounts' })).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // Released focus is not restored focus: without this the keyboard user is
    // dropped at the top of the document with no idea where they were.
    expect(document.activeElement).toBe(trigger)
  })

  it('arrow keys walk the rows', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], a.userId)

    renderChip()
    const dialog = openPopover()
    const stops = Array.from(dialog.querySelectorAll('button'))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(stops[1])
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(stops[0])
  })

  it('labels distinguish "active" from "expired" for a screen reader', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const c = makeSession({ id: 'user-c', username: 'cai', refreshTtlSeconds: -60 })
    seedSessions([a, c], a.userId)

    renderChip()
    openPopover()

    // Two different words in two different rows, and neither row's accessible
    // name leaves the reader to infer the state from a colour.
    expect(screen.getByLabelText('ana, active account')).toBeTruthy()
    expect(screen.getByLabelText('cai, session expired — sign in again')).toBeTruthy()
  })
})

describe('the popover’s own actions', () => {
  it('"Add another account" reaches AC-4.4’s surface with no pre-fill', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)

    renderChip()
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Add another account' }))

    expect(locationNow()).toBe('/account/add')
    expect(useAuthStore.getState().sessions).toHaveLength(1)
  })

  it('keeps Settings reachable — the thing the replaced avatar existed for', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)

    renderChip()
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Account settings' }))

    expect(screen.getByText('settings-page')).toBeTruthy()
  })

  it('signs out of the ACTIVE account only, naming it when there is more than one', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: B, username: 'bo' })
    seedSessions([a, b], a.userId)

    renderChip()
    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of ana' }))

    // AC-3.2: scoped, not a teardown — bo is untouched and now active.
    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([B])
    expect(useAuthStore.getState().activeUserId).toBe(B)
  })

  it('reads "Sign out" unqualified for a single-account user', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)

    renderChip()
    openPopover()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })
})

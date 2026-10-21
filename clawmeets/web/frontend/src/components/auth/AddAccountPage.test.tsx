import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('../../api/endpoints/auth', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loginUser: vi.fn(), startOAuth: vi.fn() }
})

import AddAccountPage from './AddAccountPage'
import { AuthContractError, loginUser } from '../../api/endpoints/auth'
import { useAuthStore } from '../../stores/authStore'
import { makeSession, payloadFor, seedSessions } from '../../test/authFixtures'

/**
 * AC-4.4 — the add-account surface, and B23's render half.
 *
 * The two things this file exists to hold down:
 *
 *  1. ADDING MUST NOT DROP. Every failure mode of this form — a wrong password,
 *     a 429, a dead network, a failed OAuth round trip — has to leave the
 *     accounts already in the bag exactly where they were. That is the whole
 *     difference between this surface and `LoginPage`, which reuses the same
 *     fields and whose failure path deliberately clears everything.
 *  2. B23. A failed 'add'-mode OAuth parks its message in `authStore.error` and
 *     routes here. If this form did not render that field on its FIRST paint —
 *     no click, no submit — the user would come back from Google to a sidebar
 *     that looked exactly as it had when they left, with no explanation.
 */

const A = 'user-a'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>
}

function renderAt(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/account/add${search}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/account/add" element={<AddAccountPage />} />
        <Route path="/" element={<div>app-root</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function submit(identifier: string, password: string) {
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: identifier } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  seedSessions([])
  vi.mocked(loginUser).mockReset()
})

afterEach(() => {
  cleanup()
  seedSessions([])
})

describe('AC-4.4 — credential login in \'add\' mode', () => {
  it('adds the account ALONGSIDE the existing one and makes it active', async () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)
    const b = makeSession({ id: 'user-b', username: 'bo' })
    vi.mocked(loginUser).mockResolvedValue(payloadFor(b))

    renderAt()
    submit('bo', 'pw')

    await waitFor(() =>
      expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([A, 'user-b']),
    )
    // THE ASSERTION THE CRITERION IS ABOUT: "without dropping existing
    // sessions". ana is still signed in, with her own tokens intact.
    expect(useAuthStore.getState().sessions[0].accessToken).toBe(a.accessToken)
    expect(useAuthStore.getState().activeUserId).toBe('user-b')
    // `useSwitchAccount()` owns the redirect (AC-3.2 / AC-3.6), so the surface
    // does not linger over an account it has already left.
    await waitFor(() => expect(screen.getByText('app-root')).toBeTruthy())
  })

  it('takes a `username` pre-fill — the prop AC-3.3’s add branch routes to', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)

    renderAt('?username=xavier')

    expect((screen.getByLabelText('Username or email') as HTMLInputElement).value).toBe('xavier')
    // The pre-fill is the identifier and NOTHING else — a surface that
    // pre-filled a password would be a surface that had one to pre-fill.
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  })

  it('a WRONG PASSWORD does not sign you out of the account you already have', async () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'nope', null),
    )

    renderAt()
    submit('bo', 'wrong')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy())
    // In 'replace' mode this same store call clears `sessions` outright. It is
    // the mode, spelled at this call site, that keeps ana signed in.
    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([A])
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().error).toBeTruthy()
  })

  it('validates empty fields without going near the server', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)

    renderAt()
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))

    expect(loginUser).not.toHaveBeenCalled()
    expect(screen.getByText(/Enter the username or email and password/)).toBeTruthy()
  })

  it('offers the OAuth half of "add another account" too (AC-3.1)', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)

    renderAt()
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeTruthy()
  })

  it('Cancel leaves every session exactly as it was', () => {
    const a = makeSession({ id: A, username: 'ana' })
    const b = makeSession({ id: 'user-b', username: 'bo' })
    seedSessions([a, b], a.userId)

    renderAt()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([A, 'user-b'])
    expect(useAuthStore.getState().activeUserId).toBe(A)
  })
})

describe('B23 — a failed \'add\'-mode OAuth is no longer silent', () => {
  it('renders the message the callback parked in the store, on the FIRST paint', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)
    // Exactly what `OAuthCallbackPage`'s add-failure branch leaves behind
    // before routing here: a message in the store's own `error`, and the user
    // still signed in as before.
    useAuthStore.getState().setError('We could not complete that sign-in. Please try again.')

    renderAt()

    // No click, no submit — the user has just been redirected back from a third
    // party and the first thing this surface owes them is the reason.
    expect(screen.getByText('We could not complete that sign-in. Please try again.')).toBeTruthy()
    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([A])
  })

  it('does not clear the parked message on mount', () => {
    const a = makeSession({ id: A, username: 'ana' })
    seedSessions([a], a.userId)
    useAuthStore.getState().setError('Something went wrong.')

    renderAt()

    // An on-mount clear would delete the one thing the OAuth round trip carried
    // back, and the failure would go silent again by a different route.
    expect(useAuthStore.getState().error).toBe('Something went wrong.')
  })
})

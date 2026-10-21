import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// `fireEvent`, not `@testing-library/user-event` — the latter is not a
// dependency of this project and M3 adds none.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useNavigate: () => navigateMock }
})
vi.mock('../../api/endpoints/auth', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, verifyEmail: vi.fn() }
})

import VerifyEmailPage from './VerifyEmailPage'
import { verifyEmail } from '../../api/endpoints/auth'
import { useAuthStore } from '../../stores/authStore'
import { makeSession, seedSessions } from '../../test/authFixtures'

/**
 * AC-3.3 — THE TARGET IS COMPUTED AGAINST THE WHOLE SESSION LIST.
 *
 * The defect this replaces, in the plan's own words: sessions [Y active, Z] with
 * a verification link for X. The page said "signed in as Y, sign out to continue
 * as X", the button said "Sign out and sign in as X", and the handler dropped Y,
 * fell back to Z and rendered as Z — having thrown away a live session it had no
 * reason to drop, and having named an account it never reached.
 *
 * Note the mechanism these cases turn on: the match is on `username`, not `id`.
 * `verifyEmail` returns the name the server verified and nothing else; the page
 * never holds X's id.
 */

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/verify-email?token=T']}>
      <VerifyEmailPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  navigateMock.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  seedSessions([])
})

afterEach(() => {
  cleanup()
  seedSessions([])
})

describe('X is already signed in, backgrounded', () => {
  it('switches to X and logs NOBODY out', async () => {
    const y = makeSession({ id: 'user-y', username: 'yolanda' })
    const x = makeSession({ id: 'user-x', username: 'xavier' })
    seedSessions([y, x], y.userId)
    vi.mocked(verifyEmail).mockResolvedValue({ message: 'Verified.', username: 'xavier' })

    renderPage()
    const button = await screen.findByRole('button', { name: 'Switch to xavier' })
    fireEvent.click(button)

    const state = useAuthStore.getState()
    // Both sessions survive; only WHICH ONE IS ACTIVE changed.
    expect(state.sessions.map((s) => s.userId)).toEqual(['user-y', 'user-x'])
    expect(state.activeUserId).toBe('user-x')
    // useSwitchAccount owns (switch + navigate), so the page does not navigate
    // itself — and the redirect still happens.
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
  })
})

describe('X is not signed in and other sessions remain', () => {
  it('logs nobody out and does not promise an account it cannot reach', async () => {
    const y = makeSession({ id: 'user-y', username: 'yolanda' })
    const z = makeSession({ id: 'user-z', username: 'zoe' })
    seedSessions([y, z], y.userId)
    vi.mocked(verifyEmail).mockResolvedValue({ message: 'Verified.', username: 'xavier' })

    renderPage()
    // The old copy said "Sign out and sign in as xavier" here and then delivered
    // zoe. Neither the promise nor the button may survive.
    //
    // B24 — CHANGED IN M4, and this is the 0.1d of AC-3.3 that was priced into
    // it. M3 could log nobody out but had nowhere to send the user, so the
    // button read "Sign in" and went home: true, and a dead end. AC-4.4's
    // surface exists now, so the button names the account again — and this time
    // it reaches it.
    const button = await screen.findByRole('button', { name: 'Sign in as xavier' })
    expect(screen.queryByText(/Sign out and sign in as/)).toBeNull()

    fireEvent.click(button)

    // THE ASSERTION THIS CASE EXISTS FOR: both live sessions are still here.
    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual(['user-y', 'user-z'])
    expect(useAuthStore.getState().activeUserId).toBe('user-y')
    // AC-4.4's surface, PRE-FILLED with the name the server just verified.
    expect(navigateMock).toHaveBeenCalledWith('/account/add?username=xavier', { replace: true })
  })
})

describe('exactly one session — today’s behaviour, byte-for-byte', () => {
  it('signs the single mismatched account out and goes home', async () => {
    const y = makeSession({ id: 'user-y', username: 'yolanda' })
    seedSessions([y], y.userId)
    vi.mocked(verifyEmail).mockResolvedValue({ message: 'Verified.', username: 'xavier' })

    renderPage()
    await screen.findByText(/You are currently signed in as/)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out and sign in as xavier' }))

    expect(useAuthStore.getState().sessions).toEqual([])
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
  })

  it('same-user re-verification just goes home, signing nobody out', async () => {
    const x = makeSession({ id: 'user-x', username: 'xavier' })
    seedSessions([x], x.userId)
    vi.mocked(verifyEmail).mockResolvedValue({ message: 'Verified.', username: 'xavier' })

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))

    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual(['user-x'])
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
  })

  it('signed out entirely: unchanged "Sign in" path', async () => {
    vi.mocked(verifyEmail).mockResolvedValue({ message: 'Verified.', username: 'xavier' })

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))

    expect(useAuthStore.getState().sessions).toEqual([])
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
  })
})

describe('a failed verification is untouched by any of this', () => {
  it('renders the failure and offers only the Back link', async () => {
    vi.mocked(verifyEmail).mockRejectedValue(new Error('Token expired'))
    seedSessions([makeSession({ id: 'user-y', username: 'yolanda' })], 'user-y')

    renderPage()
    await screen.findByText('Verification Failed')
    expect(screen.getByText('Token expired')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    await waitFor(() => expect(useAuthStore.getState().sessions).toHaveLength(1))
  })
})

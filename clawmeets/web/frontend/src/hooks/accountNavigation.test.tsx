import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useNavigate: () => navigateMock }
})

import { useLogout } from './useLogout'
import { useSwitchAccount } from './useSwitchAccount'
import { useAuthStore, LAST_LOGOUT_USER_KEY } from '../stores/authStore'
import { makeSession, seedSessions } from '../test/authFixtures'

/**
 * AC-3.2 / AC-3.6 — NAVIGATION OWNERSHIP IS SYMMETRIC AND IT BELONGS TO THE
 * HOOKS. `useSwitchAccount()` owns (switch + navigate); `useLogout()` owns (end
 * session + navigate); neither store action navigates.
 *
 * The outcome all of this exists to make unreachable: the URL still names the
 * DEPARTED account's project while the shell has re-rendered as the remaining
 * one — a spinner, then the flat grey "Project not found"
 * (`components/project/ProjectView.tsx:117-123`) after `retry: 1` doubles the
 * wait, inside a sidebar that already belongs to somebody else.
 */

beforeEach(() => {
  navigateMock.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  seedSessions([])
})

afterEach(() => {
  // `globals: false` in vitest.config.ts means testing-library's auto-cleanup
  // never registers, and a hook left mounted stays subscribed to the store.
  cleanup()
  seedSessions([])
})

const A = 'user-a'
const B = 'user-b'

function seedTwo() {
  const a = makeSession({ id: A })
  const b = makeSession({ id: B })
  seedSessions([a, b], a.userId)
  return { a, b }
}

describe('AC-3.2 — useLogout ends the ACTIVE session and falls back', () => {
  it('drops only the active account, re-points to the remaining one, and navigates', () => {
    const { b } = seedTwo()
    const { result } = renderHook(() => useLogout())

    act(() => result.current())

    const state = useAuthStore.getState()
    // Scoped, not a full teardown: B is untouched and still signed in.
    expect(state.sessions.map((s) => s.userId)).toEqual([B])
    expect(state.activeUserId).toBe(B)
    expect(state.isAuthenticated).toBe(true)
    expect(state.accessToken).toBe(b.accessToken)

    // AC-3.6: the URL moves off the departed account's page.
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })

    // AC-2.6: PostLoginRedirect is not tripped while a session remains.
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBeNull()
  })

  /**
   * The single-account path must be byte-for-byte what it was, and the NEGATIVE
   * assertion is the load-bearing one. `PostLoginRedirect` (`App.tsx:42-51`)
   * resumes the previous URL on a same-user re-login — "you were signed out,
   * here is the page you were on" — and an unconditional navigate to '/' would
   * silently delete that behaviour.
   */
  it('does NOT navigate when that was the last session, so the URL can be resumed', () => {
    const a = makeSession({ id: A })
    seedSessions([a], a.userId)
    const { result } = renderHook(() => useLogout())

    act(() => result.current())

    const state = useAuthStore.getState()
    expect(state.sessions).toEqual([])
    expect(state.isAuthenticated).toBe(false)
    expect(navigateMock).not.toHaveBeenCalled()
    // Full teardown still writes the resume key, exactly as before.
    expect(sessionStorage.getItem(LAST_LOGOUT_USER_KEY)).toBe(A)
  })

  it('reads the active session at CALL time, not at render time', () => {
    seedTwo()
    const { result } = renderHook(() => useLogout())
    // The active account moves after the handler was created — a background
    // session dying, or another surface switching.
    act(() => useAuthStore.getState().switchTo(B))

    act(() => result.current())

    // B was ended, not the A that was active when the handler was built.
    expect(useAuthStore.getState().sessions.map((s) => s.userId)).toEqual([A])
    expect(useAuthStore.getState().activeUserId).toBe(A)
  })
})

describe('AC-3.6 — useSwitchAccount navigates to / unconditionally', () => {
  it('switches and lands on a URL that belongs to the new account', () => {
    const { b } = seedTwo()
    const { result } = renderHook(() => useSwitchAccount())

    act(() => result.current(B))

    expect(useAuthStore.getState().activeUserId).toBe(B)
    expect(useAuthStore.getState().accessToken).toBe(b.accessToken)
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
  })

  /**
   * "Unconditionally" is the criterion's word and this is what it costs: the
   * store no-ops (nothing changed, so no cache clear and no epoch bump) and the
   * redirect still fires. Conditioning the navigate on whether the store decided
   * this counted as a switch is exactly the "which URLs are safe to keep"
   * reasoning AC-3.6 rules out.
   */
  it('still navigates when the target is already active, while the store no-ops', () => {
    seedTwo()
    const epoch = useAuthStore.getState().authEpoch
    const { result } = renderHook(() => useSwitchAccount())

    act(() => result.current(A))

    expect(useAuthStore.getState().authEpoch).toBe(epoch)
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
  })
})

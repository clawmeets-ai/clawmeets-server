import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the network layer so the store never hits fetch. loginWithCredentials is
// exercised only to prove it hydrates through the SAME setSession path OAuth uses.
vi.mock('../api/endpoints/auth', () => {
  // The store does `error instanceof AuthContractError`, so the mock must carry
  // a real class — not a stub — or the check throws at runtime.
  class AuthContractError extends Error {
    code: string
    field: string | null
    constructor(code: string, message: string, field: string | null) {
      super(message)
      this.name = 'AuthContractError'
      this.code = code
      this.field = field
    }
  }
  return { loginUser: vi.fn(), refreshSession: vi.fn(), AuthContractError }
})

import { useAuthStore } from './authStore'
import { AuthContractError, loginUser } from '../api/endpoints/auth'
import { useRunnerVersionStore } from './runnerVersionStore'
import { useAnnouncementStore } from './announcementStore'
import { seedSessions } from '../test/authFixtures'

// The byte-identical /auth/login + /auth/oauth/exchange payload.
const PAYLOAD = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user: { id: 'u1', username: 'bob' },
  assistant_agent_id: 'agent-1',
  assistant_agent_name: 'bob-assistant',
}

/**
 * AC-5.6 + followup B7.
 *
 * This used to null the MIRROR — `accessToken`/`refreshToken`/`user`/
 * `isAuthenticated` — and never touch `sessions` or `activeUserId`. Two things
 * were wrong with it, and only the second one showed up as a symptom:
 *
 *  1. It seeded a state production cannot reach. The mirror is DERIVED now; the
 *     next `syncActive()` recomputes it from `sessions[activeUserId]` and
 *     silently undoes the write. A fixture the code under test can undo is
 *     worse than no fixture.
 *  2. Session state therefore LEAKED between the cases in this file (B7). It
 *     was green only because every case that cares calls `setSession` first,
 *     which is a property of the current cases rather than of the fixture — the
 *     next case added here would have inherited the previous one's sessions.
 *
 * `seedSessions([])` runs the real `logout()`, which empties `sessions`, nulls
 * `activeUserId`, clears `error`/`errorCode` and reaches the mirror through
 * `syncActive()` — the same route the Logout button takes.
 *
 * `isLoading` is set separately and deliberately: it is not auth state, nothing
 * derives it, and `logout()` does not own it. AC-5.6 is about seeding AUTH by
 * writing the mirror, and this write claims no session.
 */
beforeEach(() => {
  seedSessions([])
  useAuthStore.setState({ isLoading: false })
})

describe('setSession (shared hydration path)', () => {
  it('maps a LoginResponse onto auth state', () => {
    useAuthStore.getState().setSession(PAYLOAD)
    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(true)
    expect(s.accessToken).toBe('access-1')
    expect(s.refreshToken).toBe('refresh-1')
    expect(s.error).toBeNull()
    expect(s.user).toMatchObject({
      id: 'u1',
      username: 'bob',
      assistant_agent_id: 'agent-1',
    })
    // created_at is synthesized (the payload carries none).
    expect(typeof s.user?.created_at).toBe('string')
  })
})

describe('loginWithCredentials', () => {
  it('routes password login through setSession (identical resulting state)', async () => {
    vi.mocked(loginUser).mockResolvedValue(PAYLOAD)
    const ok = await useAuthStore.getState().loginWithCredentials('bob', 'pw')
    expect(ok).toBe(true)
    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(true)
    expect(s.accessToken).toBe('access-1')
    expect(s.isLoading).toBe(false)
  })

  it('leaves the store unauthenticated on failure', async () => {
    vi.mocked(loginUser).mockRejectedValue(new Error('Invalid username or password'))
    const ok = await useAuthStore.getState().loginWithCredentials('bob', 'wrong')
    expect(ok).toBe(false)
    const s = useAuthStore.getState()
    expect(s.isAuthenticated).toBe(false)
    expect(s.accessToken).toBeNull()
    expect(s.error).toBe('Invalid username or password')
  })
})

// ===========================================================================
// MANDATORY TEST (d) — §4.8, the logout gap.
// ===========================================================================
//
// `logout()` clears every per-user store under the comment "Clear every
// per-user cache so nothing leaks into the next session". THERE IS NO PAGE
// RELOAD ANYWHERE IN THIS APP — it is a pure SPA transition — so a store left
// out of that list survives the session change IN MEMORY: user A logs out, user
// B logs in on the same browser, AppLayout remounts, and the banners render A's
// AGENT NAMES until B's first push lands. The pre-revert implementation missed
// exactly this, which is why the check is direct rather than incidental.
describe('logout resets BOTH new announcement stores (§4.8)', () => {
  it('clears runnerVersionStore and announcementStore', () => {
    localStorage.clear()
    useAuthStore.getState().setSession(PAYLOAD)
    useRunnerVersionStore.setState({
      runners: [{ id: 'a1', name: 'user-a-runner', version: '1.2.9' }],
    })
    useAnnouncementStore.setState({ dismissed: { 'upgrade-1-2-9': ['a1'] }, userId: 'u1' })

    useAuthStore.getState().logout()

    // Back to NEVER HYDRATED, not to `[]`: after a logout we genuinely have not
    // been told anything, whereas `[]` would assert "zero live runners".
    expect(useRunnerVersionStore.getState().runners).toBeNull()
    expect(useAnnouncementStore.getState().dismissed).toEqual({})
    expect(useAnnouncementStore.getState().userId).toBeNull()
  })

  it('leaves no agent NAME from the previous session in memory', () => {
    // The concrete leak this guards: A's agent names rendered to B.
    useAuthStore.getState().setSession(PAYLOAD)
    useRunnerVersionStore.setState({
      runners: [{ id: 'a1', name: 'alices-laptop-runner', version: null }],
    })

    useAuthStore.getState().logout()

    expect(JSON.stringify(useRunnerVersionStore.getState().runners))
      .not.toContain('alices-laptop-runner')
  })
})

// ===========================================================================
// AUTH_CONTRACT — the store's failure contract
// ===========================================================================
describe('loginWithCredentials failure contract', () => {
  it('records BOTH the display copy and the raw envelope code', async () => {
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'Invalid credentials', null),
    )
    const ok = await useAuthStore.getState().loginWithCredentials('ada', 'wrong')

    expect(ok).toBe(false)
    const s = useAuthStore.getState()
    expect(s.errorCode).toBe('invalid_credentials')
    // The message is messageForCode's, not the server's raw string.
    expect(s.error).toBe('Invalid credentials. Check your username or email and password.')
    expect(s.isAuthenticated).toBe(false)
    expect(s.accessToken).toBeNull()
    expect(s.user).toBeNull()
  })

  it('carries email_not_verified so the view can single that branch out', async () => {
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('email_not_verified', 'Email not verified.', null),
    )
    await useAuthStore.getState().loginWithCredentials('ada', 'pw')
    expect(useAuthStore.getState().errorCode).toBe('email_not_verified')
  })

  it('leaves errorCode null for a non-envelope failure (network down)', async () => {
    vi.mocked(loginUser).mockRejectedValue(new Error('Failed to fetch'))
    await useAuthStore.getState().loginWithCredentials('ada', 'pw')

    const s = useAuthStore.getState()
    expect(s.errorCode).toBeNull()
    expect(s.error).toBe('Failed to fetch')
  })

  it('setError clears a stale errorCode so a past 403 cannot re-style a later error', () => {
    useAuthStore.setState({ error: 'old', errorCode: 'email_not_verified' })
    useAuthStore.getState().setError('Enter your username or email and your password.')
    expect(useAuthStore.getState().errorCode).toBeNull()
  })

  it('clears errorCode on a subsequent success', async () => {
    useAuthStore.setState({ error: 'x', errorCode: 'invalid_credentials' })
    vi.mocked(loginUser).mockResolvedValue(PAYLOAD)
    await useAuthStore.getState().loginWithCredentials('ada', 'pw')
    expect(useAuthStore.getState().errorCode).toBeNull()
  })
})

describe('setSession nullability coercion (§10.2 item 1)', () => {
  it('hydrates a null assistant_agent_id as undefined', () => {
    useAuthStore.getState().setSession({ ...PAYLOAD, assistant_agent_id: null })
    expect(useAuthStore.getState().user?.assistant_agent_id).toBeUndefined()
  })

  it('passes a real assistant_agent_id through untouched', () => {
    useAuthStore.getState().setSession(PAYLOAD)
    expect(useAuthStore.getState().user?.assistant_agent_id).toBe('agent-1')
  })
})

describe('errorCode is not persisted', () => {
  it('is absent from the partialized state written to localStorage', () => {
    localStorage.clear()
    useAuthStore.setState({ errorCode: 'email_not_verified' })
    useAuthStore.getState().setSession(PAYLOAD)
    const persisted = localStorage.getItem('clawmeets-auth') ?? ''
    expect(persisted).not.toContain('errorCode')
  })
})

describe('the fixture is a real reset (followup B7)', () => {
  /**
   * This case deliberately does NOT sign in first. Under the old mirror-nulling
   * `beforeEach` it would have inherited whatever `sessions` the preceding case
   * left behind — every case above this one calls `setSession` — and the leak
   * was invisible precisely because no case ever looked.
   */
  it('starts each case with no sessions and no active user', () => {
    const s = useAuthStore.getState()
    expect(s.sessions).toEqual([])
    expect(s.activeUserId).toBeNull()
    expect(s.isAuthenticated).toBe(false)
    expect(s.accessToken).toBeNull()
  })
})

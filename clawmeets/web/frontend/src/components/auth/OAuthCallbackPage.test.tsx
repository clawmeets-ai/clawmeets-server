import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import OAuthCallbackPage, { OAUTH_ADD_FLAG, OAUTH_LINKED_FLAG } from './OAuthCallbackPage'
import { exchangeOAuthCode } from '../../api/endpoints/auth'
// followup B11. `vitest.config.ts` sets `globals: false`, so testing-library's
// auto-cleanup never registers: a render left standing here stays MOUNTED, and
// mounted means still subscribed to every store it reads and still holding
// every timer its effects started. The next file's fixture then re-renders it
// and re-fires those effects, in a file that has no idea this component exists.
// Audited suite-wide in M5; asserted by `src/test/suiteHygiene.test.ts`.
afterEach(cleanup)

// Hoisted so the vi.mock factories (hoisted above imports) can close over them.
const { navigateMock, setSessionMock, setErrorMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  setSessionMock: vi.fn(),
  setErrorMock: vi.fn(),
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (
    selector: (s: {
      setSession: typeof setSessionMock
      setError: typeof setErrorMock
    }) => unknown,
  ) => selector({ setSession: setSessionMock, setError: setErrorMock }),
}))

vi.mock('../../api/endpoints/auth', () => {
  class OAuthContractError extends Error {
    code: string
    field: string | null
    constructor(code: string, message: string, field: string | null) {
      super(message)
      this.name = 'OAuthContractError'
      this.code = code
      this.field = field
    }
  }
  return { exchangeOAuthCode: vi.fn(), OAuthContractError }
})

const PAYLOAD = {
  access_token: 'a',
  refresh_token: 'r',
  user: { id: 'u1', username: 'bob' },
  assistant_agent_id: 'agent-1',
}

function renderAt(search: string, strict = false) {
  const ui = (
    <MemoryRouter initialEntries={[`/auth/callback${search}`]}>
      <OAuthCallbackPage />
    </MemoryRouter>
  )
  return render(strict ? <StrictMode>{ui}</StrictMode> : ui)
}

beforeEach(() => {
  navigateMock.mockReset()
  setSessionMock.mockReset()
  setErrorMock.mockReset()
  vi.mocked(exchangeOAuthCode).mockReset()
  sessionStorage.clear()
})

describe('OAuthCallbackPage', () => {
  it('created: exchanges once, hydrates, routes to /welcome', async () => {
    vi.mocked(exchangeOAuthCode).mockResolvedValue(PAYLOAD)
    renderAt('?code=HANDOFF&status=created')

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/welcome', { replace: true }),
    )
    expect(exchangeOAuthCode).toHaveBeenCalledTimes(1)
    expect(exchangeOAuthCode).toHaveBeenCalledWith('HANDOFF')
    // The mode is now EXPLICIT at this call site (AC-3.1). Asserting on it is
    // the point: with no OAUTH_ADD_FLAG parked, an OAuth round trip must hydrate
    // as 'replace' — the byte-for-byte previous behaviour.
    expect(setSessionMock).toHaveBeenCalledWith(PAYLOAD, 'replace')
  })

  it('login: routes to / (app root)', async () => {
    vi.mocked(exchangeOAuthCode).mockResolvedValue(PAYLOAD)
    renderAt('?code=H&status=login')
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }))
    expect(sessionStorage.getItem(OAUTH_LINKED_FLAG)).toBeNull()
  })

  it('linked: routes to / and sets the one-time linked flag', async () => {
    vi.mocked(exchangeOAuthCode).mockResolvedValue(PAYLOAD)
    renderAt('?code=H&status=linked')
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }))
    expect(sessionStorage.getItem(OAUTH_LINKED_FLAG)).toBe('1')
  })

  it('no code: bounces to /login?error=NO_SESSION without exchanging', async () => {
    renderAt('?status=login')
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/login?error=NO_SESSION', { replace: true }),
    )
    expect(exchangeOAuthCode).not.toHaveBeenCalled()
  })

  it('exchange failure: redirects to /login?error=<CODE>', async () => {
    const { OAuthContractError } = await import('../../api/endpoints/auth')
    vi.mocked(exchangeOAuthCode).mockRejectedValue(
      new OAuthContractError('OAUTH_STATE_INVALID', 'msg', null),
    )
    renderAt('?code=BAD&status=login')
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/login?error=OAUTH_STATE_INVALID', {
        replace: true,
      }),
    )
    expect(setSessionMock).not.toHaveBeenCalled()
  })

  /**
   * AC-3.1 — THE 'add'-MODE ROUND TRIP.
   *
   * "This was an add, do not clobber the existing session" has to survive a full
   * browser navigation to a third party and back, which loses every scrap of
   * in-memory state. sessionStorage is the only thing left, and OAUTH_LINKED_FLAG
   * directly above is the existing precedent for the same trick.
   */
  describe("'add' mode survives the round trip", () => {
    it("hydrates as 'add' when the flag is parked, and clears it", async () => {
      sessionStorage.setItem(OAUTH_ADD_FLAG, '1')
      vi.mocked(exchangeOAuthCode).mockResolvedValue(PAYLOAD)
      renderAt('?code=H&status=login')

      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }))
      expect(setSessionMock).toHaveBeenCalledWith(PAYLOAD, 'add')
      // Read-and-cleared: a flag left standing turns the NEXT ordinary sign-in
      // into a silent add.
      expect(sessionStorage.getItem(OAUTH_ADD_FLAG)).toBeNull()
    })

    it('a FAILED add lands on the add surface, which is the thing that shows the error', async () => {
      const { OAuthContractError } = await import('../../api/endpoints/auth')
      sessionStorage.setItem(OAUTH_ADD_FLAG, '1')
      vi.mocked(exchangeOAuthCode).mockRejectedValue(
        new OAuthContractError('OAUTH_STATE_INVALID', 'msg', null),
      )
      renderAt('?code=BAD&status=login')

      // B23 — CHANGED IN M4, DELIBERATELY. M3 asserted `'/'` here, because
      // AC-4.4's surface did not exist yet and there was nowhere better to go.
      // Landing on '/' meant the user came back from the provider to a sidebar
      // that looked exactly as it had when they left — no new account, no
      // explanation — while the message sat in `error` with nothing rendering
      // it. `/account/add` reads that field on its first paint.
      await waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith('/account/add', { replace: true }),
      )
      // Still NOT /login: the user is authenticated, so App.tsx would bounce
      // /login straight to '/' and swallow the ?error= code in transit.
      expect(navigateMock).not.toHaveBeenCalledWith(
        '/login?error=OAUTH_STATE_INVALID',
        { replace: true },
      )
      // The message survives, in the field AC-4.4's add surface renders.
      expect(setErrorMock).toHaveBeenCalledTimes(1)
      expect(setErrorMock.mock.calls[0][0]).toEqual(expect.any(String))
      // A failed add must not sign you out of the account you already have.
      expect(setSessionMock).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(OAUTH_ADD_FLAG)).toBeNull()
    })
  })

  it('exchanges exactly once under StrictMode (single-use handoff guard)', async () => {
    vi.mocked(exchangeOAuthCode).mockResolvedValue(PAYLOAD)
    renderAt('?code=ONCE&status=login', true)
    await waitFor(() => expect(navigateMock).toHaveBeenCalled())
    expect(exchangeOAuthCode).toHaveBeenCalledTimes(1)
  })
})

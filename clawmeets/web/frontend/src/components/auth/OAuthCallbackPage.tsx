// Runs at /app/auth/callback — the backend's Option-A handoff target. Reads the
// single-use ?code and informational ?status, does exactly one
// POST /auth/oauth/exchange {code}, hydrates the auth store through the SAME
// setSession path password login uses (the exchange returns the byte-identical
// /auth/login payload), then routes on status. Tokens only ever live in the XHR
// response body — never the URL, history, or a JS-readable cookie.
//
// Exactly-once: a useRef guard defeats BOTH React.StrictMode's double-mount
// effect in dev AND any accidental replay of the single-use handoff code.

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { exchangeOAuthCode, OAuthContractError } from '../../api/endpoints/auth'
import { useAuthStore } from '../../stores/authStore'
import AuthShell, { AuthCard, BrandHeader } from './AuthShell'
import { messageForCode } from './oauthErrors'

// One-time "account linked" reassurance flag, read-and-cleared by the app shell
// on the first authenticated render.
export const OAUTH_LINKED_FLAG = 'clawmeets:oauth-linked'

/**
 * "THIS OAUTH ROUND TRIP IS AN ADD, NOT A SIGN-IN" (AC-3.1).
 *
 * Set by `ProviderButtons` in 'add' mode immediately before the full-page
 * navigation to the provider; read and cleared here on the way back. It has to
 * live in `sessionStorage` because the round trip is a real browser navigation
 * to a third party and back — every scrap of in-memory state is gone by the time
 * this component mounts, and the ONE thing that must survive is "do not clobber
 * the sessions already in the bag". `OAUTH_LINKED_FLAG` directly above is the
 * existing precedent for exactly this trick.
 *
 * sessionStorage, not localStorage: the flag is scoped to the tab that started
 * the flow, and a stale one must not outlive the browser session and turn a
 * later ordinary sign-in into a silent add.
 */
export const OAUTH_ADD_FLAG = 'clawmeets:oauth-add'

/** Read-and-clear, in one call, so no path can consume the flag twice or leave
 *  it standing for the next sign-in. Cleared even on the failure branch. */
function takeAddFlag(): boolean {
  try {
    const raw = sessionStorage.getItem(OAUTH_ADD_FLAG)
    sessionStorage.removeItem(OAUTH_ADD_FLAG)
    return raw === '1'
  } catch {
    // Safari private mode throws on storage access. Degrading to 'replace' is
    // the safe direction: the user ends up signed in as the account they just
    // authorized, which is what they asked for either way.
    return false
  }
}

// status -> in-flight copy while the exchange XHR is outstanding.
function statusCopy(status: string | null): string {
  switch (status) {
    case 'created':
      return 'Setting up your account…'
    case 'linked':
      return 'Linked your account — taking you in…'
    default:
      return 'Signing you in…'
  }
}

export default function OAuthCallbackPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const setSession = useAuthStore((s) => s.setSession)
  const setError = useAuthStore((s) => s.setError)
  const ran = useRef(false)
  const [status] = useState<string | null>(() => params.get('status'))

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const code = params.get('code')
    // No code -> nothing to exchange; bounce to Login with a NO_SESSION notice.
    if (!code) {
      navigate('/login?error=NO_SESSION', { replace: true })
      return
    }

    const currentStatus = params.get('status')
    // Read-and-cleared ONCE, here, before the await — so both the success and
    // the failure branch below see the same answer and neither can leave the
    // flag standing for a later sign-in.
    const isAdd = takeAddFlag()
    void (async () => {
      try {
        const payload = await exchangeOAuthCode(code)
        // THE SAME single hydration path password login uses, with the mode the
        // round trip carried back (AC-3.1). 'add' upserts and hands activation
        // to switchTo — which is what clears the cache, resets the per-user
        // stores and bumps the epoch. There is exactly one implementation of
        // "make this account active" and this is not a second one.
        setSession(payload, isAdd ? 'add' : 'replace')
        if (currentStatus === 'linked') {
          sessionStorage.setItem(OAUTH_LINKED_FLAG, '1')
        }
        // Brand-new accounts land on onboarding; everyone else on the app root,
        // where LandingRedirect decides desk-vs-welcome. Both routes live in the
        // authenticated tree that renders once setSession flips isAuthenticated.
        // An 'add' lands on '/' for the same reason a switch does (AC-3.6): the
        // URL that started this flow belonged to the PREVIOUS account.
        navigate(currentStatus === 'created' ? '/welcome' : '/', { replace: true })
      } catch (err) {
        const errorCode = err instanceof OAuthContractError ? err.code : 'OAUTH_EXCHANGE_FAILED'
        if (isAdd) {
          // A FAILED ADD MUST NOT SIGN YOU OUT of the account you already have,
          // and it must not strand you on /login either: the user is still
          // authenticated, so App.tsx would bounce /login straight to '/' and
          // the ?error= code would be swallowed in transit — a silent failure.
          //
          // So the message goes into the store's own `error`, which is the field
          // AC-4.4's add-account surface renders (it reuses AuthShell's fields,
          // the same ones LoginPage reads `error` for).
          setError(messageForCode(errorCode))
          // B23 — AND THE ROUTE IS `/account/add`, NOT `/`. Storing the message
          // was only half of it: M3 landed the user back on '/' with a sidebar
          // that looked exactly as it had before they left, no new account and
          // no explanation, while the message sat in a field nothing rendered.
          // The add surface reads `error` on its FIRST render, so routing there
          // turns a silent failure into "here is the form again, and here is
          // what went wrong" — still signed in as before, nothing dropped.
          navigate('/account/add', { replace: true })
          return
        }
        navigate(`/login?error=${encodeURIComponent(errorCode)}`, { replace: true })
      }
    })()
    // Intentionally run once on mount; the ref guard covers StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AuthShell>
      <AuthCard>
        <BrandHeader subtitle="One moment" />
        <div
          className="flex items-center justify-center gap-2.5"
          style={{ color: 'var(--ink-2)', fontSize: 14 }}
        >
          <span
            className="w-4 h-4 border-2 rounded-full animate-spin"
            style={{ borderColor: 'var(--line-2)', borderTopColor: 'var(--accent)' }}
          />
          {statusCopy(status)}
        </div>
      </AuthCard>
    </AuthShell>
  )
}

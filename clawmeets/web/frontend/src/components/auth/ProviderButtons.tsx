// Google + GitHub "Continue with …" buttons, shared by the Login and Signup
// cards. Click -> POST /auth/oauth/{provider}/start {code?} -> full-page nav to
// the returned authorization_url. The optional `code` is passed straight through
// to start(): present on Signup (invite-gated), absent on Login (pure sign-in).
// `disabled` gates the Signup path until the invite validates. A /start failure
// keeps the user on the page and renders inline via messageForCode.

import { useState } from 'react'
import { OAuthContractError, startOAuth } from '../../api/endpoints/auth'
import type { OAuthProvider } from '../../types'
import { ProviderButton } from './AuthShell'
import { OAUTH_ADD_FLAG } from './OAuthCallbackPage'
import { messageForCode } from './oauthErrors'

const PROVIDERS: { id: OAuthProvider; label: string }[] = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'github', label: 'Continue with GitHub' },
]

interface ProviderButtonsProps {
  code?: string // invite code, passed to start() on Signup; omitted on Login
  username?: string // chosen slug, passed to start() on Signup; omitted on Login
  disabled?: boolean // Signup gates buttons until the invite validates
  /** 'add' = "add another account": keep the sessions already signed in and
   *  upsert this one alongside them (AC-3.1). Defaults to 'replace', which is
   *  Login's and Signup's behaviour and is unchanged. */
  mode?: 'replace' | 'add'
}

export function ProviderButtons({
  code,
  username,
  disabled = false,
  mode = 'replace',
}: ProviderButtonsProps) {
  const [pendingProvider, setPendingProvider] = useState<OAuthProvider | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async (provider: OAuthProvider) => {
    setError(null)
    setPendingProvider(provider)
    try {
      const { authorization_url } = await startOAuth(provider, code || undefined, username || undefined)
      // PARK THE MODE BEFORE NAVIGATING AWAY (AC-3.1). The line below is a real
      // browser navigation to a third party; nothing in memory survives it, and
      // `OAuthCallbackPage` mounts in a fresh JS context with only the URL and
      // storage to go on. Written after /start succeeds and before the assign,
      // so a /start failure — which keeps the user on this page — never leaves a
      // stale flag behind to turn a later sign-in into a silent add.
      //
      // Guarded because Safari private mode throws on setItem. A throw here
      // would abort the whole flow; degrading to 'replace' at least signs the
      // user in as the account they authorized.
      if (mode === 'add') {
        try {
          sessionStorage.setItem(OAUTH_ADD_FLAG, '1')
        } catch {
          // Storage unavailable: the round trip will read no flag and hydrate as
          // 'replace'. Noted rather than swallowed silently.
        }
      }
      // Full-page navigation to the provider (NOT an XHR follow) so the browser
      // owns the redirect and the HttpOnly oauth_login_state cookie is in play.
      window.location.assign(authorization_url)
      // Intentionally leave pendingProvider set — the page is navigating away.
    } catch (err) {
      setPendingProvider(null)
      const code = err instanceof OAuthContractError ? err.code : 'OAUTH_EXCHANGE_FAILED'
      setError(messageForCode(code, provider))
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2.5" role="group" aria-label="Choose a sign-in provider">
        {PROVIDERS.map(({ id, label }) => (
          <ProviderButton
            key={id}
            provider={id}
            label={label}
            busy={pendingProvider === id}
            disabled={disabled || pendingProvider !== null}
            onClick={() => void start(id)}
          />
        ))}
      </div>
      {error && (
        <p role="alert" style={{ color: 'var(--prio-urgent-fg)', fontSize: 13 }}>
          {error}
        </p>
      )}
    </div>
  )
}

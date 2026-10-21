import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import AuthShell, {
  AuthCard,
  BrandHeader,
  ErrorNotice,
  Field,
  InfoNotice,
  InlineSpinner,
  OrDivider,
  PrimaryButton,
} from './AuthShell'
import { ProviderButtons } from './ProviderButtons'
import { messageForCode } from './oauthErrors'

// Sign-in form: ONE identifier input (a username OR an email), one password
// input, one submit button. No second field, no toggle, no mode switch — the
// client never tells the server which kind of identifier it sent.
export default function LoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const { loginWithCredentials, isLoading, error, errorCode, setError } = useAuthStore()
  const [params] = useSearchParams()

  // The backend failure redirect (/app/login?error=<CODE>) and the callback's
  // own bounce land here. Map the code to copy via the shared messageForCode —
  // the same source of truth the JSON error path uses. Runs once on mount.
  useEffect(() => {
    const code = params.get('error')
    if (code) setError(messageForCode(code))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Validation is EMPTY-ONLY (AUTH_CONTRACT ruling 4). The client does NOT
  // branch on email-vs-username and shows NO format hint: a garbage identifier
  // ("!!!", "a@b") is submitted and comes back 401 invalid_credentials, because
  // the server owns that verdict and a client-side "that's not a valid
  // username" would itself be a shape oracle.
  //
  // password is tested with === '' (length zero), NOT !password.trim(): a
  // password of "   " is legitimate — whitespace is significant — and must
  // reach the server. Same reason the send below passes it verbatim.
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (identifier.trim() === '' || password === '') {
      setError('Enter your username or email and your password.')
      return
    }
    // 'replace' is EXPLICIT, not left to the default (AC-3.1). This page is the
    // sign-in surface: reaching it means the app is unauthenticated, and any
    // session state still in the bag is stale and must go. The "add another
    // account" surface (AC-4.4) is the one that passes 'add', and the two are
    // easy to confuse precisely because they reuse these same fields — so the
    // mode is spelled at both call sites rather than at one.
    await loginWithCredentials(identifier.trim(), password, 'replace')
  }

  return (
    <AuthShell>
      <AuthCard>
        <BrandHeader subtitle="Sign in to continue" />

        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          {/* The autoComplete token stays "username" — the HTML spec's
              username token covers an email address used as a sign-in
              identifier, and there is no token that means "either". */}
          <Field
            id="identifier"
            label="Username or email"
            value={identifier}
            onChange={setIdentifier}
            placeholder="Enter your username or email"
            autoFocus
            autoComplete="username"
          />

          <Field
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Enter your password"
            autoComplete="current-password"
          />

          {/* 403 email_not_verified is the ONE branch that renders distinctly
              (§4.2) — it is actionable. Every other failure (401, 400, 429, a
              network error) shares one red notice with generic copy, so the
              four §4.1 cases are indistinguishable in the DOM. The envelope's
              `field` is never used to mark an input on a failed sign-in. */}
          {error &&
            (errorCode === 'email_not_verified' ? (
              <InfoNotice>{error}</InfoNotice>
            ) : (
              <ErrorNotice>{error}</ErrorNotice>
            ))}

          <div className="mt-1">
            <PrimaryButton type="submit" disabled={isLoading}>
              {isLoading ? <InlineSpinner label="Signing in..." /> : 'Sign in'}
            </PrimaryButton>
          </div>

          <OrDivider />

          {/* No invite code -> pure sign-in (the backend treats a start() with
              no code as returning-user login). */}
          <ProviderButtons />

          <p
            className="text-center mt-2"
            style={{ color: 'var(--ink-3)', fontSize: 13 }}
          >
            Don't have an account?{' '}
            <Link
              to="/signup"
              className="font-bold"
              style={{ color: 'var(--accent)' }}
            >
              Sign up
            </Link>
          </p>
        </form>
      </AuthCard>
    </AuthShell>
  )
}

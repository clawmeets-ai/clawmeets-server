import { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Check, X } from 'lucide-react'
import { verifyEmail } from '../../api/endpoints/auth'
import { useAuthStore } from '../../stores/authStore'
import { useSwitchAccount } from '../../hooks/useSwitchAccount'
import { useLogout } from '../../hooks/useLogout'
import { BrandName } from '../common'

/**
 * THE TARGET IS COMPUTED AGAINST THE WHOLE SESSION LIST, NOT THE ACTIVE ONE
 * (AC-3.3).
 *
 * This page used to ask a single-session question — "is the signed-in user
 * someone other than X?" — and answer it with `logout()`, which dropped
 * EVERYTHING. With N sessions in the bag that is wrong twice over. Sessions
 * [Y active, Z] and a verification link for X: the page said "signed in as Y,
 * sign out to continue as X", the button said "Sign out and sign in as X", and
 * the handler dropped Y, fell back to Z and rendered as Z — having thrown away a
 * live session it had no reason to drop, and having named an account it never
 * reached.
 *
 * THE MATCH IS ON `username`, NOT `id`, and that is forced rather than chosen:
 * `verifyEmail` returns the name the server verified and nothing else. The page
 * never holds X's id. `Session.user.username` is the only comparable field.
 *
 * X MAY ALREADY BE IN THE BAG. Verification is not sign-in: a user can hold a
 * pre-verification session for X, open the link from their mail client, and land
 * here with X sitting backgrounded. That is the `switchTo` case, and it logs
 * nobody out.
 */

/** What the page can do about the newly-verified account, given who is signed
 *  in. Named rather than inlined because the copy, the button label and the
 *  handler must all agree, and three independent ternaries is how they stop
 *  agreeing. */
type Resolution =
  /** X is the active account already (or nobody is signed in at all). Today's
   *  behaviour, byte-for-byte: go home. */
  | { kind: 'continue' }
  /** X is signed in but backgrounded. Activate it; log nobody out. */
  | { kind: 'switch'; userId: string }
  /** X is not signed in and is the ONLY session. Today's behaviour,
   *  byte-for-byte: full logout, then home. */
  | { kind: 'signout' }
  /** X is not signed in and other sessions remain. Log NOBODY out — dropping a
   *  live account to make room for one that is not even signed in is the exact
   *  defect AC-3.3 exists to close. Routes to AC-4.4's add-account surface,
   *  PRE-FILLED with `username`.
   *
   *  B24 — THIS IS THE HALF OF AC-3.3 THAT WAS PRICED INTO M4. M3 could log
   *  nobody out but had nowhere to send the user, so the page stated the
   *  situation and offered "Continue" — true, and a dead end. `/account/add`
   *  exists now, so the statement becomes the route: one click, the identifier
   *  field already carrying the name the server just verified, and both live
   *  sessions still in the bag behind it. */
  | { kind: 'add'; username: string }

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const switchAccount = useSwitchAccount()
  const logout = useLogout()
  const token = searchParams.get('token')
  const currentUser = useAuthStore((s) => s.user)
  // `listSessions()` returns the store's own `sessions` array by reference, so
  // this selector is referentially stable and re-runs only when the bag changes.
  const sessions = useAuthStore((s) => s.listSessions())
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [username, setUsername] = useState('')

  const target = username ? sessions.find((s) => s.user.username === username) : undefined
  const resolution: Resolution =
    target !== undefined
      ? target.user.id === currentUser?.id
        ? { kind: 'continue' }
        : { kind: 'switch', userId: target.userId }
      : sessions.length === 1
        ? { kind: 'signout' }
        : sessions.length === 0
          ? { kind: 'continue' }
          : { kind: 'add', username }

  const handleSignIn = () => {
    switch (resolution.kind) {
      case 'switch':
        // useSwitchAccount owns (switch + navigate) — including the redirect to
        // '/', which is why this branch does not navigate itself.
        switchAccount(resolution.userId)
        return
      case 'signout':
        // useLogout owns (end session + navigate). With exactly one session it
        // does not navigate — the full teardown flips isAuthenticated and App.tsx
        // renders the unauthenticated tree — so the navigate below still runs and
        // still lands on '/', exactly as before.
        logout()
        navigate('/', { replace: true })
        return
      case 'add':
        // B24 / AC-3.3 — the branch's real destination. `replace: true` so Back
        // from the add surface does not re-enter a verification link whose
        // single-use token the server has already consumed.
        navigate(`/account/add?username=${encodeURIComponent(resolution.username)}`, {
          replace: true,
        })
        return
      default:
        navigate('/', { replace: true })
    }
  }

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage('No verification token provided.')
      return
    }

    verifyEmail(token)
      .then((result) => {
        setStatus('success')
        setMessage(result.message)
        setUsername(result.username)
      })
      .catch((err) => {
        setStatus('error')
        setMessage(err instanceof Error ? err.message : 'Verification failed')
      })
  }, [token])

  const buttonLabel =
    resolution.kind === 'signout'
      ? `Sign out and sign in as ${username}`
      : resolution.kind === 'switch'
        ? `Switch to ${username}`
        : resolution.kind === 'add'
          ? `Sign in as ${username}`
          : 'Sign in'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-sidebar to-purple-900">
      <div className="w-full max-w-md px-4">
        <div className="bg-white rounded-lg shadow-xl p-8 text-center">
          <h1 className="text-2xl font-bold mb-6"><BrandName className="text-gray-900" /></h1>

          {status === 'loading' && (
            <div className="space-y-4">
              <div className="w-12 h-12 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin mx-auto" />
              <p className="text-gray-600">Verifying your email...</p>
            </div>
          )}

          {status === 'success' && (
            <div className="space-y-6">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                <Check className="w-8 h-8 text-green-600" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Email Verified</h2>
                <p className="text-gray-600">
                  {username ? `Welcome, ${username}! ` : ''}{message}
                </p>
                {resolution.kind === 'signout' && (
                  <p className="mt-3 text-sm text-gray-500">
                    You are currently signed in as <span className="font-medium">{currentUser?.username}</span>. Sign out to continue as <span className="font-medium">{username}</span>.
                  </p>
                )}
                {resolution.kind === 'switch' && (
                  <p className="mt-3 text-sm text-gray-500">
                    <span className="font-medium">{username}</span> is already one of your signed-in accounts. Switch to it to continue — nothing else is signed out.
                  </p>
                )}
                {resolution.kind === 'add' && (
                  <p className="mt-3 text-sm text-gray-500">
                    You have {sessions.length} accounts signed in, and <span className="font-medium">{username}</span> is not one of them. Signing in as <span className="font-medium">{username}</span> adds it alongside them — nothing else is signed out.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={handleSignIn}
                className="block w-full py-3 px-4 bg-accent text-white font-medium rounded-lg hover:bg-accent-deep transition-colors"
              >
                {buttonLabel}
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-6">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto">
                <X className="w-8 h-8 text-red-600" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Verification Failed</h2>
                <p className="text-gray-600">{message}</p>
              </div>
              <Link
                to="/"
                className="block w-full py-3 px-4 bg-accent text-white font-medium rounded-lg hover:bg-accent-deep transition-colors"
              >
                Back to Sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

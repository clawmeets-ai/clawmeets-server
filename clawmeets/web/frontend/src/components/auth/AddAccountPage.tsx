import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { useSwitchAccount } from '../../hooks/useSwitchAccount'
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

/**
 * AC-4.4 — "ADD ANOTHER ACCOUNT" REACHES CREDENTIAL LOGIN IN 'add' MODE.
 *
 * A ROUTE, NOT A MODAL, and the criterion offers both. Two callers settle it,
 * and neither can open a modal that lives in the sidebar:
 *
 *  - B24 / AC-3.3. `VerifyEmailPage` renders at `/auth/verify-email`, OUTSIDE
 *    `AppLayout` in both the authenticated and the unauthenticated tree. Its
 *    "X is not signed in and other sessions remain" branch has to REACH this
 *    surface pre-filled with `username`, and the only thing it can reach from
 *    there is a URL.
 *  - B23 / AC-3.1. A failed 'add'-mode OAuth is a full-page round trip through
 *    a third party: every scrap of in-memory state is gone, including any
 *    "the add dialog was open" flag a modal would have needed. What survives is
 *    where `OAuthCallbackPage` navigates to, and it now navigates HERE.
 *
 * A modal would have needed a sessionStorage flag to survive the OAuth round
 * trip and a second, page-level copy of itself to be reachable from
 * `VerifyEmailPage`. The route needs neither: it IS the destination both paths
 * already wanted.
 *
 * IT LIVES OUTSIDE `AppLayout` deliberately — same level as
 * `auth/verify-email`. Signing in as somebody else underneath the CURRENT
 * account's sidebar, projects and name is exactly the confusion the whole
 * feature exists to prevent, and `AuthShell`'s full-viewport frame is the
 * app's established "this is a credential surface" signal.
 */

interface AddAccountFormProps {
  /** AC-4.4's pre-fill. `VerifyEmailPage` passes the newly-verified account's
   *  name; the chip's "expired — sign in again" row passes the expired
   *  account's. Pre-fills the identifier field only — never the password. */
  username?: string
  /** Called with the id of the account that was just added or re-authorised.
   *  The PAGE decides what that means for the URL; the form never navigates. */
  onAdded: (userId: string) => void
  onCancel: () => void
}

/**
 * The credential half. Reuses `AuthShell`'s `Field` / `PrimaryButton` /
 * `ErrorNotice` / `InfoNotice` / `OrDivider` and `ProviderButtons` verbatim, so
 * this surface and `LoginPage` are the same form with a different `mode` — and
 * `error` / `errorCode` are read from exactly the fields `LoginPage` reads.
 *
 * THAT SHARED `error` FIELD IS WHAT CLOSES B23. A failed 'add'-mode OAuth
 * cannot report itself through `/login?error=` — the user is still
 * authenticated and `App.tsx` bounces `/login` to `/`, swallowing the code in
 * transit — so `OAuthCallbackPage` parks the message in the store's own
 * `error` and routes here. This component reads that field on its FIRST render
 * and does NOT clear it on mount: an on-mount clear would delete the one thing
 * the round trip carried back, and the failure would go silent again.
 */
export function AddAccountForm({ username, onAdded, onCancel }: AddAccountFormProps) {
  const [identifier, setIdentifier] = useState(username ?? '')
  const [password, setPassword] = useState('')
  const { loginWithCredentials, isLoading, error, errorCode, setError } = useAuthStore()

  // Empty-only validation, identical to LoginPage's and for the same reason
  // (AUTH_CONTRACT ruling 4): the client does not branch on email-vs-username
  // and shows no format hint, because a client-side "that is not a valid
  // username" is itself a shape oracle. `password === ''` rather than
  // `!password.trim()` — whitespace is significant and must reach the server.
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (identifier.trim() === '' || password === '') {
      setError('Enter the username or email and password of the account to add.')
      return
    }
    // 'add' is the whole point of this surface, and it is spelled here rather
    // than left to the default for the same reason LoginPage spells 'replace':
    // the two surfaces share these fields and are easy to confuse.
    const ok = await loginWithCredentials(identifier.trim(), password, 'add')
    if (!ok) return
    // `setSession(payload, 'add')` upserts and hands activation to `switchTo`,
    // so by here the store's own `activeUserId` NAMES the account that was just
    // added. Reading it back beats threading an id out of the action: there is
    // one place that decides who is active and this is not a second one.
    const added = useAuthStore.getState().activeUserId
    if (added) onAdded(added)
  }

  return (
    <AuthShell>
      <AuthCard>
        <BrandHeader subtitle="Add another account" />

        <form onSubmit={handleAdd} className="flex flex-col gap-4">
          <InfoNotice>
            The accounts you are already signed in to stay signed in. You can switch
            between them from the sidebar.
          </InfoNotice>

          <Field
            id="add-identifier"
            label="Username or email"
            value={identifier}
            onChange={setIdentifier}
            placeholder="Enter the username or email"
            autoFocus
            autoComplete="username"
          />

          <Field
            id="add-password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Enter the password"
            autoComplete="current-password"
          />

          {/* Same two-way split as LoginPage: 403 email_not_verified is the one
              actionable branch and renders distinctly (AUTH_CONTRACT §4.2);
              everything else — including a failed OAuth add arriving via the
              store's `error` (B23) — shares the one red notice. */}
          {error &&
            (errorCode === 'email_not_verified' ? (
              <InfoNotice>{error}</InfoNotice>
            ) : (
              <ErrorNotice>{error}</ErrorNotice>
            ))}

          <div className="mt-1">
            <PrimaryButton type="submit" disabled={isLoading}>
              {isLoading ? <InlineSpinner label="Adding account..." /> : 'Add account'}
            </PrimaryButton>
          </div>

          <OrDivider />

          {/* AC-3.1's OAuth half of "add another account". `mode="add"` parks the
              flag that survives the round trip to the provider and back. */}
          <ProviderButtons mode="add" />

          <button
            type="button"
            onClick={onCancel}
            className="text-center font-bold mt-2"
            style={{ color: 'var(--ink-3)', fontSize: 13 }}
          >
            Cancel
          </button>
        </form>
      </AuthCard>
    </AuthShell>
  )
}

/**
 * The route component at `/account/add`. Turns `?username=` into AC-4.4's
 * pre-fill PROP and owns the two navigations the form deliberately does not.
 */
export default function AddAccountPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const switchAccount = useSwitchAccount()

  return (
    <AddAccountForm
      username={params.get('username') ?? undefined}
      // NAVIGATION STAYS IN THE HOOK (AC-3.2). `useSwitchAccount()` owns
      // (switch + navigate), and a successful add IS a switch — the store has
      // already made the new account active, so `switchTo` here is its own
      // no-op and what the hook actually contributes is the unconditional `/`.
      //
      // THE HOOK IS LOAD-BEARING ON THE RE-AUTH PATH, not decoration. Signing
      // back in as the ALREADY-ACTIVE expired account (the chip's "Session
      // expired" row) upserts fresh tokens and leaves `activeUserId` untouched
      // — so `ActiveAccountRedirect` sees no transition and never fires, and
      // without this call the user would sit on a credential form they had
      // already satisfied with no way out but Cancel. On the ordinary path the
      // two do double-fire, which is B22's documented no-op: both go to `/`
      // with `replace: true`.
      onAdded={switchAccount}
      // Back where they came from, still signed in as before. `-1` rather than
      // `/` so cancelling an add does not throw away the page the user was on —
      // this surface is the one account-related navigation that did NOT change
      // who is active, so it is also the one that has nothing to redirect away
      // from.
      onCancel={() => navigate(-1)}
    />
  )
}

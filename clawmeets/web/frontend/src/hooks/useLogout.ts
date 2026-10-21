import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

/**
 * "Sign out" — ends the ACTIVE session, and only that one (AC-3.2).
 *
 * NAVIGATION OWNERSHIP IS SYMMETRIC AND IT BELONGS TO THE HOOKS.
 * `useSwitchAccount()` owns (switch + navigate); this hook owns (end session +
 * navigate); NEITHER store action navigates, and these two hooks are the only
 * way the UI reaches those state changes. Without the navigate below, the
 * active-session-ended case routes through `switchTo()` inside the store,
 * `isAuthenticated` stays TRUE, so nothing re-routes and the URL still names the
 * DEPARTED account's project — a spinner, then the flat grey "Project not found"
 * at `components/project/ProjectView.tsx:117-123`, inside a shell already
 * showing the remaining account's sidebar. That is the outcome AC-3.6 forbids.
 *
 * WHAT THE STORE STILL OWNS: the fallback `switchTo`. Lifting it up here would
 * leave `activeUserId` naming no session between two calls, and `App.tsx` is one
 * un-batched render from bouncing to `/login` on the strength of it.
 *
 * THE NAVIGATE IS CONDITIONAL, and the condition is not a micro-optimisation.
 * When this was the LAST session the store runs a full teardown,
 * `isAuthenticated` goes false and `App.tsx` renders the unauthenticated tree by
 * itself. The URL is deliberately left alone there: `PostLoginRedirect`
 * (`App.tsx:42-51`) resumes it on a same-user re-login — "you were signed out by
 * an expiry, here is the page you were on" — and navigating to `/` first would
 * silently delete that behaviour.
 *
 * The returned function takes no arguments, which also keeps callers (onClick
 * handlers) from leaking a click event into the store's optional `reason`.
 */
export function useLogout() {
  const navigate = useNavigate()
  return () => {
    // Read at CALL time, not at render time: a background session may have been
    // added or dropped since this handler was created.
    const { activeUserId, sessions } = useAuthStore.getState()
    const fallsBackToAnotherAccount = activeUserId !== null && sessions.length > 1

    // Scoped to the active session. With exactly one session this degenerates to
    // the full teardown byte-for-byte — same LAST_LOGOUT_USER_KEY, same reset
    // list, same null mirror — so the single-account experience is unchanged.
    useAuthStore.getState().logout(undefined, activeUserId ?? undefined)

    if (fallsBackToAnotherAccount) {
      navigate('/', { replace: true })
    }
  }
}

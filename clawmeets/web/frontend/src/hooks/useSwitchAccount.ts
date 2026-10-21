import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

/**
 * Make another signed-in account active, and land the user somewhere that
 * belongs to it (AC-3.6).
 *
 * THE NAVIGATE IS THE POINT, not a courtesy. `switchTo` clears the query cache
 * and every per-user store but it cannot touch the URL — a store action has no
 * router. A switch that leaves the URL alone keeps `/project/<A's project>`
 * mounted under B's credentials: `ProjectView` re-fetches, 404s, waits out
 * `retry: 1` (`queryClient.ts:7`) and renders the flat grey "Project not found"
 * at `components/project/ProjectView.tsx:117-123` — inside a shell already
 * showing B's sidebar, B's projects and B's name. The user sees their project
 * has vanished from someone else's account.
 *
 * UNCONDITIONALLY `/`, per AC-3.6, and the word is deliberate. There is no
 * subset of URLs that is safe to keep: project, chatroom, DM, agent, desk and
 * settings routes all key off ids scoped to one account, and the two that
 * happen to be user-anonymous are not worth a special case that the next route
 * quietly falsifies. `/` re-runs `LandingRedirect`, which decides desk-vs-welcome
 * from the NEW account's own `assistant_agent_id`.
 *
 * Re-selecting the ALREADY-ACTIVE account still navigates. `switchTo` no-ops
 * (no cache clear, no epoch bump — nothing changed), but the redirect is not
 * conditioned on it: making the navigation depend on whether the store decided
 * this counted as a switch is exactly the kind of "safe URL" reasoning above.
 * A caller that does not want the redirect should not offer the active account
 * as a switch target.
 *
 * The pair (switch + navigate) mirrors `useLogout()`'s (end session + navigate).
 * Neither store action navigates; these two hooks are the only way the UI
 * reaches those state changes.
 */
export function useSwitchAccount() {
  const navigate = useNavigate()
  return (userId: string) => {
    useAuthStore.getState().switchTo(userId)
    navigate('/', { replace: true })
  }
}

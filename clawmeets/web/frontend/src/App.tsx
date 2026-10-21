import { useEffect, useRef } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { LAST_LOGOUT_USER_KEY, useAuthStore } from './stores/authStore'
import { useUnreadStore } from './stores/unreadStore'
import { useWebSocketConnection, useWebSocketUpdates } from './hooks/useWebSocket'
import { useActiveWorkBootstrap } from './hooks/useActiveWorkBootstrap'
import { useWindowFileDropGuard } from './hooks/useWindowFileDropGuard'
import LoginPage from './components/auth/LoginPage'
import SignupPage from './components/auth/SignupPage'
import VerifyEmailPage from './components/auth/VerifyEmailPage'
import OAuthCallbackPage from './components/auth/OAuthCallbackPage'
import AddAccountPage from './components/auth/AddAccountPage'
import AppLayout from './components/layout/AppLayout'
import CreateProjectPage from './components/project/CreateProjectPage'
import ProjectView from './components/project/ProjectView'
import ChatroomView from './components/chatroom/ChatroomView'
import DMChatView from './components/dm/DMChatView'
import HubChatView from './components/hub/HubChatView'
import HubThreadGuard from './components/hub/HubThreadGuard'
import WelcomePage from './components/welcome/WelcomePage'
import AcceptSharePage from './components/sharing/AcceptSharePage'
import ShareLandingPage from './components/sharing/ShareLandingPage'
import UserSettingsPage from './components/settings/UserSettingsPage'
import AgentSettingsPage from './components/settings/AgentSettingsPage'
import FrontDeskSettingsPage from './components/settings/FrontDeskSettingsPage'
import AgentDirectoryPage from './components/discovery/AgentDirectory'
import ScheduledMessagesPage from './components/scheduled/ScheduledMessagesList'
import CreateAgentPage from './components/agent/CreateAgentPage'
import DeskPage from './components/desk/DeskPage'
import ComputerPage from './components/computer/ComputerPage'
import BriefingPage from './components/briefing/BriefingPage'
import ContextLanding from './components/context/ContextLanding'

function PostLoginRedirect() {
  const navigate = useNavigate()
  const userId = useAuthStore((s) => s.user?.id)
  useEffect(() => {
    // Share-link deep link wins (cross-user by design).
    const returnTo = sessionStorage.getItem('returnTo')
    if (returnTo) {
      sessionStorage.removeItem('returnTo')
      sessionStorage.removeItem(LAST_LOGOUT_USER_KEY)
      navigate(returnTo, { replace: true })
      return
    }
    // The URL survives logout, so a same-user re-login (e.g. after session
    // expiry) resumes the page it was on; a different user starts fresh at
    // the welcome page instead of the previous user's project/room URL.
    const lastUserId = sessionStorage.getItem(LAST_LOGOUT_USER_KEY)
    if (lastUserId) {
      sessionStorage.removeItem(LAST_LOGOUT_USER_KEY)
      if (userId && lastUserId !== userId) {
        navigate('/', { replace: true })
      }
    }
  }, [navigate, userId])
  return null
}

/**
 * RIDER C1.3 — the involuntary re-point also has to move the URL.
 *
 * AC-3.2 gives navigation to the hooks, and for every UI-initiated change that
 * is right and unchanged: `useSwitchAccount()` owns (switch + navigate) and
 * `useLogout()` owns (end session + navigate). But there is a third way
 * `activeUserId` moves, and no hook is in its call stack: a BACKGROUND request
 * for the active account 401s, its refresh credential is genuinely dead, and
 * `authStore.logout(reason, userId, epoch)` removes that session and falls back
 * to a remaining one from inside the store. Nobody clicked anything. Nothing
 * re-routes.
 *
 * What that leaves on screen: the URL still names ACCOUNT A's project while the
 * shell has already re-rendered as B — a spinner, then the flat grey "Project
 * not found" (`components/project/ProjectView.tsx:117-123`) after `retry: 1`
 * doubles the wait, under B's sidebar. Raising C1's expiry banner over THAT is
 * worse than raising nothing, which is why the two halves ship together.
 *
 * ONLY non-null -> non-null transitions navigate, and both bounds matter:
 *   - `null ->  id` is a sign-in. `PostLoginRedirect` owns that decision, and it
 *     deliberately RESUMES the previous URL for a same-user re-login.
 *   - `id -> null` is a full teardown. The URL is left alone on purpose, for the
 *     same resume; `App` renders the unauthenticated tree by itself.
 *
 * It double-fires with the hooks on the deliberate paths, and that is fine
 * rather than merely tolerable: both go to `/` with `replace: true`, so the
 * second is a no-op — and the redundancy is what makes AC-3.6's
 * "unconditionally" structural instead of a convention every future call site
 * has to remember.
 */
function ActiveAccountRedirect() {
  const navigate = useNavigate()
  const activeUserId = useAuthStore((s) => s.activeUserId)
  const previous = useRef(activeUserId)
  useEffect(() => {
    const from = previous.current
    previous.current = activeUserId
    if (from !== null && activeUserId !== null && from !== activeUserId) {
      navigate('/', { replace: true })
    }
  }, [navigate, activeUserId])
  return null
}

/**
 * AC-4.6 — an account with no linked assistant lands on `/welcome`, NOT a
 * broken `/desk`, and this function is where that is decided for a SWITCH as
 * much as for a login. `useSwitchAccount()` navigates to `/` unconditionally
 * (AC-3.6), `/` is this component, and it reads the assistant id off the
 * INCOMING account's own `user` — which `syncActive()` has already mirrored by
 * the time the navigate lands. There is nothing account-specific to add here;
 * the criterion is a statement about a path that exists, so it ships with a
 * test that walks it rather than with code that re-decides it.
 *
 * Exported for that test. It is the only way to assert the decision without
 * mounting the whole authenticated shell (websockets, query client and all) to
 * observe one `<Navigate>`.
 */
export function LandingRedirect() {
  // Post-login landing decision. Brand-new users (no linked assistant yet) go to
  // the onboarding welcome page; everyone else goes to My Desk. The signal is the
  // persisted auth user's assistant_agent_id — null for a brand-new user, set once
  // `clawmeets assistant register` links an assistant — so the decision is
  // synchronous (no fetch, no flicker) and re-evaluates on every login.
  const hasAssistant = useAuthStore((s) => Boolean(s.user?.assistant_agent_id))
  return <Navigate to={hasAssistant ? '/desk' : '/welcome'} replace />
}

function AuthenticatedApp() {
  // Set up WebSocket connection and real-time updates
  useWebSocketConnection()
  useWebSocketUpdates()
  useActiveWorkBootstrap()
  // Stop a stray file drop outside a composer from navigating the browser away.
  useWindowFileDropGuard()
  // Point the read-watermark store at whoever is signed in (AC-3.5). It lives
  // HERE, in the authenticated shell, rather than in the desk that reads it:
  // `useWebSocket` writes watermarks too, and a DESK_UPDATE landing before the
  // desk has ever mounted would otherwise be filed under the 'anon' key.
  //
  // This covers cold load and login. `switchTo` hydrates directly as its last
  // step, so a switch never renders a frame against the outgoing account's
  // marks — this effect then sees the same id and no-ops.
  const unreadUserId = useAuthStore((s) => s.user?.id ?? null)
  const hydrateUnread = useUnreadStore((s) => s.hydrate)
  useEffect(() => {
    hydrateUnread(unreadUserId)
  }, [hydrateUnread, unreadUserId])

  return (
    <>
      <PostLoginRedirect />
      <ActiveAccountRedirect />
      <Routes>
        {/* A signed-in user who lands on /login or /signup (e.g. from an old
            bookmark) should end up on their dashboard, not a blank page. */}
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="signup" element={<Navigate to="/" replace />} />
        <Route path="/" element={<AppLayout />}>
          <Route index element={<LandingRedirect />} />
          <Route path="desk" element={<DeskPage />} />
          {/* One briefing at its own address, so it can be copied,
              reopened in a new tab and reloaded (AC-3.1). Under
              AppLayout, and the URL replaces the deskStore state the
              overlay used to carry. */}
          <Route path="desk/briefings/:slug" element={<BriefingPage />} />
          <Route path="welcome" element={<WelcomePage />} />
          <Route path="c/:context" element={<ContextLanding />} />
          <Route path="projects" element={<WelcomePage />} />
          <Route path="projects/new" element={<CreateProjectPage />} />
          {/* A hub thread opened by one of these (a search hit, a pasted
              link) is sent to its /hub route before the ordinary view, which
              renders trusted Markdown, can mount. */}
          <Route path="projects/:projectId" element={<HubThreadGuard param="projectId"><ProjectView /></HubThreadGuard>} />
          <Route
            path="projects/:projectId/chatrooms/:chatroomName"
            element={<HubThreadGuard param="projectId"><ChatroomView /></HubThreadGuard>}
          />
          <Route path="dm/:agentName" element={<HubThreadGuard param="threadId"><DMChatView /></HubThreadGuard>} />
          <Route path="dm/:agentName/:threadId" element={<HubThreadGuard param="threadId"><DMChatView /></HubThreadGuard>} />
          <Route path="hub/:hubAgentId" element={<HubChatView />} />
          <Route path="hub/:hubAgentId/:threadId" element={<HubChatView />} />
          <Route path="settings" element={<UserSettingsPage />} />
          <Route path="settings/front-desk" element={<FrontDeskSettingsPage />} />
          <Route path="agents/public" element={<AgentDirectoryPage />} />
          <Route path="agents/new" element={<CreateAgentPage />} />
          <Route path="agents/:agentId/settings" element={<AgentSettingsPage />} />
          {/* The bare path renders the first computer (or the empty state) —
              ComputerPage owns that redirect, so a rail click needs no list
              fetch in the router. */}
          <Route path="computers" element={<ComputerPage />} />
          <Route path="computers/:computerId" element={<ComputerPage />} />
          <Route path="scheduled" element={<ScheduledMessagesPage />} />
        </Route>
        <Route path="shared/:token" element={<AcceptSharePage />} />
        <Route path="auth/verify-email" element={<VerifyEmailPage />} />
        {/* AC-4.4's add-account surface. OUTSIDE `AppLayout`, alongside
            verify-email: it is a credential surface, and rendering one under
            the current account's sidebar and name is the confusion this whole
            feature exists to prevent. Authenticated-tree only — signed out,
            `/account/add` falls through to `*` and is the sign-in page, which
            is the right answer to "add an account" with none to add it to. */}
        <Route path="account/add" element={<AddAccountPage />} />
        {/* AC-3.1 — THE 'add'-MODE ROUND TRIP RETURNS HERE WHILE ALREADY
            AUTHENTICATED, so this route has to exist in BOTH trees. The copy at
            the bottom of `App()` serves ordinary sign-in, where the browser
            comes back to the UNauthenticated tree; an add is by definition
            performed with a session already in the bag, so it comes back to
            THIS one. Without this line the provider redirect matched nothing
            here — `AuthenticatedApp` has no `*` fallback — and the round trip
            ended on a blank page with the single-use handoff code discarded,
            no exchange issued, and OAUTH_ADD_FLAG left standing in
            sessionStorage to turn the next ordinary sign-in into a silent add.
            Proved at the ROUTE level in `App.oauthAddCallback.test.tsx`: the
            component's own tests mount it directly, so they cannot see whether
            anything can reach it. */}
        <Route path="auth/callback" element={<OAuthCallbackPage />} />
      </Routes>
    </>
  )
}

function App() {
  const { isAuthenticated } = useAuthStore()

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
        {/* Backend Option-A handoff target. Browser URL is /app/auth/callback
            (react-router paths are basename-relative to /app). Must precede *. */}
        <Route path="/auth/callback" element={<OAuthCallbackPage />} />
        <Route path="/shared/:token" element={<ShareLandingPage />} />
        {/* Also matches the failure redirect /app/login?error=<CODE>. */}
        <Route path="*" element={<LoginPage />} />
      </Routes>
    )
  }

  return <AuthenticatedApp />
}

export default App

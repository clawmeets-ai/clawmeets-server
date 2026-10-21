import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LoginResponse, User } from '../types'
import { AuthContractError, loginUser, refreshSession } from '../api/endpoints/auth'
import { messageForCode } from '../components/auth/oauthErrors'
import { decodeExp } from './tokenExp'
import { useUnreadStore } from './unreadStore'
import { tearDownPerUserState } from './perUserStores'

// Written on logout, consumed by PostLoginRedirect: a same-user re-login
// resumes the current URL, a different user starts at the welcome page.
export const LAST_LOGOUT_USER_KEY = 'lastLogoutUserId'

export interface Session {
  /** Stable client-side handle. `user.id` is the natural key: one human
   *  cannot hold two sessions for the SAME account. */
  userId: string
  accessToken: string
  refreshToken: string
  user: User
  /** Decoded from accessToken.exp at hydration. Never fetched. */
  accessExpiresAt: number
  /** Decoded from refreshToken.exp. The field the chip's "expired" badge reads. */
  refreshExpiresAt: number
}

interface AuthState {
  sessions: Session[]
  activeUserId: string | null
  /** Global monotonic switch counter. Bumped ONLY in switchTo. Captured with
   *  userId at request entry. NOT persisted — a reload has nothing in flight,
   *  so starting again at 0 is correct and a persisted epoch would be a lie. */
  authEpoch: number

  // UNCHANGED SHAPE: derived mirror of the active session, written by one
  // internal syncActive(). Same names, types and nullability as the
  // single-session store, which is why the 53 read-only consumers compile
  // untouched.
  accessToken: string | null
  refreshToken: string | null
  user: User | null
  isAuthenticated: boolean

  isLoading: boolean
  error: string | null
  // Envelope `code` of the last failure, so the view can single out the one
  // branch that renders distinctly (403 email_not_verified) without re-parsing
  // the error. null for a non-envelope failure (network down, proxy HTML) and
  // for client-side validation. Deliberately NOT persisted — a stale code must
  // not survive a reload and re-style a later error.
  errorCode: string | null

  // Actions
  /** mode: 'replace' = today's behaviour (login page).
   *  mode: 'add'     = "add another account" from the palette or chip. */
  loginWithCredentials: (
    identifier: string,
    password: string,
    mode?: 'replace' | 'add',
  ) => Promise<boolean>
  // Hydrate the store from a /auth/login-shaped payload. THE single, shared entry
  // point that maps a LoginResponse onto auth state — used by BOTH password login
  // and the OAuth exchange, so an OAuth session is byte-for-byte a password
  // session. (There was no setAuth; this is it.)
  setSession: (payload: LoginResponse, mode?: 'replace' | 'add') => void
  /** Defaults to the ACTIVE session. Explicit id refreshes a background one. */
  refreshAccessToken: (userId?: string) => Promise<boolean>
  /** No id  → today's meaning: drop EVERY session, full teardown.
   *  With id → drop ONE session; full teardown only if it was the last.
   *  With epoch → the caller is a REQUEST, and the active-scoped half of the
   *  teardown runs only if that epoch is still current (AC-2.4). Omitted by
   *  every UI caller: a click cannot predate itself. */
  logout: (reason?: string, userId?: string, epoch?: number) => void
  // Set a display message with no associated envelope code — the OAuth redirect
  // path (?error=CODE) and client-side empty-field validation. Always clears
  // errorCode.
  setError: (error: string | null) => void

  switchTo: (userId: string) => void
  listSessions: () => Session[]
}

/**
 * v0 -> v1. The v0 blob is { accessToken, refreshToken, user, isAuthenticated }.
 * Lift it into a one-element sessions array so a tab that is signed in when the
 * deploy lands STAYS signed in (AC-2.8).
 *
 * A v0 blob with isAuthenticated: false — or with accessToken, refreshToken or
 * user missing or null, whatever isAuthenticated says — yields
 * { sessions: [], activeUserId: null }. That is precisely what v0 meant by
 * signed out. There is no partial session to build: Session.accessToken and
 * .refreshToken are non-nullable by design, and inventing an empty-string
 * session would put an entry in the chip's account list for an account that
 * cannot make a request.
 *
 * The two flags are checked INDEPENDENTLY and both must hold, because a v0 blob
 * with isAuthenticated: true and a null token was reachable: v0's logout()
 * nulled all four together, but its login-failure branch nulled the tokens and
 * set isAuthenticated: false in the same set — while a hand-edited or
 * partially-written localStorage blob is bounded by neither.
 *
 * accessExpiresAt / refreshExpiresAt are decoded from the lifted tokens' own
 * exp via decodeExp. NEVER fetched. A token that will not decode gets 0 and
 * therefore renders as expired — the chip tells the truth about a blob it
 * cannot read.
 *
 * Not persisted and therefore not migrated: authEpoch (starts at 0 on every
 * load, which is correct — nothing is in flight across a reload).
 */
function liftLegacy(persisted: unknown): { sessions: Session[]; activeUserId: string | null } {
  const empty = { sessions: [], activeUserId: null }
  if (typeof persisted !== 'object' || persisted === null) return empty

  const v0 = persisted as {
    accessToken?: unknown
    refreshToken?: unknown
    user?: unknown
    isAuthenticated?: unknown
  }
  if (v0.isAuthenticated !== true) return empty
  if (typeof v0.accessToken !== 'string' || !v0.accessToken) return empty
  if (typeof v0.refreshToken !== 'string' || !v0.refreshToken) return empty
  if (typeof v0.user !== 'object' || v0.user === null) return empty

  const user = v0.user as User
  if (typeof user.id !== 'string' || !user.id) return empty

  return {
    sessions: [
      {
        userId: user.id,
        accessToken: v0.accessToken,
        refreshToken: v0.refreshToken,
        user,
        accessExpiresAt: decodeExp(v0.accessToken),
        refreshExpiresAt: decodeExp(v0.refreshToken),
      },
    ],
    activeUserId: user.id,
  }
}

/**
 * syncActive(), reachable from the persist config.
 *
 * The mirror is DERIVED and therefore not persisted, so a reloaded tab lands
 * holding `sessions` + `activeUserId` and a null mirror — every one of the 53
 * read-only consumers would render signed out, and AC-2.8's "the tab survives
 * the deploy still signed in" would be false. The recompute has to run once
 * after rehydration, and `onRehydrateStorage` is where persist offers the hook.
 *
 * It is a module-scope ref rather than a second exported action because
 * syncActive closes over the store's own `set`/`get` and because AC-2.9 wants
 * exactly ONE way to write the mirror. zustand assigns this during
 * `config(set, get, api)`, which persist runs strictly before its first
 * `hydrate()` — so by the time the rehydration callback fires it is the real
 * function, never the no-op placeholder.
 */
let syncActiveRef: () => void = () => {}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => {
      // ------------------------------------------------------------ the writer

      /**
       * Write the derived mirror (accessToken / refreshToken / user /
       * isAuthenticated) from sessions[activeUserId]. THE single token writer:
       * the literals `accessToken:` / `refreshToken:` appear inside a `set()`
       * call in this file in exactly one place, and it is here (AC-2.9).
       *
       * REFERENTIAL STABILITY IS A CONTRACT, NOT AN OPTIMISATION.
       * This function must be a no-op — `set()` must not be called AT ALL — when
       * the active session's identity and tokens are unchanged. In particular it
       * must never rebuild `user` as a fresh object literal for an unchanged
       * active session: carry sessions[i].user through BY REFERENCE.
       *
       * Why: 27 non-test call sites subscribe with an un-selected
       * `useAuthStore()`. hooks/useWebSocket.ts:16 is one of them, and its effect
       * dep array at :45 is [isAuthenticated, accessToken, user] — compared by
       * reference, and `user` is an object. If a BACKGROUND account's silent
       * refresh produced a new `user` here, the ACTIVE account's socket would
       * tear down (the cleanup at :42 is wsManager.disconnect()) and reconnect,
       * then fire the 14-key reconnect-invalidation burst at :298-321. It
       * compiles, there is no error, and there is no log line.
       *
       * If you add a field to the mirror, add it to the equality check below.
       */
      function syncActive(): void {
        const state = get()
        const active = state.sessions.find((s) => s.userId === state.activeUserId) ?? null

        const nextAccess = active?.accessToken ?? null
        const nextRefresh = active?.refreshToken ?? null
        const nextUser = active?.user ?? null
        const nextAuthenticated = active !== null

        if (
          state.accessToken === nextAccess &&
          state.refreshToken === nextRefresh &&
          state.user === nextUser &&
          state.isAuthenticated === nextAuthenticated
        ) {
          return
        }

        set({
          accessToken: nextAccess,
          refreshToken: nextRefresh,
          user: nextUser,
          isAuthenticated: nextAuthenticated,
        })
      }
      syncActiveRef = syncActive

      /**
       * Replace one session's tokens, by id. The only mutator of
       * Session.accessToken / .refreshToken, and the only caller of syncActive()
       * on the refresh path.
       *
       * DROPS THE WRITE — silently, and this is correct — when no session with
       * this id exists any more (AC-1.11 / AC-2.4): the account was logged out
       * while its own refresh was in flight. That is the ONLY condition under
       * which a token write is discarded, and the check is session existence,
       * NOT the epoch.
       *
       * A write is never discarded for merely predating a switch: a background
       * account's refresh is legitimate, it lands in that account's own session,
       * and it must still be able to reach the scoped-logout branch of AC-2.5.
       * The epoch is compared in logout() and nowhere else.
       *
       * Recomputes accessExpiresAt / refreshExpiresAt from the new tokens' own
       * `exp`. Every other session object is carried through BY REFERENCE, so a
       * background write cannot move the active session's identity (AC-2.12).
       */
      function writeTokens(userId: string, access: string, refresh: string): void {
        const { sessions } = get()
        if (!sessions.some((s) => s.userId === userId)) return

        set({
          sessions: sessions.map((s) => (s.userId === userId ? withTokens(s, access, refresh) : s)),
        })
        syncActive()
      }

      /** Build the successor of one Session with a fresh token pair, expiries
       *  re-decoded from the new tokens' own `exp`. A pure builder, deliberately
       *  NOT a `set()`: the one place a token literal is written into store state
       *  is syncActive(), and keeping the arithmetic of AC-2.9 true is what makes
       *  that reviewable by grep rather than by reading. Sibling of
       *  sessionFrom(). */
      function withTokens(session: Session, access: string, refresh: string): Session {
        return {
          ...session,
          accessToken: access,
          refreshToken: refresh,
          accessExpiresAt: decodeExp(access),
          refreshExpiresAt: decodeExp(refresh),
        }
      }

      /** Build a Session from a /auth/login-shaped payload. Synthesises
       *  created_at (the payload carries none), and
       *  coerces assistant_agent_id null -> undefined at this ONE hydration
       *  boundary (LoginResponse is nullable per AUTH_CONTRACT §3 while
       *  User.assistant_agent_id is `?: string`). */
      function sessionFrom(payload: LoginResponse): Session {
        return {
          userId: payload.user.id,
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token,
          user: {
            id: payload.user.id,
            username: payload.user.username,
            assistant_agent_id: payload.assistant_agent_id ?? undefined,
            created_at: new Date().toISOString(),
          },
          accessExpiresAt: decodeExp(payload.access_token),
          refreshExpiresAt: decodeExp(payload.refresh_token),
        }
      }

      return {
        sessions: [],
        activeUserId: null,
        authEpoch: 0,
        accessToken: null,
        refreshToken: null,
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        errorCode: null,

        // POST the identifier (a username OR an email — the client never inspects
        // which) and the password, then hydrate through the shared setSession,
        // forwarding `mode`. On failure records BOTH the display message and the
        // raw envelope code.
        //
        // The message ALWAYS comes from messageForCode, never from the server's
        // own string: rendering err.message raw would let a future backend change
        // leak an account-existence hint into the DOM. Returns true on success;
        // never throws.
        //
        // ONE BEHAVIOUR CHANGE, and it is deliberate: on failure in mode 'add'
        // the existing sessions are NOT cleared. A failed attempt to add account
        // C must not sign you out of A. In 'replace' mode the failure path is
        // byte-for-byte the old one — the sessions go, and syncActive() nulls
        // the mirror.
        loginWithCredentials: async (
          identifier: string,
          password: string,
          mode: 'replace' | 'add' = 'replace',
        ) => {
          set({ isLoading: true, error: null, errorCode: null })

          try {
            const response = await loginUser(identifier, password)

            // Same mapping as before, now shared with the OAuth exchange.
            get().setSession(response, mode)
            set({ isLoading: false })

            return true
          } catch (error) {
            const isEnvelope = error instanceof AuthContractError
            if (mode === 'replace') {
              set({ sessions: [], activeUserId: null })
              syncActive()
            }
            set({
              isLoading: false,
              error: isEnvelope
                ? messageForCode(error.code)
                : error instanceof Error
                  ? error.message
                  : 'Login failed',
              errorCode: isEnvelope ? error.code : null,
            })
            return false
          }
        },

        // Map a /auth/login-shaped payload onto a Session and install it. The
        // shared hydration path for password login and the OAuth exchange alike
        // (the exchange returns the byte-identical /auth/login payload).
        //
        // mode 'replace' (default — the old behaviour, and what LoginPage
        //   passes): sessions = [thisOne], activeUserId = thisOne, syncActive().
        //   Any other session is dropped. There is nothing to reset that logout
        //   has not reset.
        //
        // mode 'add': UPSERT ONLY, then hand activation to switchTo(newUserId).
        //   This branch does NOT set activeUserId and does NOT end in
        //   syncActive(). Re-adding an account that is already present REPLACES
        //   its tokens rather than appending a second entry — user.id is the
        //   natural key and one human cannot hold two sessions for the same
        //   account.
        //
        //   WHY IT HANDS OFF RATHER THAN ACTIVATING — do not "simplify" this
        //   back. Making C active is not one assignment: it is
        //   queryClient.clear(), the reset list, the epoch bump, syncActive()
        //   and unreadStore.hydrate(C), in that order. 154 of the 156 query keys
        //   in this app are user-anonymous, so an activation that skips the
        //   clear renders ACCOUNT A'S DATA UNDER C'S NAME (AC-3.4) — on the
        //   first path any user of this feature ever takes. There is exactly one
        //   implementation of "make this account active" and it is switchTo;
        //   every other route to it is a second copy that will drift.
        //
        //   switchTo's own no-op guard makes the handoff safe: re-adding the
        //   already-active account upserts its fresh tokens and then does NOT
        //   clear the cache or bump the epoch, which is correct — nothing
        //   changed.
        setSession: (payload: LoginResponse, mode: 'replace' | 'add' = 'replace') => {
          const session = sessionFrom(payload)

          if (mode === 'replace') {
            set({
              sessions: [session],
              activeUserId: session.userId,
              error: null,
              errorCode: null,
            })
            syncActive()
            return
          }

          const { sessions } = get()
          const at = sessions.findIndex((s) => s.userId === session.userId)
          set({
            sessions: at === -1
              ? [...sessions, session]
              : sessions.map((s, i) => (i === at ? session : s)),
            error: null,
            errorCode: null,
          })
          get().switchTo(session.userId)
          // Re-adding the ALREADY-ACTIVE account is switchTo's no-op case, so
          // the fresh tokens above would never reach the mirror. Cheap, and
          // syncActive() is a no-op in every other branch by construction.
          syncActive()
        },

        // Exchange ONE session's refresh token for a fresh pair (rolling
        // window). `userId` defaults to the active session.
        //
        // The default is here because the settled contract signature is
        // `refreshAccessToken: (userId?: string) => Promise<boolean>` and this
        // file reproduces it verbatim. It is NOT here to keep consumers
        // compiling — no consumer calls this action at all. The only external
        // caller is api/client.ts, and it always passes an explicit id. Stating
        // the real reason matters: a comment claiming phantom callers invites
        // someone to "clean up" the default and think they have proved it
        // unused.
        //
        // Writes through writeTokens(userId, ...), so the result lands in the
        // session that asked for it and nowhere else, however long it took and
        // whatever happened to the active account in the meantime. Returns false
        // with no write if there is no such session or the exchange fails — the
        // CALLER is responsible for logging out.
        refreshAccessToken: async (userId?: string) => {
          const state = get()
          const id = userId ?? state.activeUserId
          if (!id) return false
          const session = state.sessions.find((s) => s.userId === id)
          if (!session) return false
          try {
            const { access_token, refresh_token } = await refreshSession(session.refreshToken)
            writeTokens(id, access_token, refresh_token)
            return true
          } catch {
            return false
          }
        },

        // No userId  -> the old meaning exactly: drop every session, full
        //               teardown, write LAST_LOGOUT_USER_KEY, reset every
        //               per-user store, queryClient.clear().
        // With userId -> drop THAT session only, leave the others signed in.
        //
        // Four rules the scoped branch holds:
        //  1. LAST_LOGOUT_USER_KEY is NOT written while any session remains
        //     (AC-2.6). PostLoginRedirect (App.tsx:42-51) reads it, and a switch
        //     is neither a logout nor a login — tripping it would bounce the user
        //     to '/'.
        //  2. Dropping a BACKGROUND session touches nothing global: no store
        //     reset, no queryClient.clear(), no navigation. The active account
        //     did not change.
        //  3. Dropping the ACTIVE session while others remain routes through
        //     switchTo() for the next session in list order — so the full reset
        //     happens exactly once, through the one path that owns it, and the
        //     epoch bumps. switchTo does not navigate, so the CALLER owns the
        //     redirect: useLogout() is the hook that pairs them, symmetrically
        //     with useSwitchAccount() (AC-3.2). On this path the expiry banner
        //     IS raised when the epoch is current — see rider C1 at the branch.
        //  4. THE EPOCH GUARD (AC-2.4). `epoch` is supplied only by a REQUEST —
        //     api/client.ts's logoutSession passes ctx.epoch. When it is supplied
        //     and !== get().authEpoch, the caller predates a switch that has
        //     since happened, and the two halves part company:
        //       - THE REMOVAL ALWAYS RUNS. A 401 is a 401; that session's refresh
        //         token is dead and it must leave sessions[] whenever the news
        //         arrives.
        //       - THE ACTIVE-SCOPED, USER-VISIBLE HALF DOES NOT RUN: no
        //         `error: reason` write (that write IS the "Your session has
        //         expired" banner) and no LAST_LOGOUT_USER_KEY.
        //       - THE FALLBACK switchTo IS NOT GATED. Removing the active
        //         session forces a re-point whatever the epoch says, or
        //         activeUserId names a session that is gone; see the comment at
        //         the branch itself.
        //     Scoping by userId alone does not cover this. It suppresses the
        //     banner for a BACKGROUND account, but A -> B -> A is a real
        //     sequence: a request issued two switches ago comes back 401 for A, A
        //     is active again, userId matches, and A's expiry banner is raised
        //     over a session the user has since re-selected and is happily using.
        //     An omitted `epoch` means "no guard", which is right for every UI
        //     caller: a click cannot predate itself.
        // Dropping the last session degenerates to the no-userId branch — with
        // the epoch guard still suppressing the banner and the redirect key,
        // because those are the active-scoped half wherever they appear.
        logout: (reason?: string, userId?: string, epoch?: number) => {
          const state = get()
          const scoped = userId !== undefined
          // An omitted epoch means "no guard" — every UI caller.
          const current = epoch === undefined || epoch === state.authEpoch

          if (scoped) {
            const remaining = state.sessions.filter((s) => s.userId !== userId)
            if (remaining.length > 0) {
              const wasActive = state.activeUserId === userId
              set({ sessions: remaining })
              // THE RE-POINT IS NOT EPOCH-GATED, and that is deliberate. It was,
              // in the first cut of this file, and the cross-account test caught
              // what that costs: A -> B -> A leaves a request whose epoch is two
              // switches stale but whose userId is the ACTIVE account. The
              // removal is unavoidable — the replay 401'd against the freshest
              // token A had, so A is genuinely dead — and skipping the re-point
              // leaves activeUserId naming a session that no longer exists. The
              // mirror then goes null, isAuthenticated goes false, and App.tsx
              // routes to /login while B sits signed in in the bag. That is
              // precisely the outcome AC-2.5 forbids.
              //
              // Staleness is not the failure; misdirection is (AC-2.4). Removing
              // A and landing on B is applied to the request's OWN session and
              // to the repair it forces — never to a session that did not ask
              // for it. What the epoch still gates is the active-scoped, USER-
              // VISIBLE half below: the expiry banner and LAST_LOGOUT_USER_KEY.
              if (wasActive) {
                get().switchTo(remaining[0].userId)
                // RIDER C1 — THE ACTIVE ACCOUNT'S EXPIRY IS NOT SILENT.
                //
                // This branch used to return here, and the `error: reason` write
                // in the full-teardown path below was therefore unreachable
                // whenever another session remained. AC-2.4 says the epoch gates
                // "the user-visible half only — the `error` banner and
                // LAST_LOGOUT_USER_KEY", which presumes that on a CURRENT epoch
                // the banner IS raised. It never was.
                //
                // What that cost, observed: A active, B backgrounded, A's refresh
                // credential genuinely dead. The app silently became B — B's
                // sidebar, B's projects, B's name — with no banner, no toast and
                // no log line. The likeliest reading for a real user is that the
                // app switched accounts by itself, or that their data is gone.
                //
                // THREE THINGS ARE LOAD-BEARING HERE:
                //  - `wasActive`. A BACKGROUND account dying is not news the user
                //    asked for and AC-2.5's test asserts the banner stays down.
                //    Only the account the user was LOOKING AT gets a banner.
                //  - `current`. On a stale epoch it stays suppressed — that is
                //    AC-2.4's rule and C1 does not change it. A -> B -> A means a
                //    request from two switches ago must not raise a banner over a
                //    session the user has since re-selected.
                //  - `reason ?? null`. A UI-initiated scoped logout (useLogout)
                //    passes no reason, and it must CLEAR any stale banner rather
                //    than leave the previous one standing over the new account.
                //
                // LAST_LOGOUT_USER_KEY is still NOT written — that is AC-2.6, it
                // is unconditional while any session remains, and the fix for C1
                // must not become a fall-through into the full-teardown path.
                if (current) {
                  set({ error: reason ?? null, errorCode: null })
                }
              } else {
                syncActive()
              }
              return
            }
            // The last session just left. Fall through to the full teardown.
          }

          const prevUserId = scoped ? userId : state.user?.id
          if (prevUserId && current) {
            sessionStorage.setItem(LAST_LOGOUT_USER_KEY, prevUserId)
          }
          // Clear every per-user cache so nothing leaks into the next session
          // (both the UI Logout button and the session-expiry path land here).
          // THE SAME function switchTo calls — one list, one order, no drift
          // (AC-3.7).
          tearDownPerUserState()
          set({
            sessions: [],
            activeUserId: null,
            error: current ? (reason ?? null) : null,
            errorCode: null,
          })
          syncActive()
        },

        setError: (error) => set({ error, errorCode: null }),

        // Make `userId` active. The four steps, in this order and no other:
        //   1. tearDownPerUserState() -- the shared reset list and
        //      queryClient.clear(), ALL of it while activeUserId still names
        //      the OLD user, so unreadStore.hydrate below cannot be handed a blob
        //      that step 1 is about to clear.
        //   2. set({ activeUserId, authEpoch: authEpoch + 1 })
        //   3. syncActive()
        //   4. useUnreadStore.getState().hydrate(userId)
        //
        // WHY A SWITCH RUNS A LOGOUT'S ENTIRE RESET LIST (AC-3.4 / AC-3.7). 154
        // of the 156 query keys in this app are user-anonymous, and there is no
        // page reload anywhere (pure SPA transition). A switch that spares the
        // cache renders ACCOUNT A'S DATA UNDER B'S NAME; a switch that spares the
        // stores keeps A's agent names in B's banners and A's parked to-do in B's
        // composer. The list is ONE exported function with two callers precisely
        // so it cannot drift — see stores/perUserStores.ts.
        //
        // Step 4 is the read-watermark half of AC-3.5: unreadStore is keyed per
        // user now, and it is hydrated HERE — synchronously, as the last step —
        // rather than left to the desk's own mount effect, so the desk never
        // renders a frame against the outgoing account's marks.
        //
        // Navigation is NOT here — a store action cannot navigate.
        // useSwitchAccount() owns the pair for the chip/Cmd-K path, and
        // useLogout() owns it for the logout path, which reaches this same
        // function through logout's rule 3 (AC-3.2 / AC-3.6).
        //
        // The fallback in logout rule 3 stays INSIDE the store deliberately.
        // Moving it into the hook would leave activeUserId naming a session that
        // no longer exists between two calls, and App.tsx is one un-batched
        // render away from bouncing to /login on the strength of it.
        //
        // No-op when userId is already active or names no session: a no-op
        // switch must not clear the cache, and must not bump the epoch.
        switchTo: (userId: string) => {
          const state = get()
          if (state.activeUserId === userId) return
          if (!state.sessions.some((s) => s.userId === userId)) return

          tearDownPerUserState()
          set({ activeUserId: userId, authEpoch: state.authEpoch + 1 })
          syncActive()
          useUnreadStore.getState().hydrate(userId)
        },

        /** Every signed-in session, in insertion order. The chip and the Cmd-K
         *  'account' category read this; nothing else does. */
        listSessions: () => get().sessions,
      }
    },
    {
      name: 'clawmeets-auth',
      partialize: (state) => ({
        sessions: state.sessions,
        activeUserId: state.activeUserId,
      }),
      version: 1,
      // v0 blob = one flat session. Lift it into a one-element array so an
      // existing logged-in tab is not logged out by the deploy.
      migrate: (persisted, version) => (version === 0 ? liftLegacy(persisted) : persisted),
      // The mirror is derived and therefore not persisted; recompute it once the
      // session bag has landed. See syncActiveRef above for why this is a ref.
      onRehydrateStorage: () => () => {
        syncActiveRef()
      },
    },
  ),
)

// ------------------------------------------------------------ read selectors

/**
 * The bearer for ONE session, by id. `null` when there is no such session.
 * api/client.ts's ONLY route to a token.
 *
 * DO NOT RENAME THIS TO `accessTokenFor` — and this comment is why. AC-2.10 is
 * enforced by `grep -n accessToken api/client.ts` returning NOTHING, and an
 * import line is a line: `import { accessTokenFor } from '../stores/authStore'`
 * fails that grep while being perfectly correct code. The obvious tidy-up
 * breaks the check, in a file that does not contain the reason. Hence the name,
 * and hence this comment living HERE rather than only in the plan.
 *
 * The placement is right on independent grounds too: keeping the token lookup
 * in this file behind a named two-function surface (bearerFor / hasSession) is
 * what makes "the request path talks to the store through a boundary"
 * structural instead of conventional.
 */
export function bearerFor(userId: string): string | null {
  return useAuthStore.getState().sessions.find((s) => s.userId === userId)?.accessToken ?? null
}

/** Does a session with this id still exist? Replaces the `isAuthenticated` read
 *  the request path used to do — "is THIS session still signed in", not "is
 *  anyone signed in". */
export function hasSession(userId: string): boolean {
  return useAuthStore.getState().sessions.some((s) => s.userId === userId)
}

/**
 * Is this session's REFRESH credential past its own expiry?
 *
 * AC-4.2's third chip state, and the value is read from the session's OWN
 * `refreshExpiresAt` — decoded from the refresh token's `exp` by `decodeExp` at
 * hydration and re-decoded by `withTokens` on every refresh. NOTHING IS
 * FETCHED, and nothing may be: the chip renders on every sidebar paint, and a
 * chip that asks the network whether an account is still good would issue N
 * requests per open for information the token already carries.
 *
 * The access token's expiry is deliberately NOT consulted. An expired ACCESS
 * token is the ordinary case — `api/client.ts` exchanges it through the refresh
 * ladder without the user ever knowing. It is the refresh token running out
 * that means "this account cannot come back without a password", which is the
 * only one of the two a human needs to be told about.
 *
 * A token that would not decode got 0 from `decodeExp` and therefore reads as
 * expired here, which is the truthful answer for a blob we cannot read.
 *
 * Lives beside `bearerFor` / `hasSession` because it is the same kind of thing:
 * a derived read over one `Session`, kept in the file that owns `Session` so
 * the chip and the palette cannot drift into two spellings of "expired".
 */
export function isSessionExpired(session: Session, now: number = Date.now()): boolean {
  return session.refreshExpiresAt <= now
}

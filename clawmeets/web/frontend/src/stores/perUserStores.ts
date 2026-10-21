import { queryClient } from '../queryClient'
import { useUnreadStore } from './unreadStore'
import { useUIStore } from './uiStore'
import { useMcpAuthStore } from './mcpAuthStore'
import { useSkillAuthStore } from './skillAuthStore'
import { useActiveWorkStore } from './activeWorkStore'
import { useRunnerVersionStore } from './runnerVersionStore'
import { useAnnouncementStore } from './announcementStore'
import { useDeskStore } from './deskStore'
import { useDeskLinkStore } from './deskLinkStore'
import { useHeldPostsStore } from './heldPostsStore'

/**
 * THE per-user reset list (AC-3.7). One list, named, exported, and called from
 * BOTH `authStore.logout()`'s full teardown and `authStore.switchTo()`.
 *
 * It lives in its own module rather than as a closure inside `authStore` for
 * one reason: a list with two callers drifts, and this one already has. Before
 * this project started, `stores/deskLabelViewStore.ts:125` documented its own
 * `reset()` as "Called from `authStore.logout()`'s siblings" — and that was
 * false on `main`. A list that is only reachable from inside the store body is
 * a list nobody can enumerate; this file is the enumeration, and it is what
 * `plan-account-switcher.html` §4.8 names store-by-store (AC-1.10).
 *
 * WHY A SWITCH NEEDS THE SAME LIST AS A LOGOUT. There is no page reload
 * anywhere in this app (pure SPA transition), so a store left out of this list
 * survives a session change IN MEMORY. User A switches to B, `AppLayout`
 * re-renders, and the banners keep rendering A's AGENT NAMES until B's first
 * push lands. The switch is the *more* exposed of the two callers, not the
 * less: a logout at least unmounts the authenticated tree on its way out, and a
 * switch does not.
 *
 * NOT IN THIS LIST, deliberately:
 *   - `deskLabelViewStore.reset()`. Its absence from `logout` is a pre-existing
 *     bug (backlog B2, AC-6.4), and wiring it in here would be fixing a defect
 *     this project did not create under cover of a refactor.
 *   - `authStore` itself. It owns the session bag; resetting it from its own
 *     reset list would be a loop.
 */
export function resetPerUserStores(): void {
  useUnreadStore.getState().reset()
  useUIStore.getState().reset()
  useMcpAuthStore.getState().reset()
  useSkillAuthStore.getState().reset()
  useActiveWorkStore.getState().reset()
  useRunnerVersionStore.getState().reset()
  useAnnouncementStore.getState().reset()
  // NEW IN M3, and in scope rather than backlog because it is a leak the
  // SWITCHER itself creates (AC-3.4). `pendingSop` / `pendingTask` carry whole
  // DeskSop / DeskTodo records as one-shot handoff state, so a switch performed
  // mid-handoff drops account A's to-do into account B's composer.
  useDeskStore.getState().reset()
  // The cross-highlight's pointer channel. On this list for the same reason
  // every other store is — it is per-user state that survives a switch in
  // memory — rather than because a parked hover is dangerous: the switch
  // unmounts the desk, so the worst it does is light a card under the new
  // account whose id happens to collide. Cheap to hold, and leaving it off
  // would make this list "every per-user store except one".
  useDeskLinkStore.getState().reset()
  // Held posts quote what the user wrote; another account must not see them.
  useHeldPostsStore.getState().reset()
}

/**
 * Everything a session change must tear down, in the one order that is safe.
 *
 * `queryClient.clear()` is LAST because it is the one that matters
 * if an exception escapes the store resets: 154 of the 156 query keys in this
 * app carry no user identity, so a switch that spares the cache renders account
 * A's data under account B's name (AC-3.4).
 *
 * THE CALLER runs this while `activeUserId` still names the OLD user. Anything
 * that hydrates FOR the new user (`unreadStore.hydrate`) must run after the
 * re-point, or it is handed a blob it is about to clear.
 */
export function tearDownPerUserState(): void {
  resetPerUserStores()
  queryClient.clear()
}

import { useEffect } from 'react'
import { getActiveWork } from '../api/endpoints/messages'
import { useActiveWorkStore } from '../stores/activeWorkStore'
import { useAuthStore } from '../stores/authStore'
import { wsManager } from '../api/websocket'

/**
 * Seeds and re-seeds the active-work store with a server snapshot.
 *
 * Steady-state updates flow in via ACTIVE_WORK_CHANGE WebSocket envelopes. This
 * hook covers the cases where events alone leave the client stale:
 *   - First mount (app opened with in-flight work already running).
 *   - WebSocket reconnect (events fired during the disconnect window were
 *     missed) — driven by wsManager.onConnect, which fires synchronously on
 *     every real reconnect, so there is no poll race (unlike the old 2s
 *     useWebSocketStatus edge, which mobile timer-throttling and fast
 *     reconnects could both slip past).
 *   - Tab return-to-foreground — belt-and-suspenders for a zombie socket that
 *     died without emitting a disconnect/reconnect, common when a mobile tab is
 *     backgrounded.
 *
 * On logout, clears the store so state from the previous user doesn't leak.
 */
export function useActiveWorkBootstrap(): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const { hydrate, reset } = useActiveWorkStore.getState()

  useEffect(() => {
    // Not signed in: clear any leftover state and install nothing.
    if (!isAuthenticated) {
      reset()
      return
    }

    let cancelled = false
    // Triggers (a)-(c) below can overlap — a mobile wake fires visibilitychange
    // and the reconnect within milliseconds of each other. `hydrate` replaces
    // the whole map, so an older response landing last would clobber a newer
    // snapshot and re-create the exact stale lane this hook exists to clear.
    // Only the newest request in flight is allowed to write.
    let latestSeq = 0
    // Whether any reseed has landed yet, so a first connect can cover for a
    // mount seed that failed (app opened offline / server briefly down).
    let seeded = false

    // Fetch the server snapshot and hydrate the store. Non-fatal on error: the
    // next ACTIVE_WORK_CHANGE event will refresh the relevant key anyway. Late
    // resolves after teardown (logout / unmount) are no-ops via `cancelled`.
    const reseed = () => {
      const seq = ++latestSeq
      getActiveWork()
        .then((res) => {
          if (cancelled || seq !== latestSeq) return
          seeded = true
          hydrate(res.active)
        })
        .catch(() => {
          // Non-fatal — see above.
        })
    }

    // (a) Seed once on mount. HTTP is independent of WebSocket state, so this
    //     is safe regardless of whether the socket is connected yet.
    reseed()

    // (b) Reliable reconnect re-seed. isReconnect is false only for the first
    //     connect of this page load, which mount already covered — unless that
    //     mount seed never landed, hence the `!seeded` fallback.
    const unsubscribeConnect = wsManager.onConnect((isReconnect) => {
      if (isReconnect || !seeded) reseed()
    })

    // (c) Foreground re-seed — covers a socket that silently died while the
    //     mobile tab was backgrounded and never fired a reconnect.
    const onVisible = () => {
      if (document.visibilityState === 'visible') reseed()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      unsubscribeConnect()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [isAuthenticated, hydrate, reset])
}

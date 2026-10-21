import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  createInstallToken,
  getInstallProgress,
  type InstallProgress,
  type InstallToken,
} from '../api/endpoints/install'
import { useAuthStore } from '../stores/authStore'

/**
 * The one-time install command for this account.
 *
 * A mutation rather than a query even though it only reads-and-returns, for the
 * same reason `usePairingCode` is one: each call mints a NEW single-use secret
 * with its own one-hour clock. Holding it is equivalent to holding a magic link
 * for this account, so it must never be cached, refetched on focus, or replayed
 * by a retry.
 */
export function useInstallToken() {
  return useMutation<InstallToken>({ mutationFn: createInstallToken })
}

/**
 * Mint a command once, on mount, and hand it back.
 *
 * The welcome page needs a live command the moment it renders — there is nothing
 * for the user to do until they can copy one — so this does the minting rather
 * than making the page choose when. Minting on every mount is also what keeps
 * the token on screen fresh: a one-hour window is only friction if the page can
 * go stale under it, and it cannot if every load produces a new one.
 *
 * `retry: false` on the underlying mutation (the default) matters here: a retry
 * would mint a second token and silently show the first, and a command whose
 * token was superseded is the most confusing possible failure — it looks valid
 * and is refused.
 */
export function useInstallCommand() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const mint = useInstallToken()

  useEffect(() => {
    if (isAuthenticated && !mint.data && !mint.isPending && !mint.isError) {
      mint.mutate()
    }
    // Depends on the mutation's FLAGS, not on `mint` itself: the mutation object
    // is a new identity on every render, so depending on it would mint a token
    // per render — each one superseding the last, and the command on screen
    // would be a token the server has already replaced.
  }, [isAuthenticated, mint.data, mint.isPending, mint.isError])

  return {
    command: mint.data?.command ?? '',
    windowsCommand: mint.data?.windows_command ?? '',
    steps: mint.data?.steps ?? [],
    isLoading: mint.isPending || (!mint.data && !mint.isError),
    error: mint.isError,
    retry: () => mint.mutate(),
  }
}

/**
 * How the install running on the user's machine is getting on.
 *
 * Refreshed by `INSTALL_SYNC` envelopes (see `useWebSocketUpdates`), which the
 * server pushes as each step is reported. No polling: the machine reports, the
 * server pushes, the page refetches.
 *
 * `staleTime: 0` for the same reason `useComputers` uses it — a stale answer is
 * the specific problem this surface exists to fix. A page that still says
 * "Installing…" about an install that failed two minutes ago is worse than one
 * that says nothing.
 */
export function useInstallProgress() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery<InstallProgress>({
    queryKey: ['install-progress'],
    queryFn: getInstallProgress,
    enabled: isAuthenticated,
    staleTime: 0,
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  createPairingCode,
  disconnectComputer,
  getComputerConsent,
  getComputers,
  renameComputer,
  runComputerCommand,
  type Computer,
  type ComputerAction,
  type ComputerConsent,
} from '../api/endpoints/computers'
import { useAuthStore } from '../stores/authStore'

/** Every computer the signed-in user has connected.
 *
 *  Refreshes on `HOST_SYNC` envelopes (see `useWebSocketUpdates`), which the
 *  server pushes when a machine connects, disconnects, re-reports its agents, or
 *  is renamed / disconnected from any of the user's own tabs. No polling: the
 *  socket IS the signal, and a machine's connectedness is exactly what a socket
 *  is good at reporting.
 *
 *  `staleTime: 0` because a stale answer here is the specific bug this feature
 *  exists to fix — a page that says "3 of 5 running" about a computer that went
 *  to sleep two minutes ago is worse than one that says nothing. */
export function useComputers() {
  const userId = useAuthStore((s) => s.user?.id)
  return useQuery<Computer[]>({
    queryKey: ['computers', userId],
    queryFn: getComputers,
    enabled: !!userId,
    staleTime: 0,
  })
}

/** One computer out of the list, by id.
 *
 *  Reads from the SAME query as the panel rather than its own per-id fetch. The
 *  list is small and already kept fresh by `HOST_SYNC`, so a second request
 *  would add a second thing to invalidate and a second moment for the row and
 *  the page to disagree about. */
export function useComputer(computerId: string | undefined) {
  const { data, isLoading } = useComputers()
  const computer = computerId
    ? (data ?? []).find((c) => c.id === computerId) ?? null
    : null
  return { computer, isLoading }
}

/** The allowlist and the nevers, from the server.
 *
 *  Long `staleTime`: it changes only when the product's rules change, i.e. on
 *  deploy. It is still fetched rather than hardcoded so the consent screen and
 *  the enforced allowlist cannot drift. */
export function useComputerConsent() {
  const userId = useAuthStore((s) => s.user?.id)
  return useQuery<ComputerConsent>({
    queryKey: ['computer-consent', userId],
    queryFn: getComputerConsent,
    enabled: !!userId,
    staleTime: 60 * 60 * 1000,
  })
}

/** Mint a pairing code, for the Connect-a-computer dialog.
 *
 *  A mutation rather than a query even though it only reads-and-returns: each
 *  call mints a NEW single-use secret with its own 15-minute clock, so it must
 *  never be cached, refetched on focus, or replayed by a retry. */
export function usePairingCode() {
  return useMutation({ mutationFn: createPairingCode })
}

export function useRenameComputer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameComputer(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['computers'] })
    },
  })
}

/** Disconnect a computer, from its own page.
 *
 *  Navigating away is part of the action, not the caller's afterthought: the
 *  user asked for the machine to be cut off, and the page they are on is about
 *  to be able to do nothing. They go back to the list, which no longer carries
 *  the machine (the server drops disconnected computers). `replace` so Back
 *  does not return them to a page whose every button is now dead. */
export function useDisconnectComputer() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: (id: string) => disconnectComputer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['computers'] })
      navigate('/computers', { replace: true })
    },
  })
}

/** Run one allowlisted action on a computer.
 *
 *  Does NOT optimistically flip the agent's row to "running". The machine is the
 *  only thing that knows whether a start worked, it says so on its next
 *  check-in (which arrives as `HOST_SYNC` within seconds), and a row that claims
 *  "running" before any process exists is the same lie — with a nicer
 *  animation — that this whole surface was built to stop telling.
 *
 *  The invalidate is still worth doing: it picks up `last_command`, which is how
 *  a FAILED start gets to say why instead of appearing to do nothing. */
export function useComputerCommand() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action, agent }: { id: string; action: ComputerAction; agent?: string }) =>
      runComputerCommand(id, action, agent),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['computers'] })
    },
  })
}

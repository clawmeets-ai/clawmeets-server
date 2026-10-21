import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import { listChannelThreads, listConnections, type ChannelThreadRow } from '../api/endpoints/channels'
import { CONNECTIONS_KEY } from '../components/settings/agent/channelsShared'

/** Query key of the owner's channel-thread list. The WebSocket invalidates it
 *  on every project update (a new thread, a contact's message), and Pause /
 *  Resume invalidate it after the server answers. */
export const CHANNEL_THREADS_KEY = ['channel-threads'] as const

export type ChannelThreadsState =
  /** The list hasn't answered yet: don't file channel threads anywhere. */
  | 'loading'
  /** Channels are switched off on this server (every `/me/channels` route 404s). */
  | 'off'
  /** The list failed for another reason. */
  | 'error'
  | 'ready'

export interface ChannelThreads {
  state: ChannelThreadsState
  /** project id → its row; empty unless `state === 'ready'`. */
  byProject: Map<string, ChannelThreadRow>
}

/**
 * The owner's channel threads, from ONE request for the whole sidebar
 * (`GET /me/channels/threads`). This is the only source of a thread's channel,
 * contact and pause state on the client: nothing is read from the room name.
 */
export function useChannelThreads({ enabled = true }: { enabled?: boolean } = {}): ChannelThreads {
  const q = useQuery({
    queryKey: CHANNEL_THREADS_KEY,
    queryFn: listChannelThreads,
    enabled,
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  })
  return useMemo(() => {
    if (q.data) return { state: 'ready', byProject: new Map(q.data.map((r) => [r.project_id, r])) }
    if (q.error) {
      const off = q.error instanceof ApiError && q.error.status === 404
      return { state: off ? 'off' : 'error', byProject: new Map() }
    }
    return { state: 'loading', byProject: new Map() }
  }, [q.data, q.error])
}

/** The channel thread row for one project, or null (not a channel thread, or
 *  not known yet). Shares the sidebar's cache. `enabled: false` (a room that
 *  can't be the owner's channel thread) asks nothing. */
export function useChannelThread(projectId: string, { enabled = true }: { enabled?: boolean } = {}): {
  row: ChannelThreadRow | null; state: ChannelThreadsState
} {
  const { state, byProject } = useChannelThreads({ enabled })
  return { row: byProject.get(projectId) ?? null, state }
}

/** Channels that have at least one ENABLED connection, for the sidebar tabs.
 *  Shares the Agent Settings → Channels cache. */
export function useEnabledChannels(): Set<string> {
  const q = useQuery({ queryKey: CONNECTIONS_KEY, queryFn: listConnections, retry: false })
  return useMemo(
    () => new Set((q.data ?? []).filter((c) => !c.disabled).map((c) => c.channel)),
    [q.data],
  )
}

import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import {
  getAgentHubUsage, listBridgeDeliveries, listRetained, retainHubAgent, unretainHubAgent,
  type BridgeDelivery, type ChatroomFlowChangedPayload, type HubAgentDetail, type HubAgentPage,
  type HubBridgeDeliveryPayload, type RetainedAgent, type RoomFlow,
} from '../api/endpoints/hub'
import { setRoomFlow } from '../api/endpoints/roomFlow'
import type { Chatroom } from '../types'
import { hubAgentKey } from './useHub'

/**
 * The queries and mutations of agent access: an owned agent's hub send usage,
 * retained hub agents, a workroom's relays to them and its inbound flow. They
 * live beside useHub.ts rather than growing it.
 */

export const agentHubUsageKey = (agentId: string) => ['hub-agent-usage', agentId] as const
export const RETAINED_KEY = ['hub-retained'] as const

/** Read-only: the owner sees how much of each send window the agent used. A
 *  caller who does not own the agent gets not_owner [403]; never retried. */
export function useAgentHubUsage(agentId: string | undefined) {
  return useQuery({
    queryKey: agentHubUsageKey(agentId ?? ''),
    queryFn: () => getAgentHubUsage(agentId!),
    enabled: !!agentId,
    retry: false,
    staleTime: 30_000,
  })
}

// ── retain ────────────────────────────────────────────────────────────────

/** The user's retained hub agents ([] when the hub is off). Read-only; never
 *  a hub-state error, so it never flips the config into "hub down". */
export function useRetainedAgents({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: RETAINED_KEY,
    queryFn: listRetained,
    enabled,
    retry: false,
    staleTime: 30_000,
  })
}

/** Write `retained` on every cached directory page and the agent's detail, so
 *  each card and header follows at once. */
export function setRetainedInCaches(qc: QueryClient, hubAgentId: string, retained: boolean): void {
  qc.setQueriesData<InfiniteData<HubAgentPage>>({ queryKey: ['hub-directory'] }, (data) =>
    data && {
      ...data,
      pages: data.pages.map((pg) => ({
        ...pg,
        agents: pg.agents.map((a) => (a.hub_agent_id === hubAgentId ? { ...a, retained } : a)),
      })),
    })
  qc.setQueryData<HubAgentDetail>(hubAgentKey(hubAgentId), (d) => d && { ...d, retained })
}

export function useRetainAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (hubAgentId: string) => retainHubAgent(hubAgentId),
    onSuccess: (row: RetainedAgent) => {
      setRetainedInCaches(qc, row.hub_agent_id, true)
      qc.setQueryData<RetainedAgent[]>(RETAINED_KEY, (rows) =>
        rows && [row, ...rows.filter((r) => r.hub_agent_id !== row.hub_agent_id)])
      void qc.invalidateQueries({ queryKey: RETAINED_KEY })
    },
  })
}

export function useUnretainAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (hubAgentId: string) => {
      await unretainHubAgent(hubAgentId)
      return hubAgentId
    },
    onSuccess: (hubAgentId: string) => {
      setRetainedInCaches(qc, hubAgentId, false)
      qc.setQueryData<RetainedAgent[]>(RETAINED_KEY, (rows) => rows?.filter((r) => r.hub_agent_id !== hubAgentId))
      void qc.invalidateQueries({ queryKey: RETAINED_KEY })
    },
    // not_retained: it already is not; the list catches up.
    onError: () => { void qc.invalidateQueries({ queryKey: RETAINED_KEY }) },
  })
}

// ── bridge deliveries (a workroom's relays to retained agents) ────────────

export const bridgeDeliveriesKey = (projectId: string, chatroomName: string) =>
  ['hub-bridge-deliveries', projectId, chatroomName] as const

/** Room message id → its relays, one per stand-in. */
export type BridgeDeliveryMap = Record<string, BridgeDelivery[]>

/** The route takes ids in one query string; this keeps the URL short. */
export const BRIDGE_IDS_PER_REQUEST = 50

/** A relay only moves forward; a final state stays. An unknown state is kept
 *  only when nothing is known yet. */
const RANK: Record<string, number> = { queued: 1, relayed: 2, delivered: 3, answered: 4, failed: 5, cancelled: 5 }
const rank = (s: string) => RANK[s] ?? 0

export function mergeBridgeDelivery(prev: BridgeDelivery | undefined, next: BridgeDelivery): BridgeDelivery {
  if (!prev) return next
  return rank(next.state) >= rank(prev.state) ? next : prev
}

function mergeRows(map: BridgeDeliveryMap, rows: BridgeDelivery[]): BridgeDeliveryMap {
  const out: BridgeDeliveryMap = { ...map }
  for (const d of rows) {
    const list = out[d.room_message_id] ?? []
    const i = list.findIndex((x) => x.hub_agent_id === d.hub_agent_id)
    out[d.room_message_id] = i < 0
      ? [...list, d]
      : list.map((x, j) => (j === i ? mergeBridgeDelivery(x, d) : x))
  }
  return out
}

/** The hub_bridge_delivery push: merged into the room's cache. */
export function mergeBridgeDeliveryInto(qc: QueryClient, p: HubBridgeDeliveryPayload): void {
  qc.setQueryData<BridgeDeliveryMap>(bridgeDeliveriesKey(p.project_id, p.chatroom_name), (prev) =>
    mergeRows(prev ?? {}, [p.delivery]))
}

/**
 * The relays of the messages in view that address a stand-in. Owner only
 * (`enabled`): anyone else gets 404, so a viewer never asks. Each id is
 * fetched once per room, in chunks of BRIDGE_IDS_PER_REQUEST; a new message
 * fetches only its own id, and pushes keep the known ones current.
 */
export function useBridgeDeliveries(
  projectId: string,
  chatroomName: string,
  messageIds: readonly string[],
  enabled: boolean,
): BridgeDeliveryMap {
  const qc = useQueryClient()
  const on = enabled && messageIds.length > 0
  // The ids fetched, or being fetched, in this room.
  const roomKey = `${projectId}/${chatroomName}`
  const known = useRef({ roomKey, ids: new Set<string>() })
  if (known.current.roomKey !== roomKey) known.current = { roomKey, ids: new Set() }
  const asked = known.current.ids
  const missing = messageIds.filter((id) => !asked.has(id))
  useQuery({
    queryKey: [...bridgeDeliveriesKey(projectId, chatroomName), 'fetch', missing.join(',')],
    queryFn: async () => {
      for (const id of missing) asked.add(id)
      const rows: BridgeDelivery[] = []
      for (let i = 0; i < missing.length; i += BRIDGE_IDS_PER_REQUEST) {
        const chunk = missing.slice(i, i + BRIDGE_IDS_PER_REQUEST)
        try {
          const got = await listBridgeDeliveries(projectId, chatroomName, chunk)
          // Merged per chunk, not from the query's data: a newer id list may
          // have replaced this query's key while it was in flight, and a
          // later chunk's failure keeps what earlier chunks fetched.
          qc.setQueryData<BridgeDeliveryMap>(bridgeDeliveriesKey(projectId, chatroomName), (prev) => mergeRows(prev ?? {}, got))
          rows.push(...got)
        } catch (e) {
          // This chunk and the ones not yet asked are asked again with the
          // next id list.
          for (const id of missing.slice(i)) asked.delete(id)
          throw e
        }
      }
      return rows
    },
    enabled: on && missing.length > 0,
    retry: false,
    staleTime: 30_000,
  })
  const { data } = useQuery({
    queryKey: bridgeDeliveriesKey(projectId, chatroomName),
    queryFn: () => ({}) as BridgeDeliveryMap,
    enabled: false,
    initialData: {} as BridgeDeliveryMap,
  })
  return on ? data : {}
}

// ── room flow ─────────────────────────────────────────────────────────────

/** Write a room's flow into the cached room and the project's room list, so
 *  the strip and the control follow without a refetch. */
export function applyRoomFlow(qc: QueryClient, p: ChatroomFlowChangedPayload): void {
  qc.setQueryData<Chatroom>(['chatroom', p.project_id, p.chatroom_name], (room) => room && { ...room, flow: p.flow })
  qc.setQueryData<Chatroom[]>(['chatrooms', p.project_id], (rooms) =>
    rooms?.map((r) => (r.name === p.chatroom_name ? { ...r, flow: p.flow } : r)))
}

/** PUT …/flow, then the server's answer goes into the caches: the strip shows
 *  the server's stopped_by and stopped_at, never a guess (no optimism). */
export function useSetRoomFlow(projectId: string, chatroomName: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (state: 'open' | 'stopped') => setRoomFlow(projectId, chatroomName, state),
    onSuccess: (flow: RoomFlow) => applyRoomFlow(qc, { project_id: projectId, chatroom_name: chatroomName, flow }),
  })
}

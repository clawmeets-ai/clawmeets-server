import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { wsManager } from '../api/websocket'
import { useAuthStore } from '../stores/authStore'
import { useActiveWorkStore } from '../stores/activeWorkStore'
import { useMcpAuthStore } from '../stores/mcpAuthStore'
import { useSkillAuthStore } from '../stores/skillAuthStore'
import { useUnreadStore } from '../stores/unreadStore'
import { useRunnerVersionStore } from '../stores/runnerVersionStore'
import { useDeskLabelViewStore } from '../stores/deskLabelViewStore'
import { DESK_LATEST_MESSAGES_KEY, deskRoomKey } from './useDeskUpdates'
import { PUBLIC_REQUESTS_KEY } from './usePublicRequests'
import { ControlMessageType } from '../types'
import type { ActiveWorkChangePayload, AgentCardUpdatePayload, ChangelogUpdatePayload, ControlEnvelope, DeskLabelSyncPayload, DeskReadStateSyncPayload, McpAuthUrlForUserPayload, SkillAuthUrlForUserPayload } from '../types'
import { CHANNEL_THREADS_KEY } from './useChannelThreads'
import { mergeDeliveriesInto, replaceHubChannel } from './useHub'
import { applyRoomFlow, mergeBridgeDeliveryInto } from './useAgentAccess'
import type {
  ChatroomFlowChangedPayload, HubBridgeDeliveryPayload, HubChannelStatusPayload, HubDeliveryStatePayload,
} from '../api/endpoints/hub'

export function useWebSocketConnection(): boolean {
  const { accessToken, user, isAuthenticated } = useAuthStore()
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!isAuthenticated || !accessToken || !user) {
      setConnected(false)
      return
    }

    // Connect as user for real-time updates. accessToken is in the dep array,
    // so a silent refresh transparently reconnects with the fresh token.
    wsManager.connectAsUser(user.id, accessToken)

    // Check connection status periodically
    const checkConnection = () => {
      setConnected(wsManager.isConnected())
    }

    // Initial check
    checkConnection()

    // Poll connection status (WebSocket events don't trigger React re-renders)
    const interval = setInterval(checkConnection, 2000)

    return () => {
      clearInterval(interval)
      wsManager.disconnect()
      setConnected(false)
    }
  }, [isAuthenticated, accessToken, user])

  return connected
}

/**
 * Passive hook that only monitors connection status without managing the connection.
 * Use this in components that need to read connection state but should NOT
 * own the connect/disconnect lifecycle (to avoid duplicate connections).
 */
export function useWebSocketStatus(): boolean {
  const [connected, setConnected] = useState(() => wsManager.isConnected())

  useEffect(() => {
    const interval = setInterval(() => {
      setConnected(wsManager.isConnected())
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  return connected
}

// Reconnect catch-up pacing — see handleReconnect in useWebSocketUpdates.
const RECONNECT_SETTLE_MS = 1_000
const RECONNECT_TIER_GAP_MS = 1_500

export function useWebSocketUpdates() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const handleMessage = (envelope: ControlEnvelope) => {
      // Handle notification-only protocol messages
      switch (envelope.type) {
        case ControlMessageType.CHANGELOG_UPDATE:
          // Payload is typed: ChangelogUpdatePayload with project_id, project_name, new_version
          const payload = envelope.payload as ChangelogUpdatePayload
          const projectId = payload.project_id
          if (projectId) {
            // Invalidate all chatroom-scoped caches for this project
            // Using partial query key matching: ['messages', projectId] matches ['messages', projectId, chatroomName]
            queryClient.invalidateQueries({
              queryKey: ['messages', projectId],
            })
            // The desk's batched feed spans many projects, so any project's
            // update refreshes it. cancelRefetch: false lets a burst of
            // updates share the request already in flight instead of
            // cancelling and restarting it on every entry.
            queryClient.invalidateQueries(
              { queryKey: [DESK_LATEST_MESSAGES_KEY] },
              { cancelRefetch: false },
            )
            // A public request's matches each answer on their own thread, so
            // any thread's update may move a request's status.
            queryClient.invalidateQueries(
              { queryKey: PUBLIC_REQUESTS_KEY },
              { cancelRefetch: false },
            )
            queryClient.invalidateQueries({
              queryKey: ['files', projectId],
            })
            queryClient.invalidateQueries({
              queryKey: ['fileContent', projectId],
            })
            // Refresh iframe-rendered blobs (chatroom file previews etc.)
            // on file updates. Re-keying the blob URL forces the iframe to
            // re-mount with the new bytes.
            queryClient.invalidateQueries({
              queryKey: ['fileBlobContent', projectId],
            })
            queryClient.invalidateQueries({
              queryKey: ['chatroom', projectId],
            })

            // Invalidate project-level caches
            queryClient.invalidateQueries({
              queryKey: ['chatrooms', projectId],
            })
            queryClient.invalidateQueries({
              queryKey: ['project', projectId],
            })

            // Invalidate project lists (in case room created or project status changed)
            queryClient.invalidateQueries({ queryKey: ['user-projects'] })
            queryClient.invalidateQueries({ queryKey: ['all-projects'] })
            // The Front Desk sidebar's channel threads (a new contact opens a
            // thread) and this thread's delivery status (a reply was queued).
            // Both are cheap; a burst shares the request in flight.
            queryClient.invalidateQueries({ queryKey: CHANNEL_THREADS_KEY }, { cancelRefetch: false })
            queryClient.invalidateQueries({ queryKey: ['channel-outbox', projectId] }, { cancelRefetch: false })
          }
          break

        case ControlMessageType.AGENT_STATUS_CHANGE:
          // Invalidate agents list to refresh status
          queryClient.invalidateQueries({
            queryKey: ['agents'],
          })
          break

        case ControlMessageType.PROJECT_DELETED:
          // Invalidate project lists so deleted project disappears
          queryClient.invalidateQueries({ queryKey: ['user-projects'] })
          queryClient.invalidateQueries({ queryKey: ['all-projects'] })
          break

        case ControlMessageType.ACTIVE_WORK_CHANGE: {
          const p = envelope.payload as ActiveWorkChangePayload
          useActiveWorkStore.getState().setParticipants(
            p.project_id,
            p.chatroom_name,
            p.active_participants,
          )
          break
        }

        case ControlMessageType.MCP_AUTH_URL_FOR_USER: {
          const p = envelope.payload as McpAuthUrlForUserPayload
          useMcpAuthStore.getState().set(p.agent_id, p.mcp_name, {
            auth_url: p.auth_url,
            state: p.state,
          })
          break
        }

        case ControlMessageType.SKILL_AUTH_URL_FOR_USER: {
          const p = envelope.payload as SkillAuthUrlForUserPayload
          useSkillAuthStore.getState().set(p.agent_id, p.skill_name, {
            auth_url: p.auth_url,
            state: p.state,
          })
          break
        }

        case ControlMessageType.AGENT_CARD_UPDATE: {
          const p = envelope.payload as AgentCardUpdatePayload
          // Cursor bump on the agent card (last_reflected_at). Invalidate the single-agent fetch that backs the
          // Agent Settings "Memory & Reflection" panel plus the agents list.
          queryClient.invalidateQueries({ queryKey: ['agent', p.agent_id] })
          queryClient.invalidateQueries({ queryKey: ['agents'] })
          break
        }

        case ControlMessageType.BRIEF_TAB_SYNC: {
          // One of the user's agents upserted / deleted a brief tab.
          // Invalidate the list query; useBriefTabs refetches and My Desk
          // re-renders the changed briefing in place.
          queryClient.invalidateQueries({ queryKey: ['brief-tabs'] })
          // ...and the DOCUMENT, which lives under its own key now that the
          // list carries metadata only. Without this line a refresh landing on
          // the briefing the user is LOOKING AT updates the list and leaves
          // the open document stale — AC-4.2 failing silently, with the
          // freshness line in the header disagreeing with the content under
          // it. The two keys do not collide: react-query matches element-wise,
          // so ['brief-tab'] never prefix-matches ['brief-tabs'].
          queryClient.invalidateQueries({ queryKey: ['brief-tab'] })
          break
        }

        case ControlMessageType.DESK_TODO_SYNC: {
          // The user's desk to-do plate changed (self-capture, patch,
          // reorder, delete, or an agent published a to-do). Invalidate the
          // list query; useTodos refetches and the To-do rail re-renders.
          queryClient.invalidateQueries({ queryKey: ['desk-todos'] })
          break
        }

        case ControlMessageType.DESK_SOP_SYNC: {
          // The owner's SOP library changed — in THIS session or, more to the
          // point, in another one of their tabs/devices. The server fans the
          // envelope out to every live session, so invalidating here is what
          // keeps the SOP rail consistent everywhere without a reload.
          queryClient.invalidateQueries({ queryKey: ['desk-sops'] })
          break
        }

        case ControlMessageType.DESK_LABEL_SYNC: {
          // The owner's label vocabulary moved — in this session, in another
          // tab, by voice through the assistant, or as a side effect of an
          // agent publishing a to-do with a slug that was not registered yet.
          const p = envelope.payload as DeskLabelSyncPayload
          // A merge has to be FOLLOWED, not just noticed: record what `slug`
          // became so the reconcile can re-point a live filter at the target.
          // Only the envelope carries this for a tab that did not make the
          // call, which is why the field exists.
          if (p.action === 'merge' && p.slug && p.into) {
            useDeskLabelViewStore.getState().noteMerge(p.slug, p.into)
          }
          queryClient.invalidateQueries({ queryKey: ['desk-labels'] })
          // NOT redundant with the DESK_TODO_SYNC case: delete and merge move
          // both documents and broadcast both envelopes, and invalidating the
          // plate here makes the client converge even when only one of the two
          // lands (a dropped frame, a reconnect race). react-query dedupes
          // concurrent invalidations of the same key, so it costs nothing.
          queryClient.invalidateQueries({ queryKey: ['desk-todos'] })
          break
        }

        case ControlMessageType.DESK_READ_STATE_SYNC: {
          // Another of this owner's sessions signed a desk card off. Merge the
          // watermark (last-writer-wins on updated_at) so this session's desk
          // drops the card live, then invalidate the hydration query so its
          // cache stays coherent. The hub fans this out to every live session of
          // the owner, so it reaches all their connected devices — but it is
          // still best-effort (a device that was asleep or reconnecting never
          // sees it), and the GET hydration on mount/focus is what guarantees
          // convergence.
          const p = envelope.payload as DeskReadStateSyncPayload
          useUnreadStore
            .getState()
            .mergeServerReadState(
              deskRoomKey(p.project_id),
              p.last_seen_message_id,
              p.updated_at,
            )
          queryClient.invalidateQueries({ queryKey: ['desk-read-state'] })
          // Re-order the "Recently done" section live: signing a card off
          // on any session bumps it to the top of this feed. The bare prefix
          // matches every windowed key (['desk-sign-offs', sinceIso]).
          queryClient.invalidateQueries({ queryKey: ['desk-sign-offs'] })
          break
        }

        case ControlMessageType.PROJECT_REPORT_SYNC: {
          // The coordinator upserted / deleted the project's interactive
          // report. Invalidate the per-project query so ProjectView's
          // Report tab refetches and re-renders in place.
          const p = envelope.payload as { project_id?: string }
          if (p?.project_id) {
            queryClient.invalidateQueries({
              queryKey: ['project-report', p.project_id],
            })
          }
          break
        }

        case ControlMessageType.PROJECT_PLAN_SYNC: {
          // PLAN.md or its sidecar moved. Invalidate and REFETCH — never patch
          // the local model from this envelope: `sections` is a hint for what
          // to highlight, not a delta to apply, and after the refetch the
          // previous body is gone anyway.
          //
          // The project lists ride along because `PlanSummary` (and with it
          // `open_notes_for_you`, the integer the execution gate reads) hangs
          // on the project record. Leaving them out is how the tab and the desk
          // card come to disagree about one number.
          const p = envelope.payload as { project_id?: string }
          if (p?.project_id) {
            queryClient.invalidateQueries({
              queryKey: ['project-plan', p.project_id],
            })
            queryClient.invalidateQueries({
              queryKey: ['project-plan-versions', p.project_id],
            })
            queryClient.invalidateQueries({ queryKey: ['project', p.project_id] })
            queryClient.invalidateQueries({ queryKey: ['user-projects'] })
            queryClient.invalidateQueries({ queryKey: ['all-projects'] })
          }
          break
        }

        case ControlMessageType.HUB_DELIVERY_STATE: {
          // One message to another server moved. Merged by state_at, so a
          // frame that arrives after a newer poll changes nothing.
          const p = envelope.payload as HubDeliveryStatePayload
          if (p?.project_id && p.delivery?.message_id) mergeDeliveriesInto(queryClient, p.project_id, [p.delivery])
          break
        }

        case ControlMessageType.HUB_BRIDGE_DELIVERY: {
          // A workroom's relay to a retained agent moved: merged into that
          // room's delivery lines (a relay only moves forward).
          const p = envelope.payload as HubBridgeDeliveryPayload
          if (p?.project_id && p.chatroom_name && p.delivery?.room_message_id) mergeBridgeDeliveryInto(queryClient, p)
          break
        }

        case ControlMessageType.CHATROOM_FLOW_CHANGED: {
          // A room's outside messages stopped or reopened: the strip and the
          // control follow from the frame, no refetch.
          const p = envelope.payload as ChatroomFlowChangedPayload
          if (p?.project_id && p.chatroom_name && p.flow) applyRoomFlow(queryClient, p)
          break
        }

        case ControlMessageType.HUB_CHANNEL_STATUS: {
          // The full, masked Hub channel of one of the user's agents: the
          // card replaces its whole state from it.
          const p = envelope.payload as HubChannelStatusPayload
          if (p?.agent_full_name && p.channel) replaceHubChannel(queryClient, p.agent_full_name, p.channel)
          break
        }

        case ControlMessageType.HOST_SYNC: {
          // One of the user's computers connected, disconnected, or re-reported
          // what is running on it. Invalidate and refetch — the envelope is a
          // cursor, and the roster it points at is the whole answer.
          //
          // This is what makes "your computer is on, but none of your agents are
          // running" appear WITHOUT a poll: the machine's socket is the signal,
          // and its 30-second self-scan lands here as a fresh roster.
          queryClient.invalidateQueries({ queryKey: ['computers'] })
          break
        }

        case ControlMessageType.INSTALL_SYNC: {
          // The one-command install on the user's machine reported a step.
          // Refetch rather than apply the payload: the run is defined by the
          // REST route, and a client that assembled its own copy from cursors
          // would be a second definition to keep in step.
          queryClient.invalidateQueries({ queryKey: ['install-progress'] })
          // The install's later steps are exactly the ones that change what the
          // server OBSERVES -- a computer connects, agents come online. Those
          // rows are driven by their own queries, and the welcome page is
          // usually the only thing on screen while this happens, so refresh
          // them here too rather than waiting for a separate envelope.
          queryClient.invalidateQueries({ queryKey: ['computers'] })
          queryClient.invalidateQueries({ queryKey: ['agents'] })
          break
        }

        case ControlMessageType.RUNNER_VERSIONS: {
          // Hand the RAW payload to the store. apply() owns the "is this a
          // well-formed snapshot?" decision so there is exactly one gate, and
          // the routing test can feed a raw frame end-to-end.
          useRunnerVersionStore.getState().apply(envelope.payload)
          // Re-read the config on every push. This is what preserves "editing
          // announcements.json takes effect with no server restart"; the ETag
          // (§2.2) makes it a 304 in the common case. cancelRefetch: false:
          // a runner restart wave pushes once per runner, and cancelling the
          // in-flight fetch on each one left a trail of aborted requests.
          queryClient.invalidateQueries(
            { queryKey: ['announcements'] },
            { cancelRefetch: false },
          )
          break
        }
      }
    }

    // After a reconnect, catch up on everything a push would have touched
    // while disconnected (we don't know which projects changed). Skips the
    // initial connect — mount already fetches fresh.
    //
    // This used to invalidate every key at once, the instant the socket came
    // back. That burst (one request per mounted query — dozens on My Desk)
    // could stall the server long enough for the connection to drop again, and
    // the next reconnect re-sent the same burst: a self-sustaining loop. Now:
    //   - the catch-up waits RECONNECT_SETTLE_MS, and a reconnect inside that
    //     window restarts the wait, so a flapping socket produces ONE catch-up
    //     after it stabilizes, not one per flap;
    //   - keys refresh in tiers, most visible first, RECONNECT_TIER_GAP_MS
    //     apart, and a tier is skipped if the socket dropped again meanwhile
    //     (the next reconnect redoes the whole catch-up);
    //   - per-project fan-out lists (['chatrooms'], ['chatroom']) are only
    //     marked stale: they refetch when next mounted, and a room created
    //     while disconnected still arrives via the next CHANGELOG_UPDATE for
    //     that project.
    // ['unread'] is deliberately absent: it was dropped with the sidebar unread
    // badge. Any future ['unread']-shaped feature must re-add itself here
    // rather than assume coverage.
    const reconnectTiers: unknown[][][] = [
      // Tier 0 — what the user is looking at: the desk feed and lists, the
      // open room, and the read watermarks that gate the desk lanes.
      [
        [DESK_LATEST_MESSAGES_KEY],
        ['user-projects'],
        ['all-projects'],
        ['messages'],
        ['desk-read-state'],
        ['desk-sign-offs'],
        // THE PLATE AND ITS VOCABULARY. A DESK_TODO_SYNC emitted while the
        // socket was down — laptop asleep, network blip, server restart, the
        // reconnect backoff window — is simply gone, and `['desk-todos']` is
        // `staleTime: 0` with nothing to trigger it: on a focused tab
        // react-query will not refetch on its own, so a stale ticket chip
        // ("Working" on a project the user already marked done) survives until
        // some UNRELATED to-do or label sync happens to land.
        ['desk-todos'],
        ['desk-labels'],
      ],
      // Tier 1 — secondary state.
      [
        ['project'],
        ['agents'],
        // Same argument for the briefings: BRIEF_TAB_SYNC invalidates both the
        // list and the open document, so a reconnect has to cover both or the
        // briefing the user is LOOKING AT stays stale. ['brief-tab'] does not
        // prefix-match ['brief-tabs'] — react-query matches element-wise.
        ['brief-tabs'],
        ['brief-tab'],
        // Same argument as the plate, and sharper: a HOST_SYNC missed while
        // the socket was down leaves the Computers page asserting that a
        // machine is online when it may have slept hours ago.
        ['computers'],
        // A user watching the welcome page through a socket blip would otherwise
        // see the install freeze on whichever step was last reported.
        ['install-progress'],
        // Belt-and-braces: the server re-arms the initial RUNNER_VERSIONS push
        // on every socket reconnect, so `runners` resyncs on its own. This
        // covers the config half.
        ['announcements'],
      ],
      // Tier 2 — file payloads (the heaviest responses).
      [
        ['files'],
        ['fileContent'],
        ['fileBlobContent'],
      ],
    ]
    const staleOnlyKeys = [['chatrooms'], ['chatroom']]

    let reconnectTimers: ReturnType<typeof setTimeout>[] = []
    const clearReconnectTimers = () => {
      reconnectTimers.forEach(clearTimeout)
      reconnectTimers = []
    }
    const handleReconnect = (isReconnect: boolean) => {
      if (!isReconnect) return
      clearReconnectTimers()
      reconnectTimers = reconnectTiers.map((keys, tier) =>
        setTimeout(() => {
          if (!wsManager.isConnected()) return
          if (tier === 0) {
            for (const queryKey of staleOnlyKeys) {
              queryClient.invalidateQueries({ queryKey, refetchType: 'none' })
            }
          }
          for (const queryKey of keys) {
            queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false })
          }
        }, RECONNECT_SETTLE_MS + tier * RECONNECT_TIER_GAP_MS),
      )
    }

    const unsubscribeMessages = wsManager.onAny(handleMessage)
    const unsubscribeConnect = wsManager.onConnect(handleReconnect)
    return () => {
      clearReconnectTimers()
      unsubscribeMessages()
      unsubscribeConnect()
    }
  }, [queryClient])
}

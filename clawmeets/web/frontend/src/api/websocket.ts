/**
 * WebSocket manager for real-time updates.
 * Connects to the server and dispatches events.
 */

import { ControlMessageType } from '../types'
import type { ControlEnvelope, ResyncPayload } from '../types'

type WebSocketHandler = (envelope: ControlEnvelope) => void

interface WebSocketManagerState {
  ws: WebSocket | null
  handlers: Map<ControlMessageType, Set<WebSocketHandler>>
  connectHandlers: Set<(isReconnect: boolean) => void>
  reconnectAttempts: number
  reconnectDelay: number
  agentId: string | null
  userId: string | null
  token: string | null
  mode: 'agent' | 'user' | null
  heartbeatInterval: ReturnType<typeof setInterval> | null
  intentionalClose: boolean
  hasEverConnected: boolean
  resyncTimer: ReturnType<typeof setTimeout> | null
}

// Reconnect backoff cap; the server closes with these codes when retrying is pointless.
const MAX_RECONNECT_DELAY_MS = 30_000
// Floor under the full-jitter draw, so rand(0, backoff) can't schedule a retry
// at ~0ms against a server that is still down.
const MIN_RECONNECT_DELAY_MS = 250
const CLOSE_AUTH_FAILED = 4001
const CLOSE_PARTICIPANT_GONE = 4004
// Advertised in the auth frame: this client acts on RESYNC. Without it the
// server closes the socket with 1012 instead, and the reconnect catches up.
const RESYNC_CAPABILITY = 'resync'
// Used when a RESYNC payload carries no usable jitter_s (server default).
const DEFAULT_RESYNC_JITTER_S = 15

class WebSocketManager {
  private state: WebSocketManagerState = {
    ws: null,
    handlers: new Map(),
    connectHandlers: new Set(),
    reconnectAttempts: 0,
    reconnectDelay: 1000,
    agentId: null,
    userId: null,
    token: null,
    mode: null,
    heartbeatInterval: null,
    intentionalClose: false,
    hasEverConnected: false,
    resyncTimer: null,
  }

  connect(agentId: string, token: string): void {
    if (this.state.ws?.readyState === WebSocket.OPEN ||
        this.state.ws?.readyState === WebSocket.CONNECTING) {
      return
    }

    this.state.agentId = agentId
    this.state.token = token
    this.state.mode = 'agent'

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = import.meta.env.DEV ? 'localhost:4567' : window.location.host
    const url = `${protocol}//${host}/ws/${agentId}?token=${encodeURIComponent(token)}`

    this._setupWebSocket(url)
  }

  connectAsUser(userId: string, token: string): void {
    if (this.state.ws?.readyState === WebSocket.OPEN ||
        this.state.ws?.readyState === WebSocket.CONNECTING) {
      return
    }

    this.state.userId = userId
    this.state.token = token
    this.state.mode = 'user'

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = import.meta.env.DEV ? 'localhost:4567' : window.location.host
    const url = `${protocol}//${host}/ws/user/${userId}?token=${encodeURIComponent(token)}`

    this._setupWebSocket(url)
  }

  private _setupWebSocket(url: string): void {
    this.state.intentionalClose = false
    this.state.ws = new WebSocket(url)

    this.state.ws.onopen = () => {
      // Send auth message with token (server expects this after connection)
      if (this.state.token) {
        this.state.ws?.send(JSON.stringify({
          token: this.state.token,
          capabilities: [RESYNC_CAPABILITY],
        }))
      }
      this.state.reconnectAttempts = 0
      this._startHeartbeat()
      const isReconnect = this.state.hasEverConnected
      this.state.hasEverConnected = true
      this._fireConnectHandlers(isReconnect)
    }

    this.state.ws.onmessage = (event) => {
      try {
        const envelope: ControlEnvelope = JSON.parse(event.data)
        if (envelope.type === ControlMessageType.RESYNC) {
          this._scheduleResync(envelope.payload as ResyncPayload)
        }
        this.dispatch(envelope)
      } catch (error) {
        console.error('[WebSocket] Failed to parse message:', error)
      }
    }

    this.state.ws.onclose = (event) => {
      this._stopHeartbeat()
      // The reconnect's onopen runs the same catch-up itself.
      this._clearResync()
      this.state.ws = null

      // Don't reconnect if disconnect() was called intentionally
      if (this.state.intentionalClose) {
        return
      }

      // Server-signaled dead ends: retrying with the same token re-fails
      // identically. Auth recovery happens via the HTTP 401 → token refresh
      // path, which reconnects with the fresh token.
      if (event.code === CLOSE_AUTH_FAILED || event.code === CLOSE_PARTICIPANT_GONE) {
        console.warn(`[WebSocket] Closed with code ${event.code}, not reconnecting`)
        return
      }

      // Reconnect indefinitely with capped exponential backoff + FULL JITTER.
      //
      // The backoff alone is deterministic, so every session dropped by the same
      // event (a server restart, a tunnel blip) computes the identical delay and
      // re-arrives in the same ~1s window — a phase-aligned herd. Batching divides
      // that herd's amplitude; only jitter de-aligns its arrival, so both are
      // needed. Full jitter (AWS "Exponential Backoff and Jitter": sleep =
      // rand(0, backoff)) smears arrivals uniformly across the whole window
      // instead of stacking them at its edge. The floor keeps rand(0, …) off ~0ms
      // so a flapping server still gets a breath between attempts.
      this.state.reconnectAttempts++
      const backoff = Math.min(
        this.state.reconnectDelay * Math.pow(2, this.state.reconnectAttempts - 1),
        MAX_RECONNECT_DELAY_MS,
      )
      const delay = Math.max(MIN_RECONNECT_DELAY_MS, Math.random() * backoff)
      setTimeout(() => {
        if (this.state.mode === 'agent' && this.state.agentId && this.state.token) {
          this.connect(this.state.agentId, this.state.token)
        } else if (this.state.mode === 'user' && this.state.userId && this.state.token) {
          this.connectAsUser(this.state.userId, this.state.token)
        }
      }, delay)
    }

    this.state.ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error)
    }
  }

  private _fireConnectHandlers(isReconnect: boolean): void {
    this.state.connectHandlers.forEach((handler) => {
      try {
        handler(isReconnect)
      } catch (error) {
        console.error('[WebSocket] Connect handler error:', error)
      }
    })
  }

  // RESYNC: the server asks for the catch-up a reconnect would have run, so
  // run exactly that — the connect handlers with isReconnect = true. Both
  // scopes do the same here: the browser's reconnect catch-up is one refetch
  // of every push-refreshed key, and over-refreshing is safe. Jittered so a
  // whole deployment does not refetch in the same second; a RESYNC arriving
  // while one is pending is folded into it.
  private _scheduleResync(payload: ResyncPayload | undefined): void {
    if (this.state.resyncTimer !== null) {
      return
    }
    const jitterS = typeof payload?.jitter_s === 'number' && payload.jitter_s >= 0
      ? payload.jitter_s
      : DEFAULT_RESYNC_JITTER_S
    this.state.resyncTimer = setTimeout(() => {
      this.state.resyncTimer = null
      this._fireConnectHandlers(true)
    }, Math.random() * jitterS * 1000)
  }

  private _clearResync(): void {
    if (this.state.resyncTimer !== null) {
      clearTimeout(this.state.resyncTimer)
      this.state.resyncTimer = null
    }
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this.state.heartbeatInterval = setInterval(() => {
      if (this.state.ws?.readyState === WebSocket.OPEN) {
        this.state.ws.send(JSON.stringify({ type: 'heartbeat', payload: {} }))
      }
    }, 30000) // Send heartbeat every 30 seconds
  }

  private _stopHeartbeat(): void {
    if (this.state.heartbeatInterval) {
      clearInterval(this.state.heartbeatInterval)
      this.state.heartbeatInterval = null
    }
  }

  disconnect(): void {
    this.state.intentionalClose = true
    this._stopHeartbeat()
    this._clearResync()
    if (this.state.ws) {
      this.state.ws.close()
      this.state.ws = null
    }
    this.state.agentId = null
    this.state.userId = null
    this.state.token = null
    this.state.mode = null
    this.state.reconnectAttempts = 0
  }

  // Fires after each successful (re)connection; isReconnect is false only
  // for the first connection of this page load.
  onConnect(handler: (isReconnect: boolean) => void): () => void {
    this.state.connectHandlers.add(handler)

    // Return unsubscribe function
    return () => {
      this.state.connectHandlers.delete(handler)
    }
  }

  on(type: ControlMessageType, handler: WebSocketHandler): () => void {
    if (!this.state.handlers.has(type)) {
      this.state.handlers.set(type, new Set())
    }
    this.state.handlers.get(type)!.add(handler)

    // Return unsubscribe function
    return () => {
      this.state.handlers.get(type)?.delete(handler)
    }
  }

  onAny(handler: WebSocketHandler): () => void {
    const unsubscribers: Array<() => void> = []
    // Subscribe to the notification-only protocol types
    const types: ControlMessageType[] = [
      ControlMessageType.CHANGELOG_UPDATE,
      ControlMessageType.AGENT_STATUS_CHANGE,
      ControlMessageType.PROJECT_DELETED,
      ControlMessageType.ACTIVE_WORK_CHANGE,
      ControlMessageType.MCP_AUTH_URL_FOR_USER,
      ControlMessageType.SKILL_AUTH_URL_FOR_USER,
      ControlMessageType.DESK_READ_STATE_SYNC,
      ControlMessageType.DESK_TODO_SYNC,
      ControlMessageType.DESK_SOP_SYNC,
      ControlMessageType.DESK_LABEL_SYNC,
      ControlMessageType.BRIEF_TAB_SYNC,
      ControlMessageType.AGENT_CARD_UPDATE,
      ControlMessageType.PROJECT_REPORT_SYNC,
      ControlMessageType.PROJECT_PLAN_SYNC,
      // onAny() is NOT a wildcard despite the name — dispatch() looks the type
      // up in the handler map, so a type present in the ControlMessageType enum
      // but missing HERE is dropped with no handler, no warning and no
      // console.error. It type-checks, it lints, and it ships completely inert:
      // the same failure signature as a banner that never renders. Guarded at
      // runtime by useWebSocket.runnerVersions.test.tsx — a grep cannot catch it.
      ControlMessageType.RUNNER_VERSIONS,
      // Computers page + install progress. Were missing from this list, so
      // env-var saves / start / stop spun until their 120s timeout. Guarded by
      // useWebSocket.hostSync.test.tsx.
      ControlMessageType.HOST_SYNC,
      ControlMessageType.INSTALL_SYNC,
      // The ClawMeets Hub: delivery lines and the Hub channel card. Guarded by
      // useWebSocket.hub.test.tsx.
      ControlMessageType.HUB_DELIVERY_STATE,
      ControlMessageType.HUB_CHANNEL_STATUS,
      // Agent access: a workroom's relays to retained agents, and a room's
      // inbound flow. Guarded by useWebSocket.hub.test.tsx.
      ControlMessageType.HUB_BRIDGE_DELIVERY,
      ControlMessageType.CHATROOM_FLOW_CHANGED,
    ]
    for (const type of types) {
      unsubscribers.push(this.on(type, handler))
    }
    return () => {
      unsubscribers.forEach((unsub) => unsub())
    }
  }

  private dispatch(envelope: ControlEnvelope): void {
    const handlers = this.state.handlers.get(envelope.type)
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(envelope)
        } catch (error) {
          console.error('[WebSocket] Handler error:', error)
        }
      })
    }
  }

  send(envelope: ControlEnvelope): void {
    if (this.state.ws?.readyState === WebSocket.OPEN) {
      this.state.ws.send(JSON.stringify(envelope))
    } else {
      console.warn('[WebSocket] Cannot send: not connected')
    }
  }

  isConnected(): boolean {
    return this.state.ws?.readyState === WebSocket.OPEN
  }
}

// Export singleton instance
export const wsManager = new WebSocketManager()

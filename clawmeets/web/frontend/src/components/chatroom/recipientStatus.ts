import type { AgentCard, ChatLogEntry, ChatMessage } from '../../types'
import { isBatchTimeoutEvent, isChatMessage, isAgentOfflineEvent } from '../../types'

export type RecipientStatus =
  | 'processing'
  | 'completed'
  | 'canceled'
  | 'timed_out'
  | 'offline'
  | 'pending'

// Content marker for the server-posted ack that follows a cancel request.
// Matches the literal content in `server/routes/messages.py::cancel_chatroom_invocation`.
const CANCEL_ACK_CONTENT = 'Message canceled.'

export interface RecipientStatusIndex {
  resolve: (message: ChatMessage, recipientKey: string) => RecipientStatus
  resolveAgentId: (recipientKey: string) => string
  /**
   * AC-3.7. True when this recipient timed out AND the server re-checked its
   * runner at the moment the timeout fired and found it disconnected.
   *
   * Deliberately NOT a `RecipientStatus` member. The status stays 'timed_out'
   * because the server behaviour is identical — the batch expired, the runner
   * was CANCEL_LLM'd, the row is terminal — and folding this into the union
   * would put a second terminal state ahead of the reply scan for no reason.
   * What changes is only what the chip and the note SAY, so it travels
   * alongside the status rather than inside it.
   *
   * This is not the same thing as the 'offline' status. 'offline' means the
   * agent never received the message; this means it did receive it, worked on
   * it, and its runner died before it answered. The two take opposite remedies
   * and must never be merged.
   */
  isOfflineAtTimeout: (message: ChatMessage, recipientKey: string) => boolean
  /**
   * Active agents not already represented inline under an @mention
   * (e.g. coordinator self-batches triggered by BATCH_COMPLETE). The
   * last message in the room hosts their processing rows so the UX
   * reads as one signal — there is no separate typing bar.
   */
  orphanProcessingAgentIds: string[]
}

export function buildRecipientStatusIndex(
  logEntries: ChatLogEntry[],
  agents: AgentCard[],
  activeParticipantIds: readonly string[],
): RecipientStatusIndex {
  const activeSet = new Set(activeParticipantIds)

  const idByKey = new Map<string, string>()
  for (const a of agents) {
    idByKey.set(a.id, a.id)
    if (a.name) idByKey.set(a.name, a.id)
  }
  const resolveAgentId = (key: string) => idByKey.get(key) ?? key

  type AgentEvent = { ts: number; kind: 'reply' | 'cancel' }
  const latestAddressingMessageId = new Map<string, string>()
  const eventsByAgentId = new Map<string, AgentEvent[]>()
  const addressingTsByAgentId = new Map<string, number[]>()
  // (message_id of the @mention) → set of agent ids that timed out on it.
  // Lookup is keyed by message.id at resolve() time, matching the same key
  // used in latestAddressingMessageId.
  const timedOutByMessageId = new Map<string, Set<string>>()
  // (message_id of the @mention) → set of agent ids that had no live runner
  // when it was dispatched. Same key shape as timedOutByMessageId above; both
  // are looked up by message.id at resolve() time.
  const offlineByMessageId = new Map<string, Set<string>>()
  // (message_id of the @mention) → set of agent ids that were still
  // disconnected when the timeout fired. Always a subset of the timed-out set
  // for the same message; see `isOfflineAtTimeout`.
  const offlineAtTimeoutByMessageId = new Map<string, Set<string>>()

  const chatMessages: ChatMessage[] = []
  for (const entry of logEntries) {
    if (isBatchTimeoutEvent(entry)) {
      const set = timedOutByMessageId.get(entry.message_id) ?? new Set<string>()
      for (const pid of entry.timed_out_participants) set.add(pid)
      timedOutByMessageId.set(entry.message_id, set)
      // Absent on every batch_timeout row written before AC-2.9 added the
      // field, which is why it is read defensively rather than destructured —
      // those rows must keep rendering exactly as they did.
      const offline = entry.offline_participants
      if (offline && offline.length > 0) {
        const atTimeout =
          offlineAtTimeoutByMessageId.get(entry.message_id) ?? new Set<string>()
        for (const pid of offline) atTimeout.add(pid)
        offlineAtTimeoutByMessageId.set(entry.message_id, atTimeout)
      }
      continue
    }
    if (isAgentOfflineEvent(entry)) {
      const set = offlineByMessageId.get(entry.message_id) ?? new Set<string>()
      for (const pid of entry.offline_participants) set.add(pid)
      offlineByMessageId.set(entry.message_id, set)
      continue
    }
    if (!isChatMessage(entry)) continue
    chatMessages.push(entry)

    const senderId = entry.from_participant_id
    const ts = new Date(entry.ts).getTime()
    if (entry.is_ack) {
      if (senderId && entry.content === CANCEL_ACK_CONTENT) {
        const list = eventsByAgentId.get(senderId) ?? []
        list.push({ ts, kind: 'cancel' })
        eventsByAgentId.set(senderId, list)
      }
      continue
    }
    if (senderId) {
      const list = eventsByAgentId.get(senderId) ?? []
      list.push({ ts, kind: 'reply' })
      eventsByAgentId.set(senderId, list)
    }
    for (const recipientKey of entry.expects_response_from ?? []) {
      const agentId = resolveAgentId(recipientKey)
      latestAddressingMessageId.set(agentId, entry.id)
      const list = addressingTsByAgentId.get(agentId) ?? []
      list.push(ts)
      addressingTsByAgentId.set(agentId, list)
    }
  }

  const resolve = (message: ChatMessage, recipientKey: string): RecipientStatus => {
    const agentId = resolveAgentId(recipientKey)

    // BATCH_TIMEOUT for (this @mention, this agent) is terminal: the
    // runner has been CANCEL_LLM'd and any reply that lands afterwards is
    // a no-op on the server. Check before the reply/cancel scan so a
    // ghost late reply can't flip us back to 'completed'.
    if (timedOutByMessageId.get(message.id)?.has(agentId)) return 'timed_out'

    const msgTs = new Date(message.ts).getTime()

    // The response window for this invocation ends when the same agent is
    // addressed again — a later cancel ack / reply from that point on
    // belongs to the *next* invocation, not this one.
    let nextAddressingTs = Infinity
    for (const ts of addressingTsByAgentId.get(agentId) ?? []) {
      if (ts > msgTs && ts < nextAddressingTs) nextAddressingTs = ts
    }

    // First event from the agent inside (msgTs, nextAddressingTs) resolves
    // this invocation. Events are in chronological order so the first match
    // wins; we can short-circuit once we pass the window.
    for (const ev of eventsByAgentId.get(agentId) ?? []) {
      if (ev.ts <= msgTs) continue
      if (ev.ts >= nextAddressingTs) break
      return ev.kind === 'cancel' ? 'canceled' : 'completed'
    }

    // No runner was connected when this @mention was dispatched, and nothing
    // has answered since. Deliberately checked AFTER the reply/cancel scan and
    // not alongside 'timed_out' at the top: a connect can race the liveness
    // check, so a genuine reply landing later must still win. It is ahead of
    // 'processing' so an agent that never received the message can never show
    // an in-flight indicator.
    if (offlineByMessageId.get(message.id)?.has(agentId)) return 'offline'

    const isLatestAddressing = latestAddressingMessageId.get(agentId) === message.id
    if (activeSet.has(agentId) && isLatestAddressing) return 'processing'
    return 'pending'
  }

  const isOfflineAtTimeout = (message: ChatMessage, recipientKey: string): boolean => {
    const agentId = resolveAgentId(recipientKey)
    // Gated on the timed-out set as well as the offline one. The contract says
    // offline_participants is a subset of timed_out_participants, but this is
    // the only place that assumption is load-bearing, so it is enforced rather
    // than trusted: a malformed row can then only under-report, never paint an
    // "offline at timeout" chip on a row that did not time out.
    if (!timedOutByMessageId.get(message.id)?.has(agentId)) return false
    return offlineAtTimeoutByMessageId.get(message.id)?.has(agentId) ?? false
  }

  // An agent that has any inline @mention row is represented there — its status
  // (completed / processing / timed_out / …) is shown on that row. Only agents
  // with NO inline row (e.g. a coordinator self-batch triggered by
  // BATCH_COMPLETE) may surface as orphans. Guarding on "addressed at all"
  // (not just "resolved to processing") stops a stale activeWork entry from
  // resurrecting an already-completed agent as a ghost processing row.
  const addressedAgentIds = new Set<string>()
  for (const msg of chatMessages) {
    if (msg.is_ack) continue
    for (const recipientKey of msg.expects_response_from ?? []) {
      addressedAgentIds.add(resolveAgentId(recipientKey))
    }
  }
  const orphanProcessingAgentIds = activeParticipantIds.filter(
    (id) => !addressedAgentIds.has(id),
  )

  return { resolve, resolveAgentId, isOfflineAtTimeout, orphanProcessingAgentIds }
}

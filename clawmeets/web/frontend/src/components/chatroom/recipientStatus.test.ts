import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  ChatBatchTimeoutEvent,
  ChatLogEntry,
  ChatMessage,
  ChatAgentOfflineEvent,
} from '../../types'
import { isChatMessage } from '../../types'
import { buildRecipientStatusIndex } from './recipientStatus'

/**
 * The AWAITING-forever bug.
 *
 * `batch_timeout` rows are the ONLY signal that flips a delegation row from
 * ● awaiting to ● timed out — the server posts no message the index can read,
 * and the agent stays online, so nothing else in the stream contradicts
 * "still working". DMChatView used to `.filter(isChatMessage)` before calling
 * this builder, which silently dropped exactly those rows and left every
 * timed-out DM stuck on AWAITING. That is invisible to a test that only feeds
 * messages in, which is why the pending-vs-timed-out pair is pinned here.
 */

const AGENT = 'agent-1'
const MENTION_ID = 'm-mention'

function mention(): ChatMessage {
  return {
    entry_type: 'message',
    id: MENTION_ID,
    ts: '2026-08-13T02:57:02.761692Z',
    from_participant_id: 'user-1',
    from_participant_name: 'clawmeets',
    content: 'Please review the branch and merge it back to main',
    expects_response_from: [AGENT],
    is_ack: false,
  }
}

function ack(): ChatMessage {
  return {
    entry_type: 'message',
    id: 'm-ack',
    ts: '2026-08-13T02:57:08.864263Z',
    from_participant_id: AGENT,
    from_participant_name: 'clawmeets-code_reviewer',
    content: 'Message received, processing...',
    expects_response_from: [],
    is_ack: true,
  }
}

function timeout(): ChatBatchTimeoutEvent {
  return {
    entry_type: 'batch_timeout',
    ts: '2026-08-13T03:27:31.520049Z',
    message_id: MENTION_ID,
    coordinator_id: 'user-1',
    responded_participants: [],
    timed_out_participants: [AGENT],
  }
}

function lateReply(): ChatMessage {
  return {
    entry_type: 'message',
    id: 'm-late',
    ts: '2026-08-13T03:57:00.000000Z',
    from_participant_id: AGENT,
    from_participant_name: 'clawmeets-code_reviewer',
    content: 'Merged and pushed to main.',
    expects_response_from: [],
    is_ack: false,
  }
}

function offline(participants: string[] = [AGENT]): ChatAgentOfflineEvent {
  return {
    entry_type: 'agent_offline',
    ts: '2026-08-13T02:57:02.900000Z',
    message_id: MENTION_ID,
    coordinator_id: 'user-1',
    offline_participants: participants,
    dispatched_participants: [],
  }
}

function statusOf(entries: ChatLogEntry[], activeIds: string[] = []) {
  return buildRecipientStatusIndex(entries, [], activeIds).resolve(mention(), AGENT)
}

describe('buildRecipientStatusIndex — batch_timeout handling', () => {
  it('flips the recipient to timed_out when the batch_timeout row is present', () => {
    expect(statusOf([mention(), ack(), timeout()])).toBe('timed_out')
  })

  it('falls back to pending when batch_timeout rows are filtered out', () => {
    // The exact regression: same stream, batch_timeout stripped by a caller.
    expect(statusOf([mention(), ack()])).toBe('pending')
  })

  it('keeps timed_out even while the agent shows as actively processing', () => {
    // The agent is online and the runner may still be grinding (or retrying),
    // but the server has closed the batch — terminal wins over the live signal.
    expect(statusOf([mention(), ack(), timeout()], [AGENT])).toBe('timed_out')
  })

  it('does not let a late reply flip timed_out back to completed', () => {
    expect(statusOf([mention(), ack(), timeout(), lateReply()])).toBe('timed_out')
  })

  it('still resolves completed when the reply beats the timeout', () => {
    expect(statusOf([mention(), ack(), lateReply()])).toBe('completed')
  })

  it('ignores a batch_timeout row aimed at a different @mention', () => {
    const other: ChatBatchTimeoutEvent = { ...timeout(), message_id: 'm-other' }
    expect(statusOf([mention(), ack(), other])).toBe('pending')
  })
})

/**
 * The cases above pin the builder, which was never the broken half — the bug
 * was a caller narrowing the stream on the way in, and every caller is one
 * `.filter()` away from reintroducing it. Nothing in the types objects:
 * `ChatMessage[]` is assignable to `ChatLogEntry[]`. So pin the call sites
 * instead. Cheaper than mounting DMChatView, which drags in the auth store,
 * react-query and react-markdown for a one-argument assertion.
 */
describe('every view feeds buildRecipientStatusIndex the unfiltered stream', () => {
  const VIEWS = ['../dm/DMChatView.tsx', './ChatroomView.tsx']

  it.each(VIEWS)('%s does not narrow the log stream', (relative) => {
    const source = readFileSync(
      fileURLToPath(new URL(relative, import.meta.url)),
      'utf8',
    )
    const call = source.indexOf('buildRecipientStatusIndex(')
    expect(call, 'call site not found — did the view stop using the index?').
      toBeGreaterThan(-1)

    // First argument: from the open paren to the first top-level comma.
    const args = source.slice(call + 'buildRecipientStatusIndex('.length)
    let depth = 0
    let end = 0
    for (; end < args.length; end++) {
      const ch = args[end]
      if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      else if (ch === ',' && depth === 0) break
    }
    expect(args.slice(0, end)).not.toContain('filter')
  })
})


/**
 * agent_offline: the dispatch-time sibling of batch_timeout. Same
 * message_id key, opposite temperament — timeout is terminal because the
 * server CANCEL_LLM'd the runner, whereas an offline row only says nobody was
 * connected at T+0. A runner can connect a moment later (the liveness check
 * races the connect) and answer the queued message, so a real reply must still
 * win. That is why the branch sits AFTER the reply scan, not beside timed_out.
 */
describe('buildRecipientStatusIndex — agent_offline handling', () => {
  it('flips the recipient to offline when the agent_offline row is present', () => {
    expect(statusOf([mention(), offline()])).toBe('offline')
  })

  it('shows offline, never processing, even while the agent is in the active set', () => {
    // AC-3.1: no in-flight indicator for a target known to be offline. The
    // offline branch is ahead of the processing branch for exactly this case.
    expect(statusOf([mention(), offline()], [AGENT])).toBe('offline')
  })

  it('lets a real reply after an offline row win', () => {
    // AC-3.5, the connect race: the runner came up, caught up, and answered.
    expect(statusOf([mention(), offline(), lateReply()])).toBe('completed')
  })

  it('ignores an offline row aimed at a different @mention', () => {
    const other: ChatAgentOfflineEvent = { ...offline(), message_id: 'm-other' }
    expect(statusOf([mention(), other])).toBe('pending')
  })

  it('ignores an offline row that does not name this agent', () => {
    expect(statusOf([mention(), offline(['someone-else'])])).toBe('pending')
  })

  it('keeps timed_out ahead of offline when both rows exist for the message', () => {
    // Terminal beats advisory: the server closed the batch.
    expect(statusOf([mention(), offline(), timeout()])).toBe('timed_out')
  })

  it('resolves each recipient of a mixed message independently', () => {
    // AC-3.4: one agent offline, the other delivered and working.
    const LIVE = 'agent-live'
    const mixed: ChatMessage = { ...mention(), expects_response_from: [AGENT, LIVE] }
    const row: ChatAgentOfflineEvent = {
      ...offline(),
      offline_participants: [AGENT],
      dispatched_participants: [LIVE],
    }
    const index = buildRecipientStatusIndex([mixed, row], [], [LIVE])
    expect(index.resolve(mixed, AGENT)).toBe('offline')
    expect(index.resolve(mixed, LIVE)).toBe('processing')
  })
})

/**
 * `isChatMessage` used to be written as "not a file event and not a timeout
 * event". Because `ChatMessage.entry_type` is optional (legacy rows), every
 * NEW union member silently satisfied it — and the guard's consumers render
 * what it admits (MessageList as a bubble, useDeskUpdates as a room's newest
 * message, ActivityFeed, and the builder below). Adding
 * agent_offline to the union would have shipped that regression under a
 * bug fix, so the guard is positive now. These cases fail if it ever reverts.
 */
describe('isChatMessage admits only messages', () => {
  it('rejects a agent_offline row', () => {
    expect(isChatMessage(offline())).toBe(false)
  })

  it('rejects a batch_timeout row', () => {
    expect(isChatMessage(timeout())).toBe(false)
  })

  it('still admits a legacy row with no entry_type', () => {
    const legacy = { ...mention() }
    delete (legacy as { entry_type?: string }).entry_type
    expect(isChatMessage(legacy)).toBe(true)
  })

  it('admits an explicit message row', () => {
    expect(isChatMessage(mention())).toBe(true)
  })

  it('keeps an offline row out of the addressed-agent scan', () => {
    // The builder's `chatMessages` list feeds orphanProcessingAgentIds. If the
    // guard widened, the offline row would land in it and be read for
    // `expects_response_from` / `from_participant_id` it does not have.
    const index = buildRecipientStatusIndex([offline()], [], [AGENT])
    expect(index.orphanProcessingAgentIds).toEqual([AGENT])
  })
})

/**
 * AC-3.7 — the offline-flavoured timeout.
 *
 * `batch_timeout` with a non-empty `offline_participants` is the OPPOSITE case
 * to an `agent_offline` row: the agent did receive the message and worked on
 * it, and its runner died before it answered. The status stays 'timed_out'
 * because the server behaviour is unchanged (the batch expired, the runner was
 * CANCEL_LLM'd), and the distinction travels alongside it so the chip and the
 * note can say the right thing without a second terminal state jumping ahead
 * of the reply scan.
 */
describe('buildRecipientStatusIndex — offline at timeout', () => {
  function offlineTimeout(offline: string[] = [AGENT]): ChatBatchTimeoutEvent {
    return { ...timeout(), offline_participants: offline }
  }

  function flagOf(entries: ChatLogEntry[], key: string = AGENT) {
    return buildRecipientStatusIndex(entries, [], []).isOfflineAtTimeout(mention(), key)
  }

  it('still resolves to timed_out — the batch really did expire', () => {
    expect(statusOf([mention(), ack(), offlineTimeout()])).toBe('timed_out')
  })

  it('reports the offline-at-timeout flag for the disconnected agent', () => {
    expect(flagOf([mention(), ack(), offlineTimeout()])).toBe(true)
  })

  it('does NOT report it for a plain timeout — the unchanged old behaviour', () => {
    expect(flagOf([mention(), ack(), timeout()])).toBe(false)
  })

  it('does NOT report it for a row written before the field existed', () => {
    // A batch_timeout row on disk from before AC-2.9. No key at all, not an
    // empty list — the exact shape that must keep rendering.
    const legacy = timeout()
    expect('offline_participants' in legacy).toBe(false)
    expect(flagOf([mention(), ack(), legacy])).toBe(false)
    expect(statusOf([mention(), ack(), legacy])).toBe('timed_out')
  })

  it('reports it per agent, not per row, in a mixed timeout', () => {
    const other = 'agent-2'
    const row: ChatBatchTimeoutEvent = {
      ...timeout(),
      timed_out_participants: [AGENT, other],
      offline_participants: [other],
    }
    const entries = [mention(), ack(), row]
    // The one that was merely slow is not painted as offline.
    expect(flagOf(entries, AGENT)).toBe(false)
    expect(flagOf(entries, other)).toBe(true)
  })

  it('ignores an id that is offline but not actually timed out', () => {
    // Defensive: the contract says offline_participants ⊆ timed_out_participants.
    // A malformed row may under-report, never paint a row that did not time out.
    const row: ChatBatchTimeoutEvent = {
      ...timeout(),
      timed_out_participants: [],
      offline_participants: [AGENT],
    }
    expect(flagOf([mention(), ack(), row])).toBe(false)
    expect(statusOf([mention(), ack(), row])).not.toBe('timed_out')
  })

  it('keeps the dispatch-time offline state separate from this one', () => {
    // agent_offline → 'offline', and NOT flagged as offline-at-timeout.
    const entries = [mention(), offline()]
    expect(statusOf(entries)).toBe('offline')
    expect(flagOf(entries)).toBe(false)
  })
})

/**
 * The reconnect race, restated as a test because it is the one behaviour the
 * coordinator flagged as easy to get wrong: an 'offline' status is NOT terminal
 * against a later real reply. The runner's reconnect backoff floor is 2.0s, and
 * the backend now credits a narrowed-out participant's reply into the still-open
 * batch, so a BATCH_COMPLETE whose responders include an agent we marked offline
 * is working as intended and must render as having replied.
 */
describe('buildRecipientStatusIndex — offline is not terminal against a real reply', () => {
  it('lets a reply that lands after the offline row win', () => {
    expect(statusOf([mention(), offline(), lateReply()])).toBe('completed')
  })

  it('still shows offline while nothing has answered', () => {
    expect(statusOf([mention(), offline()])).toBe('offline')
  })

  it('never shows processing for an agent that never received the message', () => {
    // Even with the agent in the active-work set — the false PROCESSING chip
    // on an undelivered message is the entire bug M3 exists to kill.
    expect(statusOf([mention(), offline()], [AGENT])).toBe('offline')
  })
})

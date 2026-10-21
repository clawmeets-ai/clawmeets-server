import { ArrowRight, X } from 'lucide-react'
import type { AgentCard } from '../../types'
import { AgentStatus } from '../../types'
import Avatar from '../common/Avatar'
import type { RecipientStatus } from './recipientStatus'

interface DelegationRowProps {
  displayName: string
  agent?: AgentCard
  status: RecipientStatus
  isCancelling: boolean
  canCancel: boolean
  onCancel: () => void
  /**
   * AC-3.6, ADVISORY ONLY. True when `status` is 'processing' AND the live
   * roster reports this agent offline — i.e. it most likely dropped after its
   * batch had already opened. Roster status is up to 60s stale (useAgents
   * `staleTime`), so this may only de-escalate how the processing chip is
   * painted: static dots and a muted "waiting" in place of confident
   * animation. It never changes `status`, never suppresses a reply, never
   * renders a terminal chip, and never removes the cancel affordance — the
   * batch really is open and really is cancellable.
   */
  advisoryOffline?: boolean
  /**
   * AC-3.7. True when `status` is 'timed_out' AND the server re-checked this
   * agent's runner as the timeout fired and found it disconnected. Unlike
   * `advisoryOffline` this is a server fact, not a stale roster reading, so it
   * is allowed to change the wording of a terminal chip — but it still does
   * not change `status`, because the batch really did expire.
   */
  offlineAtTimeout?: boolean
}

export default function DelegationRow({
  displayName,
  agent,
  status,
  isCancelling,
  canCancel,
  onCancel,
  advisoryOffline = false,
  offlineAtTimeout = false,
}: DelegationRowProps) {
  return (
    <div
      className="flex items-center gap-2.5 px-2.5 py-2 rounded-md"
      style={{
        background: 'var(--bg-rail)',
        border: '1px solid var(--line-1)',
      }}
    >
      <ArrowRight size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      <Avatar
        name={displayName}
        status={agent ? (agent.status as AgentStatus) : undefined}
        size="xs"
      />
      <span
        className="font-mono font-bold"
        style={{
          background: 'var(--accent-softer)',
          color: 'var(--accent-deep)',
          padding: '1px 6px',
          borderRadius: 4,
          fontSize: '0.85em',
        }}
      >
        @{displayName}
      </span>
      <span className="flex-1 min-w-0" />
      <RecipientStatusChip
        status={status}
        onCancel={canCancel ? onCancel : undefined}
        isCancelling={isCancelling}
        advisoryOffline={advisoryOffline}
        offlineAtTimeout={offlineAtTimeout}
      />
    </div>
  )
}

function RecipientStatusChip({
  status,
  onCancel,
  isCancelling,
  advisoryOffline,
  offlineAtTimeout,
}: {
  status: RecipientStatus
  onCancel?: () => void
  isCancelling: boolean
  advisoryOffline: boolean
  offlineAtTimeout: boolean
}) {
  if (status === 'processing') {
    // `advisoryOffline` only de-emphasizes this branch — no bullet, no colour
    // that reads terminal, and the cancel button below is rendered either way.
    return (
      <span
        className="inline-flex items-center gap-1.5"
        title={
          advisoryOffline
            ? "This agent's runner is no longer connected. The message reached it and the batch is still open, so a reply may still arrive."
            : undefined
        }
      >
        <span className="flex gap-0.5 text-gray-500">
          <span
            className={advisoryOffline ? 'font-bold opacity-50' : 'animate-bounce font-bold'}
            style={advisoryOffline ? undefined : { animationDelay: '0ms' }}
          >.</span>
          <span
            className={advisoryOffline ? 'font-bold opacity-50' : 'animate-bounce font-bold'}
            style={advisoryOffline ? undefined : { animationDelay: '150ms' }}
          >.</span>
          <span
            className={advisoryOffline ? 'font-bold opacity-50' : 'animate-bounce font-bold'}
            style={advisoryOffline ? undefined : { animationDelay: '300ms' }}
          >.</span>
        </span>
        <span
          className="font-mono font-bold uppercase"
          style={{
            fontSize: 10,
            color: advisoryOffline ? 'var(--ink-4, #9ca3af)' : 'var(--accent-deep)',
            letterSpacing: '.04em',
          }}
        >
          {advisoryOffline ? 'waiting' : 'processing'}
        </span>
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={isCancelling}
            title="Stop"
            aria-label="Cancel"
            className="ml-0.5 p-0.5 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </span>
    )
  }
  if (status === 'completed') {
    return (
      <span
        className="font-mono font-bold uppercase"
        style={{ fontSize: 10, color: 'var(--prio-quick-fg)', letterSpacing: '.04em' }}
      >
        ● completed
      </span>
    )
  }
  if (status === 'canceled') {
    return (
      <span
        className="font-mono font-bold uppercase"
        style={{ fontSize: 10, color: '#b91c1c', letterSpacing: '.04em' }}
      >
        ● canceled
      </span>
    )
  }
  if (status === 'timed_out') {
    // AC-3.7. Same terminal state, different cause, so the word "timed out" is
    // kept and qualified rather than replaced — the batch really did expire.
    // Amber like ● offline because this one is also fixable from the user's
    // own machine; the plain timeout stays red because nothing the user can do
    // makes an agent that was connected the whole time answer faster.
    if (offlineAtTimeout) {
      return (
        <span
          className="font-mono font-bold uppercase"
          style={{ fontSize: 10, color: '#b45309', letterSpacing: '.04em' }}
          title="This agent received the message, but its runner was no longer connected when the batch timed out"
        >
          ● offline · timed out
        </span>
      )
    }
    return (
      <span
        className="font-mono font-bold uppercase"
        style={{ fontSize: 10, color: '#b91c1c', letterSpacing: '.04em' }}
      >
        ● timed out
      </span>
    )
  }
  if (status === 'offline') {
    // Amber, not the #b91c1c red of canceled / timed out. Red reads "broken";
    // amber reads "did not start, and you can fix it" — truer here, and it
    // keeps offline visually separable from timed out, which after this change
    // means something different (waited and nobody came, vs. nobody was ever
    // there). The state is carried by the word, so colour stays decorative.
    // No cancel affordance: nothing was dispatched, so there is nothing to stop.
    return (
      <span
        className="font-mono font-bold uppercase"
        style={{ fontSize: 10, color: '#b45309', letterSpacing: '.04em' }}
        title="This agent's runner was not connected when the message was sent"
      >
        ● offline
      </span>
    )
  }
  return (
    <span
      className="font-mono font-bold uppercase"
      style={{ fontSize: 10, color: 'var(--ink-4, #9ca3af)', letterSpacing: '.04em' }}
    >
      ● awaiting
    </span>
  )
}

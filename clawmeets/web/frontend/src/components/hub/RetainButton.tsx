import { useState } from 'react'
import type { HubAgent } from '../../api/endpoints/hub'
import { useAgents } from '../../hooks/useAgents'
import { useAuthStore } from '../../stores/authStore'
import { useRetainAgent, useRetainedAgents, useUnretainAgent } from '../../hooks/useAgentAccess'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import { REMOTE_TEXT_CAP, safeRemoteText } from '../../utils/hubDisplay'
import RetainDialog, { retainErrorText } from './RetainDialog'

type RetainTarget = Pick<HubAgent, 'hub_agent_id' | 'name' | 'deployment_name'> &
  Partial<Pick<HubAgent, 'retained' | 'is_local'>>

const labelOf = (a: RetainTarget) =>
  `${safeRemoteText(a.name, REMOTE_TEXT_CAP.name)}@${safeRemoteText(a.deployment_name, REMOTE_TEXT_CAP.name)}`

/** Retained per the agent row, or per the user's retained list (a thread's
 *  stored target carries no flag). */
export function useIsRetained(agent: RetainTarget): boolean {
  const { data: rows } = useRetainedAgents()
  return agent.retained === true || !!rows?.some((r) => r.hub_agent_id === agent.hub_agent_id)
}

/** An agent of this server (is_local) that the signed-in user owns: there is
 *  nothing to retain. Matched by its full name in the user's agent list. */
export function useIsOwnAgent(agent: RetainTarget): boolean {
  const { data: agents } = useAgents()
  const userId = useAuthStore((s) => s.user?.id)
  return !!agent.is_local && !!userId &&
    !!agents?.some((a) => a.name === agent.name && a.registered_by === userId)
}

/**
 * "Retain" on another person's agent, on this server or another, or the
 * "Retained" badge once it is. Retaining opens RetainDialog; the POST sets
 * `retained` on every cached card. The user's own agent gets neither.
 */
export default function RetainButton({ agent, size = 'card' }: { agent: RetainTarget; size?: 'card' | 'header' }) {
  const retained = useIsRetained(agent)
  const retain = useRetainAgent()
  const own = useIsOwnAgent(agent)
  const [open, setOpen] = useState(false)
  if (own) return null
  const label = labelOf(agent)

  if (retained) {
    return (
      <span
        className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[11px] font-semibold"
        data-testid="retained-badge"
      >
        {RETAIN_COPY.retained}
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => { retain.reset(); setOpen(true) }}
        disabled={retain.isPending}
        className={size === 'header'
          ? 'rounded border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50'
          : 'px-2 py-0.5 rounded border border-gray-200 text-[11px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50'}
        data-testid="retain-button"
      >
        {retain.isPending ? RETAIN_COPY.retaining : RETAIN_COPY.retain}
      </button>
      <RetainDialog
        agentLabel={label}
        open={open}
        busy={retain.isPending}
        error={retain.isError ? retainErrorText(retain.error) : null}
        onCancel={() => setOpen(false)}
        onConfirm={() => retain.mutate(agent.hub_agent_id, { onSuccess: () => setOpen(false) })}
      />
    </>
  )
}

/**
 * "Unretain": an item of an agent's ⋯ menu (or a plain button on a retained
 * row), shown only while it is retained. An agent that is in workrooms now
 * asks first ("It leaves N rooms").
 */
export function UnretainAction({ agent, onDone, variant = 'menuitem' }: {
  agent: RetainTarget
  onDone?: () => void
  variant?: 'menuitem' | 'button'
}) {
  const retained = useIsRetained(agent)
  const { data: rows, isLoading } = useRetainedAgents()
  const unretain = useUnretainAgent()
  if (!retained) return null
  // live_rooms comes from the list: wait for it, so the ask is never skipped.
  const live = rows?.find((r) => r.hub_agent_id === agent.hub_agent_id)?.live_rooms ?? 0
  const run = () => {
    if (live > 0 && !window.confirm(RETAIN_COPY.unretainLive(labelOf(agent), live))) return
    unretain.mutate(agent.hub_agent_id, { onSettled: () => onDone?.() })
  }
  return (
    <button
      type="button"
      role={variant === 'menuitem' ? 'menuitem' : undefined}
      disabled={unretain.isPending || isLoading}
      onClick={run}
      className={variant === 'menuitem'
        ? 'block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:text-gray-400'
        : 'text-xs font-semibold text-gray-600 hover:text-red-700 hover:underline disabled:opacity-50'}
      data-testid="unretain"
    >
      {RETAIN_COPY.unretain}
    </button>
  )
}

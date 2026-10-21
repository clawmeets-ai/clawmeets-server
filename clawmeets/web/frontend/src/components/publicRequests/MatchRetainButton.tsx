import { useState } from 'react'
import { Check, Pin } from 'lucide-react'
import { useRetainAgent, useRetainedAgents, useUnretainAgent } from '../../hooks/useAgentAccess'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import RetainDialog, { retainErrorText } from '../hub/RetainDialog'
import { useIsRetained } from '../hub/RetainButton'
import { agentLabel, type DrawerAgent } from './agentView'

/**
 * Retain as this page shows it: a primary "Retain" that turns into a green
 * "Retained", and clicking "Retained" un-retains. Retaining goes through the
 * same dialog and routes as everywhere else; un-retaining an agent that is in
 * workrooms asks first, as UnretainAction does.
 */
export default function MatchRetainButton({ agent, large = false }: { agent: DrawerAgent; large?: boolean }) {
  const target = { hub_agent_id: agent.agent_ref, name: agent.display_name, deployment_name: agent.server ?? '' }
  const retained = useIsRetained(target)
  const { data: rows } = useRetainedAgents()
  const retain = useRetainAgent()
  const unretain = useUnretainAgent()
  const [open, setOpen] = useState(false)
  const label = agentLabel(agent)
  const size = large ? ' lg' : ''

  if (retained) {
    const live = rows?.find((r) => r.hub_agent_id === agent.agent_ref)?.live_rooms ?? 0
    const run = () => {
      if (live > 0 && !window.confirm(RETAIN_COPY.unretainLive(label, live))) return
      unretain.mutate(agent.agent_ref)
    }
    return (
      <button
        type="button"
        className={`pr-btn on${size}`}
        onClick={run}
        disabled={unretain.isPending}
        title={RETAIN_COPY.unretain}
        data-testid="match-retained"
      >
        <Check size={15} strokeWidth={2.6} />
        {RETAIN_COPY.retained}
      </button>
    )
  }
  return (
    <>
      <button
        type="button"
        className={`pr-btn pri${size}`}
        onClick={() => { retain.reset(); setOpen(true) }}
        disabled={retain.isPending}
        data-testid="match-retain"
      >
        <Pin size={15} />
        {retain.isPending ? RETAIN_COPY.retaining : RETAIN_COPY.retain}
      </button>
      <RetainDialog
        agentLabel={label}
        open={open}
        busy={retain.isPending}
        error={retain.isError ? retainErrorText(retain.error) : null}
        onCancel={() => setOpen(false)}
        onConfirm={() => retain.mutate(agent.agent_ref, { onSuccess: () => setOpen(false) })}
      />
    </>
  )
}

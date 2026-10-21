import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PublicRequest, RequestMatch } from '../../api/endpoints/publicRequests'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { useSendPublicRequest, useSetMatchDismissed } from '../../hooks/usePublicRequests'
import AgentPanel from './AgentPanel'
import AgentRankList from './AgentRankList'
import ProgressBoard from './ProgressBoard'
import { COPY, DEFAULT_SEND, formatWhen, isSent } from './requestCopy'

/** Until the user picks, the panel shows the first agent to respond, else
 *  the best-ranked one the request went to. Rank order never changes. */
function defaultPick(matches: RequestMatch[]): string | null {
  const responded = matches.filter((m) => m.responded_at !== null)
  if (responded.length) {
    return responded.reduce((a, b) => (b.responded_at! < a.responded_at! ? b : a)).agent_ref
  }
  return (matches.find((m) => isSent(m.status)) ?? matches[0])?.agent_ref ?? null
}

function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/** The request header and progress board, alone while the server ranks. */
export function RequestHeader({ text, createdAt, children }: { text: string; createdAt: number | null; children: React.ReactNode }) {
  return (
    <>
      <div className="pr-eyebrow">{COPY.eyebrow(createdAt === null ? 'Just now' : formatWhen(createdAt))}</div>
      <div className="pr-q" data-testid="request-text">{text}</div>
      {children}
    </>
  )
}

export default function RequestRoom({ request, onOpenAgent, drawerOpen }: {
  request: PublicRequest
  onOpenAgent: (ref: string) => void
  drawerOpen: boolean
}) {
  const { matches } = request
  const [pick, setPick] = useState<string | null>(null)
  const active = pick && matches.some((m) => m.agent_ref === pick) ? pick : defaultPick(matches)
  const index = Math.max(0, matches.findIndex((m) => m.agent_ref === active))
  const match = matches[index]

  const { data: retainedRows } = useRetainedAgents()
  const retained = useMemo(
    () => new Set((retainedRows ?? []).filter((r) => r.state === 'active').map((r) => r.hub_agent_id)),
    [retainedRows],
  )
  const send = useSendPublicRequest(request.id)
  const dismiss = useSetMatchDismissed(request.id)

  const step = (delta: number) => {
    if (!matches.length) return
    setPick(matches[(index + delta + matches.length) % matches.length].agent_ref)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (drawerOpen || typingInField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1) }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const sentMatches = matches.filter((m) => isSent(m.status))
  const working = sentMatches.filter((m) => m.status === 'working').length

  return (
    <div className="pr-room">
      <RequestHeader text={request.text} createdAt={request.created_at}>
        <ProgressBoard
          searching={false}
          matched={request.matched}
          sent={request.sent}
          working={working}
          responded={request.responded}
        />
      </RequestHeader>
      {match && (
        <>
          <div className="pr-switchhead">
            <b>{COPY.switcherTitle(request.sent, request.matched)}</b>
            <span className="pr-done">
              <span className="pr-pips" aria-hidden>
                {sentMatches.map((m) => <i key={m.agent_ref} className={m.status === 'responded' ? 'on' : ''} />)}
              </span>
              {COPY.responded(request.responded, request.sent)}
            </span>
            <span className="pr-nav">
              <button type="button" className="pr-btn icon" onClick={() => step(-1)} aria-label={COPY.prev} disabled={matches.length < 2}>
                <ChevronLeft size={16} />
              </button>
              <span className="pc">{index + 1} / {matches.length}</span>
              <button type="button" className="pr-btn icon" onClick={() => step(1)} aria-label={COPY.next} disabled={matches.length < 2}>
                <ChevronRight size={16} />
              </button>
            </span>
          </div>
          <div className="pr-md">
            <AgentRankList
              matches={matches}
              activeRef={match.agent_ref}
              retained={retained}
              onSelect={setPick}
              onLoadMore={() => send.mutate({ count: DEFAULT_SEND })}
              loadingMore={send.isPending}
            />
            <AgentPanel
              key={match.agent_ref}
              match={match}
              onOpenAgent={() => onOpenAgent(match.agent_ref)}
              onSend={() => send.mutate({ agent_refs: [match.agent_ref] })}
              sending={send.isPending}
              onDismiss={(dismissed) => dismiss.mutate({ agentRef: match.agent_ref, dismissed })}
            />
          </div>
        </>
      )}
    </div>
  )
}

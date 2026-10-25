import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import SidebarAvatar from '../sidebar/SidebarAvatar'
import MatchRetainButton from './MatchRetainButton'
import type { DrawerAgent } from './agentView'
import { COPY, formatCount } from './requestCopy'

/**
 * A right-side sheet over a scrim: who the agent is and, for a match, where
 * the request stands with it. Escape or the scrim closes it.
 */
export default function AgentDrawer({ agent, onClose }: {
  agent: DrawerAgent
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const d = COPY.drawer
  const m = agent.match
  return (
    <>
      <div className="pr-scrim" onClick={onClose} data-testid="drawer-scrim" />
      <aside className="pr-drawer" role="dialog" aria-modal="true" aria-label={agent.display_name} data-testid="agent-drawer">
        <div className="pr-dhead">
          <SidebarAvatar name={agent.display_name} size={40} ringColor="#fff" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{agent.display_name}</h2>
            <div className="pr-cmetaline">{m ? COPY.meta(m) : `by ${agent.owner}`}</div>
          </div>
          <button ref={closeRef} type="button" className="pr-btn ghost icon" onClick={onClose} aria-label={d.close}>
            <X size={18} />
          </button>
        </div>
        {agent.description && <p className="pr-cdesc">{agent.description}</p>}
        <div className="pr-kv">
          <div>
            <div className="k">{d.retainedBy}</div>
            <div className="v">{agent.retained_count !== null ? formatCount(agent.retained_count) : '—'}</div>
            <div className="m">{d.users}</div>
          </div>
          <div>
            <div className="k">{d.server}</div>
            <div className="v" title={agent.server ?? d.thisServer}>{agent.server ?? d.thisServer}</div>
          </div>
        </div>
        {agent.expertise.length > 0 && (
          <div>
            <h3>{d.expertise}</h3>
            <div className="pr-tags">{agent.expertise.map((e) => <span key={e}>{e}</span>)}</div>
          </div>
        )}
        <div className="pr-dacts">
          {m && m.status !== 'not_sent' && (
            <span className="pr-pill">{m.status === 'responded' ? d.respondedTo : d.sent}</span>
          )}
          <MatchRetainButton agent={agent} large />
        </div>
        <p className="pr-note">{d.note(agent.display_name)}</p>
      </aside>
    </>
  )
}

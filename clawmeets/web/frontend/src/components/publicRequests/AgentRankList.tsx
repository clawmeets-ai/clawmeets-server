import { Check, Pin, Plus } from 'lucide-react'
import type { RequestMatch } from '../../api/endpoints/publicRequests'
import SidebarAvatar from '../sidebar/SidebarAvatar'
import { fromMatch } from './agentView'
import { COPY, DEFAULT_SEND, rowState } from './requestCopy'

/**
 * The agent switcher: matches in server rank order, sticky beside the panel
 * on desktop and a sideways strip on phones. The last row sends the request
 * to the next few unsent matches.
 */
export default function AgentRankList({ matches, activeRef, retained, onSelect, onLoadMore, loadingMore }: {
  matches: RequestMatch[]
  activeRef: string | null
  retained: Set<string>
  onSelect: (ref: string) => void
  onLoadMore: () => void
  loadingMore: boolean
}) {
  const unsent = matches.filter((m) => m.status === 'not_sent' && !m.send_error).length
  return (
    <nav className="pr-list" aria-label="Matched agents" data-testid="rank-list">
      {matches.map((m, i) => {
        const a = fromMatch(m)
        const { tone, label } = rowState(m, retained.has(m.agent_ref))
        const on = m.agent_ref === activeRef
        return (
          <button
            key={m.agent_ref}
            type="button"
            className={`pr-li${on ? ' on' : ''}${tone === 'dismissed' ? ' dismissed' : ''}`}
            aria-current={on ? 'true' : undefined}
            onClick={() => onSelect(m.agent_ref)}
            data-testid="rank-row"
          >
            <span className="rk">{i + 1}</span>
            <SidebarAvatar name={a.display_name} size={28} ringColor="#fff" />
            <span className="tx">
              <b>{a.display_name}</b>
              <em className={`pr-status ${tone}`} data-testid="rank-status">
                {tone === 'working' && <i className="pr-sp" />}
                {tone === 'responded' && <Check size={11} strokeWidth={2.6} />}
                {tone === 'retained' && <Pin size={11} strokeWidth={2.6} />}
                {label}
              </em>
            </span>
          </button>
        )
      })}
      {unsent > 0 && (
        <button type="button" className="pr-li more" onClick={onLoadMore} disabled={loadingMore} data-testid="load-more">
          <span className="rk"><Plus size={14} /></span>
          <span className="tx">
            <b>{COPY.loadMore(Math.min(DEFAULT_SEND, unsent))}</b>
            <em className="pr-status">{COPY.moreMatched(unsent)}</em>
          </span>
        </button>
      )}
    </nav>
  )
}

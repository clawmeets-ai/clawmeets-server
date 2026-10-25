import { Check, Pin, Plus } from 'lucide-react'
import type { RequestMatch } from '../../api/endpoints/publicRequests'
import SidebarAvatar from '../sidebar/SidebarAvatar'
import { fromMatch } from './agentView'
import { COPY, fitLabel, rowState } from './requestCopy'

/**
 * The agent switcher: matches in the hub's rank order, sticky beside the
 * panel on desktop and a sideways strip on phones. The last row asks the hub
 * for more (a new ask that excludes everyone already asked).
 */
export default function AgentRankList({ matches, activeRef, retained, onSelect, onAskMore, askingMore }: {
  matches: RequestMatch[]
  activeRef: string | null
  retained: Set<string>
  onSelect: (ref: string) => void
  onAskMore: () => void
  askingMore: boolean
}) {
  return (
    <nav className="pr-list" aria-label="Matched agents" data-testid="rank-list">
      {matches.map((m, i) => {
        const a = fromMatch(m)
        const { tone, label } = rowState(m, retained.has(m.agent_ref))
        const on = m.agent_ref === activeRef
        // The hub's estimate, in words.
        const fit = fitLabel(m)
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
              {fit && <span className="pr-fit" data-testid="rank-fit">{fit}</span>}
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
      <button type="button" className="pr-li more" onClick={onAskMore} disabled={askingMore} data-testid="ask-more">
        <span className="rk"><Plus size={14} /></span>
        <span className="tx">
          <b>{COPY.askMore}</b>
          <em className="pr-status">{COPY.askMoreSub}</em>
        </span>
      </button>
    </nav>
  )
}

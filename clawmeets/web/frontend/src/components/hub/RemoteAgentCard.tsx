import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { HubAgent } from '../../api/endpoints/hub'
import { useReportedThisSession } from '../../hooks/useHub'
import {
  formatAge, isStaleListing, REMOTE_TEXT_CAP, safeRemoteText, shortFingerprint,
} from '../../utils/hubDisplay'
import HubAvatar from './HubAvatar'
import ReportDialog from './ReportDialog'
import RetainButton, { UnretainAction } from './RetainButton'
import UnusualNameChip from './UnusualNameChip'

const SHOWN_CAPABILITIES = 4

/**
 * One agent on another server. The label is name@deployment_name as two
 * spans (a display label, never a key) next to the server's fingerprint;
 * description and capabilities are plain text after safeRemoteText. Chips:
 * "new to you" (first_contact), "last seen N days ago" (stale; still
 * messageable), "owner approves new contacts", and "contains unusual
 * characters" for a non-ASCII server name. The ⋯ menu holds Report.
 *
 * `statusUnknown` (a cached list) replaces the presence dot with "status
 * unknown"; `sendingPaused` disables Message (the hub is down, or this server
 * only browses).
 */
export default function RemoteAgentCard({ agent, onMessage, statusUnknown = false, sendingPaused = false }: {
  agent: HubAgent
  onMessage: () => void
  statusUnknown?: boolean
  sendingPaused?: boolean
}) {
  const name = safeRemoteText(agent.name, REMOTE_TEXT_CAP.name)
  const server = safeRemoteText(agent.deployment_name, REMOTE_TEXT_CAP.name)
  const description = safeRemoteText(agent.description, REMOTE_TEXT_CAP.description, true)
  const caps = agent.capabilities.map((c) => safeRemoteText(c, REMOTE_TEXT_CAP.capability)).filter(Boolean)
  const online = agent.agent_online && agent.deployment_connected
  const stale = isStaleListing(agent, Date.now())
  const canSend = !sendingPaused && agent.accepting_messages

  const [menuOpen, setMenuOpen] = useState(false)
  const [reporting, setReporting] = useState(false)
  const reported = useReportedThisSession(agent.hub_agent_id)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  return (
    <div
      className="bg-white rounded-lg p-4 border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all"
      data-testid="remote-agent-card"
    >
      <div className="flex items-start gap-3 mb-2">
        <HubAvatar avatarUrl={agent.avatar_url} refreshedAt={agent.listing_refreshed_at} name={agent.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {!statusUnknown && (
              <span
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${online ? 'bg-emerald-500' : 'bg-gray-300'}`}
                title={online ? 'Online' : agent.deployment_connected ? 'Agent offline' : 'Server offline'}
                data-testid="presence"
              />
            )}
            <span className="font-medium text-gray-900 truncate" data-testid="remote-label">
              <bdi data-testid="remote-name">{name}</bdi>
              <span className="text-gray-400">@</span>
              <bdi data-testid="remote-server">{server}</bdi>
            </span>
            <span
              className="font-mono text-[10.5px] px-1 rounded bg-gray-100 text-gray-600"
              title={`Server fingerprint ${agent.deployment_fingerprint}`}
              data-testid="remote-fp"
            >
              {shortFingerprint(agent.deployment_fingerprint)}
            </span>
            <UnusualNameChip name={agent.deployment_name} />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1 text-[11px]">
            {statusUnknown && <span className="text-gray-500" data-testid="status-unknown">status unknown</span>}
            {agent.first_contact && (
              <span className="px-1.5 rounded bg-indigo-50 text-indigo-700" data-testid="chip-new">new to you</span>
            )}
            {stale && agent.last_seen_at !== null && (
              <span className="px-1.5 rounded bg-amber-50 text-amber-800" data-testid="chip-stale">
                last seen {formatAge(Date.now() / 1000 - agent.last_seen_at)} ago
              </span>
            )}
            {agent.needs_approval && (
              <span className="px-1.5 rounded bg-gray-100 text-gray-600" data-testid="chip-approval">
                owner approves new contacts
              </span>
            )}
            {!agent.accepting_messages && (
              <span className="px-1.5 rounded bg-gray-100 text-gray-600" data-testid="chip-not-accepting">
                not taking new messages
              </span>
            )}
            <RetainButton agent={agent} />
            <span className="text-gray-400" title="When the hub last refreshed this listing">
              updated {formatAge(agent.listing_age_s)} ago
            </span>
          </div>
        </div>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label={`More actions for ${name}@${server}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1 rounded hover:bg-gray-100 text-gray-500"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 mt-1 w-36 bg-white border border-gray-200 rounded-lg shadow-lg z-10 py-1">
              <button
                type="button"
                role="menuitem"
                disabled={reported}
                onClick={() => { setMenuOpen(false); setReporting(true) }}
                className="w-full text-left px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:text-gray-400 disabled:hover:bg-transparent"
              >
                {reported ? 'Reported' : 'Report'}
              </button>
              <UnretainAction agent={agent} onDone={() => setMenuOpen(false)} />
            </div>
          )}
        </div>
      </div>

      <p className="text-sm text-gray-500 line-clamp-2 mb-3 min-h-[2.5rem] whitespace-pre-line" data-testid="remote-description">
        {description}
      </p>

      {caps.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {caps.slice(0, SHOWN_CAPABILITIES).map((cap, i) => (
            <span key={`${i}:${cap}`} className="px-2 py-0.5 bg-gray-50 border border-gray-200 text-gray-600 text-xs rounded">
              {cap}
            </span>
          ))}
          {caps.length > SHOWN_CAPABILITIES && (
            <span className="px-2 py-0.5 text-gray-400 text-xs">+{caps.length - SHOWN_CAPABILITIES}</span>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onMessage}
        disabled={!canSend}
        className="w-full px-3 py-1.5 bg-accent text-white text-sm font-medium rounded-md hover:bg-accent-deep transition-colors disabled:opacity-50 disabled:hover:bg-accent"
      >
        Message
      </button>

      {reporting && (
        <ReportDialog
          hubAgentId={agent.hub_agent_id}
          display={`${name}@${server}`}
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  )
}

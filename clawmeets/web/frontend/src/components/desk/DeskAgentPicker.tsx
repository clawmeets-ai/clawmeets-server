import { useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Search } from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { useAuthStore } from '../../stores/authStore'
import { displayName, matchesQuery } from '../../utils/agentDisplay'
import { REMOTE_TEXT_CAP, safeRemoteText } from '../../utils/hubDisplay'
import { reachableAgents } from '../../utils/reachableAgents'
import { isHubRecipient, recipientId, recipientLabel, type DeskRecipient } from '../../utils/deskRecipient'
import type { AgentCard } from '../../types'
import Avatar from '../common/Avatar'

interface DeskAgentPickerProps {
  onPick: (agent: DeskRecipient) => void
  onClose: () => void
  /** Filter to the caller's own agents plus the agents they retained, of this
   *  server and of others (default true). False offers every agent of this
   *  server and nothing elsewhere. */
  ownedOnly?: boolean
}

/**
 * Recipient popover for the desk composer / take-over — "who do I hand this
 * to?". Reuses the agent roster (`useAgents`), `Avatar`, and the shared
 * name-display helpers, so it matches the mention dropdown used in chat. The
 * user's own assistant (`{username}-assistant`) sorts first, then the user's
 * own agents, then the agents of this server they retained, then the retained
 * agents of other servers (`name@server`, a globe, remote text cleaned): a send
 * to one of those starts a hub thread.
 *
 * Positioned `absolute` against whatever the caller has made `relative` — in
 * the desk composer that is the `@agent` chip itself, so the list drops out of
 * the name it replaces. Hence a fixed width rather than `left-0 right-0`: the
 * anchor is a chip a few characters wide, not the full composer card.
 */
export default function DeskAgentPicker({ onPick, onClose, ownedOnly = true }: DeskAgentPickerProps) {
  const { user } = useAuthStore()
  const { data: agents } = useAgents()
  const { data: retained } = useRetainedAgents({ enabled: ownedOnly })
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const pool = useMemo((): DeskRecipient[] => {
    const all = agents ?? []
    const reachable = ownedOnly ? reachableAgents(all, user?.id, retained) : { local: all, hub: [] }
    const assistantName = user ? `${user.username}-assistant` : ''
    const isOwn = (a: AgentCard) => !!user && a.registered_by === user.id
    const local = [...reachable.local].sort((a, b) => {
      if (a.name === assistantName) return -1
      if (b.name === assistantName) return 1
      if (isOwn(a) !== isOwn(b)) return isOwn(a) ? -1 : 1
      return displayName(a, user).localeCompare(displayName(b, user))
    })
    const elsewhere = [...reachable.hub].sort((a, b) => recipientLabel(a, user).localeCompare(recipientLabel(b, user)))
    return [...local, ...elsewhere]
  }, [agents, retained, ownedOnly, user])

  const list = q
    ? pool.filter((a) =>
        isHubRecipient(a)
          ? recipientLabel(a, user).toLowerCase().includes(q.toLowerCase())
          : matchesQuery(a, q, user ?? null))
    : pool

  // Keep the highlight in bounds as the filtered list shrinks/grows; reset to
  // the top on every new query so the first match is always pre-selected.
  const activeIdx = Math.min(active, Math.max(0, list.length - 1))
  useEffect(() => {
    setActive(0)
  }, [q])
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  return (
    <div
      className="absolute z-50 left-0 top-full mt-1.5 w-[420px] max-w-[80vw] rounded-lg border border-gray-200 bg-white shadow-[0_12px_40px_rgba(31,24,38,.18)] overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        <Search className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, list.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const picked = list[activeIdx]
              if (picked) onPick(picked)
            }
          }}
          placeholder="Send to which agent…"
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-gray-900 placeholder:text-gray-400"
        />
      </div>
      <div ref={listRef} className="max-h-56 overflow-y-auto p-1.5 flex flex-col gap-0.5">
        {list.map((a, i) => (
          <button
            key={recipientId(a)}
            onClick={() => onPick(a)}
            onMouseMove={() => setActive(i)}
            data-active={i === activeIdx}
            className={`flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 ${
              i === activeIdx ? 'bg-gray-100' : 'hover:bg-gray-50'
            }`}
          >
            <Avatar name={isHubRecipient(a) ? safeRemoteText(a.name, REMOTE_TEXT_CAP.name) : displayName(a, user)}
              status={isHubRecipient(a) ? undefined : a.status} size="sm" />
            <span className="font-mono text-[12.5px] font-semibold text-gray-900 truncate">
              {recipientLabel(a, user)}
            </span>
            {isHubRecipient(a) && (
              <Globe className="w-3 h-3 shrink-0 text-gray-400" aria-label="On another server" />
            )}
            <span className="ml-auto text-[10.5px] text-gray-500 truncate max-w-[45%]">
              {isHubRecipient(a)
                ? `retained · ${safeRemoteText(a.description, REMOTE_TEXT_CAP.description) || 'agent'}`
                : a.name === `${user?.username}-assistant`
                  ? 'coordinator'
                  : a.registered_by !== user?.id
                    ? `retained · ${a.description || 'agent'}`
                    : a.description || 'agent'}
            </span>
          </button>
        ))}
        {list.length === 0 && (
          <div className="px-3 py-3 text-center text-xs text-gray-400">
            No agent matches “{q}”.
          </div>
        )}
      </div>
    </div>
  )
}

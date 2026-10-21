import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, ChevronDown, Settings2 } from 'lucide-react'
import { getAvailableMcps, getMcpDetail } from '../../api/endpoints/mcps'
import { selectPendingAuth, useMcpAuthStore } from '../../stores/mcpAuthStore'
import type { McpMeta } from '../../types'
import McpConfigModal from './McpConfigModal'
import PreConsentModal from './PreConsentModal'
import { PRIVACY_POLICY_URL, TERMS_URL } from '../../utils/legalUrls'

interface McpCatalogProps {
  value: string[]
  onChange: (next: string[]) => void
  /**
   * When set, MCP rows render an inline "Continue with Google" link if a
   * runner-minted OAuth URL is pending for ``(agentId, mcp.name)``. Omit on
   * pages without a single owning agent (catalog browsing pre-creation).
   */
  agentId?: string
}

const COLORS = [
  { bg: 'bg-purple-100', text: 'text-purple-700' },
  { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  { bg: 'bg-amber-100', text: 'text-amber-700' },
  { bg: 'bg-rose-100', text: 'text-rose-700' },
  { bg: 'bg-sky-100', text: 'text-sky-700' },
  { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  { bg: 'bg-teal-100', text: 'text-teal-700' },
  { bg: 'bg-pink-100', text: 'text-pink-700' },
]

function colorFor(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]
}

function avatarFor(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export default function McpCatalog({ value, onChange, agentId }: McpCatalogProps) {
  const [search, setSearch] = useState('')

  const { data: mcps = [], isLoading } = useQuery({
    queryKey: ['mcps'],
    queryFn: () => getAvailableMcps(),
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return mcps
    return mcps.filter((m) => `${m.name} ${m.description}`.toLowerCase().includes(q))
  }, [mcps, search])

  const isAdded = (name: string) => value.includes(name)
  const toggle = (name: string) => {
    if (isAdded(name)) onChange(value.filter((s) => s !== name))
    else onChange([...value, name])
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search MCP servers…"
          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50/50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-300 transition-colors"
        />
      </div>

      {/* Rows */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-8">No matches.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((mcp) => (
            <McpRow
              key={mcp.name}
              mcp={mcp}
              added={isAdded(mcp.name)}
              onToggle={() => toggle(mcp.name)}
              agentId={agentId}
            />
          ))}
        </div>
      )}

      {/* Custom MCP CTA */}
    </div>
  )
}

function McpRow({
  mcp,
  added,
  onToggle,
  agentId,
}: {
  mcp: McpMeta
  added: boolean
  onToggle: () => void
  agentId?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const color = colorFor(mcp.name)
  const initials = avatarFor(mcp.name)
  const verified = mcp.tags.includes('verified')
  const community = mcp.tags.includes('community')

  // Empty key when no agent is in scope so the selector returns undefined
  // without flagging the store as a dependency for unrelated rows.
  const pending = useMcpAuthStore(selectPendingAuth(agentId ?? '', mcp.name))
  const clearPending = useMcpAuthStore((s) => s.clear)

  // The catalog list endpoint omits the manifest, so fetch the detail lazily
  // for installed rows that may have a Configure affordance. Only triggered
  // when an agent is in scope and the MCP is added.
  const { data: detail } = useQuery({
    queryKey: ['mcp-detail', mcp.name],
    queryFn: () => getMcpDetail(mcp.name),
    enabled: added && !!agentId,
    staleTime: 5 * 60 * 1000,
  })
  const starterConfig = detail?.manifest?.starter_config ?? null
  const isConfigurable = added && !!agentId && starterConfig != null

  // Drop any pending auth URL when the MCP is no longer installed — uninstall
  // cancels the runner-side flow, so the cached URL is stale and clicking it
  // would no-op against the runner's dropped waiter.
  useEffect(() => {
    if (!added && agentId && pending) {
      clearPending(agentId, mcp.name)
    }
  }, [added, agentId, mcp.name, pending, clearPending])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setExpanded((v) => !v)
        }
      }}
      className={`flex flex-col gap-2 p-3 rounded-xl border transition-colors text-left cursor-pointer ${
        added ? 'border-purple-300 bg-purple-50/30' : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center ${color.bg}`}>
          <span className={`text-xs font-mono font-bold ${color.text}`}>{initials}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-bold text-gray-900 truncate">{mcp.name}</h3>
            {verified && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">
                ✓ Verified
              </span>
            )}
            {community && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-600 bg-gray-50 border border-gray-200 rounded-full px-1.5 py-0.5">
                Community
              </span>
            )}
            <span className="text-[10.5px] text-gray-400 ml-1">v{mcp.version}</span>
          </div>
          <p className={`text-xs text-gray-500 mt-0.5 whitespace-pre-wrap ${expanded ? '' : 'truncate'}`}>
            {mcp.description}
          </p>
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          className={`flex-shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
            added
              ? 'bg-accent text-white border-accent hover:bg-accent-deep'
              : 'bg-white text-gray-700 border-gray-200 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700'
          }`}
        >
          {added ? 'Connected' : 'Connect'}
        </button>
      </div>
      {isConfigurable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setConfigOpen(true)
          }}
          className="inline-flex items-center justify-center gap-2 self-stretch px-3 py-2 text-xs font-semibold rounded-lg bg-white border border-purple-200 text-purple-700 hover:bg-purple-50 hover:border-purple-300 transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5" />
          Configure {mcp.name}
        </button>
      )}
      {added && pending && agentId && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setConsentOpen(true)
          }}
          className="inline-flex items-center justify-center gap-2 self-stretch px-3 py-2 text-xs font-semibold rounded-lg bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300 transition-colors"
        >
          <span aria-hidden className="inline-block w-3 h-3 rounded-full bg-gradient-to-br from-blue-500 via-rose-500 to-amber-400" />
          Continue with Google to authorize {mcp.name}
        </button>
      )}
      {consentOpen && pending && agentId && (
        <PreConsentModal
          open={consentOpen}
          integrationName={mcp.name}
          scopes={detail?.manifest?.auth?.scopes ?? []}
          authUrl={pending.auth_url}
          privacyPolicyUrl={PRIVACY_POLICY_URL}
          termsUrl={TERMS_URL}
          onContinue={() => {
            // Open Google inside this user gesture, then optimistically clear
            // the pending URL (same trust boundary as the former anchor).
            window.open(pending.auth_url, '_blank', 'noopener,noreferrer')
            clearPending(agentId, mcp.name)
            setConsentOpen(false)
          }}
          onCancel={() => setConsentOpen(false)}
        />
      )}
      {configOpen && agentId && (
        <McpConfigModal
          agentId={agentId}
          mcpName={mcp.name}
          fallbackStarter={starterConfig}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </div>
  )
}

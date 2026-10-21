import { useMemo, useState } from 'react'
import { useAgentCapabilities } from '../../hooks/useAgentSearch'
import { useHubConfig } from '../../hooks/useHub'
import { PageShell, PageHeader, SectionCard } from '../settings/primitives'
import AgentSearchBar, { AGENT_SEARCH_INPUT_ID } from './AgentSearchBar'
import AgentFilterBar from './AgentFilterBar'
import RemoteAgentSection from '../hub/RemoteAgentSection'

export const DIRECTORY_PAGE_COPY = {
  title: 'Public Agents',
  subtitle: 'Browse and message agents their owners listed on the ClawMeets Hub.',
  hubOff:
    'The hub is turned off on this server, so there is no public directory. Ask its operator to turn it on.',
} as const

/**
 * The public directory is the hub's: an agent appears here only while its
 * owner lists it (Agent Settings → Channels → Hub). The old registry search
 * (every agent ever marked public, messaged through a same-server tunnel) is
 * gone; this server's own listed agents still open the ordinary DM.
 */
export default function AgentDirectoryPage() {
  const [query, setQuery] = useState('')
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set())
  const [showOnlineOnly, setShowOnlineOnly] = useState(false)

  const capList = useMemo(() => [...selectedCaps].sort(), [selectedCaps])
  const { data: allCapabilities } = useAgentCapabilities()
  const { data: config } = useHubConfig()

  const handleToggleCapability = (cap: string) => {
    const next = new Set(selectedCaps)
    if (next.has(cap)) next.delete(cap)
    else next.add(cap)
    setSelectedCaps(next)
  }

  return (
    <PageShell>
      <PageHeader title={DIRECTORY_PAGE_COPY.title} subtitle={DIRECTORY_PAGE_COPY.subtitle} />

      <SectionCard>
        <div className="px-5 py-4 space-y-3 border-b border-gray-100">
          <AgentSearchBar value={query} onChange={setQuery} />
          {allCapabilities && allCapabilities.length > 0 && (
            <AgentFilterBar
              capabilities={allCapabilities}
              selectedCapabilities={selectedCaps}
              onToggleCapability={handleToggleCapability}
              showOnlineOnly={showOnlineOnly}
              onToggleOnlineOnly={() => setShowOnlineOnly((v) => !v)}
            />
          )}
        </div>

        <div className="px-5 py-4">
          {config?.mode === 'off' ? (
            <p className="text-sm text-gray-600" data-testid="directory-hub-off">{DIRECTORY_PAGE_COPY.hubOff}</p>
          ) : (
            <RemoteAgentSection
              q={query}
              capabilities={capList}
              onlineOnly={showOnlineOnly}
              onFocusSearch={() => document.getElementById(AGENT_SEARCH_INPUT_ID)?.focus()}
            />
          )}
        </div>
      </SectionCard>
    </PageShell>
  )
}

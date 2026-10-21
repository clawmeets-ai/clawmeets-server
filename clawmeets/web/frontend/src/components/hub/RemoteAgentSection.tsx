import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { HUB_CONFIG_KEY, useHubConfig, useHubDirectory } from '../../hooks/useHub'
import { HUB_COPY, hubLinkPausesSending } from '../../utils/hubThread'
import { dedupeRemote, formatAge, formatHubDate, hubThreadPath, localListed } from '../../utils/hubDisplay'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import RemoteAgentCard from './RemoteAgentCard'
import RetainedList from './RetainedList'
import HubEnrollmentDialog from './HubEnrollmentDialog'

export const DIRECTORY_COPY = {
  heading: 'Public agents on the hub',
  localHeading: 'On this server',
  remoteHeading: 'On other servers',
  notRegistered: "This server isn't registered with the hub yet, so agents on other servers can't be shown. Ask its operator.",
  setupNeeded: 'Set up hub access to see agents on other servers.',
  setup: 'Set up hub access',
  notAvailable: "The ClawMeets Hub isn't available yet.",
  unreachable: "Can't reach the hub.",
  cached: (age: string) => `Can't reach the hub. Showing the list from ${age} ago. Sending to other servers is paused.`,
  busy: (s: number) => `Search is busy, try again in ${s} s.`,
  searchToSeeMore: 'Search to see more agents',
  narrow: 'Narrow your search to see more results',
  empty: 'No public agents match.',
  failed: "Couldn't search other servers.",
} as const

/**
 * The directory: hub search, split into this server's own listed agents
 * ("On this server": is_local, Message opens the ordinary DM) and agents on
 * other servers (Message opens a hub thread). An agent is in the directory
 * only while its Hub channel lists it; being public alone is not enough. Hub search with the page's own
 * q, capabilities and online filter. Rendered only when config.mode is not
 * 'off' (then there is no section and no error). Banners come first from the
 * config (registration, untrusted link), then from the search answer: a
 * cached list with its age (Message disabled), the hub down with nothing
 * cached, a rate-limited search that keeps the last results. Paging: "Load
 * more" while next_cursor is set; an empty q gets one page and ends with
 * "Search to see more agents"; query_too_broad ends with "Narrow your search".
 * In mode 'auto' an unregistered server offers "Set up hub access" instead of
 * "ask its operator": the enrollment dialog registers it, then the search runs.
 */
export default function RemoteAgentSection({ q, capabilities, onlineOnly, onFocusSearch, retainedOnly: initialRetained = false }: {
  q: string
  capabilities: string[]
  onlineOnly: boolean
  onFocusSearch: () => void
  /** Start with the "Retained" filter on. */
  retainedOnly?: boolean
}) {
  const [retainedOnly, setRetainedOnly] = useState(initialRetained)
  const [enrolling, setEnrolling] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: config } = useHubConfig()
  const mode = config?.mode
  const registered = config?.registration === 'active'
  const untrusted = config?.hub_link === 'untrusted'
  const dir = useHubDirectory({
    q, capabilities, onlineOnly,
    enabled: !!config && mode !== 'off' && registered && !untrusted,
  })
  const agents = useMemo(
    () => dedupeRemote(dir.agents, config?.deployment_fingerprint ?? null),
    [dir.agents, config?.deployment_fingerprint],
  )
  const local = useMemo(() => localListed(dir.agents), [dir.agents])
  // Ids the directory shows listed and not retained: a retained row that the
  // server marked unlisted reads "Listed again — retain?".
  const listedNow = useMemo(
    () => new Set(agents.filter((a) => !a.retained).map((a) => a.hub_agent_id)),
    [agents],
  )

  if (!config || mode === 'off') return null
  const code = dir.error?.code
  if (code === 'hub_off_on_server') return null

  const shell = (body: ReactNode) => (
    <section aria-labelledby="hub-directory-heading" data-testid="remote-agent-section">
      <div className="flex items-center gap-2 mb-3">
        <h2 id="hub-directory-heading" className="text-xs font-bold uppercase tracking-[0.08em] text-gray-500">
          {DIRECTORY_COPY.heading}
        </h2>
        <button
          type="button"
          aria-pressed={retainedOnly}
          title={RETAIN_COPY.filterTitle}
          onClick={() => setRetainedOnly((v) => !v)}
          className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${
            retainedOnly ? 'bg-accent text-white border-accent' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
          }`}
          data-testid="retained-filter"
        >
          {RETAIN_COPY.filter}
        </button>
      </div>
      {body}
    </section>
  )
  // The retained list is the user's own set, read from this server: it does
  // not depend on the hub answering a search.
  if (retainedOnly) return shell(<RetainedList listedNow={listedNow} />)
  const note = (text: string, testId: string) => (
    <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2" data-testid={testId}>
      {text}
    </p>
  )

  if (config.registration === 'suspended') return shell(note(HUB_COPY.suspended, 'hub-banner'))
  if (mode === 'auto' && (!registered || code === 'hub_not_registered')) {
    if (untrusted) return shell(note(DIRECTORY_COPY.notAvailable, 'hub-banner'))
    const enrolled = () => {
      setEnrolling(false)
      // The config says registered once refetched, which enables the search;
      // a search that already answered hub_not_registered runs again.
      void queryClient.invalidateQueries({ queryKey: HUB_CONFIG_KEY })
      void queryClient.invalidateQueries({ queryKey: ['hub-directory'] })
    }
    return shell(
      <div className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 flex flex-wrap items-center gap-3" data-testid="hub-banner">
        <span>{DIRECTORY_COPY.setupNeeded}</span>
        <button
          type="button"
          onClick={() => setEnrolling(true)}
          className="px-3 py-1 text-xs font-semibold rounded-lg bg-purple-600 text-white hover:bg-purple-700"
        >
          {DIRECTORY_COPY.setup}
        </button>
        {enrolling && <HubEnrollmentDialog onDone={enrolled} onClose={() => setEnrolling(false)} />}
      </div>,
    )
  }
  if (!registered || code === 'hub_not_registered') return shell(note(DIRECTORY_COPY.notRegistered, 'hub-banner'))
  if (untrusted || code === 'hub_untrusted') return shell(note(HUB_COPY.untrusted, 'hub-banner'))
  if (code === 'hub_unreachable') return shell(note(DIRECTORY_COPY.unreachable, 'hub-banner'))

  const page = dir.lastPage
  const cached = page?.served_from === 'cache'
  const browseOnly = mode === 'discover_only'
  const sendingPaused = cached || browseOnly || hubLinkPausesSending(config)

  const group = (title: string, testId: string, cards: ReactNode) => (
    <div data-testid={testId}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-400 mb-2">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{cards}</div>
    </div>
  )

  let footer: ReactNode = null
  if (dir.tooBroad) {
    footer = <p className="text-xs text-gray-500" data-testid="hub-footer">{DIRECTORY_COPY.narrow}</p>
  } else if (dir.hasMore) {
    footer = (
      <button
        type="button"
        onClick={dir.loadMore}
        disabled={dir.isFetchingMore}
        className="text-sm font-semibold text-accent-deep hover:underline disabled:opacity-50"
      >
        {dir.isFetchingMore ? 'Loading…' : 'Load more'}
      </button>
    )
  } else if (!dir.q && page) {
    footer = (
      <button type="button" onClick={onFocusSearch} className="text-sm font-semibold text-accent-deep hover:underline" data-testid="hub-footer">
        {DIRECTORY_COPY.searchToSeeMore}
      </button>
    )
  }

  return shell(
    <div className="space-y-3">
      {cached && (
        <p
          className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
          title={page?.cached_at != null ? `Cached ${formatHubDate(page.cached_at)}` : undefined}
          data-testid="hub-cached"
        >
          {DIRECTORY_COPY.cached(formatAge(page?.cache_age_s ?? 0))}
        </p>
      )}
      {browseOnly && !cached && note(HUB_COPY.browseOnly, 'hub-browse-only')}
      {dir.retryAfter !== null && (
        <p role="status" className="text-xs text-amber-800" data-testid="hub-busy">{DIRECTORY_COPY.busy(dir.retryAfter)}</p>
      )}
      {code === 'query_too_broad' && agents.length === 0 && note(DIRECTORY_COPY.narrow, 'hub-footer')}
      {(dir.failed || (dir.error && !['rate_limited', 'query_too_broad'].includes(code ?? ''))) &&
        note(DIRECTORY_COPY.failed, 'hub-failed')}
      {dir.isLoading ? (
        <p className="text-sm text-gray-400">Searching the hub…</p>
      ) : agents.length > 0 || local.length > 0 ? (
        <>
          {local.length > 0 && group(DIRECTORY_COPY.localHeading, 'hub-local-group', local.map((a) => (
            <RemoteAgentCard
              key={a.hub_agent_id}
              agent={a}
              statusUnknown={cached}
              onMessage={() => navigate(`/dm/${encodeURIComponent(a.name)}`)}
            />
          )))}
          {agents.length > 0 && group(DIRECTORY_COPY.remoteHeading, 'hub-remote-group', agents.map((a) => (
            <RemoteAgentCard
              key={a.hub_agent_id}
              agent={a}
              statusUnknown={cached}
              sendingPaused={sendingPaused}
              onMessage={() => navigate(hubThreadPath(a.hub_agent_id))}
            />
          )))}
        </>
      ) : page && !dir.error ? (
        <p className="text-sm text-gray-400">{DIRECTORY_COPY.empty}</p>
      ) : null}
      {footer}
    </div>,
  )
}

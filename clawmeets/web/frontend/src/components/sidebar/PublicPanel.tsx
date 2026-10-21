import { useMemo } from 'react'
import { Link, useLocation, useNavigate, useMatch } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import { useAgents } from '../../hooks/useAgents'
import { useUserProjects } from '../../hooks/useProjects'
import { counterpartOf, frontDeskSide } from '../../utils/frontDesk'
import { isFrontDeskProject, parseFrontDeskName, type AgentCard } from '../../types'
import { shortName } from '../../utils/agentDisplay'
import { groupHubThreads, hubThreadPath, REMOTE_TEXT_CAP, safeRemoteText } from '../../utils/hubDisplay'
import type { HubTarget } from '../../api/endpoints/hub'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { usePublicRequests } from '../../hooks/usePublicRequests'
import { AGENT_PARAM, fromRetained, requestPath, REQUESTS_PATH } from '../publicRequests/agentView'
import { COPY } from '../publicRequests/requestCopy'
import UnusualNameChip from '../hub/UnusualNameChip'
import PanelShell from './PanelShell'
import AgentRow from './AgentRow'
import SidebarAvatar from './SidebarAvatar'

const SECTION = 'px-3 pt-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-ink-3'

interface OwnerBucket {
  owner: string
  agents: AgentCard[]
}

/** The greyed row's chip: why a hub thread no longer takes messages. */
export function hubRowChip(t: HubTarget): string | null {
  switch (t.closed_reason) {
    case null:
      return t.listed ? null : 'no longer listed'
    case 'agent_unlisted':
      return 'no longer listed'
    case 'key_revoked':
      return 'key revoked'
    case 'identity_changed':
      return 'server changed'
    case 'deployment_suspended':
      return 'server suspended'
    case 'hub_off_on_server':
      return 'hub off'
    default:
      return 'closed'
  }
}

// Public context. On top: "New request", the user's public requests, and the
// agents they retained (a click opens the agent drawer on the requests page).
// Below, under "Conversations": agents you've DMed that belong to OTHER users. Each lives in a
// per-agent FD project `{username}-fd-{short}` whose coordinator IS the foreign
// agent; grouped by that agent's owner. Revived from the old AgentList.
//
// Below them, hub threads (projects with a hub_target): one bucket per server's
// GENESIS fingerprint, headed "@ {deployment_name}" (plus the short fingerprint
// when two servers share a name). Rows show hub_target.display as text and open
// /hub/{hub_agent_id}/{project_id}; unlisted or closed rows are greyed with a chip.
export default function PublicPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuthStore()
  const navigate = useNavigate()
  const dmMatch = useMatch('/dm/:agentName')
  const hubMatch = useMatch('/hub/:hubAgentId/:threadId')
  const activeHubThread = hubMatch?.params.threadId ?? null
  const activeAgentName = dmMatch?.params.agentName ? decodeURIComponent(dmMatch.params.agentName) : null

  const location = useLocation()
  const requestMatch = useMatch(`${REQUESTS_PATH}/:requestId`)
  const activeRequest = requestMatch?.params.requestId ?? null

  const { data: allAgents } = useAgents()
  const { data: projects } = useUserProjects()
  const { data: requests } = usePublicRequests()
  const { data: retainedRows } = useRetainedAgents()
  const retained = useMemo(
    () => (retainedRows ?? []).filter((r) => r.state === 'active').map(fromRetained),
    [retainedRows],
  )

  const buckets: OwnerBucket[] = useMemo(() => {
    if (!user || !projects || !allAgents) return []
    const agentById = new Map(allAgents.map((a) => [a.id, a]))
    const byOwner = new Map<string, AgentCard[]>()
    const seen = new Set<string>()
    for (const p of projects) {
      // Hub threads have their own buckets (below), never an owner bucket.
      if (p.hub_target) continue
      // Requester/local end of a Front Desk thread:
      //   new model — surface==='frontdesk' with a foreign partner
      //               (frontDeskSide === 'local'); created_by === me confirms it
      //               is my own local end.
      //   legacy     — a shared '-fd-' row (surface==='dm') where I'm the
      //               requester, kept for the migration window (Front Desk §7).
      const isNewLocal =
        frontDeskSide(p, agentById, user.id) === 'local' && p.created_by === user.id
      const fd = parseFrontDeskName(p.name)
      const isLegacyLocal = isFrontDeskProject(p) && fd?.requester === user.username
      if (!isNewLocal && !isLegacyLocal) continue
      const agent = agentById.get(counterpartOf(p))
      if (!agent) continue
      // Foreign agents only. Redundant for the new-local branch (frontDeskSide
      // already required a foreign coordinator) but load-bearing for legacy.
      if (agent.registered_by === user.id) continue
      if (seen.has(agent.id)) continue
      seen.add(agent.id)
      // Usernames cannot contain '-', so the first hyphen splits owner/short.
      const dash = agent.name.indexOf('-')
      if (dash <= 0) continue
      const owner = agent.name.slice(0, dash)
      const arr = byOwner.get(owner) ?? []
      arr.push(agent)
      byOwner.set(owner, arr)
    }
    const out: OwnerBucket[] = []
    for (const [owner, agents] of byOwner.entries()) {
      agents.sort((a, b) => a.name.localeCompare(b.name))
      out.push({ owner, agents })
    }
    out.sort((a, b) => a.owner.localeCompare(b.owner))
    return out
  }, [user, projects, allAgents])

  const hubBuckets = useMemo(() => groupHubThreads(projects ?? []), [projects])

  const selectAgent = (agent: AgentCard) => {
    if (!confirmLeaveIfDirty()) return
    navigate(`/dm/${encodeURIComponent(agent.name)}`)
    onNavigate?.()
  }

  const go = (to: string) => {
    if (!confirmLeaveIfDirty()) return
    navigate(to)
    onNavigate?.()
  }

  // The drawer opens over whatever requests page is showing, else over the ask page.
  const openRetained = (ref: string) => {
    const base = location.pathname.startsWith(REQUESTS_PATH) ? location.pathname : REQUESTS_PATH
    go(`${base}?${AGENT_PARAM}=${encodeURIComponent(ref)}`)
  }

  const selectHubThread = (t: HubTarget, projectId: string) => {
    if (!confirmLeaveIfDirty()) return
    navigate(hubThreadPath(t.hub_agent_id, projectId))
    onNavigate?.()
  }

  return (
    <PanelShell title="Public agents" addTo="/agents/public" addLabel="Browse public agents" onNavigate={onNavigate}>
      <div className="px-1.5 pt-1 space-y-1">
        <button
          type="button"
          onClick={() => go(REQUESTS_PATH)}
          className="flex items-center gap-2 w-[calc(100%-1rem)] mx-2 mb-1 px-3 py-2 rounded-lg text-[13px] font-bold text-white bg-accent hover:bg-accent-deep transition-colors"
          data-testid="new-request"
        >
          <Plus className="w-4 h-4" />
          {COPY.sidebar.newRequest}
        </button>

        <div className={SECTION}>{COPY.sidebar.requests}</div>
        {requests?.length ? requests.map((r) => {
          const selected = activeRequest === r.id
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => go(requestPath(r.id))}
              className={`block w-full text-left px-3 py-1.5 rounded hover:bg-sidebar-hover transition-colors ${
                selected ? 'bg-sidebar-active text-sidebar-text-active' : 'text-sidebar-text'
              }`}
              aria-current={selected ? 'page' : undefined}
              data-testid="request-row"
            >
              <span className={`block text-[13px] leading-snug line-clamp-2 ${selected ? 'font-bold' : 'font-semibold'}`}>{r.text}</span>
              <span className="block text-[11.5px] text-ink-3">{COPY.sidebar.requestMeta(r.responded, r.matched)}</span>
            </button>
          )
        }) : (
          <div className="px-3 py-1 text-sidebar-text text-xs opacity-75">{COPY.sidebar.requestsEmpty}</div>
        )}

        <div className={SECTION}>{COPY.sidebar.retained}</div>
        {retained.length ? retained.map((a) => (
          <button
            key={a.agent_ref}
            type="button"
            onClick={() => openRetained(a.agent_ref)}
            className="flex items-center gap-2 w-full text-left pl-3 pr-4 py-1 rounded text-sidebar-text hover:bg-sidebar-hover transition-colors"
            data-testid="retained-row"
          >
            <SidebarAvatar name={a.display_name} size={21} ringColor="var(--bg-sidebar)" />
            <span className="min-w-0">
              <bdi className="block truncate text-[13px] font-semibold">{a.display_name}</bdi>
              <span className="block truncate text-[11.5px] text-ink-3">{COPY.sidebar.retainedMeta}</span>
            </span>
          </button>
        )) : (
          <div className="px-3 py-1 text-sidebar-text text-xs opacity-75">{COPY.sidebar.retainedEmpty}</div>
        )}

        <div className={SECTION}>{COPY.sidebar.conversations}</div>
        {buckets.length === 0 && hubBuckets.length === 0 && (
          <div className="px-3 py-2 text-sidebar-text text-xs opacity-75">No public agents DMed yet</div>
        )}
        {buckets.map((bucket) => (
          <div key={bucket.owner}>
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-channel/70">
              {bucket.owner}
            </div>
            {bucket.agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                viewer={user}
                label={shortName(agent)}
                isSelected={activeAgentName === agent.name}
                onClick={() => selectAgent(agent)}
              />
            ))}
          </div>
        ))}
        {hubBuckets.map((bucket) => (
          <div key={`hub:${bucket.fingerprint}`} data-testid="hub-bucket">
            <div
              className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-channel/70 truncate"
              title={`Server fingerprint ${bucket.fingerprint}`}
              data-testid="hub-bucket-header"
            >
              @ {bucket.label}<UnusualNameChip name={bucket.deploymentName} />
            </div>
            {bucket.projects.map((p) => {
              const t = p.hub_target
              const display = safeRemoteText(t.display, REMOTE_TEXT_CAP.name * 2)
              const chip = hubRowChip(t)
              const selected = activeHubThread === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectHubThread(t, p.id)}
                  className={`flex items-center gap-2 pl-3 pr-4 py-1 w-full text-left rounded hover:bg-sidebar-hover transition-colors ${
                    selected ? 'bg-sidebar-active text-sidebar-text-active font-bold' : 'text-sidebar-text'
                  } ${chip ? 'opacity-60' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  data-testid="hub-row"
                >
                  <SidebarAvatar name={safeRemoteText(t.name, REMOTE_TEXT_CAP.name)} size={21} ringColor="var(--bg-sidebar)" />
                  <bdi className="truncate font-mono text-[13px]" data-testid="hub-row-display">{display}</bdi>
                  {chip && (
                    <span className="ml-auto flex-shrink-0 text-[10px] px-1 rounded bg-white/10" data-testid="hub-row-chip">
                      {chip}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
        <Link
          to="/agents/public"
          onClick={() => onNavigate?.()}
          className="flex items-center justify-center mx-2 mt-2 px-3 py-2 rounded-lg text-[13px] font-semibold text-accent-deep bg-white border border-border hover:bg-sidebar-hover transition-colors"
        >
          Browse public agents
        </Link>
      </div>
    </PanelShell>
  )
}

import { useMemo, useState, type KeyboardEvent } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { ChevronRight, User as UserIcon } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import { useActiveWorkStore, selectAnyProjectHasActiveWork } from '../../stores/activeWorkStore'
import { useAgents } from '../../hooks/useAgents'
import { useUserProjects } from '../../hooks/useProjects'
import { useDeleteProject } from '../../hooks/useDeleteProject'
import { getChatrooms } from '../../api/endpoints'
import { displayName } from '../../utils/agentDisplay'
import { frontDeskSide, isLegacyFdHost } from '../../utils/frontDesk'
import { parseFrontDeskName, type AgentCard } from '../../types'
import { groupByRecency } from '../../utils/recencyBuckets'
import { useChannelThreads, useEnabledChannels, type ChannelThreadsState } from '../../hooks/useChannelThreads'
import type { ChannelThreadRow } from '../../api/endpoints/channels'
import { CHANNEL_ORDER, THREAD_COPY, channelName, contactLabel } from '../../utils/channelThreads'
import ChannelBadge from '../channels/ChannelBadge'
import HubContactLabel from '../hub/HubContactLabel'
import type { HubContactFields } from '../../api/endpoints/hub'
import { hubContactText } from '../../utils/hubDisplay'
import PanelShell from './PanelShell'
import ProjectRow from './ProjectRow'
import RecencyHeader from './RecencyHeader'
import ActiveWorkDot from './ActiveWorkDot'
import SidebarAvatar, { statusDotColor } from './SidebarAvatar'

interface FDProject {
  id: string
  name: string
  channels: string[]
  lastModified: string // project.last_modified ?? created_at
  /** Set for a channel thread: its row from `GET /me/channels/threads`. */
  row?: ChannelThreadRow
}
/**
 * One group under a desk:
 * - `user` / `agent`: an ordinary Front Desk requester, read from the
 *   `{requester}-fd-{agent}` room name (ordinary threads only);
 * - `contact`: a channel contact, keyed on the opaque contact id;
 * - `removed`: threads whose connection was removed (All tab only);
 * - `pending`: threads that may be channel threads, while the channel list is
 *   loading, failed or channels are off — never filed under a requester.
 */
interface FromGroup {
  key: string
  requester: string
  kind: 'user' | 'agent' | 'contact' | 'removed' | 'pending'
  channel?: string
  disabled?: boolean
  /** A Hub contact's structured fields: drawn by HubContactLabel. */
  hub?: HubContactFields
  projects: FDProject[]
}
interface DeskGroup {
  agent: AgentCard
  froms: FromGroup[]
  projectCount: number
  lastModified: string // max lastModified across all froms → projects
}

const TAB_STORAGE_KEY = 'frontDesk.channelTab'

function readStoredTab(): string {
  try {
    return sessionStorage.getItem(TAB_STORAGE_KEY) ?? 'all'
  } catch {
    return 'all'
  }
}

function PausedMark() {
  return (
    <span
      data-testid="paused-mark"
      className="shrink-0 text-[8.5px] font-extrabold uppercase tracking-[0.05em] text-amber-700 bg-amber-50 rounded px-1 py-px"
    >
      {THREAD_COPY.paused}
    </span>
  )
}

function DisabledMark() {
  return (
    <span
      data-testid="disabled-mark"
      className="shrink-0 text-[8.5px] font-extrabold uppercase tracking-[0.05em] text-ink-4 bg-sidebar-section rounded px-1 py-px"
    >
      {THREAD_COPY.disabled}
    </span>
  )
}

function pendingLabel(state: ChannelThreadsState): string {
  if (state === 'off') return THREAD_COPY.offGroup
  if (state === 'error') return THREAD_COPY.errorGroup
  return THREAD_COPY.loadingGroup
}

// Person icon for a user requestor; slate avatar for an agent requestor.
function RequestorGlyph({ requester, kind }: { requester: string; kind: 'user' | 'agent' }) {
  if (kind === 'agent') {
    return <SidebarAvatar name={requester} size={16} color="var(--av-slate)" />
  }
  return (
    <span className="w-4 shrink-0 inline-flex justify-center text-ink-3">
      <UserIcon className="w-[13px] h-[13px]" />
    </span>
  )
}

function FDeskFrom({
  from,
  activeChannel,
  onOpenChannel,
}: {
  from: FromGroup
  activeChannel: { projectId: string; channel: string } | null
  onOpenChannel: (projectId: string, channel: string) => void
}) {
  const [open, setOpen] = useState(true)
  const working = useActiveWorkStore(selectAnyProjectHasActiveWork(from.projects.map((p) => p.id)))
  const deleteProjectMutation = useDeleteProject()
  const deleteProject = (id: string, name: string) => {
    if (window.confirm(`Delete Front Desk project "${name}"? This cannot be undone.`)) {
      deleteProjectMutation.mutate(id)
    }
  }
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 w-full px-1 py-1 rounded text-left hover:bg-sidebar-hover transition-colors"
        title={from.requester}
        data-testid={`fd-group-${from.kind}`}
      >
        <ChevronRight className={`w-3 h-3 text-ink-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {from.kind === 'user' || from.kind === 'agent' ? (
          <RequestorGlyph requester={from.requester} kind={from.kind} />
        ) : from.kind === 'contact' && from.channel ? (
          <ChannelBadge channel={from.channel} />
        ) : null}
        {/* A contact's name came from outside: text, isolated so a
            right-to-left name can't flip the row. */}
        {from.hub ? (
          <span className="min-w-0 truncate font-mono text-[11.5px] font-semibold text-ink-2" data-testid="fd-group-name">
            <HubContactLabel fields={from.hub} fallbackName={from.requester} />
          </span>
        ) : (
          <bdi className="min-w-0 truncate font-mono text-[11.5px] font-semibold text-ink-2" data-testid="fd-group-name">
            {from.requester}
          </bdi>
        )}
        {from.kind === 'contact' && from.projects.some((p) => p.row?.paused) && <PausedMark />}
        {from.kind === 'contact' && from.disabled && <DisabledMark />}
        {working && <ActiveWorkDot />}
        {(from.kind === 'user' || from.kind === 'agent') && (
          <span className="ml-auto shrink-0 text-[8.5px] font-extrabold uppercase tracking-[0.05em] text-ink-4 bg-sidebar-section rounded px-1.5 py-px">
            {from.kind}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-[15px] pl-2" style={{ borderLeft: '1.5px solid var(--line-1)' }}>
          {from.projects.map((p) => (
            <ProjectRow
              key={p.id}
              name={from.kind === 'removed' && p.row ? contactLabel(p.row.contact_name, p.row.channel) : p.name}
              items={p.channels}
              projectId={p.id}
              activeItem={activeChannel?.projectId === p.id ? activeChannel.channel : null}
              onOpenItem={(channel) => onOpenChannel(p.id, channel)}
              onDelete={() => deleteProject(p.id, p.name)}
              deleteTitle={`Delete ${p.name}`}
              leading={from.kind === 'removed' && p.row ? <ChannelBadge channel={p.row.channel} /> : undefined}
              trailing={from.kind === 'contact' && p.row?.paused ? <PausedMark /> : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** "2 senders", "3 contacts", or "3 contacts · 1 sender": ordinary requesters
 *  are senders, channel people are contacts. */
function deskSubtitle(froms: FromGroup[]): string {
  const senders = froms.filter((f) => f.kind === 'user' || f.kind === 'agent').length
  const contacts = froms.filter((f) => f.kind === 'contact').length
  const parts: string[] = []
  if (contacts > 0) parts.push(`${contacts} ${contacts === 1 ? 'contact' : 'contacts'}`)
  if (senders > 0 || contacts === 0) parts.push(`${senders} ${senders === 1 ? 'sender' : 'senders'}`)
  return parts.join(' · ')
}

/** All, then each channel with an ENABLED connection, in a fixed order. */
function ChannelTabs({ tabs, selected, onSelect }: {
  tabs: string[]; selected: string; onSelect: (tab: string) => void
}) {
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = tabs.indexOf(selected)
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onSelect(next)
    document.getElementById(`fd-tab-${next}`)?.focus()
  }
  return (
    <div role="tablist" aria-label="Channels" onKeyDown={move} className="flex flex-wrap gap-1 px-2 pt-1 pb-1.5">
      {tabs.map((tab) => {
        const active = tab === selected
        return (
          <button
            key={tab}
            id={`fd-tab-${tab}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold transition-colors ${
              active ? 'bg-sidebar-active text-sidebar-text-active' : 'text-ink-3 hover:bg-sidebar-hover'
            }`}
          >
            {tab !== 'all' && <ChannelBadge channel={tab} size={11} decorative />}
            {tab === 'all' ? THREAD_COPY.allTab : channelName(tab)}
          </button>
        )
      })}
    </div>
  )
}

function FDeskDesk({
  desk,
  activeChannel,
  onOpenChannel,
}: {
  desk: DeskGroup
  activeChannel: { projectId: string; channel: string } | null
  onOpenChannel: (projectId: string, channel: string) => void
}) {
  const { user } = useAuthStore()
  const [open, setOpen] = useState(true)
  const label = displayName(desk.agent, user)
  const working = useActiveWorkStore(
    selectAnyProjectHasActiveWork(desk.froms.flatMap((f) => f.projects.map((p) => p.id))),
  )
  return (
    <div className="py-1.5" style={{ borderTop: '1px solid var(--line-1)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full px-2 py-1 rounded text-left hover:bg-sidebar-hover transition-colors"
        title={label}
      >
        <ChevronRight className={`w-3.5 h-3.5 text-ink-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <SidebarAvatar name={label} size={22} dot dotColor={statusDotColor(desk.agent.status)} ringColor="var(--bg-sidebar)" />
        <span className="min-w-0 truncate font-mono text-[12.5px] font-bold text-ink-1">{label}</span>
        {working && <ActiveWorkDot />}
        <span className="text-[10px] text-ink-4 shrink-0" data-testid="fd-desk-subtitle">
          {deskSubtitle(desk.froms)}
        </span>
        <span
          className="ml-auto shrink-0 inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full font-mono text-[10.5px] font-extrabold text-white"
          style={{ background: 'var(--accent)' }}
        >
          {desk.projectCount}
        </span>
      </button>
      {open && (
        <div className="ml-4 pl-[9px]" style={{ borderLeft: '1.5px solid var(--line-2)' }}>
          {desk.froms.map((from) => (
            <FDeskFrom key={from.key} from={from} activeChannel={activeChannel} onOpenChannel={onOpenChannel} />
          ))}
        </div>
      )}
    </div>
  )
}

// F-Desk context: owner-side inbound channels as a Desk › From › Projects ›
// Channels tree — grouped by the local fielding agent (busiest desk first),
// then the foreign requestor, then that engagement's project(s) and channels.
export default function FrontDeskPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuthStore()
  const navigate = useNavigate()
  const channelMatch = useMatch('/projects/:projectId/chatrooms/:chatroomName')
  const activeChannel = channelMatch
    ? { projectId: channelMatch.params.projectId!, channel: channelMatch.params.chatroomName! }
    : null

  const { data: allAgents } = useAgents()
  const { data: projects } = useUserProjects()

  const agentById = useMemo(
    () => new Map((allAgents ?? []).map((a) => [a.id, a])),
    [allAgents],
  )

  // Owner-side FD projects (you host them):
  //   new model  — surface==='frontdesk' AND you own the fielding coordinator
  //                 (frontDeskSide === 'host'). On a row you host, created_by is
  //                 YOU: _create_fd_host_project writes created_by = the fielding
  //                 agent's registered_by, the same value frontDeskSide compares
  //                 against, so host ⟹ created_by === user.id holds by
  //                 construction. created_by is the FOREIGN owner only on the
  //                 *requester* end, which this filter excludes. Coordinator
  //                 ownership is the discriminator because it is what separates
  //                 the two ends, not because created_by is someone else's.
  //   legacy      — a shared '-fd-' row (surface==='dm') you created, kept for
  //                 the migration window (removal condition: Front Desk plan §7).
  const fdProjects = (projects ?? []).filter(
    (p) =>
      !!user &&
      (frontDeskSide(p, agentById, user.id) === 'host' || isLegacyFdHost(p, user.id)),
  )

  const chatroomQueries = useQueries({
    queries: fdProjects.map((p) => ({
      queryKey: ['chatrooms', p.id],
      queryFn: () => getChatrooms(p.id),
      enabled: !!p.id,
    })),
  })

  // Channel threads: tab, badge, contact and pause come ONLY from this list
  // (one request for the whole sidebar); nothing is read from the room name.
  const channelThreads = useChannelThreads()
  const enabledChannels = useEnabledChannels()
  const tabs = [
    'all',
    ...CHANNEL_ORDER.filter((c) => enabledChannels.has(c)),
    ...[...enabledChannels].filter((c) => !(CHANNEL_ORDER as readonly string[]).includes(c)).sort(),
  ]
  const [storedTab, setStoredTab] = useState(readStoredTab)
  // A channel that lost its last enabled connection has no tab: show All.
  // The stored choice stays, so the tab comes back if the channel does.
  const tab = tabs.includes(storedTab) ? storedTab : 'all'
  const selectTab = (next: string) => {
    setStoredTab(next)
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, next)
    } catch {
      /* private mode: the choice lasts until reload */
    }
  }
  // Group by desk (fielding agent) → requester or contact → projects. Data is
  // tiny, so we rebuild each render rather than memoize across the volatile
  // query arrays.
  const desks: DeskGroup[] = (() => {
    if (!allAgents) return []
    const byDesk = new Map<string, { agent: AgentCard; froms: Map<string, FromGroup> }>()
    fdProjects.forEach((project, i) => {
      const agent = agentById.get(project.coordinator_id)
      if (!agent) return
      const row = channelThreads.byProject.get(project.id)
      // A channel tab holds only that channel's live threads; All holds every
      // Front Desk thread, channel and ordinary.
      if (tab !== 'all' && (!row || row.connection_removed || row.channel !== tab)) return
      const ordinary = row ? null : parseFrontDeskName(project.name)
      let from: Omit<FromGroup, 'projects'>
      if (row && row.connection_removed) {
        from = { key: 'removed', requester: THREAD_COPY.removedGroup, kind: 'removed' }
      } else if (row) {
        // Keyed on the opaque contact id: two people with one name stay apart.
        from = {
          key: `contact:${row.contact_id}`,
          requester: hubContactText(row) ?? contactLabel(row.contact_name, row.channel),
          kind: 'contact', channel: row.channel, disabled: !row.connection_enabled,
          ...(row.deployment_fingerprint ? { hub: row } : {}),
        }
      } else if (ordinary || channelThreads.state === 'ready') {
        // "From {sender}" tier for ordinary threads. The backend keeps the
        // requester prefix in the host slug ({requester}-fd-{short}-{hex8}) for
        // BOTH new (surface='frontdesk') and legacy (surface='dm') rows, so we
        // read it from the name. If a slug ever lacks it, degrade to a single
        // unlabeled desk bucket rather than crashing (matches the plan's
        // "desk-only grouping" fallback).
        const requester = ordinary?.requester ?? '—'
        // Usernames can't contain '-', so a hyphen means the requester is an agent.
        from = { key: `req:${requester}`, requester, kind: requester.includes('-') ? 'agent' : 'user' }
      } else {
        // Not an ordinary name, and the channel list hasn't said what it is:
        // hold it apart rather than misfile it under "—".
        from = { key: 'pending', requester: pendingLabel(channelThreads.state), kind: 'pending' }
      }
      const channels = (chatroomQueries[i]?.data ?? []).map((cr) => cr.name)
      const lastModified = project.last_modified ?? project.created_at ?? ''
      const desk = byDesk.get(agent.id) ?? { agent, froms: new Map<string, FromGroup>() }
      const group = desk.froms.get(from.key) ?? { ...from, projects: [] }
      group.projects.push({ id: project.id, name: project.display_name || project.name, channels, lastModified, row })
      desk.froms.set(from.key, group)
      byDesk.set(agent.id, desk)
    })

    const out: DeskGroup[] = []
    for (const { agent, froms } of byDesk.values()) {
      const fromList = Array.from(froms.values())
      const projectCount = fromList.reduce((n, f) => n + f.projects.length, 0)
      // Desk's activity instant = newest project across all its senders.
      const lastModified = fromList.reduce(
        (max, f) => f.projects.reduce((m, p) => (p.lastModified > m ? p.lastModified : m), max),
        '',
      )
      // A contact's threads: newest first. Ordinary requesters keep the
      // project list's order, as before.
      for (const f of fromList) {
        if (f.kind === 'contact') f.projects.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
      }
      // Busiest first, then by name; "No longer connected" and the pending
      // group always last.
      const tail = (f: FromGroup) => (f.kind === 'removed' || f.kind === 'pending' ? 1 : 0)
      fromList.sort(
        (a, b) => tail(a) - tail(b) || b.projects.length - a.projects.length || a.requester.localeCompare(b.requester),
      )
      out.push({ agent, froms: fromList, projectCount, lastModified })
    }
    // Busiest desk first.
    out.sort((a, b) => b.projectCount - a.projectCount || a.agent.name.localeCompare(b.agent.name))
    return out
  })()

  // Recency headers are the outer level; each bucket keeps its busiest-desk-first
  // order. Desks are bucketed by their newest project. Empty buckets are dropped.
  const deskBuckets = groupByRecency(desks, (d) => d.lastModified)

  const openChannel = (projectId: string, channel: string) => {
    if (!confirmLeaveIfDirty()) return
    navigate(`/projects/${projectId}/chatrooms/${channel}`)
    onNavigate?.()
  }

  return (
    <PanelShell title="Front desk" onNavigate={onNavigate}>
      {/* One tab is just the panel: no strip until a channel is connected. */}
      {tabs.length > 1 && <ChannelTabs tabs={tabs} selected={tab} onSelect={selectTab} />}
      <div className="pt-1" role={tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 1 ? `fd-tab-${tab}` : undefined}>
        {desks.length === 0 && (
          <div className="px-3 py-2 text-sidebar-text text-xs opacity-75">
            {tab === 'all' ? 'No Front Desk channels yet. Make an agent public in its settings under Channels → Hub.' : THREAD_COPY.emptyTab(tab)}
          </div>
        )}
        {deskBuckets.map((bucket, i) => (
          <div key={bucket.id}>
            <RecencyHeader label={bucket.label} first={i === 0} />
            {bucket.items.map((desk) => (
              <FDeskDesk key={desk.agent.id} desk={desk} activeChannel={activeChannel} onOpenChannel={openChannel} />
            ))}
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

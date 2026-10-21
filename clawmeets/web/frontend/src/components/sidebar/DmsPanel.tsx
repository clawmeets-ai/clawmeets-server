import { useEffect, useState } from 'react'
import { useNavigate, useMatch } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import { useDmThreads, type DmThread, type DmThreadGroup } from '../../hooks/useDmThreads'
import {
  useActiveWorkStore,
  selectProjectHasActiveWork,
  selectAnyProjectHasActiveWork,
} from '../../stores/activeWorkStore'
import { shortName } from '../../utils/agentDisplay'
import { formatRelativeTime } from '../../utils/formatDate'
import { groupByRecency } from '../../utils/recencyBuckets'
import PanelShell from './PanelShell'
import RecencyHeader from './RecencyHeader'
import ActiveWorkDot from './ActiveWorkDot'
import DmIcon from './DmIcon'
import SidebarAvatar, { statusDotColor } from './SidebarAvatar'

function DmThreadRow({
  thread,
  active,
  onOpen,
}: {
  thread: DmThread
  active: boolean
  onOpen: () => void
}) {
  const working = useActiveWorkStore(selectProjectHasActiveWork(thread.projectId))
  return (
    <div>
      <button
        onClick={onOpen}
        className={`flex items-center gap-2 w-full px-2 py-1 rounded text-left transition-colors ${
          active ? 'bg-sidebar-active text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-hover'
        }`}
        title={thread.title}
      >
        <DmIcon scheduled={thread.isScheduled} size={13} className="text-ink-3" />
        <span className="flex-1 min-w-0 truncate font-mono text-[12px]">{thread.title}</span>
        {working && <ActiveWorkDot />}
        {thread.lastModified && (
          <span className="font-mono text-[10.5px] text-ink-4 tabular-nums shrink-0">
            {formatRelativeTime(thread.lastModified)}
          </span>
        )}
      </button>
    </div>
  )
}

function DmGroup({
  group,
  activeThreadId,
  onOpenThread,
}: {
  group: DmThreadGroup
  activeThreadId: string | null
  onOpenThread: (agentName: string, projectId: string) => void
}) {
  // Collapsed by default: the owner is shown as a section header, so the rail
  // opens showing agent handles with their threads tucked away.
  const [open, setOpen] = useState(false)
  const { agent, threads } = group
  const label = shortName(agent)
  const groupWorking = useActiveWorkStore(
    selectAnyProjectHasActiveWork(threads.map((t) => t.projectId)),
  )

  // Auto-expand the group holding the selected thread (e.g. the DMs first item
  // opened on tab-click). Fires on the selection transition only, so it won't
  // fight a user who manually collapsed a group whose thread stays selected.
  const hasActiveThread = threads.some((t) => t.projectId === activeThreadId)
  useEffect(() => {
    if (hasActiveThread) setOpen(true)
  }, [hasActiveThread])

  return (
    <div className="mb-px">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-[7px] text-left hover:bg-sidebar-hover transition-colors"
      >
        <ChevronRight
          className={`w-3 h-3 text-ink-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <SidebarAvatar
          name={label}
          size={19}
          dot
          dotColor={statusDotColor(agent.status)}
          ringColor="var(--bg-sidebar)"
        />
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold text-ink-1">
          {label}
        </span>
        {groupWorking && <ActiveWorkDot />}
        <span className="ml-auto font-mono text-[10.5px] font-extrabold text-ink-4 tabular-nums">
          {threads.length}
        </span>
      </button>
      {open && (
        <div className="ml-4 pl-[9px]" style={{ borderLeft: '1.5px solid var(--line-2)' }}>
          {threads.map((th) => (
            <DmThreadRow
              key={th.projectId}
              thread={th}
              active={activeThreadId === th.projectId}
              onOpen={() => onOpenThread(agent.name, th.projectId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-channel/70">
      {children}
    </div>
  )
}

// A group's activity instant = its newest thread. useDmThreads sorts each
// group's threads newest-first, so threads[0] is the max.
function groupInstant(group: DmThreadGroup): string {
  return group.threads[0]?.lastModified ?? ''
}

// Own/external owner split, rendered for one recency bucket's worth of groups:
// a "Your agents" section (groups the viewer owns) followed by one section per
// external owner (username up to the first '-'), owners alphabetized. Input
// order within each section is preserved (useDmThreads' newest-first order).
function renderOwnerSections(
  groups: DmThreadGroup[],
  userId: string | undefined,
  renderGroup: (group: DmThreadGroup) => React.ReactNode,
): React.ReactNode {
  const ownGroups: DmThreadGroup[] = []
  const externalByOwner = new Map<string, DmThreadGroup[]>()
  for (const group of groups) {
    if (userId && group.agent.registered_by === userId) {
      ownGroups.push(group)
      continue
    }
    const dash = group.agent.name.indexOf('-')
    const owner = dash > 0 ? group.agent.name.slice(0, dash) : group.agent.name
    const arr = externalByOwner.get(owner) ?? []
    arr.push(group)
    externalByOwner.set(owner, arr)
  }
  const externalOwners = Array.from(externalByOwner.keys()).sort((a, b) => a.localeCompare(b))
  return (
    <>
      {ownGroups.length > 0 && (
        <>
          <SectionHeader>Your agents</SectionHeader>
          {ownGroups.map(renderGroup)}
        </>
      )}
      {externalOwners.map((owner) => (
        <div key={owner}>
          <SectionHeader>{owner}</SectionHeader>
          {externalByOwner.get(owner)!.map(renderGroup)}
        </div>
      ))}
    </>
  )
}

// DMs context: all DM conversations (own + external agents) as threads grouped
// by agent, sectioned by owner — a "Your agents" section plus one section per
// external owner (foreign agents reached via Front Desk threads).
export default function DmsPanel({
  onOpenPalette,
  onNavigate,
}: {
  onOpenPalette: () => void
  onNavigate?: () => void
}) {
  // Own/external owner split: an agent counts as "owned" when I registered it.
  const userId = useAuthStore((s) => s.user?.id)
  const navigate = useNavigate()
  const threadMatch = useMatch('/dm/:agentName/:threadId')
  const activeThreadId = threadMatch?.params.threadId ?? null
  const { groups } = useDmThreads()

  const openThread = (agentName: string, projectId: string) => {
    if (!confirmLeaveIfDirty()) return
    navigate(`/dm/${encodeURIComponent(agentName)}/${projectId}`)
    onNavigate?.()
  }

  const renderGroup = (group: DmThreadGroup) => (
    <DmGroup
      key={group.agent.id}
      group={group}
      activeThreadId={activeThreadId}
      onOpenThread={openThread}
    />
  )

  // Recency headers are the outer level; the own/external owner split runs
  // inside each bucket. Groups keep useDmThreads' newest-first order, so within
  // each bucket sections and rows stay newest-first. Empty buckets are dropped.
  const buckets = groupByRecency(groups, groupInstant)

  return (
    <PanelShell title="Direct messages" onAdd={onOpenPalette} addLabel="Start a conversation">
      <div className="px-1.5 pt-1">
        {groups.length === 0 && (
          <div className="px-2 py-2 text-sidebar-text text-xs opacity-75">No conversations yet</div>
        )}
        {buckets.map((bucket, i) => (
          <div key={bucket.id}>
            <RecencyHeader label={bucket.label} first={i === 0} />
            {renderOwnerSections(bucket.items, userId, renderGroup)}
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

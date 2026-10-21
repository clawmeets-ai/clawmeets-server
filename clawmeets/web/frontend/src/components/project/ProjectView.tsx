import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Share2, PanelRightOpen, X } from 'lucide-react'
import { useProject, useChatrooms } from '../../hooks/useProjects'
import { useIsProjectViewer, useCreateShareLink } from '../../hooks/useSharing'
import { useAllParticipants } from '../../hooks/useAgents'
import AgentNameLink from '../agent/AgentNameLink'
import { useProjectReport } from '../../hooks/useProjectReport'
import { useRenameProject } from '../../hooks/useRenameProject'
import { useUIStore } from '../../stores/uiStore'
import { useAuthStore } from '../../stores/authStore'
import { ProjectStatus, AgentStatus } from '../../types'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import Loading from '../common/Loading'
import Badge from '../common/Badge'
import Avatar from '../common/Avatar'
import VerifiedBadge from '../common/VerifiedBadge'
import Timestamp from '../common/Timestamp'
import ActivityFeed from './ActivityFeed'
import { ProjectReportTab } from './ProjectReportTab'
import { ProjectPlanTab } from './ProjectPlanTab'
import Overlay from '../common/Overlay'
import ResizeHandle from '../common/ResizeHandle'
import CollapsibleHeader from '../common/CollapsibleHeader'
import InlineEditableTitle from '../common/InlineEditableTitle'
import DeleteProjectButton from './DeleteProjectButton'

type ProjectMainTab = 'activity' | 'report' | 'plan'

const statusVariant = {
  [ProjectStatus.ACTIVE]: 'info' as const,
  [ProjectStatus.COMPLETED]: 'success' as const,
  [ProjectStatus.FAILED]: 'error' as const,
}

// The badge used to render `project.status` raw, so it spelled the wire slug —
// "completed" — while the ticket chip for the very same project said "Done".
// Same reason `ticketLabel` exists: the enum is the value, the label is the
// copy, and COMPLETED is shown as Done everywhere the user can read it.
const statusLabel = {
  [ProjectStatus.ACTIVE]: 'active',
  [ProjectStatus.COMPLETED]: 'done',
  [ProjectStatus.FAILED]: 'failed',
}

export default function ProjectView() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { data: project, isLoading: projectLoading } = useProject(projectId)
  const { data: chatrooms, isLoading: chatroomsLoading } = useChatrooms(projectId)
  const { data: allParticipants } = useAllParticipants()
  const { isMobileRightPanelOpen, openMobileRightPanel, closeMobileRightPanel, rightPanelWidth, setRightPanelWidth } = useUIStore()
  const isViewer = useIsProjectViewer(projectId)
  const rename = useRenameProject()
  const createShareLinkMutation = useCreateShareLink()
  const viewer = useAuthStore((state) => state.user) ?? null
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { data: report } = useProjectReport(projectId)
  const hasReport = !!report
  // The Plan tab is shown iff the project record carries a plan summary and
  // the shape is not front-desk: the requester sees no plan surface at all,
  // and there is deliberately none to build. Absence of `plan` is the signal
  // that there is no plan — a DM, or a pre-feature project — so this is a
  // presence check, never a read of `plan.phase`, which is null on front-desk.
  const hasPlan = !!project?.plan && project.plan.surface !== 'frontdesk'
  const [mainTab, setMainTab] = useState<ProjectMainTab>('activity')
  // Default to the Report tab on completed projects that have one — the
  // user usually opens these to see the conclusions, not to scroll
  // history. Activity stays one click away.
  useEffect(() => {
    if (hasReport && project?.status === ProjectStatus.COMPLETED) {
      setMainTab('report')
    }
  }, [hasReport, project?.status])
  // If the report disappears (deleted), drop back to Activity.
  useEffect(() => {
    if (!hasReport && mainTab === 'report') setMainTab('activity')
  }, [hasReport, mainTab])
  useEffect(() => {
    if (!hasPlan && mainTab === 'plan') setMainTab('activity')
  }, [hasPlan, mainTab])
  // Honor the ?tab= deep-links — `report` (the report link in notification
  // emails) so it lands on the Report tab regardless of project status, and
  // `plan` (a desk card's PLAN band release control) so answering the notes
  // that hold a run starts on the document rather than on the activity feed.
  // Each is gated on its surface EXISTING, so a stale link degrades to Activity
  // rather than to an empty tab.
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const want = searchParams.get('tab')
    if (hasReport && want === 'report') setMainTab('report')
    if (hasPlan && want === 'plan') setMainTab('plan')
  }, [hasReport, hasPlan, searchParams])

  const handleShare = async () => {
    if (shareUrl) {
      setShareUrl(null)
      return
    }
    try {
      const result = await createShareLinkMutation.mutateAsync(projectId)
      const url = `${window.location.origin}/app${result.share_url}`
      setShareUrl(url)
    } catch {
      // error handled by mutation
    }
  }

  const handleCopyLink = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Users see all chatrooms
  const visibleChatrooms = chatrooms

  if (projectLoading || chatroomsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading size="lg" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Project not found
      </div>
    )
  }

  // Get agent details for participants (includes both workers and assistants)
  const participantAgents = project.participating_agents
    .map((id) => allParticipants?.find((a) => a.id === id))
    .filter(Boolean)

  const coordinator = allParticipants?.find((a) => a.id === project.coordinator_id)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <CollapsibleHeader className="border-b border-border px-6 py-4 pl-14 lg:pl-6">
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {/* min-w-0 all the way down, so a long title truncates instead of
                pushing the status badge and the action buttons off the row. */}
            <h2 className="text-xl text-channel-active min-w-0">
              <InlineEditableTitle
                value={project.display_name || project.name}
                label="Project name"
                // A share-link viewer is a 403 on this route (share links are
                // read-only everywhere else too), so they get a plain title.
                editable={!isViewer}
                onSave={(next) => rename.mutateAsync({ projectId, displayName: next })}
              />
            </h2>
            {isViewer && (
              <span className="shrink-0 text-xs font-semibold text-channel bg-sidebar px-2 py-0.5 rounded-full">
                Read-only
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isViewer && (
              /* Share button */
              <div className="relative">
                <button
                  onClick={handleShare}
                  disabled={createShareLinkMutation.isPending}
                  className="p-1.5 rounded-md hover:bg-sidebar-hover text-channel hover:text-channel-active transition-colors disabled:opacity-50"
                  aria-label="Share project"
                  title="Share project"
                >
                  <Share2 className="w-4 h-4" />
                </button>
                {shareUrl && (
                  <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-border rounded-lg shadow-lg p-3 z-50">
                    <p className="text-xs text-channel mb-2">Share this link for read-only access:</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={shareUrl}
                        className="flex-1 text-xs px-2 py-1.5 border border-border rounded bg-sidebar text-channel-active"
                      />
                      <button
                        onClick={handleCopyLink}
                        className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent-deep transition-colors font-bold"
                      >
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <Badge variant={statusVariant[project.status]}>
              {statusLabel[project.status]}
            </Badge>
            <DeleteProjectButton projectId={projectId} />
            {/* Right-panel trigger - visible only on mobile */}
            <button
              onClick={openMobileRightPanel}
              className="p-2 rounded-md hover:bg-sidebar-hover transition-colors lg:hidden"
              aria-label="Open project info panel"
              title="Project info"
            >
              <PanelRightOpen className="w-5 h-5 text-channel" />
            </button>
          </div>
        </div>
        <p className="text-sidebar-text text-sm mb-3">{project.request}</p>
        <div className="flex items-center gap-4 text-sm text-channel">
          <span>
            Created <Timestamp date={project.created_at} />
          </span>
          {coordinator && (
            <span className="flex items-center gap-1">
              Coordinator:
              <span className="font-semibold text-channel-active">{agentDisplayName(coordinator, viewer)}</span>
            </span>
          )}
        </div>
      </CollapsibleHeader>

      {/* Content */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Activity / Report tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div
            role="tablist"
            className="flex gap-1 px-6 pt-5 border-b border-border"
          >
            <button
              role="tab"
              type="button"
              aria-selected={mainTab === 'activity'}
              onClick={() => setMainTab('activity')}
              className={
                'px-3 pt-2 pb-3 bg-transparent border-0 -mb-px text-xs font-extrabold uppercase tracking-wider transition-colors ' +
                (mainTab === 'activity'
                  ? 'text-channel-active border-b-2 border-accent'
                  : 'text-channel border-b-2 border-transparent hover:text-channel-active')
              }
            >
              Activity
            </button>
            {hasReport && (
              <button
                role="tab"
                type="button"
                aria-selected={mainTab === 'report'}
                onClick={() => setMainTab('report')}
                className={
                  'px-3 pt-2 pb-3 bg-transparent border-0 -mb-px text-xs font-extrabold uppercase tracking-wider transition-colors ' +
                  (mainTab === 'report'
                    ? 'text-channel-active border-b-2 border-accent'
                    : 'text-channel border-b-2 border-transparent hover:text-channel-active')
                }
              >
                Report
              </button>
            )}
            {hasPlan && (
              <button
                role="tab"
                type="button"
                aria-selected={mainTab === 'plan'}
                onClick={() => setMainTab('plan')}
                className={
                  'px-3 pt-2 pb-3 bg-transparent border-0 -mb-px text-xs font-extrabold uppercase tracking-wider transition-colors ' +
                  (mainTab === 'plan'
                    ? 'text-channel-active border-b-2 border-accent'
                    : 'text-channel border-b-2 border-transparent hover:text-channel-active')
                }
              >
                Plan
                {/* The one integer, READ off the project record and never
                    recomputed here. `open_notes_for_you` is what the execution
                    gate reads; a second count on this surface is the drift the
                    single implementation exists to refuse. */}
                {project?.plan && project.plan.open_notes_for_you > 0 && (
                  <span className="ml-1 text-accent" data-testid="plan-tab-count">
                    {project.plan.open_notes_for_you}
                  </span>
                )}
              </button>
            )}
          </div>

          {mainTab === 'activity' ? (
            <ActivityFeed projectId={projectId} chatrooms={visibleChatrooms || []} />
          ) : mainTab === 'plan' ? (
            <div className="flex-1 overflow-hidden">
              <ProjectPlanTab projectId={projectId} active={mainTab === 'plan'} />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <ProjectReportTab projectId={projectId} active={mainTab === 'report'} />
            </div>
          )}
        </div>

        {/* Backdrop overlay for mobile right panel */}
        <Overlay isOpen={isMobileRightPanelOpen} onClose={closeMobileRightPanel} />

        <ResizeHandle side="right" onResize={setRightPanelWidth} />

        {/* Sidebar - slide-in on mobile, static on desktop */}
        <aside
          className={`
            fixed inset-y-0 right-0 z-50 bg-sidebar border-l border-border p-4 overflow-y-auto scrollbar-thin flex-shrink-0
            transform transition-transform duration-300 ease-in-out
            lg:relative lg:translate-x-0 lg:transform-none lg:transition-none lg:z-auto
            ${isMobileRightPanelOpen ? 'translate-x-0' : 'translate-x-full'}
          `}
          style={{ width: rightPanelWidth }}
        >
          {/* Close button - visible only on mobile */}
          <button
            onClick={closeMobileRightPanel}
            className="absolute top-3 right-3 p-1 rounded-md hover:bg-sidebar-hover transition-colors lg:hidden"
            aria-label="Close panel"
          >
            <X className="w-5 h-5 text-channel" />
          </button>

          {/* Chatrooms */}
          <div className="mb-6 mt-8 lg:mt-0">
            <h3 className="text-xs font-extrabold text-channel uppercase tracking-wider mb-3">
              Chatrooms ({visibleChatrooms?.length || 0})
            </h3>
            <div className="space-y-1">
              {visibleChatrooms?.map((room) => (
                <button
                  key={room.id}
                  onClick={() => navigate(`/projects/${projectId}/chatrooms/${room.id}`)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-sidebar-hover transition-colors text-sm"
                >
                  <span className="text-channel mr-1">#</span>
                  <span className="text-channel-active">{room.name}</span>
                  <span className="text-channel text-xs ml-2">
                    ({room.participants.length})
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Participants */}
          <div>
            <h3 className="text-xs font-extrabold text-channel uppercase tracking-wider mb-3">
              Participants ({participantAgents.length})
            </h3>
            <div className="space-y-2">
              {participantAgents.map((agent) => {
                const label = agentDisplayName(agent!, viewer)
                return (
                <div key={agent!.id} className="flex items-center gap-2.5">
                  <Avatar
                    name={label}
                    status={agent!.status as AgentStatus}
                    size="md"
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-channel-active truncate flex items-center gap-1">
                      <AgentNameLink agentName={agent!.name} className="truncate">
                        {label}
                      </AgentNameLink>
                      {agent!.is_verified && <VerifiedBadge />}
                      {agent!.id === project.coordinator_id && (
                        <span className="text-channel text-xs ml-1 font-normal">(coordinator)</span>
                      )}
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

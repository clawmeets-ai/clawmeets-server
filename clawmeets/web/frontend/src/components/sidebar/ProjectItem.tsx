import { useEffect, useMemo } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { ChevronRight, Folder } from 'lucide-react'
import { ProjectStatus } from '../../types'
import { useAgents } from '../../hooks/useAgents'
import { useUIStore } from '../../stores/uiStore'
import { useActiveWorkStore, selectProjectHasActiveWork } from '../../stores/activeWorkStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import ChatroomItem from './ChatroomItem'
import ActiveWorkDot from './ActiveWorkDot'
import { ISOLATION_COPY } from '../../utils/agentAccessCopy'

// Local view model for project in sidebar
interface ProjectView {
  project_id: string
  project_name: string
  status?: ProjectStatus
  chatrooms: Array<{ chatroom_id: string; chatroom_name: string }>
  // DM threads (surface === 'dm') navigate to the DM chat view instead of the
  // project view; coordinator_id resolves the DM'd agent for that route. Front
  // Desk ends (surface === 'frontdesk') are filtered out upstream
  // (useProjectsWithChatrooms) and never reach this row, so no FD nav branch is
  // needed here — the union member exists only for type-completeness.
  surface?: 'regular' | 'dm' | 'frontdesk'
  coordinator_id?: string
  chatrooms_unavailable?: boolean
}

interface ProjectItemProps {
  project: ProjectView
  onNavigate?: () => void
}

export default function ProjectItem({ project, onNavigate }: ProjectItemProps) {
  const navigate = useNavigate()
  const projectMatch = useMatch('/projects/:projectId/*')
  const { data: allAgents } = useAgents()
  const {
    expandedProjects,
    toggleProjectExpanded,
    setProjectExpanded,
  } = useUIStore()

  const isExpanded = expandedProjects.has(project.project_id)
  const isSelected = projectMatch?.params.projectId === project.project_id

  // Selecting a project expands it (default-selected, deep-link, or palette nav).
  // Deps exclude the expand state so it fires on the selection transition only —
  // it won't re-expand a project the user manually collapsed while it stays selected.
  useEffect(() => {
    if (isSelected) setProjectExpanded(project.project_id, true)
  }, [isSelected, project.project_id, setProjectExpanded])

  const hasActiveWork = useActiveWorkStore(selectProjectHasActiveWork(project.project_id))

  // Pin the project's anchor rooms to the top of the chatroom list:
  // shared-context (the brief/files everyone shares) then coordinator
  // (user's direct line). Other rooms keep their original order — Array
  // .sort is stable, so returning 0 for non-priority rooms preserves it.
  const sortedChatrooms = useMemo(() => {
    const priority = (name: string) => {
      if (name.startsWith('shared-context')) return 0
      if (name.startsWith('user-communication')) return 1
      return 2
    }
    return [...project.chatrooms].sort(
      (a, b) => priority(a.chatroom_name) - priority(b.chatroom_name),
    )
  }, [project.chatrooms])

  const handleClick = () => {
    if (!confirmLeaveIfDirty()) return
    // A DM-thread row opens the DM chat view bound to this thread project;
    // the agent name comes from the thread's coordinator. Regular projects
    // open the project view and auto-expand their chatroom list.
    if (project.surface === 'dm') {
      const agent = allAgents?.find((a) => a.id === project.coordinator_id)
      const path = agent
        ? `/dm/${encodeURIComponent(agent.name)}/${project.project_id}`
        : `/projects/${project.project_id}`
      navigate(path)
      onNavigate?.()
      return
    }
    navigate(`/projects/${project.project_id}`)
    if (!isExpanded) {
      toggleProjectExpanded(project.project_id)
    }
    onNavigate?.()
  }

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleProjectExpanded(project.project_id)
  }

  const isFailed = project.status === ProjectStatus.FAILED

  return (
    <div>
      <div className="transition-colors duration-700">
        <button
          onClick={handleClick}
          className={`
            flex items-center gap-2 w-full pl-2 pr-3 py-1 text-left text-sm
            hover:bg-sidebar-hover transition-colors
            ${isSelected ? 'bg-sidebar-active text-sidebar-text-active font-bold' : ''}
          `}
        >
          <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="flex-1 min-w-0 truncate font-mono text-[12px]">{project.project_name}</span>
          {isFailed && (
            <span
              className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-red-100 text-red-700 flex-shrink-0"
              title="Project failed"
            >
              Failed
            </span>
          )}
          {hasActiveWork && <ActiveWorkDot />}
          {project.chatrooms_unavailable && (
            <span className="text-[10px] text-ink-4 shrink-0" data-testid="project-unavailable">
              {ISOLATION_COPY.batchUnavailable}
            </span>
          )}
          {project.chatrooms.length > 0 && (
            <span className="font-mono text-[10px] font-extrabold text-ink-4 tabular-nums shrink-0">
              {project.chatrooms.length}
            </span>
          )}
          {project.chatrooms.length > 0 && (
            <span
              onClick={handleToggle}
              className="flex items-center text-channel hover:text-channel-active cursor-pointer shrink-0"
            >
              <ChevronRight
                className={`w-3.5 h-3.5 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              />
            </span>
          )}
        </button>
      </div>

      {isExpanded && (
        <div className="ml-4 border-l border-border">
          <div className="pl-7 pr-4 pt-2 pb-0.5 text-[10px] font-semibold tracking-wider uppercase text-channel">
            Chatrooms
          </div>
          {sortedChatrooms.map((chatroom) => (
            <ChatroomItem
              key={chatroom.chatroom_id}
              projectId={project.project_id}
              chatroom={chatroom}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

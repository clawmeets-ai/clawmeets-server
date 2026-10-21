import { useMemo, useState } from 'react'
import { useAssistantAgent } from '../../hooks/useAssistantAgent'
import { useProjectsWithChatrooms, type ProjectView } from '../../hooks/useProjectsWithChatrooms'
import { isThreadProject } from '../../types'
import PanelShell from './PanelShell'
import ProjectItem from './ProjectItem'
import RecencyHeader from './RecencyHeader'
import Loading from '../common/Loading'
import { groupByRecency } from '../../utils/recencyBuckets'
import DmComposeModal from '../dm/DmComposeModal'

// Projects context: regular + shared projects (own-DM threads live in the
// Agents roster). Reuses the rich ProjectItem, so chatroom expansion / unread /
// delete carry over.
export default function ProjectsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { data: projects, isLoading, error } = useProjectsWithChatrooms()
  const assistant = useAssistantAgent()
  const [composeOpen, setComposeOpen] = useState(false)

  const listed = useMemo(() => {
    const byModifiedDesc = (a: ProjectView, b: ProjectView) =>
      (b.last_modified ?? b.created_at ?? '').localeCompare(a.last_modified ?? a.created_at ?? '')
    // Defense-in-depth: threads (dm + frontdesk) are already excluded at the
    // source (useProjectsWithChatrooms), so this only ever drops nothing new —
    // but keep it so a stray thread can never surface in the regular list.
    return (projects ?? []).filter((p) => !isThreadProject(p)).sort(byModifiedDesc)
  }, [projects])

  // Partition the sorted list into Today / Last 7 Days / Other by each project's
  // activity timestamp; empty buckets are dropped. Sort within each bucket is
  // preserved, so ProjectItem behaviour (expansion / unread / delete) is intact.
  const buckets = useMemo(
    () => groupByRecency(listed, (p) => p.last_modified ?? p.created_at),
    [listed],
  )

  // `+` opens the DM compose modal (mode='project') against the user's
  // assistant. Falls back to the classic new-project form if no assistant is
  // registered yet, so the button is never a dead end.
  return (
    <>
    <PanelShell
      title="Projects"
      onAdd={assistant ? () => setComposeOpen(true) : undefined}
      addTo={assistant ? undefined : '/projects/new'}
      addLabel="New project"
      onNavigate={onNavigate}
    >
      <div className="px-1.5 pt-1">
        {isLoading && (
          <div className="px-3 py-2">
            <Loading size="sm" />
          </div>
        )}
        {error && <div className="px-3 py-2 text-red-400 text-sm">Failed to load projects</div>}
        {!isLoading && !error && listed.length === 0 && (
          <div className="px-3 py-2 text-sidebar-text text-xs opacity-75">No projects yet</div>
        )}
        {!isLoading &&
          !error &&
          buckets.map((bucket, i) => (
            <div key={bucket.id}>
              <RecencyHeader label={bucket.label} first={i === 0} />
              {bucket.items.map((project) => (
                <ProjectItem key={project.project_id} project={project} onNavigate={onNavigate} />
              ))}
            </div>
          ))}
      </div>
    </PanelShell>
    {composeOpen && assistant && (
      <DmComposeModal
        mode="project"
        recipient={assistant}
        onClose={() => setComposeOpen(false)}
      />
    )}
    </>
  )
}

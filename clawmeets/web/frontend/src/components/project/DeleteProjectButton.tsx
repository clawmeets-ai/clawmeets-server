import { Trash2 } from 'lucide-react'
import { useProject } from '../../hooks/useProjects'
import { useIsProjectViewer, useRemoveSharedProject } from '../../hooks/useSharing'
import { useDeleteProject } from '../../hooks/useDeleteProject'

// Header trash for a project, shared by the project page and its chatrooms.
// Owners delete the project; a viewer of a shared project can only drop it
// from their own list. Both hooks navigate away when the open project goes.
export default function DeleteProjectButton({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId)
  const isViewer = useIsProjectViewer(projectId)
  const deleteProjectMutation = useDeleteProject()
  const removeSharedMutation = useRemoveSharedProject()

  const handleDelete = () => {
    const name = project?.display_name || project?.name || ''
    if (isViewer) {
      if (window.confirm(`Remove "${name}" from your projects?`)) {
        removeSharedMutation.mutate(projectId)
      }
    } else if (window.confirm(`Delete project "${name}"? This cannot be undone.`)) {
      deleteProjectMutation.mutate(projectId)
    }
  }
  const pending = isViewer ? removeSharedMutation.isPending : deleteProjectMutation.isPending
  const title = isViewer ? 'Remove from my projects' : 'Delete project'

  return (
    <button
      onClick={handleDelete}
      disabled={pending}
      className="p-1.5 rounded-md hover:bg-red-100 text-channel hover:text-red-600 transition-colors disabled:opacity-50"
      aria-label={title}
      title={title}
    >
      <Trash2 className="w-4 h-4" />
    </button>
  )
}

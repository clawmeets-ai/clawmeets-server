import { useEffect } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useContextFirstItem } from '../../hooks/useContextFirstItem'
import { useUIStore, type RailContext } from '../../stores/uiStore'
import Loading from '../common/Loading'
import ContextGuide from './ContextGuide'

// Contexts that resolve through this landing (Desk → /desk and Sched → /scheduled
// have their own main views and never route here).
const KNOWN = new Set<RailContext>(['agents', 'dms', 'projects', 'frontdesk', 'public'])

// The main-panel target of a rail-tab click: redirect to the context's first item,
// or render the per-tab zero state when the context is empty. Reached only via
// Sidebar.handleRailSelect (never a deep-link), so it never hijacks a direct URL.
export default function ContextLanding() {
  const { context } = useParams<{ context: string }>()
  const ctx = (context ?? '') as RailContext
  const known = KNOWN.has(ctx)
  const setProjectExpanded = useUIStore((s) => s.setProjectExpanded)

  const { route, loading } = useContextFirstItem(known ? ctx : undefined)

  // Unfold the target project's rooms in the side panel (matches a sidebar click).
  const projectId = ctx === 'projects' && route ? route.split('/')[2] : undefined
  useEffect(() => {
    if (projectId) setProjectExpanded(projectId, true)
  }, [projectId, setProjectExpanded])

  if (!known) return <Navigate to="/desk" replace />
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading size="md" />
      </div>
    )
  }
  if (route)
    return (
      <Navigate
        to={route}
        replace
        state={ctx === 'projects' ? { focusComposer: true } : undefined}
      />
    )
  return <ContextGuide context={ctx} />
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { useUIStore, railContextFromPath, type RailContext } from '../../stores/uiStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import { useDmThreads } from '../../hooks/useDmThreads'
import { useActiveWorkStore, selectAnyProjectHasActiveWork } from '../../stores/activeWorkStore'
import { useUserProjects } from '../../hooks/useProjects'
import { isFrontDeskProject, isThreadProject } from '../../types'
import SidebarRail from '../sidebar/SidebarRail'
import CommandPalette from '../sidebar/CommandPalette'
import HotkeysHelp from '../sidebar/HotkeysHelp'
import { RAIL_SHORTCUTS } from '../sidebar/railShortcuts'
import AgentsPanel from '../sidebar/AgentsPanel'
import DmsPanel from '../sidebar/DmsPanel'
import ProjectsPanel from '../sidebar/ProjectsPanel'
import ComputersPanel from '../sidebar/ComputersPanel'
import FrontDeskPanel from '../sidebar/FrontDeskPanel'
import PublicPanel from '../sidebar/PublicPanel'
import ScheduledPanel from '../sidebar/ScheduledPanel'
import MyDeskRailPanel from '../sidebar/MyDeskRailPanel'

interface SidebarProps {
  onNavigate?: () => void
}

// Two-level rail sidebar (approach C): a 68px icon rail selects one of six
// contexts; a single panel renders only the active one. Replaces the former
// single-column reorg.
export default function Sidebar({ onNavigate }: SidebarProps) {
  const { user } = useAuthStore()
  const { railContext, setRailContext } = useUIStore()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [hotkeysOpen, setHotkeysOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // Every rail tab drives the main panel too: open the context's first item
  // (via the /c/<ctx> landing), UNLESS you're already viewing content in that
  // context — then just keep the side panel and leave the main pane where it is.
  // "Already in context" = railContext matches AND we're on a real content route
  // (guards drift onto /settings, /projects/new, the welcome page, etc.).
  const handleRailSelect = useCallback(
    (id: RailContext) => {
      const c = railContextFromPath(location.pathname)
      const inContext = railContext === id && c != null && c !== 'welcome'
      setRailContext(id)
      if (id === 'welcome') return // the logo's <Link> handles navigation
      if (inContext) return
      if (!confirmLeaveIfDirty()) return
      if (id === 'desk') return navigate('/desk')
      if (id === 'scheduled') return navigate('/scheduled')
      // Computers has its own main view and resolves its own first item (or its
      // empty state) inside ComputerPage, so it skips the /c/<ctx> landing for
      // the same reason Desk and Sched do.
      if (id === 'computers') return navigate('/computers')
      navigate(`/c/${id}`) // agents | dms | projects | frontdesk | public
    },
    [railContext, location.pathname, navigate, setRailContext],
  )

  // Deep-link / reload: select the rail context that matches the route so a
  // reloaded chatroom URL shows Projects, not the default Agents panel. Runs
  // only on mount — in-app rail clicks stay decoupled from the URL.
  useLayoutEffect(() => {
    const ctx = railContextFromPath(location.pathname)
    if (ctx) setRailContext(ctx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { groups: dmGroups } = useDmThreads()
  const dmProjectIds = useMemo(
    () => dmGroups.flatMap((g) => g.threads.map((t) => t.projectId)),
    [dmGroups],
  )
  const dmsActive = useActiveWorkStore(selectAnyProjectHasActiveWork(dmProjectIds))
  const { data: projects } = useUserProjects()
  const regularProjectIds = useMemo(
    () => (projects ?? []).filter((p) => !isThreadProject(p)).map((p) => p.id),
    [projects],
  )
  const fdProjectIds = useMemo(
    () => (projects ?? []).filter((p) => isFrontDeskProject(p) && p.created_by === user?.id).map((p) => p.id),
    [projects, user?.id],
  )
  const projectsActive = useActiveWorkStore(selectAnyProjectHasActiveWork(regularProjectIds))
  const frontdeskActive = useActiveWorkStore(selectAnyProjectHasActiveWork(fdProjectIds))

  // Global ⌘K / Ctrl+K toggles the palette; "?" opens the shortcuts panel. Bare
  // "g" then a letter jumps to a rail context (Gmail/Linear-style chord, mapped
  // by RAIL_SHORTCUTS). Chords are ignored while typing or when a modifier is
  // held, so they never clobber input or the desk's own single-key shortcuts
  // (j/k/[/]/space/e/r/x/o).
  const pendingGRef = useRef(0)
  useEffect(() => {
    const chord = new Map(RAIL_SHORTCUTS.map((s) => [s.key, s.context]))
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

      if (e.key === '?') {
        e.preventDefault()
        setHotkeysOpen(true)
        return
      }

      const now = Date.now()
      const ctx = chord.get(e.key.toLowerCase())
      if (ctx && now - pendingGRef.current < 800) {
        pendingGRef.current = 0
        e.preventDefault()
        handleRailSelect(ctx)
        return
      }
      pendingGRef.current = e.key === 'g' || e.key === 'G' ? now : 0
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleRailSelect])

  const panel = (() => {
    switch (railContext) {
      case 'welcome':
        return null // logo / Welcome landing → no side panel
      case 'desk':
        return <MyDeskRailPanel onNavigate={onNavigate} />
      case 'dms':
        return <DmsPanel onOpenPalette={() => setPaletteOpen(true)} onNavigate={onNavigate} />
      case 'projects':
        return <ProjectsPanel onNavigate={onNavigate} />
      case 'computers':
        return <ComputersPanel onNavigate={onNavigate} />
      case 'frontdesk':
        return <FrontDeskPanel onNavigate={onNavigate} />
      case 'scheduled':
        return <ScheduledPanel onNavigate={onNavigate} />
      case 'public':
        return <PublicPanel onNavigate={onNavigate} />
      case 'agents':
      default:
        return <AgentsPanel onNavigate={onNavigate} />
    }
  })()

  return (
    <aside className="flex flex-row w-full h-full bg-sidebar">
      <SidebarRail
        context={railContext}
        onSelect={handleRailSelect}
        working={{ dms: dmsActive, projects: projectsActive, frontdesk: frontdeskActive }}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenHotkeys={() => setHotkeysOpen(true)}
        onNavigate={onNavigate}
        user={user}
      />
      {panel}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <HotkeysHelp
        open={hotkeysOpen}
        onClose={() => setHotkeysOpen(false)}
      />
    </aside>
  )
}

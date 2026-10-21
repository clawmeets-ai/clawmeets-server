import { create } from 'zustand'

// Which context the two-level rail sidebar is showing (one visible at a time).
// 'welcome' is a non-tab state: no rail tab highlights and no side panel renders
// (the Welcome landing page owns the full width) — set by the top-left logo.
export type RailContext = 'welcome' | 'desk' | 'agents' | 'dms' | 'projects' | 'computers' | 'frontdesk' | 'scheduled' | 'public'

// A deep-linked / reloaded URL should select the matching rail context. The bare
// "/projects" welcome page maps to the panel-less 'welcome' state so a reload
// keeps the tab deselected and the side panel hidden. Paths come from
// useLocation(), which is already basename-stripped ("/app" removed).
export function railContextFromPath(pathname: string): RailContext | null {
  if (pathname.startsWith('/desk')) return 'desk'
  if (pathname.startsWith('/dm/')) return 'dms'
  if (pathname.startsWith('/scheduled')) return 'scheduled'
  // Both the bare list and one machine's page. Unlike '/projects', there is no
  // panel-less welcome variant to carve out: '/computers' with no id redirects
  // to the first machine (or renders the empty state) inside the same context.
  if (pathname.startsWith('/computers')) return 'computers'
  if (pathname === '/requests' || pathname.startsWith('/requests/')) return 'public' // public requests
  if (/^\/projects\/.+/.test(pathname)) return 'projects' // /projects/:id, /chatrooms/..., /projects/new
  if (pathname === '/projects' || pathname === '/projects/') return 'welcome' // bare welcome page
  if (pathname.startsWith('/c/')) return pathname.slice(3).split('/')[0] as RailContext // /c/<ctx> landing
  return null // /agents/*, /settings → leave the current context
}

interface UIState {
  // Sidebar state
  railContext: RailContext
  expandedProjects: Set<string>
  expandedAgentTeams: Set<string>
  isDMChatsSectionExpanded: boolean
  isProjectsSectionExpanded: boolean
  isSharedProjectsSectionExpanded: boolean
  isTeamsSectionExpanded: boolean
  isFrontDeskSectionExpanded: boolean
  isPublicAgentsSectionExpanded: boolean

  // Mobile panel state
  isMobileSidebarOpen: boolean
  isMobileRightPanelOpen: boolean

  // Panel widths (desktop resize)
  sidebarWidth: number
  rightPanelWidth: number

  // Actions
  setRailContext: (context: RailContext) => void
  toggleProjectExpanded: (projectId: string) => void
  setProjectExpanded: (projectId: string, expanded: boolean) => void
  toggleAgentTeam: (teamName: string) => void
  expandAgentTeam: (teamName: string) => void
  toggleTeamsSection: () => void

  // Section collapse actions
  toggleDMChatsSection: () => void
  toggleProjectsSection: () => void
  toggleSharedProjectsSection: () => void
  toggleFrontDeskSection: () => void
  togglePublicAgentsSection: () => void

  // Mobile panel actions
  openMobileSidebar: () => void
  closeMobileSidebar: () => void
  toggleMobileSidebar: () => void
  openMobileRightPanel: () => void
  closeMobileRightPanel: () => void
  toggleMobileRightPanel: () => void

  // Panel width actions
  setSidebarWidth: (delta: number) => void
  setRightPanelWidth: (delta: number) => void

  // Reset
  reset: () => void
}

export const useUIStore = create<UIState>((set) => ({
  railContext: 'agents',
  expandedProjects: new Set(),
  expandedAgentTeams: new Set(),
  isDMChatsSectionExpanded: true,
  // Redesigned sidebar demotes Projects below the agent roster and starts it
  // collapsed.
  isProjectsSectionExpanded: false,
  isSharedProjectsSectionExpanded: false,
  isTeamsSectionExpanded: true,
  isFrontDeskSectionExpanded: true,
  isPublicAgentsSectionExpanded: true,
  isMobileSidebarOpen: false,
  isMobileRightPanelOpen: false,
  // Two-level rail: 68px icon rail + 232px context panel.
  sidebarWidth: 300,
  rightPanelWidth: 256,

  setRailContext: (context) => set({ railContext: context }),

  toggleProjectExpanded: (projectId) =>
    set((state) => {
      const expanded = new Set(state.expandedProjects)
      if (expanded.has(projectId)) {
        expanded.delete(projectId)
      } else {
        expanded.add(projectId)
      }
      return { expandedProjects: expanded }
    }),

  setProjectExpanded: (projectId, expanded) =>
    set((state) => {
      const newExpanded = new Set(state.expandedProjects)
      if (expanded) {
        newExpanded.add(projectId)
      } else {
        newExpanded.delete(projectId)
      }
      return { expandedProjects: newExpanded }
    }),

  toggleAgentTeam: (teamName) =>
    set((state) => {
      const expanded = new Set(state.expandedAgentTeams)
      if (expanded.has(teamName)) {
        expanded.delete(teamName)
      } else {
        expanded.add(teamName)
      }
      return { expandedAgentTeams: expanded }
    }),

  expandAgentTeam: (teamName) =>
    set((state) => {
      if (state.expandedAgentTeams.has(teamName)) return state
      const expanded = new Set(state.expandedAgentTeams)
      expanded.add(teamName)
      return { expandedAgentTeams: expanded }
    }),

  toggleTeamsSection: () =>
    set((state) => ({ isTeamsSectionExpanded: !state.isTeamsSectionExpanded })),

  // Section collapse actions
  toggleDMChatsSection: () =>
    set((state) => ({ isDMChatsSectionExpanded: !state.isDMChatsSectionExpanded })),
  toggleProjectsSection: () =>
    set((state) => ({ isProjectsSectionExpanded: !state.isProjectsSectionExpanded })),
  toggleSharedProjectsSection: () =>
    set((state) => ({ isSharedProjectsSectionExpanded: !state.isSharedProjectsSectionExpanded })),
  toggleFrontDeskSection: () =>
    set((state) => ({ isFrontDeskSectionExpanded: !state.isFrontDeskSectionExpanded })),
  togglePublicAgentsSection: () =>
    set((state) => ({ isPublicAgentsSectionExpanded: !state.isPublicAgentsSectionExpanded })),

  // Mobile panel actions
  openMobileSidebar: () => set({ isMobileSidebarOpen: true }),
  closeMobileSidebar: () => set({ isMobileSidebarOpen: false }),
  toggleMobileSidebar: () =>
    set((state) => ({ isMobileSidebarOpen: !state.isMobileSidebarOpen })),
  openMobileRightPanel: () => set({ isMobileRightPanelOpen: true }),
  closeMobileRightPanel: () => set({ isMobileRightPanelOpen: false }),
  toggleMobileRightPanel: () =>
    set((state) => ({ isMobileRightPanelOpen: !state.isMobileRightPanelOpen })),

  // Panel width actions (delta-based for resize handle)
  setSidebarWidth: (delta) =>
    set((state) => ({ sidebarWidth: Math.min(400, Math.max(200, state.sidebarWidth + delta)) })),
  setRightPanelWidth: (delta) =>
    set((state) => ({ rightPanelWidth: Math.min(400, Math.max(200, state.rightPanelWidth + delta)) })),

  // Reset all state to defaults
  reset: () => set({
    railContext: 'agents',
    expandedProjects: new Set(),
    expandedAgentTeams: new Set(),
    isDMChatsSectionExpanded: true,
    isProjectsSectionExpanded: false,
    isSharedProjectsSectionExpanded: false,
    isTeamsSectionExpanded: true,
    isFrontDeskSectionExpanded: true,
    isPublicAgentsSectionExpanded: true,
    isMobileSidebarOpen: false,
    isMobileRightPanelOpen: false,
    sidebarWidth: 300,
    rightPanelWidth: 256,
  }),
}))

import { Outlet, useLocation } from 'react-router-dom'
import { Menu } from 'lucide-react'
import Sidebar from './Sidebar'
import ConnectionStatus from '../common/ConnectionStatus'
import Overlay from '../common/Overlay'
import ResizeHandle from '../common/ResizeHandle'
import { useUIStore } from '../../stores/uiStore'
import OAuthLinkedBanner from '../auth/OAuthLinkedBanner'
import AnnouncementBanners from '../common/AnnouncementBanners'

// View routes (My Desk / project / chatroom / dm) manage their own internal
// scrolling, so the outer <main> is overflow-hidden. Other pages (settings,
// /projects/new form, etc.) scroll vertically.
const VIEW_ROUTE = /^\/(desk|projects\/(?!new(\/|$))[^/]+|dm\/[^/]+)/

export default function AppLayout() {
  const {
    isMobileSidebarOpen,
    openMobileSidebar,
    closeMobileSidebar,
    sidebarWidth,
    setSidebarWidth,
    railContext,
  } = useUIStore()
  const location = useLocation()
  const isViewRoute = VIEW_ROUTE.test(location.pathname)
  // The Welcome landing renders no side panel, so collapse the sidebar to just
  // the 68px icon rail (and drop the resize handle) instead of leaving a gap.
  const noPanel = railContext === 'welcome'
  const mainClass = isViewRoute
    ? 'flex-1 flex flex-col bg-white h-full overflow-hidden'
    : 'flex-1 flex flex-col bg-white h-full overflow-y-auto'

  return (
    <>
      <ConnectionStatus />

      {/* Hamburger button - visible only on mobile */}
      <button
        onClick={openMobileSidebar}
        className="fixed top-3 left-3 z-50 p-2 rounded-md bg-accent text-white hover:bg-accent-deep transition-colors lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="w-6 h-6" />
      </button>

      {/* Backdrop overlay for mobile sidebar */}
      <Overlay isOpen={isMobileSidebarOpen} onClose={closeMobileSidebar} />

      {/* Height comes from #root (dvh); h-full lets the shell track it. */}
      <div className="flex h-full overflow-hidden">
        {/* Sidebar wrapper with slide-in behavior on mobile */}
        <div
          className={`
            fixed top-0 left-0 h-viewport z-50 transform transition-transform duration-300 ease-in-out
            lg:relative lg:h-full lg:translate-x-0 lg:transform-none lg:transition-none flex-shrink-0
            ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
          style={{ width: noPanel ? 68 : sidebarWidth }}
        >
          <Sidebar onNavigate={closeMobileSidebar} />
        </div>

        {!noPanel && <ResizeHandle side="left" onResize={setSidebarWidth} />}

        <main className={mainClass}>
          <OAuthLinkedBanner />
          {/* Below OAuthLinkedBanner so a just-completed OAuth confirmation
              stays the top-most message. Renders null whenever there is
              nothing to say, so it costs no layout space in the common case. */}
          <AnnouncementBanners />
          <Outlet />
        </main>
      </div>
    </>
  )
}

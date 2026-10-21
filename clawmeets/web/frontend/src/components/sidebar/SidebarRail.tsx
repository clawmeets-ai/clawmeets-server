import { Link } from 'react-router-dom'
import { LayoutDashboard, Users, MessageSquare, Folder, Laptop, Inbox, Clock, Globe, Search, Keyboard } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RailContext } from '../../stores/uiStore'
import type { User } from '../../types'
import AccountChip from './AccountChip'

interface RailTab {
  id: RailContext
  icon: LucideIcon
  label: string
}

const ALL_TABS: RailTab[] = [
  { id: 'desk', icon: LayoutDashboard, label: 'My Desk' },
  { id: 'agents', icon: Users, label: 'Agents' },
  { id: 'dms', icon: MessageSquare, label: 'DMs' },
  { id: 'projects', icon: Folder, label: 'Projects' },
  // Directly under Projects. "Computers" is the longest label in the rail by one
  // character; the tab's fixed 46px width and 9px type hold it on one line.
  { id: 'computers', icon: Laptop, label: 'Computers' },
  { id: 'frontdesk', icon: Inbox, label: 'F-Desk' },
  { id: 'scheduled', icon: Clock, label: 'Sched' },
  { id: 'public', icon: Globe, label: 'Public' },
]

interface SidebarRailProps {
  context: RailContext
  onSelect: (context: RailContext) => void
  /** per-context in-progress flag → pulsing dot on the tab. */
  working?: Partial<Record<RailContext, boolean>>
  onOpenPalette: () => void
  onOpenHotkeys: () => void
  onNavigate?: () => void
  user: User | null
}

// The 68px icon rail: one button per context, a search shortcut, and the
// account chip pinned to the bottom. Exactly one button is active at a time.
export default function SidebarRail({
  context,
  onSelect,
  working,
  onOpenPalette,
  onOpenHotkeys,
  onNavigate,
  user,
}: SidebarRailProps) {
  return (
    <div
      // The rail is a scroll surface, not a fixed stack: on a short viewport the
      // account chip at its foot has to stay reachable. `[&>*]:shrink-0` keeps the
      // tabs at their designed height instead of squashing to content — the
      // flex-1 spacer still grows, so the chip stays pinned when everything fits.
      className="flex-none flex flex-col items-center gap-1 h-full min-h-0 overflow-y-auto overscroll-contain scrollbar-thin [&>*]:shrink-0"
      style={{
        width: 68,
        background: 'var(--bg-sidebar-section)',
        borderRight: '1px solid var(--line-2)',
        padding: '12px 0 10px',
      }}
    >
      <Link
        to="/projects"
        onClick={() => {
          // Welcome landing: deselect every tab and hide the side panel so it's
          // clearly a standalone page, not "under" the previously selected tab.
          onSelect('welcome')
          onNavigate?.()
        }}
        className="flex items-center justify-center text-white mb-2.5"
        style={{
          width: 36,
          height: 36,
          borderRadius: 11,
          background: 'linear-gradient(155deg, var(--accent), var(--accent-deep))',
          boxShadow: 'var(--shadow-2), inset 0 1px 0 rgba(255,255,255,.28)',
        }}
        aria-label="Home"
        title="ClawMeets"
      >
        <MessageSquare className="w-5 h-5" strokeWidth={2.1} />
      </Link>

      {ALL_TABS.map((tab) => {
        const Icon = tab.icon
        const active = context === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className="relative flex flex-col items-center justify-center gap-[3px] text-[9px] font-bold transition-colors"
            style={{
              width: 46,
              height: 42,
              borderRadius: 10,
              background: active ? '#ffffff' : 'transparent',
              color: active ? 'var(--accent-deep)' : 'var(--ink-3)',
              boxShadow: active ? 'var(--shadow-1)' : 'none',
            }}
          >
            {working?.[tab.id] && (
              <span
                className="absolute w-2 h-2 rounded-full bg-accent animate-pulse"
                style={{ top: 6, left: 8 }}
                title="Working…"
                aria-label="Working"
              />
            )}
            <Icon className="w-[18px] h-[18px]" strokeWidth={2} />
            <span>{tab.label}</span>
          </button>
        )
      })}

      <div className="flex-1" />

      <button
        onClick={onOpenPalette}
        className="flex flex-col items-center justify-center gap-[3px] text-[9px] font-bold transition-colors"
        style={{
          width: 46,
          height: 46,
          borderRadius: 11,
          color: 'var(--ink-2)',
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--line-2)',
        }}
        title="Search (⌘K)"
        aria-label="Search"
      >
        <Search className="w-[18px] h-[18px]" strokeWidth={2} />
        <span>Search</span>
      </button>

      <button
        onClick={onOpenHotkeys}
        className="flex flex-col items-center justify-center gap-[3px] text-[9px] font-bold transition-colors mt-1"
        style={{
          width: 46,
          height: 46,
          borderRadius: 11,
          color: 'var(--ink-2)',
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--line-2)',
        }}
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
      >
        <Keyboard className="w-[18px] h-[18px]" strokeWidth={2} />
        <span>Keys</span>
      </button>

      {/* AC-4.1 — the chip REPLACES the avatar. What stood here was a bare
          `Link to="/settings"` showing one initial; Settings is now the second
          row of the chip's popover, so nothing that used to be reachable from
          this corner stopped being reachable. `user` still gates it: the rail
          renders for an unauthenticated shell in no route today, but the guard
          was here and removing it would be an unrelated behaviour change. */}
      {user && <AccountChip onNavigate={onNavigate} />}
    </div>
  )
}

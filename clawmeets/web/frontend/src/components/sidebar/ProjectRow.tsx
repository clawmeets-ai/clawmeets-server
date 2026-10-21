import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, Hash, Trash2 } from 'lucide-react'
import {
  useActiveWorkStore,
  selectProjectHasActiveWork,
  selectActiveParticipants,
} from '../../stores/activeWorkStore'
import ActiveWorkDot from './ActiveWorkDot'
import { getChatroomDisplayName } from '../../utils/chatroomDisplay'

function ChannelRow({
  projectId,
  channel,
  active,
  onOpen,
}: {
  projectId: string
  channel: string
  active: boolean
  onOpen: () => void
}) {
  const working = useActiveWorkStore(selectActiveParticipants(projectId, channel))
  return (
    <button
      onClick={onOpen}
      className={`flex items-center gap-2 w-full pl-5 pr-3 py-1 rounded text-left transition-colors ${
        active ? 'bg-sidebar-active text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-hover'
      }`}
      title={channel}
    >
      <Hash className="w-3 h-3 text-ink-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate font-mono text-[12px]">
        {getChatroomDisplayName(channel)}
      </span>
      {working.length > 0 && <ActiveWorkDot />}
    </button>
  )
}

// Shared folder-led project row: [folder] name [count] [chevron] over a
// collapsible list of children (rooms or channels), each a `# name` sub-row.
// When `projectId` is supplied (Front desk), the row and each channel show an
// active-work dot while the fielding agent is working.
export default function ProjectRow({
  name,
  items,
  projectId,
  onOpenItem,
  activeItem,
  startOpen = false,
  onDelete,
  deleteTitle,
  leading,
  trailing,
}: {
  name: string
  items: string[]
  projectId?: string
  onOpenItem?: (item: string) => void
  /** highlight the child whose name matches (active route). */
  activeItem?: string | null
  startOpen?: boolean
  /** hover trash on the folder header (owned projects). */
  onDelete?: () => void
  deleteTitle?: string
  /** replaces the folder icon (Front Desk: a channel badge). */
  leading?: ReactNode
  /** after the name (Front Desk: a "Paused" mark). */
  trailing?: ReactNode
}) {
  const has = items.length > 0
  const [open, setOpen] = useState(startOpen)

  // Auto-expand when one of this project's children is the active route (e.g. the
  // Front Desk first item selected on tab-open). Leaving it (activeItem → null)
  // doesn't force-collapse, matching the Projects panel's persistent expand.
  useEffect(() => {
    if (activeItem) setOpen(true)
  }, [activeItem])
  const rowWorking = useActiveWorkStore(
    projectId ? selectProjectHasActiveWork(projectId) : () => false,
  )

  return (
    <div>
      <div className="group relative">
        <button
          onClick={() => has && setOpen((o) => !o)}
          className={`flex items-center gap-2 w-full pl-2 ${onDelete ? 'pr-8' : 'pr-3'} py-1 rounded text-left text-sidebar-text hover:bg-sidebar-hover transition-colors`}
          title={name}
        >
          {leading ?? <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />}
          <span className="flex-1 min-w-0 truncate font-mono text-[12px]">{name}</span>
          {trailing}
          {rowWorking && <ActiveWorkDot />}
          {has && (
            <span className="font-mono text-[10px] font-extrabold text-ink-4 tabular-nums shrink-0">
              {items.length}
            </span>
          )}
          {has && (
            <ChevronRight
              className={`w-3 h-3 text-ink-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            />
          )}
        </button>
        {/* Hover trash; the bg chip masks the trailing count+chevron on hover. */}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded bg-sidebar-hover hover:bg-red-100 text-channel hover:text-red-600 transition-all opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
            title={deleteTitle ?? `Delete ${name}`}
            aria-label={deleteTitle ?? `Delete ${name}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {has &&
        open &&
        items.map((it) =>
          projectId ? (
            <ChannelRow
              key={it}
              projectId={projectId}
              channel={it}
              active={activeItem === it}
              onOpen={() => onOpenItem?.(it)}
            />
          ) : (
            <button
              key={it}
              onClick={() => onOpenItem?.(it)}
              className={`flex items-center gap-2 w-full pl-5 pr-3 py-1 rounded text-left transition-colors ${
                activeItem === it ? 'bg-sidebar-active text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-hover'
              }`}
              title={it}
            >
              <Hash className="w-3 h-3 text-ink-4 shrink-0" />
              <span className="flex-1 min-w-0 truncate font-mono text-[12px]">
                {getChatroomDisplayName(it)}
              </span>
            </button>
          ),
        )}
    </div>
  )
}

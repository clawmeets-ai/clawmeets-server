import type { RailContext } from '../../stores/uiStore'

// Single source of truth for the "g then <key>" rail navigation chords. Drives
// the keydown handler in Sidebar.tsx and the HotkeysHelp panel, so the bindings
// and their documentation never drift. Letters are the first letter of the
// visible label (M=My Desk, A=Agents, D=DMs, P=Projects, F=Front Desk,
// S=Scheduled, C=Computers); Public is the sole exception (u=pUblic) since p is
// taken.
export const RAIL_SHORTCUTS: { context: RailContext; key: string; label: string }[] = [
  { context: 'desk', key: 'm', label: 'My Desk' },
  { context: 'agents', key: 'a', label: 'Agents' },
  { context: 'dms', key: 'd', label: 'DMs' },
  { context: 'projects', key: 'p', label: 'Projects' },
  { context: 'computers', key: 'c', label: 'Computers' },
  { context: 'frontdesk', key: 'f', label: 'Front Desk' },
  { context: 'scheduled', key: 's', label: 'Scheduled' },
  { context: 'public', key: 'u', label: 'Public' },
]

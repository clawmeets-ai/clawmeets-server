import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentCard, Project } from '../../types'
import type { ChannelThreadRow } from '../../api/endpoints/channels'

/**
 * ⌘K finds a channel thread by its contact's name, and labels it with who the
 * person is and the channel — never the room name (`ch-…`).
 */

const navigate = vi.fn()
const agents: AgentCard[] = [{ id: 'a-support', name: 'support', registered_by: 'u1' } as AgentCard]
const projects: Project[] = [
  { id: 'p-chan', name: 'ch-1a2b3c4d-deadbeef', display_name: 'Table booking', surface: 'frontdesk',
    coordinator_id: 'a-support', created_by: 'u1', created_at: '', status: 'active' } as unknown as Project,
]
const rows = new Map<string, ChannelThreadRow>([['p-chan', {
  project_id: 'p-chan', channel: 'whatsapp', connection_id: 'c', connection_enabled: true,
  connection_removed: false, contact_id: 'k', contact_name: 'Mara Quintero', paused: false,
}]])

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('../../hooks/useSops', () => ({ useSops: () => ({ sops: [], isLoading: false }) }))
vi.mock('../../hooks/useTodos', () => ({ useTodos: () => ({ todos: [], isLoading: false }) }))
vi.mock('../../hooks/useSopRecents', () => ({ useSopRecents: () => ({ recentIds: [], touch: vi.fn() }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../hooks/useAgentAccess', () => ({ useRetainedAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useTeamGroups', () => ({
  useTeamGroups: () => ({ sortedTeamNames: [], teamBuckets: new Map() }),
}))
vi.mock('../../hooks/useChannelThreads', () => ({
  useChannelThreads: () => ({ state: 'ready', byProject: rows }),
}))
vi.mock('../../hooks/useDmThreads', () => ({ useDmThreads: () => ({ groups: [] }) }))
vi.mock('../../hooks/useProjects', () => ({
  useUserProjects: () => ({ data: projects }),
  useAllProjects: () => ({ data: [] }),
}))
vi.mock('../../stores/uiStore', () => ({
  useUIStore: () => ({
    expandedAgentTeams: new Set<string>(), toggleAgentTeam: vi.fn(), expandAgentTeam: vi.fn(),
    setRailContext: vi.fn(), setProjectExpanded: vi.fn(),
  }),
}))
vi.mock('../../stores/authStore', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useAuthStore: (sel?: (s: Record<string, unknown>) => unknown) => {
      const state = { user: { id: 'u1', username: 'clawmeets' }, sessions: [], activeUserId: 'u1' }
      return sel ? sel(state) : state
    },
  }
})
vi.mock('../../hooks/useSwitchAccount', () => ({ useSwitchAccount: () => vi.fn() }))
vi.mock('../../stores/deskStore', () => ({
  useDeskStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ requestSop: vi.fn(), requestTask: vi.fn(), requestRailTab: vi.fn() }),
}))
vi.mock('../../stores/unsavedGuard', () => ({ confirmLeaveIfDirty: () => true }))
vi.mock('../../hooks/useMessageSearch', () => ({ useMessageSearch: () => ({ kind: 'idle' }) }))

Element.prototype.scrollIntoView = vi.fn()

const { default: CommandPalette } = await import('./CommandPalette')

afterEach(cleanup)

describe('CommandPalette — channel threads', () => {
  it("searching the contact's name finds their thread, labelled with the person and the channel", () => {
    render(<CommandPalette open onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/Jump to a tab/), { target: { value: 'mara' } })
    expect(screen.getByText('Mara Quintero · Table booking (WhatsApp)')).toBeTruthy()
    expect(screen.queryByText(/ch-1a2b3c4d/)).toBeNull()
  })
})

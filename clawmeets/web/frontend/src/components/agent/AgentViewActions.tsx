import { Link, useNavigate } from 'react-router-dom'
import { MessageSquare, FolderTree, Settings, Trash2 } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useDeleteAgent } from '../../hooks/useAgents'
import { isAssistantAgent } from '../../utils/personalize'
import type { AgentCard } from '../../types'

/** The three agent views the header switches between. */
export type AgentView = 'start' | 'home' | 'settings'

/** URL of an agent's start view, by its full (globally unique) name. */
export function agentStartPath(agentName: string): string {
  return `/dm/${encodeURIComponent(agentName)}`
}

/** URL of each agent view — the home folder is the start view's `?view=home`,
 *  opened at `homePath` (a home-relative folder) when one is given. */
export function agentViewPath(agent: Pick<AgentCard, 'id' | 'name'>, view: AgentView, homePath?: string): string {
  const dm = agentStartPath(agent.name)
  if (view === 'home') return homePath ? `${dm}?view=home&path=${encodeURIComponent(homePath)}` : `${dm}?view=home`
  if (view === 'settings') return `/agents/${agent.id}/settings`
  return dm
}

interface Props {
  agent: AgentCard
  agentLabel: string
  active: AgentView
}

const ITEMS = [
  { view: 'start', icon: MessageSquare, title: 'Start a thread', label: (n: string) => `Chat with ${n}` },
  { view: 'home', icon: FolderTree, title: 'Home folder', label: (n: string) => `Home folder of ${n}` },
  { view: 'settings', icon: Settings, title: 'Agent settings', label: (n: string) => `Settings for ${n}` },
] as const

/**
 * Header actions shared by the agent's start, home-folder and settings views,
 * so the same bar stays put while moving between them: one icon per view (the
 * current one highlighted) plus Delete. Owner-only; the assistant is never
 * deletable.
 */
export default function AgentViewActions({ agent, agentLabel, active }: Props) {
  const navigate = useNavigate()
  const user = useAuthStore((state) => state.user)
  const deleteAgentMutation = useDeleteAgent()
  const handleDeleteAgent = () => {
    if (!window.confirm(`Delete ${agentLabel}? This cannot be undone.`)) return
    // Its threads go with it, so leave the view once the delete lands.
    deleteAgentMutation.mutate(agent.id, { onSuccess: () => navigate('/', { replace: true }) })
  }

  // The server says per viewer whether this folder is browsable; absent means no.
  const items = ITEMS.filter((i) => i.view !== 'home' || agent.home_folder_browsable === true)

  return (
    <>
      {items.map(({ view, icon: Icon, title, label }) => {
        const current = view === active
        return (
          <Link
            key={view}
            to={agentViewPath(agent, view)}
            className={`p-2 rounded-md hover:bg-sidebar-hover transition-colors ${
              current ? 'text-channel-active bg-sidebar-hover' : 'text-channel hover:text-channel-active'
            }`}
            aria-label={label(agentLabel)}
            aria-current={current ? 'page' : undefined}
            title={title}
          >
            <Icon className="w-5 h-5" />
          </Link>
        )
      })}
      {!isAssistantAgent(agent, user) && (
        <button
          type="button"
          onClick={handleDeleteAgent}
          disabled={deleteAgentMutation.isPending}
          className="p-2 rounded-md hover:bg-red-100 transition-colors text-channel hover:text-red-600 disabled:opacity-50"
          aria-label={`Delete ${agentLabel}`}
          title="Delete agent"
        >
          <Trash2 className="w-5 h-5" />
        </button>
      )}
    </>
  )
}

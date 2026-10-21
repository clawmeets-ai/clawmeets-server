import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Save } from 'lucide-react'
import { updateAgent } from '../../api/endpoints/agents'
import { displayName } from '../../utils/agentDisplay'
import type { AgentCard, User } from '../../types'
import TeamAndAgentPicker from '../common/TeamAndAgentPicker'
import { Alert } from './primitives'

export const INVITABLE_COPY = {
  noCandidates: 'You have no other agents to bring in. Register more agents to enable delegation.',
  helper:
    'Applies to new conversations only; existing ones keep the list they started with. Teams and agents ' +
    'add up: an agent on a picked team, or picked by name, may be brought in. Leave both empty and ' +
    'the agent answers alone.',
} as const

/**
 * Which of the owner's other agents a public agent may bring into the
 * conversations it hosts: the card's `default_invitable_agents` (agent ids)
 * and `default_invitable_teams`. Shared by the Hub tab and the Front Desk
 * page so both edit the one setting the same way.
 *
 * Pills are display names (short for owned agents); the wire format is
 * agent ids. Owner-scoped display names are unique because the registry
 * enforces unique full names and all owned agents share the `{owner}-`
 * prefix. Stale ids (agent deleted, transferred) are dropped on load.
 *
 * Saving is a plain card update: top-level card fields, so no settings push
 * to the runner. `disabledReason` shows the saved list read-only.
 */
export default function InvitableAgentsPicker({
  coordinator,
  candidates,
  viewer,
  helper = INVITABLE_COPY.helper,
  disabledReason,
  idPrefix,
}: {
  coordinator: AgentCard
  candidates: AgentCard[]
  viewer: User | null
  helper?: ReactNode
  disabledReason?: string | null
  idPrefix: string
}) {
  const queryClient = useQueryClient()

  const candidateLabelById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of candidates) m.set(c.id, displayName(c, viewer))
    return m
  }, [candidates, viewer])

  const candidateIdByLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const [id, label] of candidateLabelById) m.set(label, id)
    return m
  }, [candidateLabelById])

  const initialLabels = useMemo(() => {
    const labels: string[] = []
    for (const id of coordinator.default_invitable_agents ?? []) {
      const label = candidateLabelById.get(id)
      if (label) labels.push(label)
    }
    return labels
  }, [coordinator.default_invitable_agents, candidateLabelById])

  const initialTeams = useMemo(
    () => [...(coordinator.default_invitable_teams ?? [])],
    [coordinator.default_invitable_teams],
  )

  const [labels, setLabels] = useState<string[]>(initialLabels)
  const [teams, setTeams] = useState<string[]>(initialTeams)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const initialKey = `${initialLabels.join('|')}::${initialTeams.join('|')}`
  const [lastInitialKey, setLastInitialKey] = useState(initialKey)
  if (initialKey !== lastInitialKey) {
    setLastInitialKey(initialKey)
    setLabels(initialLabels)
    setTeams(initialTeams)
  }

  const dirty =
    labels.length !== initialLabels.length ||
    labels.some((l, i) => l !== initialLabels[i]) ||
    teams.length !== initialTeams.length ||
    teams.some((t, i) => t !== initialTeams[i])

  const saveMutation = useMutation({
    mutationFn: () => {
      const ids: string[] = []
      const unknown: string[] = []
      for (const label of labels) {
        const id = candidateIdByLabel.get(label)
        if (id) ids.push(id)
        else unknown.push(label)
      }
      if (unknown.length > 0) {
        throw new Error(`Unknown agent(s): ${unknown.join(', ')}. Pick from the dropdown.`)
      }
      return updateAgent(coordinator.id, {
        default_invitable_agents: ids,
        default_invitable_teams: teams,
      })
    },
    onSuccess: () => {
      setSavedAt(Date.now())
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (e: Error) => {
      setError(e.message)
      setSavedAt(null)
    },
  })

  const suggestions = useMemo(
    () => Array.from(candidateLabelById.values()).sort(),
    [candidateLabelById],
  )
  const teamSuggestions = useMemo(() => {
    const set = new Set<string>()
    for (const c of candidates) {
      for (const t of c.user_teams || []) set.add(t)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [candidates])

  if (disabledReason) {
    return <p className="text-xs text-gray-500">{disabledReason}</p>
  }
  if (candidates.length === 0) {
    return <p className="text-xs text-gray-400 italic">{INVITABLE_COPY.noCandidates}</p>
  }
  return (
    <div>
      <TeamAndAgentPicker
        teams={teams}
        agents={labels}
        onChange={({ teams: nextTeams, agents: nextLabels }) => {
          setTeams(nextTeams)
          setLabels(nextLabels)
          setSavedAt(null)
          setError(null)
        }}
        teamSuggestions={teamSuggestions}
        agentSuggestions={suggestions}
        teamsId={`${idPrefix}-teams-${coordinator.id}`}
        agentsId={`${idPrefix}-agents-${coordinator.id}`}
        teamPlaceholder="Marketing, Outbound…"
        agentPlaceholder="Type to add an agent…"
      />
      <p className="mt-1 text-[11px] text-gray-500">{helper}</p>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!dirty || saveMutation.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-accent text-white hover:bg-accent-deep disabled:bg-accent-soft disabled:cursor-not-allowed transition-colors"
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          Save
        </button>
        {savedAt && !dirty && <span className="text-xs text-emerald-600">Saved.</span>}
      </div>
      {error && (
        <div className="mt-2">
          <Alert type="error" message={error} />
        </div>
      )}
    </div>
  )
}

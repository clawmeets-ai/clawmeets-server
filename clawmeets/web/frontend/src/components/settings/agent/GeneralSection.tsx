import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMyAgents } from '../../../hooks/useMyAgents'
import type { AgentCard } from '../../../types'
import TagPillInput from '../../common/TagPillInput'
import type { AgentSettingsDraft, AgentSettingsDraftApi } from './useAgentSettingsDraft'
import { Field, SectionTitle, inputClass } from './fields'

/** Description, capabilities, teams (all on the shared draft) + visibility note. */
export default function GeneralSection({
  agent,
  draft,
  set,
}: {
  agent: AgentCard
  draft: AgentSettingsDraft
  set: AgentSettingsDraftApi['set']
}) {
  // Seed the Teams autocomplete from the user's other agents so team names
  // stay consistent without a server-side allowlist.
  const { data: ownedAgents = [] } = useMyAgents()
  const knownTeamSuggestions = useMemo(() => {
    const set = new Set<string>()
    for (const a of ownedAgents) for (const t of a.user_teams || []) set.add(t)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [ownedAgents])

  return (
    <>
      <SectionTitle title="General" subtitle="How this agent describes itself to you and to other agents" />
      <div className="space-y-5">
        <Field label="Description" htmlFor="description">
          <textarea
            id="description"
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            rows={3}
            className={`${inputClass} resize-vertical`}
          />
        </Field>
        <Field label="Capabilities" hint="Used by other agents to find and delegate to this one.">
          <TagPillInput
            value={draft.capabilities}
            onChange={(v) => set('capabilities', v)}
            placeholder="research, writing, scheduling…"
          />
        </Field>
        <Field
          label="Teams"
          htmlFor="userTeams"
          hint={<>The agent appears under each team in the TEAMS sidebar; suggestions come from your other agents.</>}
        >
          <TagPillInput
            id="userTeams"
            value={draft.userTeams}
            onChange={(v) => set('userTeams', v)}
            suggestions={knownTeamSuggestions}
            placeholder="Marketing, Outbound…"
          />
        </Field>
        <p className="text-xs text-gray-500">
          Visibility:{' '}
          <span className="font-semibold text-gray-800">
            {agent.discoverable_through_registry ? 'public' : 'private'}
          </span>{' '}
          · publish it in{' '}
          <Link
            to="?section=channels&channel=hub"
            className="font-semibold text-purple-700 hover:text-purple-800 underline underline-offset-2"
          >
            Channels → Hub
          </Link>
          {agent.discoverable_through_registry && (
            <>
              {' '}· every public agent's invite list in{' '}
              <Link
                to="/settings/front-desk"
                className="font-semibold text-purple-700 hover:text-purple-800 underline underline-offset-2"
              >
                Front Desk Settings
              </Link>
            </>
          )}
        </p>
      </div>
    </>
  )
}

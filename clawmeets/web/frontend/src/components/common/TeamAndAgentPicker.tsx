import TagPillInput from './TagPillInput'

interface TeamAndAgentPickerProps {
  /** Team labels (free-form strings). */
  teams: string[]
  /** Agent identifiers — display names for project filters; agent IDs for FD allowlist. Caller adapts. */
  agents: string[]
  onChange: (next: { teams: string[]; agents: string[] }) => void
  teamSuggestions?: string[]
  agentSuggestions?: string[]
  teamPlaceholder?: string
  agentPlaceholder?: string
  /** Form field id for the teams row (used by the parent's <label htmlFor>). */
  teamsId?: string
  /** Form field id for the agents row. */
  agentsId?: string
  /** Optional copy under each row, rendered in muted text. */
  teamHelper?: string
  agentHelper?: string
}

/**
 * Unified picker for an `(teams, agents)` allowlist. Used in two places that
 * share the same UX shape (project candidate-pool filter + Front Desk
 * invitable-agents allowlist) but persist to different backends.
 *
 * Two stacked TagPillInput rows in one bordered card. Visually grouped to
 * signal "these compose via OR" without inventing a mixed-type chip.
 */
export default function TeamAndAgentPicker({
  teams,
  agents,
  onChange,
  teamSuggestions,
  agentSuggestions,
  teamPlaceholder,
  agentPlaceholder,
  teamsId,
  agentsId,
  teamHelper,
  agentHelper,
}: TeamAndAgentPickerProps) {
  return (
    <div className="border border-gray-200 rounded-lg bg-gray-50/30 p-3 space-y-3">
      <div>
        <label
          htmlFor={teamsId}
          className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1"
        >
          Teams
        </label>
        <TagPillInput
          id={teamsId}
          value={teams}
          onChange={(next) => onChange({ teams: next, agents })}
          suggestions={teamSuggestions}
          placeholder={teamPlaceholder}
        />
        {teamHelper && (
          <p className="mt-1 text-[11px] text-gray-500">{teamHelper}</p>
        )}
      </div>
      <div>
        <label
          htmlFor={agentsId}
          className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1"
        >
          Agents
        </label>
        <TagPillInput
          id={agentsId}
          value={agents}
          onChange={(next) => onChange({ teams, agents: next })}
          suggestions={agentSuggestions}
          placeholder={agentPlaceholder}
        />
        {agentHelper && (
          <p className="mt-1 text-[11px] text-gray-500">{agentHelper}</p>
        )}
      </div>
    </div>
  )
}

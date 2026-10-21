import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, SlidersHorizontal, Star, LayoutGrid } from 'lucide-react'
import { registerAgent, updateAgent } from '../../api/endpoints/agents'
import { installSkills } from '../../api/endpoints/skills'
import { installMcps } from '../../api/endpoints/mcps'
import { useAuthStore } from '../../stores/authStore'
import { useMyAgents } from '../../hooks/useMyAgents'
import TagPillInput from '../common/TagPillInput'
import SkillCatalog from './SkillCatalog'
import McpCatalog from './McpCatalog'
import { SectionCard, Alert } from '../settings/primitives'
// The provider tiles and the model placeholder both read the shared catalog —
// this form used to keep its own three-entry copy, which is how `opencode`
// stayed unofferable here long after it shipped everywhere else.
import {
  CLI_PROVIDERS,
  DEFAULT_LLM_PROVIDER,
  getLlmProvider,
  type LlmProviderId,
} from '../../config/llmProviders'

const CAPABILITY_SUGGESTIONS = [
  'research',
  'writing',
  'scheduling',
  'data analysis',
  'code review',
  'support triage',
  'design feedback',
  'meeting notes',
  'competitive intel',
]

const TEAM_FALLBACK_SUGGESTIONS = ['retail', 'ops', 'growth', 'engineering', 'design', 'founders']

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

function FieldLabel({
  htmlFor,
  label,
  hint,
  required,
}: {
  htmlFor?: string
  label: string
  hint?: string
  required?: boolean
}) {
  return (
    <label htmlFor={htmlFor} className="block mb-1.5">
      <span className="text-sm font-semibold text-gray-800">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {hint && <span className="text-xs text-gray-500 font-normal ml-1.5">— {hint}</span>}
    </label>
  )
}

function SuggestionChips({
  label,
  options,
  selected,
  onAdd,
}: {
  label: string
  options: string[]
  selected: string[]
  onAdd: (value: string) => void
}) {
  if (options.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.09em] text-gray-400 mr-1">
        {label}
      </span>
      {options.map((opt) => {
        const used = selected.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            disabled={used}
            onClick={() => onAdd(opt)}
            className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
              used
                ? 'bg-gray-50 border-gray-200 text-gray-300 line-through cursor-default'
                : 'bg-white border-gray-200 text-gray-600 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700'
            }`}
          >
            + {opt}
          </button>
        )
      })}
    </div>
  )
}

function SectionShell({
  icon,
  title,
  subtitle,
  badge,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <SectionCard>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 className="flex items-center gap-2 text-base font-bold text-gray-900">
          <span className="text-purple-600">{icon}</span>
          {title}
        </h2>
        {badge}
      </div>
      <div className="px-6 py-5 space-y-5">
        {subtitle && (
          <p className="text-sm text-gray-500 leading-relaxed -mt-1">{subtitle}</p>
        )}
        {children}
      </div>
    </SectionCard>
  )
}

function CountBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      className={`text-[10px] font-bold uppercase tracking-[0.09em] ${
        count > 0 ? 'text-purple-700' : 'text-gray-400'
      }`}
    >
      {count} {label}
    </span>
  )
}

export default function CreateAgentPage() {
  const navigate = useNavigate()
  const username = useAuthStore((s) => s.user?.username) ?? ''

  const { data: ownedAgents = [] } = useMyAgents()
  const teamSuggestions = useMemo(() => {
    const set = new Set<string>(TEAM_FALLBACK_SUGGESTIONS)
    for (const a of ownedAgents) {
      for (const t of a.user_teams || []) set.add(t)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [ownedAgents])
  const teamSectionLabel = ownedAgents.some((a) => (a.user_teams || []).length > 0)
    ? 'From your teams'
    : 'Suggested'

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [discoverable, setDiscoverable] = useState(false)
  const [teams, setTeams] = useState<string[]>([])
  const [knowledgeDir, setKnowledgeDir] = useState('')
  const [kdTouched, setKdTouched] = useState(false)
  const [llmProvider, setLlmProvider] = useState<LlmProviderId>(DEFAULT_LLM_PROVIDER)
  const [llmModel, setLlmModel] = useState('')
  const [skills, setSkills] = useState<string[]>([])
  const [mcps, setMcps] = useState<string[]>([])

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const nameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  // Knowledge-dir auto-derive: keep in sync with `./{name}` until the user edits it.
  useEffect(() => {
    if (kdTouched) return
    setKnowledgeDir(name ? `./${name}` : '')
  }, [name, kdTouched])

  const isDirty =
    name.trim().length > 0 ||
    description.trim().length > 0 ||
    capabilities.length > 0 ||
    teams.length > 0 ||
    knowledgeDir.trim().length > 0 ||
    llmModel.trim().length > 0 ||
    skills.length > 0 ||
    mcps.length > 0 ||
    discoverable

  const canSubmit = name.trim().length > 0 && !submitting

  const fullNamePreview = name ? `${username}-${name}` : `${username}-…`

  const addCapability = (cap: string) => {
    if (!capabilities.includes(cap)) setCapabilities([...capabilities, cap])
  }
  const addTeam = (team: string) => {
    if (!teams.includes(team)) setTeams([...teams, team])
  }

  const handleCancel = () => {
    if (isDirty && !window.confirm('Discard this new agent?')) return
    if (window.history.length > 1) navigate(-1)
    else navigate('/projects')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setSubmitting(true)

    let agentId: string
    try {
      const res = await registerAgent({
        name: name.trim(),
        description: description.trim() || undefined,
        capabilities,
        discoverable_through_registry: discoverable,
        user_teams: teams,
      })
      agentId = res.agent_id
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create agent')
      setSubmitting(false)
      return
    }

    const partialFailures: string[] = []

    try {
      await updateAgent(agentId, {
        local_settings: {
          knowledge_dir: knowledgeDir.trim() || undefined,
          llm_provider: llmProvider,
          llm_model: llmModel.trim() || undefined,
        },
      })
    } catch {
      partialFailures.push('local settings')
    }

    if (skills.length > 0) {
      try {
        await installSkills(agentId, skills)
      } catch {
        partialFailures.push('skills')
      }
    }
    if (mcps.length > 0) {
      try {
        await installMcps(agentId, mcps)
      } catch {
        partialFailures.push('MCP servers')
      }
    }

    const notice =
      partialFailures.length > 0
        ? `Agent created, but ${partialFailures.join(' and ')} could not be saved. Try again from this page.`
        : null

    navigate(`/agents/${agentId}/settings`, { state: notice ? { notice } : undefined })
  }

  return (
    <div className="flex-1 overflow-y-auto py-10">
      <div className="max-w-4xl mx-auto px-6">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-[26px] leading-[1.15] font-extrabold tracking-[-0.02em] text-gray-900">
            Create a new agent
          </h1>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed max-w-2xl">
            Give them a name, a job, and somewhere to keep their notes. You can wire up skills and
            MCP servers after they're created.
          </p>
        </div>

        {error && (
          <div className="mb-4">
            <Alert type="error" message={error} />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Configuration */}
          <SectionShell icon={<SlidersHorizontal className="w-4 h-4" />} title="Configuration">
            <div>
              <FieldLabel
                htmlFor="agent-name"
                label="Short name"
                hint="how you'll call them in commands and the sidebar"
                required
              />
              <input
                ref={nameInputRef}
                id="agent-name"
                type="text"
                value={name}
                onChange={(e) => setName(slugify(e.target.value))}
                placeholder="ops"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 transition-colors bg-gray-50/50 placeholder-gray-400 font-mono"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                Full name will be{' '}
                <code className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[11px] text-gray-700">
                  {fullNamePreview}
                </code>{' '}
                — that's how the agent identifies itself to other people.
              </p>
            </div>

            <div>
              <FieldLabel htmlFor="agent-description" label="Description" />
              <textarea
                id="agent-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="What does this agent do? Write it like you'd describe a teammate. The other agents read this when deciding who to delegate to."
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 transition-colors resize-vertical bg-gray-50/50 placeholder-gray-400 italic"
              />
            </div>

            <div>
              <FieldLabel label="Capabilities" />
              <TagPillInput
                value={capabilities}
                onChange={setCapabilities}
                placeholder="research, writing, scheduling…"
              />
              <SuggestionChips
                label="Suggested"
                options={CAPABILITY_SUGGESTIONS}
                selected={capabilities}
                onAdd={addCapability}
              />
              <p className="mt-2 text-xs text-gray-500">
                Short, comma-separated tags. Used by other agents to find them.
              </p>
            </div>

            <div className="flex items-start gap-2.5">
              <input
                type="checkbox"
                id="agent-discoverable"
                checked={discoverable}
                onChange={(e) => setDiscoverable(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500/30"
              />
              <label htmlFor="agent-discoverable" className="cursor-pointer">
                <span className="text-sm font-semibold text-gray-800">
                  Discoverable through agent registry
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  Other people on your team can see and delegate to this agent.
                </span>
              </label>
            </div>

            <div>
              <FieldLabel label="Teams" />
              <TagPillInput
                value={teams}
                onChange={setTeams}
                placeholder="retail, ops, growth…"
              />
              <SuggestionChips
                label={teamSectionLabel}
                options={teamSuggestions}
                selected={teams}
                onAdd={addTeam}
              />
              <p className="mt-2 text-xs text-gray-500">
                The agent appears under each team in the{' '}
                <code className="px-1 py-0.5 bg-gray-100 rounded font-mono text-[10.5px] text-gray-600">
                  TEAMS
                </code>{' '}
                sidebar.
              </p>
            </div>
          </SectionShell>

          {/* Runner settings */}
          <SectionShell icon={<Sparkles className="w-4 h-4" />} title="Runner settings">
            <div>
              <FieldLabel
                htmlFor="agent-knowledge-dir"
                label="Knowledge directory"
                hint="where the agent keeps its notes"
              />
              <input
                id="agent-knowledge-dir"
                type="text"
                value={knowledgeDir}
                onChange={(e) => {
                  setKdTouched(true)
                  setKnowledgeDir(e.target.value)
                }}
                placeholder="./knowledge"
                className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 transition-colors bg-gray-50/50 placeholder-gray-400"
              />
              <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
                Local path on the computer this agent runs on. Relative paths (e.g.{' '}
                <code className="font-mono text-[11px] bg-gray-100 px-1 py-0.5 rounded">./knowledge</code>{' '}
                or{' '}
                <code className="font-mono text-[11px] bg-gray-100 px-1 py-0.5 rounded">
                  ./notes/ledger
                </code>
                ) resolve against the agent's own folder,{' '}
                <code className="font-mono text-[11px] bg-gray-100 px-1 py-0.5 rounded">
                  ~/.clawmeets/agents/&lt;agent&gt;/
                </code>
                ; <code className="font-mono text-[11px] bg-gray-100 px-1 py-0.5 rounded">~</code>{' '}
                expands to your home; absolute paths are honored as-is. Changes apply on the next
                project.
              </p>
            </div>

            <div>
              <FieldLabel label="LLM provider" required />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CLI_PROVIDERS.map((opt) => {
                  const selected = llmProvider === opt.id
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setLlmProvider(opt.id)}
                      className={`px-3 py-2.5 rounded-lg border text-left transition-colors ${
                        selected
                          ? 'border-purple-400 bg-purple-50 ring-2 ring-purple-200'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div
                        className={`text-sm font-bold ${
                          selected ? 'text-purple-700' : 'text-gray-800'
                        }`}
                      >
                        {opt.label}
                      </div>
                      <div className="text-[10px] font-mono text-gray-400 mt-0.5">
                        {opt.vendor ?? opt.id}
                      </div>
                    </button>
                  )
                })}
              </div>
              <p className="mt-1.5 text-xs text-gray-500">
                Requires the corresponding CLI on that computer. Restart the agent for
                changes to take effect.
              </p>
            </div>

            <div>
              <FieldLabel
                htmlFor="agent-model"
                label="Model"
                hint="provider-specific, optional"
              />
              <input
                id="agent-model"
                type="text"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder={getLlmProvider(llmProvider)?.modelPlaceholder ?? 'leave blank for default'}
                className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 transition-colors bg-gray-50/50 placeholder-gray-400"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                Provider-specific model name. Leave blank to use the provider default.
              </p>
            </div>
          </SectionShell>

          {/* Skills */}
          <SectionShell
            icon={<Star className="w-4 h-4" />}
            title="Skills"
            subtitle="Pick the things this agent should know how to do. You can add or remove skills later."
            badge={<CountBadge count={skills.length} label="added" />}
          >
            <SkillCatalog value={skills} onChange={setSkills} />
          </SectionShell>

          {/* MCP servers */}
          <SectionShell
            icon={<LayoutGrid className="w-4 h-4" />}
            title="MCP servers"
            subtitle="Connect external tools and data sources via the Model Context Protocol. The agent gets read access by default; write actions still require your approval."
            badge={<CountBadge count={mcps.length} label="connected" />}
          >
            <McpCatalog value={mcps} onChange={setMcps} />
          </SectionShell>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 pt-2 pb-8">
            {!canSubmit && name.trim().length === 0 && (
              <span className="text-xs text-gray-400 mr-auto">Needs a short name</span>
            )}
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-5 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Creating…' : 'Create agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

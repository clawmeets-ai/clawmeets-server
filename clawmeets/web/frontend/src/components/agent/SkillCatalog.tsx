import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, ChevronDown, Settings2, KeyRound } from 'lucide-react'
import { getAvailableSkills, getSkillDetail, reauthSkill } from '../../api/endpoints/skills'
import {
  getTemplateSetup,
  listTemplates,
  type TemplateSetup,
} from '../../api/endpoints/templates'
import { selectPendingSkillAuth, useSkillAuthStore } from '../../stores/skillAuthStore'
import type { SkillMeta } from '../../types'
import SkillConfigModal from './SkillConfigModal'
import PreConsentModal from './PreConsentModal'
import { PRIVACY_POLICY_URL, TERMS_URL } from '../../utils/legalUrls'

interface SkillCatalogProps {
  value: string[]
  onChange: (next: string[]) => void
  /** When provided, added rows lazy-fetch their detail and surface a
   *  Configure pill if the skill ships a `starter_config.jsonc`. Omit on
   *  flows where the catalog is browsed without an agent in scope (e.g.
   *  initial agent creation). */
  agentId?: string
}

const COLORS = [
  { bg: 'bg-purple-100', text: 'text-purple-700' },
  { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  { bg: 'bg-amber-100', text: 'text-amber-700' },
  { bg: 'bg-rose-100', text: 'text-rose-700' },
  { bg: 'bg-sky-100', text: 'text-sky-700' },
  { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  { bg: 'bg-teal-100', text: 'text-teal-700' },
  { bg: 'bg-pink-100', text: 'text-pink-700' },
]

function colorFor(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]
}

function avatarFor(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function formatTeam(name: string): string {
  if (name === 'All') return name
  return name.replace(/_/g, ' ').toUpperCase()
}

export default function SkillCatalog({ value, onChange, agentId }: SkillCatalogProps) {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<string>('All')

  const { data: skills = [], isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: () => getAvailableSkills(),
  })

  // Derive each skill's team chips from the agent catalog's setup.json (GET /templates): a skill belongs
  // to team T iff some agent under any template with `user_teams: [T]` lists
  // that skill in its `skills:` array. Replaces the static TABS + tag-based
  // filter so adding a new team in a template is enough — no frontend edit.
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => listTemplates(),
  })

  const templateIds = useMemo(
    () => templates.map((t) => t.id).sort(),
    [templates],
  )

  const { data: skillToTeams = new Map<string, string[]>() } = useQuery({
    queryKey: ['skill-team-index', templateIds],
    enabled: templates.length > 0,
    queryFn: async () => {
      const setups = await Promise.all(
        templates.map((t) =>
          getTemplateSetup(t.id).catch(() => null as TemplateSetup | null),
        ),
      )
      const idx = new Map<string, Set<string>>()
      setups.forEach((setup, i) => {
        if (!setup) return
        const tmplId = templates[i].id
        for (const agent of setup.agents ?? []) {
          const teams = agent.user_teams?.length ? agent.user_teams : [tmplId]
          for (const skill of agent.skills ?? []) {
            if (!idx.has(skill)) idx.set(skill, new Set())
            const bucket = idx.get(skill)!
            for (const team of teams) bucket.add(team)
          }
        }
      })
      return new Map([...idx].map(([k, v]) => [k, [...v].sort()]))
    },
  })

  const tabs = useMemo<string[]>(() => {
    const all = new Set<string>()
    for (const teams of skillToTeams.values()) for (const t of teams) all.add(t)
    return ['All', ...[...all].sort()]
  }, [skillToTeams])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return skills.filter((s) => {
      if (tab !== 'All' && !skillToTeams.get(s.name)?.includes(tab)) return false
      if (q && !`${s.name} ${s.description}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [skills, search, tab, skillToTeams])

  const isAdded = (name: string) => value.includes(name)
  const toggle = (name: string) => {
    if (isAdded(name)) onChange(value.filter((s) => s !== name))
    else onChange([...value, name])
  }

  return (
    <div className="space-y-4">
      {/* Tabs + search row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((t) => {
            const active = tab === t
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                  active
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                }`}
              >
                {formatTeam(t)}
              </button>
            )
          })}
        </div>
        <div className="relative ml-auto flex-1 min-w-[180px] max-w-[260px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search skills…"
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-full bg-gray-50/50 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-300 transition-colors"
          />
        </div>
      </div>

      {/* Tile grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-8">No matches.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((skill) => (
            <SkillTile
              key={skill.name}
              skill={skill}
              teams={skillToTeams.get(skill.name) ?? []}
              added={isAdded(skill.name)}
              onToggle={() => toggle(skill.name)}
              agentId={agentId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SkillTile({
  skill,
  teams,
  added,
  onToggle,
  agentId,
}: {
  skill: SkillMeta
  teams: string[]
  added: boolean
  onToggle: () => void
  agentId?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [reauthing, setReauthing] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const color = colorFor(skill.name)
  const initials = avatarFor(skill.name)

  // The catalog list endpoint omits starter_config, so fetch the detail
  // lazily for installed rows that may have a Configure affordance. Only
  // triggered when an agent is in scope and the skill is added.
  const { data: detail } = useQuery({
    queryKey: ['skill-detail', skill.name],
    queryFn: () => getSkillDetail(skill.name),
    enabled: added && !!agentId,
    staleTime: 5 * 60 * 1000,
  })
  const starterConfig = detail?.starter_config ?? null
  const isConfigurable = added && !!agentId && starterConfig != null
  // Auth block on the registry entry. Surfaces the "Continue with Google"
  // affordance when the runner posts a skill_auth_url_for_user envelope after
  // SKILL_SYNC install. Mirrors McpRow's auth-row pattern.
  const needsAuth = skill.auth != null
  const pending = useSkillAuthStore(selectPendingSkillAuth(agentId ?? '', skill.name))
  const clearPending = useSkillAuthStore((s) => s.clear)
  useEffect(() => {
    if (!added && agentId && pending) {
      clearPending(agentId, skill.name)
    }
  }, [added, agentId, skill.name, pending, clearPending])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setExpanded((v) => !v)
        }
      }}
      className={`flex flex-col gap-2 p-3 rounded-xl border transition-colors text-left cursor-pointer ${
        added ? 'border-purple-300 bg-purple-50/30' : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center ${color.bg}`}>
          <span className={`text-xs font-mono font-bold ${color.text}`}>{initials}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-sm font-bold text-gray-900 truncate">{skill.name}</h3>
            {teams.map((team) => (
              <span
                key={team}
                className="text-[10px] font-bold uppercase tracking-wider text-gray-600 bg-gray-50 border border-gray-200 rounded-full px-1.5 py-0.5"
              >
                {formatTeam(team)}
              </span>
            ))}
            {needsAuth && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-1.5 py-0.5">
                OAuth
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">
            {skill.summary ?? skill.description}
          </p>
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          className={`flex-shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
            added
              ? 'bg-accent text-white border-accent hover:bg-accent-deep'
              : 'bg-white text-gray-700 border-gray-200 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700'
          }`}
        >
          {added ? '✓ Added' : '+ Add'}
        </button>
      </div>
      {expanded && (
        <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed pl-[3.25rem]">
          {skill.description}
        </p>
      )}
      {isConfigurable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setConfigOpen(true)
          }}
          className="inline-flex items-center justify-center gap-2 self-stretch px-3 py-2 text-xs font-semibold rounded-lg bg-white border border-purple-200 text-purple-700 hover:bg-purple-50 hover:border-purple-300 transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5" />
          Configure {skill.name}
        </button>
      )}
      {added && needsAuth && agentId && !pending && (
        <button
          type="button"
          disabled={reauthing}
          onClick={(e) => {
            e.stopPropagation()
            setReauthing(true)
            reauthSkill(agentId, skill.name)
              .catch((err) => {
                console.error(`Failed to trigger re-auth for ${skill.name}:`, err)
              })
              .finally(() => setReauthing(false))
          }}
          className="inline-flex items-center justify-center gap-2 self-stretch px-3 py-2 text-xs font-semibold rounded-lg bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <KeyRound className="w-3.5 h-3.5" />
          {reauthing ? `Requesting…` : `Re-authenticate ${skill.name}`}
        </button>
      )}
      {added && pending && agentId && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setConsentOpen(true)
          }}
          className="inline-flex items-center justify-center gap-2 self-stretch px-3 py-2 text-xs font-semibold rounded-lg bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300 transition-colors"
        >
          <span aria-hidden className="inline-block w-3 h-3 rounded-full bg-gradient-to-br from-blue-500 via-rose-500 to-amber-400" />
          Continue with Google to authorize {skill.name}
        </button>
      )}
      {consentOpen && pending && agentId && (
        <PreConsentModal
          open={consentOpen}
          integrationName={skill.name}
          scopes={skill.auth?.scopes ?? []}
          authUrl={pending.auth_url}
          privacyPolicyUrl={PRIVACY_POLICY_URL}
          termsUrl={TERMS_URL}
          onContinue={() => {
            // Open Google inside this user gesture, then optimistically clear
            // the pending URL (same trust boundary as the former anchor).
            window.open(pending.auth_url, '_blank', 'noopener,noreferrer')
            clearPending(agentId, skill.name)
            setConsentOpen(false)
          }}
          onCancel={() => setConsentOpen(false)}
        />
      )}
      {configOpen && agentId && (
        <SkillConfigModal
          agentId={agentId}
          skillName={skill.name}
          fallbackStarter={starterConfig}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </div>
  )
}

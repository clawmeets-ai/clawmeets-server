import { useState, useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useParams, Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getAgent } from '../../api/endpoints/agents'
import { getAgentSkills, installSkills, uninstallSkill } from '../../api/endpoints/skills'
import { getAgentMcps, installMcps, uninstallMcp } from '../../api/endpoints/mcps'
import { getAgentKnowledgePacks, installKnowledgePacks, uninstallKnowledgePack } from '../../api/endpoints/knowledgePacks'
import { useAuthStore } from '../../stores/authStore'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import VerifiedBadge from '../common/VerifiedBadge'
import Avatar from '../common/Avatar'
import CollapsibleHeader from '../common/CollapsibleHeader'
import AgentViewActions from '../agent/AgentViewActions'
import type { AgentStatus } from '../../types'
import SkillCatalog from '../agent/SkillCatalog'
import McpCatalog from '../agent/McpCatalog'
import ConnectedAccounts from './ConnectedAccounts'
import ModelConfigSection from './ModelConfigSection'
import { ResetToDefaultModel } from './DefaultModelSection'
import { SectionCard, SectionHeader, Alert } from './primitives'
import { SETTINGS_SECTIONS, parseSection } from './agent/sections'
import type { SettingsSectionId } from './agent/sections'
import { useInstallSelection } from './agent/useInstallSelection'
import { useAgentSettingsDraft } from './agent/useAgentSettingsDraft'
import type { AgentSettingsDraft } from './agent/useAgentSettingsDraft'
import AgentStatusStrip from './agent/AgentStatusStrip'
import GeneralSection from './agent/GeneralSection'
import KnowledgeSection from './agent/KnowledgeSection'
import RuntimeSection from './agent/RuntimeSection'
import StorageSection from './agent/StorageSection'
import ChannelsSection from './agent/ChannelsSection'
import { SectionTitle } from './agent/fields'

const EMPTY: string[] = []

// Which section each shared-draft field lives in, so the nav can mark the
// sections holding unsaved edits.
const DRAFT_FIELD_SECTION: Record<keyof AgentSettingsDraft, SettingsSectionId> = {
  description: 'general',
  capabilities: 'general',
  userTeams: 'general',
  knowledgeDir: 'knowledge',
  gitUrl: 'runtime',
  gitBaseBranch: 'runtime',
  localStorageDir: 'storage',
  sharedStorageDir: 'storage',
  extraDirs: 'runtime',
}

/**
 * Agent Settings. A left-hand section list shows ONE section at a time
 * (`?section=<id>`, default General) instead of one long scroll.
 *
 * Save model: description / capabilities / teams / the knowledge folder / git
 * share one draft (held here, so edits survive switching sections) and one
 * sticky Save bar that appears only while the draft is dirty. Model configs,
 * skills, MCP servers and knowledge packs apply the moment they're clicked.
 */
export default function AgentSettingsPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const viewer = useAuthStore((state) => state.user) ?? null
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const section = parseSection(searchParams.get('section'))
  const navRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({})

  // Display a one-shot notice forwarded by CreateAgentPage when post-register
  // steps (runner settings / skills / mcps) failed. Clear from history once read.
  const [arrivalNotice, setArrivalNotice] = useState<string | null>(null)
  useEffect(() => {
    const state = location.state as { notice?: string } | null
    if (state?.notice) {
      setArrivalNotice(state.notice)
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
    }
  }, [location, navigate])

  const { data: agent, isLoading } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => getAgent(agentId!),
    enabled: !!agentId,
  })

  const draftApi = useAgentSettingsDraft(agent)

  const { data: installedSkills = EMPTY } = useQuery({
    queryKey: ['agent-skills', agentId],
    queryFn: () => getAgentSkills(agentId!),
    enabled: !!agentId,
  })
  const skills = useInstallSelection({
    queryKey: ['agent-skills', agentId],
    installed: installedSkills,
    install: (name) => installSkills(agentId!, [name]),
    uninstall: (name) => uninstallSkill(agentId!, name),
  })

  const { data: installedMcps = EMPTY } = useQuery({
    queryKey: ['agent-mcps', agentId],
    queryFn: () => getAgentMcps(agentId!),
    enabled: !!agentId,
  })
  const mcps = useInstallSelection({
    queryKey: ['agent-mcps', agentId],
    installed: installedMcps,
    install: (name) => installMcps(agentId!, [name]),
    uninstall: (name) => uninstallMcp(agentId!, name),
  })

  const { data: installedPacks } = useQuery({
    queryKey: ['agent-knowledge-packs', agentId],
    queryFn: () => getAgentKnowledgePacks(agentId!),
    enabled: !!agentId,
    select: (packs) => packs.map((p) => p.slug),
  })
  const packs = useInstallSelection({
    queryKey: ['agent-knowledge-packs', agentId],
    installed: installedPacks ?? EMPTY,
    install: (slug) => installKnowledgePacks(agentId!, [slug]),
    uninstall: (slug) => uninstallKnowledgePack(agentId!, slug),
  })

  const selectSection = (id: SettingsSectionId) => {
    // replace: flipping between sections shouldn't fill the Back stack.
    setSearchParams(id === 'general' ? {} : { section: id }, { replace: true })
  }

  // Vertical tablist keyboard support: ↑/↓ move, Home/End jump.
  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SETTINGS_SECTIONS.findIndex((s) => s.id === section)
    const last = SETTINGS_SECTIONS.length - 1
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight' ? Math.min(i + 1, last)
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? Math.max(i - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    const id = SETTINGS_SECTIONS[next].id
    selectSection(id)
    navRefs.current[id]?.focus()
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500" />
      </div>
    )
  }

  if (!agent || !draftApi.draft) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-gray-500 mb-2">Agent not found.</p>
          <Link to="/projects" className="text-purple-600 hover:text-purple-700 text-sm underline underline-offset-2">
            Back to projects
          </Link>
        </div>
      </div>
    )
  }

  const { draft, set } = draftApi
  const counts: Partial<Record<SettingsSectionId, number>> = {
    skills: skills.selection.length,
    integrations: mcps.selection.length,
    knowledge: packs.selection.length,
  }
  const dirtySections = new Set<SettingsSectionId>()
  const { saved } = draftApi
  for (const key of Object.keys(DRAFT_FIELD_SECTION) as (keyof AgentSettingsDraft)[]) {
    if (saved && JSON.stringify(draft[key]) !== JSON.stringify(saved[key])) {
      dirtySections.add(DRAFT_FIELD_SECTION[key])
    }
  }

  const agentLabel = agentDisplayName(agent, viewer)

  return (
    <div className="flex flex-col h-full">
      {/* Same header bar as the agent's start and home-folder views (DMChatView). */}
      <CollapsibleHeader className="border-b border-border px-6 py-3 pl-14 lg:pl-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar name={agentLabel} status={agent.status as AgentStatus} size="md" />
            <h1 className="flex items-center gap-2 text-lg text-channel-active min-w-0">
              <span className="truncate">{agentLabel}</span>
              {agent.is_verified && <VerifiedBadge />}
            </h1>
          </div>
          {!!viewer && agent.registered_by === viewer.id && (
            <div className="flex items-center gap-1">
              <AgentViewActions agent={agent} agentLabel={agentLabel} active="settings" />
            </div>
          )}
        </div>
      </CollapsibleHeader>

    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 pt-6">
        <div className="mb-6">
          <AgentStatusStrip agent={agent} />
        </div>

        {arrivalNotice && (
          <div className="mb-4">
            <Alert type="warning" message={arrivalNotice} />
          </div>
        )}

        <div className="flex flex-col md:flex-row md:items-start gap-6">
          {/* Section list — a vertical rail on desktop, a scrollable pill row on small screens. */}
          <nav
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            onKeyDown={onNavKeyDown}
            className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible md:w-48 md:shrink-0 md:sticky md:top-6 -mx-1 px-1 pb-1 md:pb-0"
          >
            {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => {
              const active = id === section
              const count = counts[id]
              return (
                <button
                  key={id}
                  ref={(el) => { navRefs.current[id] = el }}
                  type="button"
                  role="tab"
                  id={`agent-settings-tab-${id}`}
                  aria-selected={active}
                  aria-controls="agent-settings-panel"
                  tabIndex={active ? 0 : -1}
                  onClick={() => selectSection(id)}
                  className={`shrink-0 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-left whitespace-nowrap transition-colors ${
                    active ? 'bg-purple-50 text-purple-800 font-bold' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${active ? 'text-purple-600' : 'text-gray-400'}`} />
                  <span className="flex-1">{label}</span>
                  {dirtySections.has(id) && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved changes" />
                  )}
                  {count ? <span className="text-[11px] font-semibold text-gray-400">{count}</span> : null}
                </button>
              )
            })}
          </nav>

          <section
            role="tabpanel"
            id="agent-settings-panel"
            aria-labelledby={`agent-settings-tab-${section}`}
            className="flex-1 min-w-0 pb-24"
          >
            {section === 'general' && <GeneralSection agent={agent} draft={draft} set={set} />}

            {section === 'model' && (
              <>
                <SectionTitle title="Model & routing" subtitle="Which model answers this agent's messages — one model, or several tried in priority order." />
                <ModelConfigSection agentId={agent.id} canEdit={!!viewer && agent.registered_by === viewer.id} />
                {!!viewer && agent.registered_by === viewer.id && <ResetToDefaultModel agentId={agent.id} />}
              </>
            )}

            {section === 'skills' && (
              <>
                <SectionTitle title="Skills" subtitle="Capabilities installed on this agent. Changes apply immediately." />
                <SkillCatalog value={skills.selection} onChange={skills.onChange} agentId={agent.id} />
              </>
            )}

            {section === 'integrations' && (
              <>
                <SectionTitle title="Integrations" subtitle="Accounts and servers this agent can reach. Changes apply immediately." />
                <div className="space-y-6">
                  <SectionCard>
                    <SectionHeader
                      title="Connected accounts"
                      subtitle="Google integrations this agent has authorized — disconnect to withdraw access"
                    />
                    <div className="px-6 py-5">
                      <ConnectedAccounts agentId={agent.id} />
                    </div>
                  </SectionCard>
                  <SectionCard>
                    <SectionHeader title="MCP servers" />
                    <div className="px-6 py-5">
                      <McpCatalog value={mcps.selection} onChange={mcps.onChange} agentId={agent.id} />
                      {mcps.selection.length > 0 && (
                        <p className="mt-3 text-xs text-gray-500">
                          Servers requiring authentication will surface a "Continue with Google" link here once the agent mints one.
                          If the agent runs on this computer, you can also authorize from a terminal:
                          <code className="mx-1 px-1.5 py-0.5 bg-gray-50 border border-gray-200 rounded font-mono text-gray-600">
                            clawmeets mcp auth &lt;name&gt; --agent {agent.name}
                          </code>
                        </p>
                      )}
                    </div>
                  </SectionCard>
                </div>
              </>
            )}

            {section === 'channels' && (
              !!viewer && agent.registered_by === viewer.id
                ? <ChannelsSection agentId={agent.id} agentName={agent.name} />
                : <p className="text-sm text-gray-500">Only this agent's owner can manage its channels.</p>
            )}

            {section === 'knowledge' && <KnowledgeSection draft={draft} set={set} packs={packs} />}

            {section === 'storage' && <StorageSection draft={draft} set={set} />}

            {section === 'runtime' && <RuntimeSection agentId={agent.id} agentName={agent.name} draft={draft} set={set} />}
          </section>
        </div>
      </div>

      {/* Save bar — only while the shared draft has unsaved edits (or just saved / failed). */}
      {(draftApi.isDirty || draftApi.error || draftApi.justSaved) && (
        <div className="sticky bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
          <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between gap-4" role="status">
            <span className="text-sm">
              {draftApi.error ? (
                <span className="text-red-700">Couldn't save: {draftApi.error}</span>
              ) : draftApi.isDirty ? (
                <span className="text-gray-700">
                  Unsaved changes in{' '}
                  {SETTINGS_SECTIONS.filter((s) => dirtySections.has(s.id)).map((s) => s.label).join(', ')}
                </span>
              ) : (
                <span className="text-emerald-700">Saved</span>
              )}
            </span>
            {draftApi.isDirty && (
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={draftApi.discard}
                  disabled={draftApi.isSaving}
                  className="px-4 py-2 text-sm font-semibold border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={draftApi.save}
                  disabled={draftApi.isSaving}
                  className="px-5 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {draftApi.isSaving ? 'Saving…' : 'Save changes'}
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
    </div>
  )
}

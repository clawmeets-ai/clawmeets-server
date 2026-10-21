import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, GitBranch, Cpu, Wrench, Boxes, Package } from 'lucide-react'
import type { AgentCard } from '../../types'
import { getAgentSkills } from '../../api/endpoints/skills'
import { getAgentMcps } from '../../api/endpoints/mcps'
import { getAgentKnowledgePacks } from '../../api/endpoints/knowledgePacks'

// Deterministic, at-a-glance summary of what an agent is equipped for, shown in
// the DM zero-state. Everything is composed from data already in hand
// (`AgentCard` + owner-scoped per-agent installs) — no LLM call.
//
// `description` is rendered by the parent header; this card carries the
// structured extras: capabilities, configured resources, and installed
// skills/MCPs/knowledge-packs. Skills/MCPs/packs are only fetchable for the
// user's OWN agents (owner-gated endpoints), so those sections are gated on
// `isOwnAgent` — foreign agents degrade to capabilities + resource flags.

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--line-1)] bg-white px-2.5 py-1 text-[12px] font-medium text-ink-2">
      {children}
    </span>
  )
}

function ResourceChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line-1)] bg-white px-2.5 py-1 text-[12px] font-medium text-ink-2">
      <span className="text-ink-4">{icon}</span>
      {children}
    </span>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="uppercase font-extrabold tracking-[0.09em] text-[11px] text-ink-3">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

// Trailing path segment of a git URL/path, minus a `.git` suffix — a friendly
// repo label without leaking the full (possibly private) URL.
function repoLabel(gitUrl: string): string {
  const trimmed = gitUrl.replace(/\/+$/, '')
  const base = trimmed.split('/').pop() ?? trimmed
  return base.replace(/\.git$/, '') || trimmed
}

export default function AgentSummaryCard({
  agent,
  isOwnAgent,
}: {
  agent: AgentCard
  isOwnAgent: boolean
}) {
  const ls = agent.local_settings ?? {}

  const { data: skills = [] } = useQuery({
    queryKey: ['agent-skills', agent.id],
    queryFn: () => getAgentSkills(agent.id),
    enabled: isOwnAgent,
  })
  const { data: mcps = [] } = useQuery({
    queryKey: ['agent-mcps', agent.id],
    queryFn: () => getAgentMcps(agent.id),
    enabled: isOwnAgent,
  })
  const { data: packs = [] } = useQuery({
    queryKey: ['agent-knowledge-packs', agent.id],
    queryFn: () => getAgentKnowledgePacks(agent.id),
    enabled: isOwnAgent,
  })

  // Resource presence flags — never the raw filesystem paths (for a foreign
  // agent those are another machine's paths). Model line only when it adds
  // signal (a non-default provider or an explicit model).
  const resources = useMemo(() => {
    const items: { key: string; icon: React.ReactNode; label: string }[] = []
    if (ls.knowledge_dir) items.push({ key: 'kb', icon: <BookOpen className="w-3.5 h-3.5" />, label: 'Knowledge base' })
    if (ls.git_url) items.push({ key: 'git', icon: <GitBranch className="w-3.5 h-3.5" />, label: `Git: ${repoLabel(ls.git_url)}` })
    const provider = ls.llm_provider
    if (ls.llm_model || (provider && provider !== 'claude')) {
      items.push({ key: 'llm', icon: <Cpu className="w-3.5 h-3.5" />, label: ls.llm_model || provider! })
    }
    return items
  }, [ls.knowledge_dir, ls.git_url, ls.llm_provider, ls.llm_model])

  const capabilities = agent.capabilities ?? []

  const hasAnything =
    capabilities.length > 0 ||
    resources.length > 0 ||
    (isOwnAgent && (skills.length > 0 || mcps.length > 0 || packs.length > 0))

  if (!hasAnything) return null

  return (
    <div className="mb-8 rounded-xl border border-[var(--line-1)] bg-[var(--bg-card-hover)] px-5 py-4 flex flex-col gap-4">
      {capabilities.length > 0 && (
        <Section label="Capabilities">
          {capabilities.map((c, i) => (
            <Chip key={i}>{c}</Chip>
          ))}
        </Section>
      )}

      {resources.length > 0 && (
        <Section label="Equipped with">
          {resources.map((r) => (
            <ResourceChip key={r.key} icon={r.icon}>
              {r.label}
            </ResourceChip>
          ))}
        </Section>
      )}

      {isOwnAgent && skills.length > 0 && (
        <Section label="Skills">
          {skills.map((s) => (
            <ResourceChip key={s} icon={<Wrench className="w-3.5 h-3.5" />}>
              {s}
            </ResourceChip>
          ))}
        </Section>
      )}

      {isOwnAgent && mcps.length > 0 && (
        <Section label="MCP servers">
          {mcps.map((m) => (
            <ResourceChip key={m} icon={<Boxes className="w-3.5 h-3.5" />}>
              {m}
            </ResourceChip>
          ))}
        </Section>
      )}

      {isOwnAgent && packs.length > 0 && (
        <Section label="Knowledge packs">
          {packs.map((p) => (
            <ResourceChip key={p.slug} icon={<Package className="w-3.5 h-3.5" />}>
              {p.name}
            </ResourceChip>
          ))}
        </Section>
      )}
    </div>
  )
}

import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import type { AgentCard, User } from '../../types'
import { useAuthStore } from '../../stores/authStore'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import {
  useAgentSampleRequests,
  type AgentSampleRequest,
} from '../../hooks/useAgentSampleRequests'
import Avatar from '../common/Avatar'
import { AgentStatus } from '../../types'
import { ASSISTANT_STARTER_SAMPLES } from '../sample-request/assistantStarterSamples'
import SampleIdeaList from '../sample-request/SampleIdeaList'
import AgentSummaryCard from './AgentSummaryCard'

// Full-width accent CTA rendered under the capability summary — "here's what I
// can do → now make me an expert at it". The whole card is a button that
// prefills the composer via onPersonalize (which carries the hidden
// personalize-trigger). Copy branches on isAssistant: the assistant learns the
// USER (interview / résumé + LinkedIn); every other agent deep-researches the
// field its role serves. Shown for every agent.
function PersonalizeCTA({
  bareName,
  isAssistant,
  onPersonalize,
}: {
  bareName: string | null
  isAssistant: boolean
  onPersonalize: () => void
}) {
  const name = bareName ?? 'agent'
  const title = isAssistant
    ? `Help @${name} get to know you`
    : `Make @${name} an industry expert with deep research`
  const subtitle = isAssistant
    ? `Choose how: share your résumé/LinkedIn, paste a profile from ChatGPT/Claude, or answer a few questions. @${name} builds a profile of who you are and how you like to work — and consults it on every future turn.`
    : `Out of the box @${name} reasons like a brilliant new grad. A few minutes of deep research on your field makes it an expert in your world.`
  return (
    <button
      type="button"
      onClick={onPersonalize}
      className="group w-full text-left mb-7 flex items-center gap-3.5 rounded-xl px-4 py-3.5 bg-gradient-to-br from-[#faf5ff] to-[#f0e9ff] border border-[#d9c9ff] hover:border-accent-deep hover:shadow-sm transition-all"
    >
      <span className="shrink-0 w-10 h-10 rounded-xl bg-accent-deep text-white flex items-center justify-center">
        <Sparkles className="w-5 h-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-extrabold text-ink-1">
          {title}
        </span>
        <span className="block text-[12.5px] text-ink-3 leading-relaxed mt-0.5">
          {subtitle}
        </span>
      </span>
    </button>
  )
}

// #3: assistant onboarding starter prompts (moved off the welcome page) now live
// in a shared module so DeskZeroState reuses the same set — see
// ../sample-request/assistantStarterSamples. Rendered here only on the user's own
// assistant DM (isAssistantDM) and only when the template returns no sample
// requests — the `-assistant` agent isn't registered from a team template, so it
// has none. Renders through the shared one-line SampleIdeaList (grouped by
// `category`, one row per idea) — the full prompt body previews as ghost text
// in the composer below on hover instead of being printed into a card here.

// Group samples by category, preserving insertion order. Categories are
// declared on each item (flat list) — same order as authored in setup.json.
function groupByCategory(
  samples: AgentSampleRequest[],
): { category: string; items: AgentSampleRequest[] }[] {
  const order: string[] = []
  const buckets = new Map<string, AgentSampleRequest[]>()
  for (const s of samples) {
    const cat = s.category || 'Suggestions'
    if (!buckets.has(cat)) {
      order.push(cat)
      buckets.set(cat, [])
    }
    buckets.get(cat)!.push(s)
  }
  return order.map((category) => ({ category, items: buckets.get(category)! }))
}

export default function DMZeroState({
  agent,
  onUseSample,
  onPreviewSample,
  onPersonalize,
}: {
  agent: AgentCard | undefined
  onUseSample: (text: string) => void
  /** Hover/focus a row → preview its body as composer ghost text (null clears). */
  onPreviewSample?: (text: string | null) => void
  onPersonalize: () => void
}) {
  const user = useAuthStore((s) => s.user) as User | null
  const bareName = useMemo(
    () => (agent ? agentDisplayName(agent, user ?? null) : null),
    [agent, user],
  )
  const { samples } = useAgentSampleRequests(bareName)

  // Surface DM-vs-coordinator distinction only on the user's own assistant DM
  // (predicate: agent named `{username}-assistant`).
  const isAssistantDM = !!user && !!agent && agent.name === `${user.username}-assistant`
  // Own-agent gate for the owner-scoped skills/MCPs/packs fetch in the summary
  // card (same predicate as DMChatView).
  const isOwnAgent = !!user && !!agent && agent.registered_by === user.id

  // #3: template samples win when present; otherwise the assistant DM shows the
  // built-in onboarding starters (moved off the welcome page). Any other agent
  // with no template samples falls through to the minimal placeholder below.
  const displaySamples = useMemo(
    () => (samples.length > 0 ? samples : isAssistantDM ? ASSISTANT_STARTER_SAMPLES : []),
    [samples, isAssistantDM],
  )
  const grouped = useMemo(() => groupByCategory(displaySamples), [displaySamples])
  const assistantIntro = (
    <p className="text-[12.5px] text-ink-3 leading-relaxed">
      DM me for anything that doesn't need the rest of the team. To bring in the
      team, start a project — I become your <strong>coordinator</strong>, your
      deputy running the team on your behalf.
    </p>
  )

  // Minimal placeholder only while the agent is still resolving from the list.
  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-channel">
        <div className="text-center max-w-md px-6 space-y-3">
          <p>Start a conversation with @{bareName ?? 'agent'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-6 py-8">
        {/* Header — large avatar + eyebrow + question + description */}
        <header className="flex items-start gap-4 mb-8">
          <Avatar
            name={bareName ?? agent.name}
            status={agent.status as AgentStatus}
            size="lg"
          />
          <div className="flex flex-col gap-1.5 min-w-0">
            <span
              className="uppercase font-extrabold tracking-[0.09em] text-[11px]"
              style={{ color: 'var(--accent-deep)' }}
            >
              Start a thread
            </span>
            <h2 className="text-[20px] font-extrabold text-ink-1 leading-snug">
              What can <span className="text-accent-deep">@{bareName}</span> dig into for you?
            </h2>
            <p className="text-[13.5px] text-ink-3 leading-relaxed">
              {[
                agent.description,
                grouped.length > 0
                  ? 'Pick a starter or write your own.'
                  : 'Write your first message below.',
              ]
                .filter(Boolean)
                .join('. ')}
            </p>
            {isAssistantDM && assistantIntro}
          </div>
        </header>

        {/* Capability summary — what the agent is equipped for */}
        <AgentSummaryCard agent={agent} isOwnAgent={isOwnAgent} />

        {/* Personalize CTA — sits between "here's what I can do" and the sample
            prompts, so onboarding comes before the user picks a task. */}
        <PersonalizeCTA
          bareName={bareName}
          isAssistant={isAssistantDM}
          onPersonalize={onPersonalize}
        />

        {/* Grouped one-line ideas. Hovering a row ghosts its full body into
            the composer below; clicking fills it for real. */}
        <div className="flex flex-col gap-7">
          {grouped.map(({ category, items }, gi) => (
            <SampleIdeaList
              key={`${gi}:${category}`}
              label={category}
              samples={items}
              onUse={onUseSample}
              onPreview={onPreviewSample}
            />
          ))}
        </div>

        <p className="mt-8 text-center text-[12px] text-ink-4">
          Or just start typing in the composer below — Enter to send, Shift+Enter for a new line.
        </p>
      </div>
    </div>
  )
}

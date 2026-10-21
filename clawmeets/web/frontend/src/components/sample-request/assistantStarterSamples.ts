import { TrendingUp, Home, Scale, BookCheck, type LucideIcon } from 'lucide-react'
import type { AgentSampleRequest } from '../../hooks/useAgentSampleRequests'

// Assistant onboarding starter prompts. Shared by two zero-states so they stay
// consistent by construction:
//   - DMZeroState  — shown on the user's own assistant DM when the `-assistant`
//                    agent (never team-registered, so it has no template
//                    samples) would otherwise render an empty launchpad.
//   - DeskZeroState — shown on an empty My Desk; tapping a row prefills the
//                     desk composer in place.
//
// Titles are the REQUEST, not a category. Both zero-states render one line per
// idea (SampleIdeaList) with the full body previewed as composer ghost text on
// hover — so "Investment" would be the only thing a user ever reads about this
// prompt unless they hover it. The title has to carry the offer on its own.
// The term "model agents", word for word as clawmeets/models/provider_agents.py
// MODEL_AGENT_DEFINITION writes it for the onboarding and convene starter
// to-dos. tests/test_provider_agents.py fails if the two drift.
const MODEL_AGENT_DEFINITION =
  'Model agents are the agents named after the AI models I connected at install (claude, codex, gemini, ..., plus one per API key). Each one has no job of its own: it speaks for its model and for what that model has already seen of my work. My other agents, like my assistant and thought_partner, each have a job, and each one runs on one of those models.'

const MODEL_AGENTS = 'Ask my model agents'

export const ASSISTANT_STARTER_SAMPLES: AgentSampleRequest[] = [
  // First, and carries the definition, so a new owner meets the concept in
  // the first sample that uses it.
  {
    category: MODEL_AGENTS,
    title: 'Get one answer from all my models on a hard decision',
    request:
      `${MODEL_AGENT_DEFINITION} Convene my model agents on: [Should I raise now or wait for $20k MRR?]. Blind answers first, then reconcile, and show where they still disagree.`,
  },
  {
    category: MODEL_AGENTS,
    title: 'Fact-check a rule with every model, settled on the source',
    request:
      'Ask my model agents: [What does the EU AI Act require of a B2B chatbot by 2027?]. Settle each disagreement against a primary source.',
  },
  {
    category: 'Sample requests',
    title: 'Should I invest in NVIDIA, Apple, or Google?',
    request:
      "Set up an agent team of equity_researcher and cpa to analyze whether investing in NVIDIA, Apple, Google, and Microsoft is a good idea — equity_researcher owns the fundamentals and valuation of each stock, cpa owns the tax treatment and after-tax return. Register, start, and personalize any of them I don't already have.",
  },
  {
    category: 'Sample requests',
    title: 'Should I sell my condo — and at what price?',
    request:
      "Set up an agent team of real_estate_specialist and cpa to analyze whether I should sell my condo at 480 Mission Bay Blvd North #515, SF — and at what price. real_estate_specialist owns the comps, market read, and listing price; cpa owns capital gains and the after-tax proceeds. Register, start, and personalize any of them I don't already have.",
  },
]

// Title → row glyph. Keyed on title (not index) so reordering the list above
// can't silently shuffle the icons. Server-supplied template samples aren't in
// this map and fall back to a generic glyph in SampleIdeaList, which is why the
// `AgentSampleRequest` wire type needs no icon field.
export const STARTER_ICONS: Record<string, LucideIcon> = {
  'Get one answer from all my models on a hard decision': Scale,
  'Fact-check a rule with every model, settled on the source': BookCheck,
  'Should I invest in NVIDIA, Apple, or Google?': TrendingUp,
  'Should I sell my condo — and at what price?': Home,
}

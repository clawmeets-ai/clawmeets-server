import type { AgentCard, User } from '../types'

// Build the personalize prefill from the agent's OWN description + capabilities
// so the deep-research ask points at THIS agent's field. The assistant gets the
// interview framing (it learns the USER, not a field); every other agent gets
// the role-anchored deep-research framing. Both carry the hidden trigger comment
// that actually fires /clawmeets:personalize — only the visible copy differs.
// Shared by the DM view (DMChatView) and the desk composer (DeskComposer) so the
// two surfaces stay a single source of truth for the prompt copy.
export function buildPersonalizeMessage(
  agent: AgentCard,
  agentLabel: string,
  isAssistant: boolean,
): string {
  const trigger = '<!-- clawmeets:personalize-trigger -->\n\n'
  if (isAssistant) {
    return (
      trigger +
      "Let's set up my profile so you know me from day one. I'll share my " +
      'résumé (or a screenshot of my LinkedIn) — read it, ask me the couple of ' +
      "things it can't tell you, then build a picture of who I am and how I " +
      'like to work.'
    )
  }
  // Drop capabilities that are empty or the generic "general" placeholder so a
  // thin card degrades gracefully (no dangling "— —") instead of reading oddly.
  const caps = (agent.capabilities || [])
    .map((c) => c.trim())
    .filter((c) => c && c.toLowerCase() !== 'general')
  const capsClause = caps.length > 0 ? ` ${caps.join(', ')} —` : ''
  const role = agent.description ? ` (${agent.description})` : ''
  return (
    trigger +
    `Hi @${agentLabel} — right now you're a strong generalist at your role${role}, ` +
    `but new to *my* world. Go deep on the field this role serves for me —${capsClause} ` +
    `research what you can, ask me 1–3 targeted questions if something's genuinely ` +
    `missing, then come back an expert who knows how my industry and I actually work.`
  )
}

// True when `agent` is the caller's own assistant ({user.username}-assistant).
// The assistant gets the method-picker modal; every other agent gets the
// role-anchored deep-research prefill.
export function isAssistantAgent(
  agent: AgentCard | null | undefined,
  user: User | null | undefined,
): boolean {
  return !!user && !!agent && agent.name === `${user.username}-assistant`
}

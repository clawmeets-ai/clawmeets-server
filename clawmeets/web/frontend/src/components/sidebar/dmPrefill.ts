// Templated prefill messages for the sidebar `+` deep-links. Clicking `+` on the
// Agents / Projects panels opens the user's assistant DM with the composer
// pre-filled (via `?draft=`), so "create an agent / create a project" starts as
// a conversation with the assistant instead of a bare form. Placeholders use
// <angle brackets> so the user sees exactly what to fill in.
export const AGENT_DRAFT_TEMPLATE =
  'Please create an agent named <name> specialized in <expertise>. <other relevant description>'

export const PROJECT_DRAFT_TEMPLATE =
  "Please create a project with <agent1's name>, <agent2's name>, ... to <task description>."

// Build a deep-link to any agent's DM with the composer prefilled — typed, NOT
// sent. Keeping the encoding in one place keeps every caller DRY; the `?draft=`
// value round-trips through DMChatView's `searchParams.get('draft')`.
export function agentDraftUrl(agentName: string, draft: string): string {
  return `/dm/${encodeURIComponent(agentName)}?draft=${encodeURIComponent(draft)}`
}

// The same link into the assistant's DM. Still exported for any other deep-link
// into the assistant DM; the sidebar `+` buttons no longer use it (they open
// `DmComposeModal` instead), but the `?draft=` prefill path in DMChatView
// remains intact.
export function assistantDraftUrl(assistantName: string, draft: string): string {
  return agentDraftUrl(assistantName, draft)
}

// One controlled value per variable in AGENT_DRAFT_TEMPLATE.
export interface AgentDraftValues {
  name: string
  expertise: string
  other: string
}

// PROJECT_DRAFT_TEMPLATE's agent clause is a repetition PATTERN, not one token,
// so its value is a LIST of agent names (task is the single scalar).
export interface ProjectDraftValues {
  agents: string[]
  task: string
}

// Trim, drop blanks, and case-insensitively de-dupe while keeping the FIRST
// casing seen. Shared by the project assembler so the sent list matches what the
// live preview shows.
function cleanAgentList(agents: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of agents) {
    const name = raw.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

// Assemble the "create an agent" DM body from AGENT_DRAFT_TEMPLATE. Substitutes
// <name>/<expertise> with trimmed values and <other relevant description> with
// other.trim(), then trims the whole string. Because the period sits BEFORE the
// token in the template ("...in <expertise>. <other...>"), a blank `other`
// collapses cleanly to "...specialized in <expertise>." — no dangling token, no
// double period, no trailing space. Single source of truth: design + code share
// this assembler.
export function assembleAgentDraft(v: AgentDraftValues): string {
  return AGENT_DRAFT_TEMPLATE.replace('<name>', v.name.trim())
    .replace('<expertise>', v.expertise.trim())
    .replace('<other relevant description>', v.other.trim())
    .trim()
}

// Assemble the "create a project" DM body. The agent list is rebuilt from the
// cleaned names (trim → drop blanks → case-insensitive de-dupe, first casing
// kept → comma-join) and <task description> is substituted. Kept co-located with
// PROJECT_DRAFT_TEMPLATE and matching its lexical skeleton so the two never
// drift. Returns a trimmed, send-ready string.
export function assembleProjectDraft(v: ProjectDraftValues): string {
  const agents = cleanAgentList(v.agents).join(', ')
  return `Please create a project with ${agents} to ${v.task.trim()}.`.trim()
}
